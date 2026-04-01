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
 *
 * IMPORTANT: Since K8s Ingress routes traffic directly to pods (bypassing
 * the Node.js sleepProxy middleware), we ALSO check the NGINX Ingress
 * controller's access logs for recent traffic to each subdomain. This
 * ensures we don't sleep containers that are actively receiving traffic.
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
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

// 15 minutes of inactivity → sleep
const INACTIVITY_TIMEOUT_MS =
  parseInt(process.env.SLEEP_INACTIVITY_MINUTES || "15") * 60 * 1000;

const INGRESS_NAMESPACE = "ingress-nginx";
const INGRESS_SELECTOR = "app.kubernetes.io/component=controller";
const { PROJECT_DOMAIN } = require("../Middleware/subdomainParser");

/* ------------------------------------------------------------------ */
/* Helper: Check NGINX Ingress access logs for recent traffic          */
/* Returns a Set of subdomains that had traffic in the last N minutes  */
/* ------------------------------------------------------------------ */
async function getActiveSubdomainsFromIngressLogs(sinceMinutes = 20) {
  const activeSubdomains = new Map(); // subdomain → latest timestamp

  try {
    // Find ingress controller pod(s)
    const pods = await coreV1.listNamespacedPod({
      namespace: INGRESS_NAMESPACE,
      labelSelector: INGRESS_SELECTOR,
    });

    if (!pods || !pods.items || pods.items.length === 0) {
      console.log("[sleepWatcher] ⚠ No ingress controller pods found, skipping log check");
      return activeSubdomains;
    }

    const sinceSeconds = sinceMinutes * 60;

    for (const pod of pods.items) {
      const podName = pod.metadata.name;

      try {
        // Read recent logs from ingress controller
        const logResponse = await coreV1.readNamespacedPodLog({
          name: podName,
          namespace: INGRESS_NAMESPACE,
          sinceSeconds,
          tailLines: 2000, // cap to prevent memory issues
        });

        const logText = typeof logResponse === "string" ? logResponse : (logResponse?.body || "");
        if (!logText) continue;

        const lines = logText.split("\n");

        for (const line of lines) {
          // NGINX Ingress default log format includes the host in the request
          // Format: IP - - [timestamp] "METHOD path HTTP/x.x" status ... "host" ...
          // Or the combined format has host embedded
          //
          // Common patterns to match:
          //   "Host: subdomain.localhost" or the host field in the log
          //   The NGINX ingress log format (by default) includes the $host field

          // Try to extract subdomain from the log line
          // NGINX ingress default log format:
          // <ip> - - [date] "request" status size "referer" "user-agent" <request_length> <request_time> [<upstream>] [<alt_upstream>] <response_length> <response_time> <status> <req_id>
          // But the host can appear differently. Let's look for *.PROJECT_DOMAIN pattern

          const hostRegex = new RegExp(`([a-z0-9][a-z0-9-]+)\\.${PROJECT_DOMAIN.replace(/\./g, "\\.")}`, "gi");
          const matches = line.match(hostRegex);

          if (matches) {
            for (const fullHost of matches) {
              const subdomain = fullHost.split(`.${PROJECT_DOMAIN}`)[0].toLowerCase();
              // Skip system subdomains
              if (subdomain === "www" || subdomain === "api" || subdomain === "admin") continue;

              // Use current time as the "last seen" since these logs are recent
              if (!activeSubdomains.has(subdomain)) {
                activeSubdomains.set(subdomain, new Date());
              }
            }
          }
        }
      } catch (logErr) {
        console.log(`[sleepWatcher] ⚠ Could not read logs from ${podName}: ${logErr.message}`);
      }
    }
  } catch (err) {
    console.log(`[sleepWatcher] ⚠ Ingress log check failed: ${err.message}`);
  }

  return activeSubdomains;
}

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

    /* ── Step 1: Check Ingress logs for actual traffic ──────────── */
    const activeFromIngress = await getActiveSubdomainsFromIngressLogs(20);
    
    if (activeFromIngress.size > 0) {
      console.log(
        `[sleepWatcher] Ingress logs show recent traffic for: ${[...activeFromIngress.keys()].join(", ")}`
      );

      // Update lastActivityAt for any subdomain that has real traffic
      for (const [subdomain, lastSeen] of activeFromIngress) {
        try {
          const project = await Project.findOne({
            where: { subdomain },
            attributes: ["id"],
          });

          if (project) {
            const [updatedCount] = await DockerInfo.update(
              { lastActivityAt: lastSeen },
              {
                where: {
                  ProjectId: project.id,
                  status: "running",
                  // Only update if the new timestamp is more recent
                  lastActivityAt: { [Op.lt]: lastSeen },
                },
              }
            );

            if (updatedCount > 0) {
              console.log(
                `[sleepWatcher] ✓ Updated lastActivityAt for ${subdomain} (traffic detected in ingress logs)`
              );
            }
          }
        } catch (updateErr) {
          console.error(
            `[sleepWatcher] Failed to update activity for ${subdomain}: ${updateErr.message}`
          );
        }
      }
    } else {
      console.log("[sleepWatcher] No recent traffic detected in ingress logs");
    }

    /* ── Step 2: Now do the normal idle check ───────────────────── */
    // Re-query with updated timestamps
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
