/**
 * kubeNodeCleanupCron.js
 * ─────────────────────────────────────────────────────────────────────
 * Periodic reconciliation of KubeNode usage counters against actual
 * K8s cluster state. Runs every 30 minutes.
 *
 * Fixes phantom resource usage caused by:
 *   - Projects deleted without calling releaseNode()
 *   - Failed deployments that reserved but never released capacity
 *   - Nodes removed from the cluster but still tracked in DB
 * ─────────────────────────────────────────────────────────────────────
 */
const cron = require("node-cron");
const KubeNode = require("../Models/Deployment/kubeNode");
const DockerInfo = require("../Models/Projects/dockerInfo");
const { discoverAndSyncNodes } = require("../Utils/nodeManager");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

// Default resource usage per running container (should match nodeManager)
const FREE_TIER_CPU = parseInt(process.env.FREE_TIER_CPU_MILLICORES || "500");
const FREE_TIER_MEM = parseInt(process.env.FREE_TIER_MEMORY_MI || "512");

/**
 * Reconcile KubeNode usage counters against actual DockerInfo records.
 */
async function reconcileNodeUsage() {
  console.log("[kubeNodeCleanup] Starting node usage reconciliation...");

  const kubeNodes = await KubeNode.findAll();
  let corrected = 0;
  let pruned = 0;

  for (const node of kubeNodes) {
    // Count running containers actually assigned to this node
    const runningCount = await DockerInfo.count({
      where: { nodeId: node.nodeName, status: "running" },
    });

    const expectedCpu = runningCount * FREE_TIER_CPU;
    const expectedMem = runningCount * FREE_TIER_MEM;

    const currentCpu = node.usedCpuMillicores || 0;
    const currentMem = node.usedMemoryMi || 0;

    // Check for mismatch
    if (currentCpu !== expectedCpu || currentMem !== expectedMem) {
      console.log(
        `[kubeNodeCleanup] ⚠ Node "${node.nodeName}" usage mismatch: ` +
        `DB(${currentCpu}m/${currentMem}Mi) → Expected(${expectedCpu}m/${expectedMem}Mi) ` +
        `(${runningCount} running containers)`
      );

      await node.update({
        usedCpuMillicores: expectedCpu,
        usedMemoryMi: expectedMem,
      });
      corrected++;
    }
  }

  // Prune nodes that no longer exist in K8s
  try {
    const k8sNodeList = await coreV1.listNode();
    const k8sNodeNames = new Set(
      (k8sNodeList.items || []).map((n) => n.metadata.name)
    );

    for (const node of kubeNodes) {
      if (!k8sNodeNames.has(node.nodeName)) {
        // Check if any DockerInfo still references this node
        const refCount = await DockerInfo.count({
          where: { nodeId: node.nodeName },
        });
        if (refCount === 0) {
          console.log(
            `[kubeNodeCleanup] 🗑 Pruning stale node "${node.nodeName}" — ` +
            `not in K8s cluster and no containers reference it`
          );
          await node.destroy();
          pruned++;
        }
      }
    }
  } catch (k8sErr) {
    console.error("[kubeNodeCleanup] K8s API error during node pruning:", k8sErr.message);
  }

  console.log(
    `[kubeNodeCleanup] Reconciliation complete: ${corrected} corrected, ${pruned} pruned`
  );
}

/**
 * Start the cleanup cron (every 30 minutes).
 */
function startKubeNodeCleanupCron() {
  console.log("[kubeNodeCleanup] Scheduling node usage reconciliation (every 30 min)...");

  // Run immediately on startup
  reconcileNodeUsage().catch((err) =>
    console.error("[kubeNodeCleanup] Initial reconciliation failed:", err.message)
  );

  // Schedule recurring
  cron.schedule("*/30 * * * *", async () => {
    try {
      await reconcileNodeUsage();
    } catch (err) {
      console.error("[kubeNodeCleanup] Cron error:", err.message);
    }
  });
}

module.exports = { startKubeNodeCleanupCron, reconcileNodeUsage };
