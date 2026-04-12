/**
 * dataHygieneCron.js
 * ─────────────────────────────────────────────────────────────────────
 * Periodic data hygiene: clean orphaned records across Redis, DB,
 * and K8s that accumulate from crashes, partial deletes, and stale jobs.
 *
 * Runs every 30 minutes + once on startup.
 *
 * Cleanup targets:
 *   1. BullMQ — completed/failed jobs older than 24h
 *   2. BullMQ — stale "active" jobs with no matching project
 *   3. DB — DeploymentJobs stuck in queued/building > 30 min
 *   4. DB — ServiceInstances stuck in provisioning > 30 min
 *   5. DB — Orphaned ServiceInstances pointing to deleted projects
 *   6. DB — Orphaned EnvVars pointing to deleted projects
 *   7. DB — Orphaned CronJobInstances pointing to deleted projects
 *   8. K8s — Namespaces in "project-{id}" pattern with no matching project
 * ─────────────────────────────────────────────────────────────────────
 */

const cron = require("node-cron");
const { Op } = require("sequelize");

const Project = require("../Models/Projects/projects");
const DockerInfo = require("../Models/Projects/dockerInfo");
const DeploymentJob = require("../Models/Deployment/deploymentJob");
const ServiceInstance = require("../Models/Services/serviceInstance");
const EnvironmentVariable = require("../Models/Services/environmentVariable");
const CronJobInstance = require("../Models/Services/cronJobInstance");
const { deployQueue, wakeQueue, serviceQueue } = require("./queues");

const LOG = "[dataHygiene]";

/* ── Core cleanup logic ────────────────────────────────────────────── */

async function runDataHygiene() {
  console.log(`${LOG} Starting data hygiene sweep...`);

  const stats = {
    bullmqCleaned: 0,
    staleDeployJobs: 0,
    staleServiceJobs: 0,
    orphanedServices: 0,
    orphanedEnvVars: 0,
    orphanedCronJobs: 0,
    orphanedNamespaces: 0,
  };

  // ── 1. Clean old BullMQ completed/failed jobs (> 24h) ─────────────
  try {
    const GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours
    for (const queue of [deployQueue, wakeQueue, serviceQueue]) {
      const qName = queue.name;
      try {
        const completedCleaned = await queue.clean(GRACE_MS, 500, "completed");
        const failedCleaned = await queue.clean(GRACE_MS, 500, "failed");
        const total = (completedCleaned?.length || 0) + (failedCleaned?.length || 0);
        stats.bullmqCleaned += total;
        if (total > 0) {
          console.log(`${LOG}   ${qName}: cleaned ${total} old jobs from Redis`);
        }
      } catch (qErr) {
        console.warn(`${LOG}   ${qName}: cleanup failed — ${qErr.message}`);
      }
    }
  } catch (err) {
    console.error(`${LOG} BullMQ cleanup error:`, err.message);
  }

  // ── 2. Clean stale BullMQ jobs that reference non-existent projects ─
  try {
    for (const queue of [deployQueue, wakeQueue]) {
      const allJobs = await queue.getJobs(["active", "waiting", "delayed"]);
      for (const job of allJobs) {
        const pid = job.data?.projectId;
        if (!pid) continue;
        const project = await Project.findByPk(pid);
        if (!project) {
          await job.remove().catch(() => {});
          stats.bullmqCleaned++;
          console.log(`${LOG}   Removed orphaned ${queue.name} job ${job.id} (project #${pid} deleted)`);
        }
      }
    }
  } catch (err) {
    console.error(`${LOG} Orphaned BullMQ job cleanup error:`, err.message);
  }

  // ── 3. Fail stuck DeploymentJobs (queued/building > 30 min) ───────
  try {
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const [affectedCount] = await DeploymentJob.update(
      {
        status: "failed",
        errorMessage: "Auto-failed by data hygiene: stuck for over 30 minutes",
        completedAt: new Date(),
      },
      {
        where: {
          status: { [Op.in]: ["queued", "building"] },
          createdAt: { [Op.lt]: staleThreshold },
        },
      }
    );
    stats.staleDeployJobs = affectedCount;
    if (affectedCount > 0) {
      console.log(`${LOG}   Marked ${affectedCount} stale deployment jobs as failed`);
    }
  } catch (err) {
    console.error(`${LOG} Stale deploy job cleanup error:`, err.message);
  }

  // ── 4. Fix stuck ServiceInstances (provisioning > 30 min) ─────────
  try {
    const svcThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const [affectedCount] = await ServiceInstance.update(
      {
        status: "failed",
        errorMessage: "Auto-failed by data hygiene: provisioning stuck for over 30 minutes",
      },
      {
        where: {
          status: "provisioning",
          createdAt: { [Op.lt]: svcThreshold },
        },
      }
    );
    stats.staleServiceJobs = affectedCount;
    if (affectedCount > 0) {
      console.log(`${LOG}   Marked ${affectedCount} stuck service provisions as failed`);
    }
  } catch (err) {
    console.error(`${LOG} Stuck service cleanup error:`, err.message);
  }

  // ── 5. Clean orphaned ServiceInstances (project deleted) ──────────
  try {
    // Find service instances whose ProjectId is not null but project doesn't exist
    const allServices = await ServiceInstance.findAll({
      where: { ProjectId: { [Op.ne]: null } },
      attributes: ["id", "ProjectId", "instanceName"],
    });
    const orphanIds = [];
    for (const svc of allServices) {
      const proj = await Project.findByPk(svc.ProjectId);
      if (!proj) orphanIds.push(svc.id);
    }
    if (orphanIds.length > 0) {
      // Detach from deleted project (make standalone) rather than deleting
      await ServiceInstance.update(
        { ProjectId: null },
        { where: { id: { [Op.in]: orphanIds } } }
      );
      stats.orphanedServices = orphanIds.length;
      console.log(`${LOG}   Detached ${orphanIds.length} services from deleted projects`);
    }
  } catch (err) {
    console.error(`${LOG} Orphaned service cleanup error:`, err.message);
  }

  // ── 6. Clean orphaned EnvironmentVariables ────────────────────────
  try {
    const allEnvVars = await EnvironmentVariable.findAll({
      where: { ProjectId: { [Op.ne]: null } },
      attributes: ["id", "ProjectId"],
    });
    const orphanIds = [];
    for (const ev of allEnvVars) {
      const proj = await Project.findByPk(ev.ProjectId);
      if (!proj) orphanIds.push(ev.id);
    }
    if (orphanIds.length > 0) {
      await EnvironmentVariable.destroy({ where: { id: { [Op.in]: orphanIds } } });
      stats.orphanedEnvVars = orphanIds.length;
      console.log(`${LOG}   Deleted ${orphanIds.length} orphaned env vars`);
    }
  } catch (err) {
    console.error(`${LOG} Orphaned env var cleanup error:`, err.message);
  }

  // ── 7. Clean orphaned CronJobInstances ────────────────────────────
  try {
    const allCrons = await CronJobInstance.findAll({
      where: { ProjectId: { [Op.ne]: null } },
      attributes: ["id", "ProjectId"],
    });
    const orphanIds = [];
    for (const cj of allCrons) {
      const proj = await Project.findByPk(cj.ProjectId);
      if (!proj) orphanIds.push(cj.id);
    }
    if (orphanIds.length > 0) {
      await CronJobInstance.destroy({ where: { id: { [Op.in]: orphanIds } } });
      stats.orphanedCronJobs = orphanIds.length;
      console.log(`${LOG}   Deleted ${orphanIds.length} orphaned cron jobs`);
    }
  } catch (err) {
    console.error(`${LOG} Orphaned cron job cleanup error:`, err.message);
  }

  // ── 8. Clean orphaned K8s namespaces ──────────────────────────────
  // Legacy: services used to be provisioned in project-{id} and sarthiq-svc-{id}
  // namespaces. Now all workloads go to sarthiq-apps. Clean up orphans.
  try {
    const k8s = require("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

    const nsList = await coreV1.listNamespace();
    const namespaces = (nsList.items || []).map((ns) => ns.metadata.name);

    // Match both legacy patterns: project-{id} and sarthiq-svc-{id}
    const legacyNs = namespaces.filter((ns) =>
      /^project-\d+$/.test(ns) || /^sarthiq-svc-\d+$/.test(ns)
    );
    for (const ns of legacyNs) {
      const idMatch = ns.match(/(\d+)$/);
      const projId = idMatch ? parseInt(idMatch[1]) : null;
      const project = projId ? await Project.findByPk(projId) : null;
      if (!project) {
        // Project doesn't exist — this namespace is orphaned
        try {
          const { deleteNamespace } = require("../Utils/kubeClient");
          await deleteNamespace(ns);
          stats.orphanedNamespaces++;
          console.log(`${LOG}   Deleted orphaned namespace ${ns}`);
        } catch (nsErr) {
          console.warn(`${LOG}   Failed to delete namespace ${ns}: ${nsErr.message}`);
        }
      }
    }
  } catch (err) {
    // K8s might not be accessible — non-fatal
    console.warn(`${LOG} K8s namespace cleanup skipped: ${err.message}`);
  }

  // ── 9. Clean orphaned K8s workloads in sarthiq-apps ────────────────
  // Safety net: delete Deployments/StatefulSets/Services that have our
  // managed-by=sarthiq label but no matching DB record.
  try {
    const { NAMESPACE } = require("../Utils/kubeClient");
    const k8s = require("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

    // Check orphaned service StatefulSets/Deployments
    const svcLabel = "sarthiq.com/component=service";

    // StatefulSets
    try {
      const ssList = await appsV1.listNamespacedStatefulSet({ namespace: NAMESPACE, labelSelector: svcLabel });
      for (const ss of (ssList.items || [])) {
        const instanceId = ss.metadata?.labels?.["sarthiq.com/instanceId"];
        if (!instanceId) continue;
        const dbRecord = await ServiceInstance.findByPk(parseInt(instanceId));
        if (!dbRecord) {
          console.log(`${LOG}   Orphaned StatefulSet '${ss.metadata.name}' (instanceId=${instanceId}) — deleting...`);
          await appsV1.deleteNamespacedStatefulSet({
            name: ss.metadata.name,
            namespace: NAMESPACE,
            body: { propagationPolicy: "Foreground" },
          }).catch((e) => console.warn(`${LOG}   Failed to delete SS '${ss.metadata.name}': ${e.message}`));
          stats.orphanedNamespaces++;
        }
      }
    } catch (ssErr) {
      console.warn(`${LOG}   StatefulSet scan error: ${ssErr.message}`);
    }

    // Deployments (only service-type, not project deployments)
    try {
      const depList = await appsV1.listNamespacedDeployment({ namespace: NAMESPACE, labelSelector: svcLabel });
      for (const dep of (depList.items || [])) {
        const instanceId = dep.metadata?.labels?.["sarthiq.com/instanceId"];
        if (!instanceId) continue;
        const dbRecord = await ServiceInstance.findByPk(parseInt(instanceId));
        if (!dbRecord) {
          console.log(`${LOG}   Orphaned Deployment '${dep.metadata.name}' (instanceId=${instanceId}) — deleting...`);
          await appsV1.deleteNamespacedDeployment({
            name: dep.metadata.name,
            namespace: NAMESPACE,
            body: { propagationPolicy: "Foreground" },
          }).catch((e) => console.warn(`${LOG}   Failed to delete Dep '${dep.metadata.name}': ${e.message}`));
          stats.orphanedNamespaces++;
        }
      }
    } catch (depErr) {
      console.warn(`${LOG}   Deployment scan error: ${depErr.message}`);
    }

    // Orphaned K8s Services for deleted service instances
    try {
      const k8sSvcList = await coreV1.listNamespacedService({ namespace: NAMESPACE, labelSelector: svcLabel });
      for (const svc of (k8sSvcList.items || [])) {
        const instanceId = svc.metadata?.labels?.["sarthiq.com/instanceId"];
        if (!instanceId) continue;
        const dbRecord = await ServiceInstance.findByPk(parseInt(instanceId));
        if (!dbRecord) {
          console.log(`${LOG}   Orphaned K8s Service '${svc.metadata.name}' — deleting...`);
          await coreV1.deleteNamespacedService({
            name: svc.metadata.name,
            namespace: NAMESPACE,
          }).catch((e) => console.warn(`${LOG}   Failed to delete Service '${svc.metadata.name}': ${e.message}`));
        }
      }
    } catch (svcErr) {
      console.warn(`${LOG}   Service scan error: ${svcErr.message}`);
    }

    // Orphaned project Deployments (not service-type)
    try {
      const projectLabel = "managed-by=sarthiq";
      const allDeps = await appsV1.listNamespacedDeployment({ namespace: NAMESPACE, labelSelector: projectLabel });
      for (const dep of (allDeps.items || [])) {
        // Skip service deployments (already handled above)
        if (dep.metadata?.labels?.["sarthiq.com/component"] === "service") continue;
        const depName = dep.metadata.name;
        // Check if any project has this subdomain (slug = deployment name)
        const matchingProject = await Project.findOne({
          where: { subdomain: depName },
        });
        if (!matchingProject) {
          // Also check by safeLabel pattern — could be a different format
          const matchByLabel = await Project.findOne({
            where: { subdomain: depName.replace(/-\d+$/, '') },
          });
          if (!matchByLabel) {
            console.log(`${LOG}   Orphaned project Deployment '${depName}' — deleting...`);
            await appsV1.deleteNamespacedDeployment({
              name: depName,
              namespace: NAMESPACE,
              body: { propagationPolicy: "Foreground" },
            }).catch((e) => console.warn(`${LOG}   Failed to delete '${depName}': ${e.message}`));
            stats.orphanedNamespaces++;
          }
        }
      }
    } catch (projErr) {
      console.warn(`${LOG}   Project deployment scan error: ${projErr.message}`);
    }
  } catch (err) {
    console.warn(`${LOG} K8s orphan workload cleanup skipped: ${err.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(`${LOG} ✅ Sweep complete: ${JSON.stringify(stats)}`);
  } else {
    console.log(`${LOG} ✅ Sweep complete — everything clean.`);
  }

  return stats;
}

/* ── Cron scheduler ────────────────────────────────────────────────── */

function startDataHygieneCron() {
  // Run once on startup (after a short delay to let DB sync finish)
  setTimeout(() => {
    runDataHygiene().catch((err) => {
      console.error(`${LOG} Startup sweep failed:`, err.message);
    });
  }, 15_000); // 15s delay after boot

  // Schedule every 30 minutes
  cron.schedule("*/30 * * * *", () => {
    runDataHygiene().catch((err) => {
      console.error(`${LOG} Scheduled sweep failed:`, err.message);
    });
  });

  console.log(`${LOG} Scheduled: every 30 minutes + startup.`);
}

module.exports = { startDataHygieneCron, runDataHygiene };
