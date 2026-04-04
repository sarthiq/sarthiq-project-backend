/**
 * nodeManager.js
 * ─────────────────────────────────────────────────────────────────────
 * Selects the best Kubernetes node for a new deployment
 * and keeps the KubeNode table accurate.
 *
 * KEY CHANGES (v2):
 *   - REMOVED hardcoded "minikube-local" fallback
 *   - Added live K8s node discovery via CoreV1 API
 *   - Added preflightClusterCheck() for early failure detection
 *   - Handles single-node control-plane clusters (NoSchedule taint)
 *   - Detects NotReady nodes and excludes them
 *   - Marks stale DB nodes as inactive
 *
 * Strategy: pick the active node with the most free capacity
 * (lowest ratio of used/total for both CPU + memory).
 * ─────────────────────────────────────────────────────────────────────
 */
const k8s = require("@kubernetes/client-node");
const KubeNode = require("../Models/Deployment/kubeNode");
const { getNodeMetrics } = require("./kubeClient");

// K8s client for node discovery
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

// ── ARCHITECTURE NOTE ──────────────────────────────────────────
// Master server (control-plane) = runs ONLY sarthiq backend + frontend
// Worker nodes (node servers)   = run ONLY student/user projects
// The master server must NEVER be used to deploy student projects.
// If no worker nodes exist, deployments must FAIL, not fall back to master.
// ───────────────────────────────────────────────────────────────

// In production, NEVER schedule student projects on the control-plane.
// Set ALLOW_CONTROL_PLANE_SCHEDULING=true ONLY for local dev (minikube/kind).
const ALLOW_CONTROL_PLANE_SCHEDULING =
  process.env.ALLOW_CONTROL_PLANE_SCHEDULING === "true" ||
  process.env.NODE_ENV !== "production";

// Resource cost per FREE-TIER container (must match tierConfig defaults)
const FREE_TIER_CPU_MILLICORES = 500; // 0.5 vCPU = 500m
const FREE_TIER_MEMORY_MI = 512; // 512 MiB

/* ------------------------------------------------------------------ */
/* Helper: parse K8s resource strings to numeric values                 */
/* ------------------------------------------------------------------ */
function parseCpuToMillicores(cpu) {
  if (!cpu) return 0;
  const str = String(cpu);
  if (str.endsWith("m")) return parseInt(str);
  if (str.endsWith("n")) return Math.round(parseInt(str) / 1_000_000);
  return Math.round(parseFloat(str) * 1000); // whole cores → millicores
}

function parseMemoryToMi(mem) {
  if (!mem) return 0;
  const str = String(mem);
  if (str.endsWith("Ki")) return Math.round(parseInt(str) / 1024);
  if (str.endsWith("Mi")) return parseInt(str);
  if (str.endsWith("Gi")) return parseInt(str) * 1024;
  if (str.endsWith("Ti")) return parseInt(str) * 1024 * 1024;
  // Raw bytes (no suffix)
  return Math.round(parseInt(str) / (1024 * 1024));
}

/* ------------------------------------------------------------------ */
/* Helper: check if a node is ready                                     */
/* ------------------------------------------------------------------ */
function isNodeReady(node) {
  const conditions = node.status?.conditions || [];
  const readyCondition = conditions.find((c) => c.type === "Ready");
  return readyCondition?.status === "True";
}

/* ------------------------------------------------------------------ */
/* Helper: check if a node has blocking taints for regular pods         */
/* ------------------------------------------------------------------ */
function hasBlockingTaints(node) {
  const taints = node.spec?.taints || [];
  // NoSchedule and NoExecute prevent regular pods from being scheduled
  const blockingEffects = ["NoSchedule", "NoExecute"];
  return taints.some((t) => blockingEffects.includes(t.effect));
}

/* ------------------------------------------------------------------ */
/* Helper: check if a node is a control-plane node                      */
/* ------------------------------------------------------------------ */
function isControlPlaneNode(node) {
  const labels = node.metadata?.labels || {};
  return (
    labels["node-role.kubernetes.io/control-plane"] !== undefined ||
    labels["node-role.kubernetes.io/master"] !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* discoverAndSyncNodes: discover real K8s nodes and sync to DB         */
/* ------------------------------------------------------------------ */
async function discoverAndSyncNodes() {
  try {
    const nodeList = await coreV1.listNode();
    const k8sNodes = nodeList.items || [];

    if (k8sNodes.length === 0) {
      console.warn("[nodeManager] ⚠ No nodes found in Kubernetes cluster!");
      return [];
    }

    const isSingleNode = k8sNodes.length === 1;
    const discoveredNames = new Set();
    const results = [];

    for (const node of k8sNodes) {
      const nodeName = node.metadata.name;
      discoveredNames.add(nodeName);

      const ready = isNodeReady(node);
      const capacity = node.status?.capacity || {};
      const allocatable = node.status?.allocatable || {};

      // Use allocatable (capacity minus system reserved) for real limits
      const totalCpu = parseCpuToMillicores(allocatable.cpu || capacity.cpu);
      const totalMem = parseMemoryToMi(allocatable.memory || capacity.memory);

      // Check if this node can accept pods
      const controlPlane = isControlPlaneNode(node);
      const hasTaints = hasBlockingTaints(node);

      // ── CRITICAL: Control-plane = master server = NOT for student projects ──
      // In production, the master server runs only the SarthiQ backend/frontend.
      // Student projects MUST deploy on dedicated worker nodes.
      // Only allow control-plane scheduling in dev environments (minikube/kind).
      let schedulable = ready;
      if (controlPlane && !ALLOW_CONTROL_PLANE_SCHEDULING) {
        // PRODUCTION: Never schedule student projects on the master server
        schedulable = false;
        console.log(
          `[nodeManager] ⛔ Node '${nodeName}' is the control-plane (master server). ` +
            `Student projects cannot be deployed here. Skipping.`
        );
      } else if (hasTaints && !controlPlane) {
        // Non-control-plane nodes with taints (e.g., maintenance mode)
        schedulable = false;
      } else if (controlPlane && hasTaints && ALLOW_CONTROL_PLANE_SCHEDULING) {
        // DEV ONLY: allow scheduling on control-plane (minikube/kind)
        schedulable = ready;
        console.log(
          `[nodeManager] ⚠ DEV MODE: Allowing scheduling on control-plane '${nodeName}'`
        );
      }

      // Upsert to DB
      const [dbNode] = await KubeNode.upsert({
        nodeName,
        totalCpuMillicores: totalCpu,
        totalMemoryMi: totalMem,
        isActive: ready && schedulable,
      });

      results.push({
        nodeName,
        ready,
        schedulable,
        controlPlane,
        hasTaints,
        totalCpu,
        totalMem,
        dbId: dbNode.id,
      });

      console.log(
        `[nodeManager] Node: ${nodeName} | Ready: ${ready} | Schedulable: ${schedulable} | ` +
          `Control-Plane: ${controlPlane} | CPU: ${totalCpu}m | Mem: ${totalMem}Mi`
      );
    }

    // Mark any DB nodes that no longer exist in K8s as inactive
    const allDbNodes = await KubeNode.findAll();
    for (const dbNode of allDbNodes) {
      if (!discoveredNames.has(dbNode.nodeName) && dbNode.isActive) {
        console.log(
          `[nodeManager] ⚠ Deactivating stale DB node: ${dbNode.nodeName} (no longer in cluster)`
        );
        await dbNode.update({ isActive: false });
      }
    }

    return results;
  } catch (err) {
    console.error(
      `[nodeManager] ⚠ K8s node discovery failed: ${err.message}`
    );
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* preflightClusterCheck: validate cluster can accept new deployments   */
/* Call this BEFORE creating any K8s resources.                         */
/* ------------------------------------------------------------------ */
async function preflightClusterCheck() {
  const discovered = await discoverAndSyncNodes();

  if (discovered.length === 0) {
    return {
      ok: false,
      reason:
        "Cannot reach Kubernetes cluster or no nodes found. " +
        "Ensure kubectl is configured and the cluster is running.",
      nodes: [],
      isSingleNode: false,
    };
  }

  const readyNodes = discovered.filter((n) => n.ready);
  if (readyNodes.length === 0) {
    return {
      ok: false,
      reason: `All ${discovered.length} cluster node(s) are NotReady. Check node health with 'kubectl get nodes'.`,
      nodes: discovered,
      isSingleNode: discovered.length === 1,
    };
  }

  const schedulableNodes = discovered.filter((n) => n.schedulable);

  // ── CRITICAL CHECK: Are there any WORKER nodes (non-control-plane)? ──
  // The master server must NEVER run student projects.
  // If only the control-plane exists, reject the deployment.
  const workerNodes = schedulableNodes.filter((n) => !n.controlPlane);
  const controlPlaneNodes = discovered.filter((n) => n.controlPlane);

  if (schedulableNodes.length === 0) {
    // Check if it's because only control-plane exists
    if (controlPlaneNodes.length > 0 && !ALLOW_CONTROL_PLANE_SCHEDULING) {
      return {
        ok: false,
        reason:
          "No worker nodes available for deployment. " +
          "The master server (control-plane) cannot be used for student projects. " +
          "Please add a worker node to the cluster or renew the expired node server.",
        nodes: discovered,
        isSingleNode: discovered.length === 1,
        controlPlaneOnly: true,
      };
    }

    return {
      ok: false,
      reason:
        "All ready nodes have NoSchedule/NoExecute taints. " +
        "Either remove taints from a worker node or add one without taints.",
      nodes: discovered,
      isSingleNode: discovered.length === 1,
    };
  }

  // In production, ensure we have actual worker nodes, not just control-plane
  if (workerNodes.length === 0 && !ALLOW_CONTROL_PLANE_SCHEDULING) {
    return {
      ok: false,
      reason:
        "No worker nodes available for deployment. " +
        "Only the master server (control-plane) was found, but student projects " +
        "can only run on dedicated worker nodes. " +
        "Please add a worker node or renew the expired node server.",
      nodes: discovered,
      isSingleNode: discovered.length === 1,
      controlPlaneOnly: true,
    };
  }

  const isSingleNode = discovered.length === 1;
  const controlPlaneOnly =
    isSingleNode && discovered[0].controlPlane;

  return {
    ok: true,
    reason: null,
    nodes: schedulableNodes,
    isSingleNode,
    controlPlaneOnly,
    totalSchedulableNodes: schedulableNodes.length,
  };
}

/* ------------------------------------------------------------------ */
/* sync: refresh KubeNode rows from live metrics-server data            */
/* ------------------------------------------------------------------ */
async function syncNodeMetrics() {
  const live = await getNodeMetrics();
  for (const m of live) {
    // Use proper parsers — raw parseInt fails on nanocores ("600448522n" → 600448522 WRONG)
    const usedCpu = parseCpuToMillicores(m.cpuUsage);
    const usedMem = parseMemoryToMi(m.memUsage);

    // Only update usage numbers — don't create fake entries
    const existing = await KubeNode.findOne({
      where: { nodeName: m.nodeName },
    });
    if (existing) {
      await existing.update({
        usedCpuMillicores: usedCpu,
        usedMemoryMi: usedMem,
      });
    }
    // If the node doesn't exist in DB, discoverAndSyncNodes() will create it
  }
}

/* ------------------------------------------------------------------ */
/* getBestNode: returns KubeNode with enough headroom for one deploy    */
/* ------------------------------------------------------------------ */
async function getBestNode(
  requiredCpu = FREE_TIER_CPU_MILLICORES,
  requiredMemMi = FREE_TIER_MEMORY_MI
) {
  // First, discover real nodes from K8s API (creates/updates DB records)
  await discoverAndSyncNodes();

  // Then freshen usage data from metrics-server (non-fatal if unavailable)
  await syncNodeMetrics().catch((err) => {
    console.log(
      `[nodeManager] Metrics-server unavailable (non-fatal): ${err.message}`
    );
  });

  let nodes = await KubeNode.findAll({ where: { isActive: true } });

  if (!nodes.length) {
    throw new Error(
      "No active, schedulable Kubernetes nodes found. " +
        "Run 'kubectl get nodes' to check cluster state. " +
        "For single-node clusters, ensure the node is Ready."
    );
  }

  const eligible = nodes.filter(
    (n) =>
      n.totalCpuMillicores - n.usedCpuMillicores >= requiredCpu &&
      n.totalMemoryMi - n.usedMemoryMi >= requiredMemMi
  );

  if (!eligible.length) {
    // Provide detailed capacity info for debugging
    const capacityInfo = nodes
      .map(
        (n) =>
          `${n.nodeName}: CPU ${n.usedCpuMillicores}/${n.totalCpuMillicores}m, ` +
          `Mem ${n.usedMemoryMi}/${n.totalMemoryMi}Mi`
      )
      .join("; ");
    throw new Error(
      `All cluster nodes are at capacity (need ${requiredCpu}m CPU, ${requiredMemMi}Mi RAM). ` +
        `Current usage: [${capacityInfo}]. Please try again later or scale the cluster.`
    );
  }

  // Score: lower is better (busier node scores higher so we bin-pack)
  eligible.sort((a, b) => {
    const scoreA =
      a.usedCpuMillicores / a.totalCpuMillicores +
      a.usedMemoryMi / a.totalMemoryMi;
    const scoreB =
      b.usedCpuMillicores / b.totalCpuMillicores +
      b.usedMemoryMi / b.totalMemoryMi;
    return scoreB - scoreA; // descending = most-used first (bin-pack)
  });

  return eligible[0];
}

/* ------------------------------------------------------------------ */
/* reserveNode: increment usage counters when a deploy starts          */
/* ------------------------------------------------------------------ */
async function reserveNode(
  nodeId,
  cpuMillicores = FREE_TIER_CPU_MILLICORES,
  memMi = FREE_TIER_MEMORY_MI
) {
  await KubeNode.increment(
    { usedCpuMillicores: cpuMillicores, usedMemoryMi: memMi },
    { where: { id: nodeId } }
  );
}

/* ------------------------------------------------------------------ */
/* releaseNode: decrement usage counters when a container is stopped   */
/* ------------------------------------------------------------------ */
async function releaseNode(
  nodeId,
  cpuMillicores = FREE_TIER_CPU_MILLICORES,
  memMi = FREE_TIER_MEMORY_MI
) {
  const node = await KubeNode.findByPk(nodeId);
  if (!node) return;

  await node.update({
    usedCpuMillicores: Math.max(0, node.usedCpuMillicores - cpuMillicores),
    usedMemoryMi: Math.max(0, node.usedMemoryMi - memMi),
  });
}

/* ------------------------------------------------------------------ */
/* registerNode: upsert a node entry (call this on cluster join)       */
/* ------------------------------------------------------------------ */
async function registerNode(
  nodeName,
  totalCpuMillicores = 2000,
  totalMemoryMi = 4096
) {
  const [node] = await KubeNode.upsert({
    nodeName,
    totalCpuMillicores,
    totalMemoryMi,
  });
  return node;
}

module.exports = {
  getBestNode,
  reserveNode,
  releaseNode,
  registerNode,
  syncNodeMetrics,
  discoverAndSyncNodes,
  preflightClusterCheck,
};
