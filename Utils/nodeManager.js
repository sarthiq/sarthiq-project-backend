/**
 * nodeManager.js
 * Selects the best Kubernetes node for a new deployment
 * and keeps the KubeNode table accurate.
 *
 * Strategy: pick the active node with the most free capacity
 * (lowest ratio of used/total for both CPU + memory).
 */
const KubeNode = require("../Models/Deployment/kubeNode");
const { getNodeMetrics } = require("./kubeClient");

// Resource cost per FREE-TIER container (must match tierConfig defaults)
const FREE_TIER_CPU_MILLICORES = 500; // 0.5 vCPU = 500m
const FREE_TIER_MEMORY_MI = 512; // 512 MiB

/* ------------------------------------------------------------------ */
/* sync: refresh KubeNode rows from live metrics-server data            */
/* ------------------------------------------------------------------ */
async function syncNodeMetrics() {
  const live = await getNodeMetrics();
  for (const m of live) {
    // parse "150m" → 150
    const usedCpu = parseInt(m.cpuUsage) || 0;
    // parse "512Mi" → 512
    const usedMem = parseInt(m.memUsage) || 0;

    await KubeNode.upsert({
      nodeName: m.nodeName,
      usedCpuMillicores: usedCpu,
      usedMemoryMi: usedMem,
      isActive: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* getBestNode: returns KubeNode with enough headroom for one deploy    */
/* ------------------------------------------------------------------ */
async function getBestNode(
  requiredCpu = FREE_TIER_CPU_MILLICORES,
  requiredMemMi = FREE_TIER_MEMORY_MI
) {
  // First, freshen usage data from metrics-server
  await syncNodeMetrics().catch(() => {}); // non-fatal if metrics-server is slow

  let nodes = await KubeNode.findAll({ where: { isActive: true } });

  // Fallback for local testing (e.g. Minikube without metrics-server)
  if (!nodes.length) {
    console.log("[nodeManager] No active nodes found from metrics-server. Auto-registering 'minikube-local' fallback.");
    await registerNode("minikube-local", 4000, 8192); // 4 CPU, 8GB RAM limit
    nodes = await KubeNode.findAll({ where: { isActive: true } });
  }

  if (!nodes.length) throw new Error("No active Kubernetes nodes registered.");

  const eligible = nodes.filter(
    (n) =>
      n.totalCpuMillicores - n.usedCpuMillicores >= requiredCpu &&
      n.totalMemoryMi - n.usedMemoryMi >= requiredMemMi
  );

  if (!eligible.length) {
    throw new Error(
      "All cluster nodes are at capacity. Please try again later."
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
};
