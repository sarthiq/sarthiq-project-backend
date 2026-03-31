/**
 * sleepWatcher.js
 * BullMQ Worker that runs on the sleepCheckQueue.
 *
 * It is scheduled as a repeatable job (every 5 minutes).
 * For every running container inactive for ≥ INACTIVITY_TIMEOUT_MS,
 * it scales the K8s deployment to 0 replicas (sleep).
 *
 * Container wakes up automatically when the next HTTP request arrives
 * (handled by sleepProxy.js in the Middleware directory).
 */
const { Worker } = require("bullmq");
const { Op } = require("sequelize");
const k8s = require("@kubernetes/client-node");

const { connection, sleepCheckQueue } = require("./queues");
const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const { scaleDeployment, safeLabel, NAMESPACE } = require("../Utils/kubeClient");
const { releaseNode } = require("../Utils/nodeManager");
const KubeNode = require("../Models/Deployment/kubeNode");

// Dedicated K8s client for pre-flight checks
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

// 15 minutes of inactivity → sleep
const INACTIVITY_TIMEOUT_MS =
  parseInt(process.env.SLEEP_INACTIVITY_MINUTES || "15") * 60 * 1000;

/**
 * Check if a K8s deployment exists before attempting to scale it.
 * @returns {boolean} true if deployment exists, false if not
 */
async function deploymentExists(subdomain) {
  const label = safeLabel(subdomain);
  try {
    await appsV1.readNamespacedDeployment({
      name: label,
      namespace: NAMESPACE,
    });
    return true;
  } catch (err) {
    if (
      err.statusCode === 404 ||
      err?.response?.statusCode === 404 ||
      err?.body?.code === 404
    ) {
      return false;
    }
    // Network/auth errors — assume it might exist, let scaleDeployment handle it
    return true;
  }
}

const sleepWatcher = new Worker(
  "sleepCheckQueue",
  async (job) => {
    const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS);

    console.log(
      `[sleepWatcher] Checking for containers idle since ${cutoff.toISOString()}`
    );

    // Find all running containers that haven't had activity
    const idleDockers = await DockerInfo.findAll({
      where: {
        status: "running",
        lastActivityAt: { [Op.lt]: cutoff },
      },
      include: [{ model: Project, attributes: ["subdomain", "id", "title"] }],
    });

    console.log(`[sleepWatcher] Found ${idleDockers.length} idle container(s)`);

    for (const docker of idleDockers) {
      const project = docker.Project;
      if (!project?.subdomain) continue;

      try {
        // ── PRE-CHECK: Verify deployment exists in K8s ──────────
        const exists = await deploymentExists(project.subdomain);

        if (!exists) {
          // Deployment was destroyed (e.g. system restart) — just fix DB
          console.log(
            `[sleepWatcher] ⚠ ${project.subdomain}: K8s deployment not found. Correcting DB → sleeping`
          );
          docker.status = "sleeping";
          await docker.save();

          // Release node capacity
          if (docker.nodeId) {
            const node = await KubeNode.findOne({
              where: { nodeName: docker.nodeId },
            });
            if (node) {
              await releaseNode(node.id);
            }
          }

          console.log(`[sleepWatcher] ✓ ${project.subdomain} DB corrected to sleeping`);
          continue; // Skip the scale call — nothing to scale
        }

        console.log(
          `[sleepWatcher] Sleeping: ${project.subdomain} (idle since ${docker.lastActivityAt})`
        );

        // Scale to 0 replicas
        await scaleDeployment(project.subdomain, 0);

        // Release node capacity
        if (docker.nodeId) {
          const node = await KubeNode.findOne({
            where: { nodeName: docker.nodeId },
          });
          if (node) {
            await releaseNode(node.id);
          }
        }

        docker.status = "sleeping";
        await docker.save();

        console.log(`[sleepWatcher] ✓ ${project.subdomain} is now sleeping`);
      } catch (err) {
        // If scaleDeployment threw a 404, auto-correct instead of erroring
        const is404 =
          err.statusCode === 404 ||
          err?.response?.statusCode === 404 ||
          (err.message && err.message.includes("not found"));

        if (is404) {
          console.log(
            `[sleepWatcher] ⚠ ${project.subdomain}: deployment not found (404). Correcting DB → sleeping`
          );
          docker.status = "sleeping";
          await docker.save();
        } else {
          console.error(
            `[sleepWatcher] Failed to sleep ${project.subdomain}: ${err.message}`
          );
        }
      }
    }
  },
  {
    connection,
    concurrency: 1, // serial to avoid race conditions
  }
);

sleepWatcher.on("failed", (job, err) =>
  console.error(`[sleepWatcher] Job failed: ${err.message}`)
);

/* ------------------------------------------------------------------ */
/* Register repeatable job (every 5 minutes).                          */
/* Call this once at app startup.                                       */
/* ------------------------------------------------------------------ */
async function startSleepWatcherCron() {
  // Remove any existing repeat job first (idempotent)
  const existing = await sleepCheckQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === "sleep-check") {
      await sleepCheckQueue.removeRepeatableByKey(job.key);
    }
  }

  const intervalMs =
    parseInt(process.env.SLEEP_CHECK_INTERVAL_MINUTES || "5") * 60 * 1000;

  await sleepCheckQueue.add(
    "sleep-check",
    {},
    {
      repeat: { every: intervalMs },
      removeOnComplete: true,
    }
  );

  console.log(
    `[sleepWatcher] Cron scheduled: every ${intervalMs / 60000} minutes`
  );
}

module.exports = { sleepWatcher, startSleepWatcherCron };
