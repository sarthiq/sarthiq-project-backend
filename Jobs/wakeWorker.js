/**
 * wakeWorker.js
 * BullMQ Worker that handles on-demand wake-up of sleeping containers.
 *
 * Triggered by:
 *   1. sleepProxy.js – when a request hits a sleeping subdomain
 *   2. Frontend "Wake" button via wakeProject mutation
 *
 * Flow:
 *   1. Verify container is actually sleeping
 *   2. Check capacity for the original node (re-reserve)
 *   3. Scale K8s deployment from 0 → 1
 *   4. Wait for pod ready
 *   5. Update DB status → 'running'
 */
const { Worker } = require("bullmq");
const { Op } = require("sequelize");
const { connection } = require("./queues");
const { deployQueue } = require("./queues");
const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const DeploymentJob = require("../Models/Deployment/deploymentJob");
const KubeNode = require("../Models/Deployment/kubeNode");
const { scaleDeployment, waitForReady } = require("../Utils/kubeClient");
const { reserveNode, getBestNode } = require("../Utils/nodeManager");

const wakeWorker = new Worker(
  "wakeQueue",
  async (job) => {
    const { projectId, deploymentJobId } = job.data;

    const project = await Project.findByPk(projectId);
    const dockerInfo = await DockerInfo.findOne({
      where: { ProjectId: projectId },
    });

    if (!project || !dockerInfo) {
      throw new Error("Project or DockerInfo not found for wake job");
    }

    // Load the tracking job record if provided
    const jobRecord = deploymentJobId
      ? await DeploymentJob.findByPk(deploymentJobId)
      : null;

    const logLine = (msg) => {
      console.log(`[wakeWorker] ${msg}`);
      if (jobRecord) {
        jobRecord.logs = (jobRecord.logs || "") + `[WAKE] ${msg}\n`;
        jobRecord.save().catch(() => {});
      }
    };

    // Guard: only wake sleeping containers
    if (!["sleeping", "failed"].includes(dockerInfo.status)) {
      logLine(`Container ${project.subdomain} is not sleeping (status: ${dockerInfo.status}). Skipping.`);
      return { skipped: true };
    }

    try {
      dockerInfo.status = "building"; // interim status while waking
      await dockerInfo.save();

      if (jobRecord) {
        jobRecord.status = "building";
        jobRecord.startedAt = new Date();
        await jobRecord.save();
      }

      /* ---- Reserve node capacity ------------------------------------ */
      let nodeId = null;
      if (dockerInfo.nodeId) {
        // Try to reuse same node
        const node = await KubeNode.findOne({
          where: { nodeName: dockerInfo.nodeId },
        });
        if (node) {
          nodeId = node.id;
          await reserveNode(node.id);
          logLine(`Re-assigned to original node: ${dockerInfo.nodeId}`);
        }
      }

      // Fallback: pick any available node
      if (!nodeId) {
        const bestNode = await getBestNode();
        nodeId = bestNode.id;
        await reserveNode(bestNode.id);
        dockerInfo.nodeId = bestNode.nodeName;
        logLine(`Assigned to new node: ${bestNode.nodeName}`);
      }

      /* ---- Scale K8s deployment to 1 ------------------------------- */
      logLine(`Scaling ${project.subdomain} from 0 → 1 replica...`);
      try {
        await scaleDeployment(project.subdomain, 1);
      } catch (scaleErr) {
        // If deployment doesn't exist in K8s (404), fall back to full redeploy
        const is404 = scaleErr.statusCode === 404 ||
          scaleErr?.response?.statusCode === 404 ||
          (scaleErr.message && scaleErr.message.includes("not found"));

        if (is404) {
          logLine(`⚠ K8s Deployment not found. Checking recent failures before re-deploy...`);

          // ── Circuit breaker: Don't re-deploy if we failed recently ──
          // This prevents an infinite loop when infra is broken:
          //   wake → 404 → re-deploy → fail → wake → 404 → re-deploy ...
          const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
          const recentFailure = await DeploymentJob.findOne({
            where: {
              ProjectId: project.id,
              status: 'failed',
              completedAt: { [Op.gt]: new Date(Date.now() - COOLDOWN_MS) },
            },
            order: [['completedAt', 'DESC']],
          });

          if (recentFailure) {
            logLine(
              `⚠ Skipping re-deploy: project failed ${Math.round((Date.now() - recentFailure.completedAt) / 60000)} min ago. ` +
              `Error was: ${(recentFailure.errorMessage || 'unknown').slice(0, 100)}. ` +
              `Will retry after cooldown (${COOLDOWN_MS / 60000} min).`
            );
            dockerInfo.status = "failed";
            await dockerInfo.save();

            if (jobRecord) {
              jobRecord.status = "failed";
              jobRecord.errorMessage = `Wake skipped: recent deploy failure (cooldown ${COOLDOWN_MS / 60000} min)`;
              jobRecord.completedAt = new Date();
              await jobRecord.save();
            }

            return { skipped: true, reason: 'recent_failure', subdomain: project.subdomain };
          }

          logLine(`No recent failures. Proceeding with full re-deploy...`);

          // Reset status so deploy worker can pick it up
          dockerInfo.status = "queued";
          await dockerInfo.save();

          if (jobRecord) {
            jobRecord.status = "queued";
            jobRecord.logs = (jobRecord.logs || "") + "[WAKE] No K8s deployment found. Re-deploying from scratch...\n";
            await jobRecord.save();
          }

          // Enqueue a full deploy
          const userId = jobRecord?.UserId || null;
          const newDbJob = await require("../Models/Deployment/deploymentJob").create({
            ProjectId: parseInt(project.id),
            UserId: userId,
            status: "queued",
            logs: "[DEPLOY] Auto-triggered by wake fallback\n",
          });

          await deployQueue.add("deploy", {
            projectId: parseInt(project.id),
            deploymentJobId: newDbJob.id,
            userId,
          }, { jobId: `deploy-${project.id}-${newDbJob.id}` });

          logLine(`✅ Redeploy job enqueued (job #${newDbJob.id}).`);
          return { redeployed: true, subdomain: project.subdomain };
        }

        throw scaleErr; // rethrow non-404 errors
      }

      /* ---- Wait for pod ready -------------------------------------- */
      logLine("Waiting for pod to become ready...");
      await waitForReady(project.subdomain, 120_000); // 2 min timeout

      /* ---- Update DB ----------------------------------------------- */
      dockerInfo.status = "running";
      dockerInfo.lastActivityAt = new Date();
      await dockerInfo.save();

      if (jobRecord) {
        jobRecord.status = "done";
        jobRecord.completedAt = new Date();
        await jobRecord.save();
      }

      logLine(`✅ ${project.subdomain} is awake and serving traffic!`);
      return { success: true, subdomain: project.subdomain };
    } catch (err) {
      logLine(`❌ Wake failed: ${err.message}`);

      // Revert to sleeping on failure (it's still scaled down)
      dockerInfo.status = "sleeping";
      await dockerInfo.save();

      if (jobRecord) {
        jobRecord.status = "failed";
        jobRecord.errorMessage = err.message;
        jobRecord.completedAt = new Date();
        await jobRecord.save();
      }

      throw err;
    }
  },
  {
    connection,
    concurrency: parseInt(process.env.WAKE_CONCURRENCY || "10"),
  }
);

wakeWorker.on("completed", (job) =>
  console.log(`[wakeWorker] Job ${job.id} completed`)
);
wakeWorker.on("failed", (job, err) =>
  console.error(`[wakeWorker] Job ${job?.id} failed: ${err.message}`)
);

module.exports = wakeWorker;
