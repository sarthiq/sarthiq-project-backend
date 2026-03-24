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

const { connection, sleepCheckQueue } = require("./queues");
const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const { scaleDeployment } = require("../Utils/kubeClient");
const { releaseNode } = require("../Utils/nodeManager");
const KubeNode = require("../Models/Deployment/kubeNode");

// 15 minutes of inactivity → sleep
const INACTIVITY_TIMEOUT_MS =
  parseInt(process.env.SLEEP_INACTIVITY_MINUTES || "15") * 60 * 1000;

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
        console.error(
          `[sleepWatcher] Failed to sleep ${project.subdomain}: ${err.message}`
        );
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
