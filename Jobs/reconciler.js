/**
 * reconciler.js
 * ─────────────────────────────────────────────────────────────────────
 * Startup reconciler: syncs DB state with actual Kubernetes cluster state.
 *
 * WHY: When Docker Desktop / minikube restarts, all K8s deployments and
 * pods are destroyed. But the MySQL DB still has DockerInfo.status = "running".
 * This causes cascading failures:
 *   - sleepProxy sends traffic to non-existent services → 502
 *   - sleepWatcher tries to scale non-existent deployments → 404
 *   - containerService can't find pods → "no running pod found"
 *   - Metrics calls fail because pods don't exist
 *
 * FIX: On every app startup this reconciler:
 *   1. Finds ALL DockerInfo records with status "running" or "building"
 *   2. Checks if the corresponding K8s deployment actually exists
 *   3. If NOT → marks the DB record as "sleeping" so users can re-wake
 *   4. If deployment exists but has 0 ready replicas → marks as "sleeping"
 *
 * WHEN: Called once during bootstrap(), BEFORE BullMQ workers start.
 * ─────────────────────────────────────────────────────────────────────
 */
const { Op } = require("sequelize");
const k8s = require("@kubernetes/client-node");

const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const { safeLabel, NAMESPACE } = require("../Utils/kubeClient");

// Create a dedicated K8s client for the reconciler
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

/**
 * Check if a K8s deployment exists and has ready replicas.
 *
 * @param {string} deploymentName - the safeLabel'd name
 * @returns {{ exists: boolean, readyReplicas: number }}
 */
async function checkDeploymentHealth(deploymentName) {
  try {
    const dep = await appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace: NAMESPACE,
    });
    return {
      exists: true,
      readyReplicas: dep.status?.readyReplicas || 0,
      replicas: dep.spec?.replicas || 0,
    };
  } catch (err) {
    // 404 = deployment doesn't exist
    if (
      err.statusCode === 404 ||
      err?.response?.statusCode === 404 ||
      err?.body?.code === 404
    ) {
      return { exists: false, readyReplicas: 0, replicas: 0 };
    }
    // Other errors (network, auth) — log but treat as "can't verify"
    console.warn(
      `[reconciler] ⚠ Could not check deployment '${deploymentName}': ${err.message}`
    );
    return { exists: false, readyReplicas: 0, replicas: 0 };
  }
}

/**
 * Reconcile DB state with K8s cluster state.
 * Call this once at startup, BEFORE BullMQ workers start processing.
 */
async function reconcileOnStartup() {
  console.log("\n[reconciler] 🔄 Starting DB ↔ K8s state reconciliation...");

  // Find all records the DB thinks are "active"
  const activeStatuses = ["running", "building", "queued"];
  const activeDockers = await DockerInfo.findAll({
    where: {
      status: { [Op.in]: activeStatuses },
    },
    include: [{ model: Project, attributes: ["id", "subdomain", "title"] }],
  });

  if (activeDockers.length === 0) {
    console.log("[reconciler] ✓ No active containers in DB. Nothing to reconcile.");
    return { corrected: 0, verified: 0, total: 0 };
  }

  console.log(
    `[reconciler] Found ${activeDockers.length} DB record(s) with active status. Verifying against K8s...`
  );

  let corrected = 0;
  let verified = 0;
  const corrections = [];

  for (const docker of activeDockers) {
    const project = docker.Project;

    // Skip if no project or no subdomain (can't look up K8s resources)
    if (!project?.subdomain) {
      console.log(
        `[reconciler]   ⚠ DockerInfo #${docker.id} has no project/subdomain. Marking as failed.`
      );
      docker.status = "failed";
      await docker.save();
      corrected++;
      corrections.push({
        id: docker.id,
        project: "unknown",
        from: docker.status,
        to: "failed",
        reason: "No project/subdomain",
      });
      continue;
    }

    const label = safeLabel(project.subdomain);
    const health = await checkDeploymentHealth(label);

    if (!health.exists) {
      // Deployment doesn't exist in K8s — mark as sleeping
      const oldStatus = docker.status;
      docker.status = "sleeping";
      await docker.save();
      corrected++;
      corrections.push({
        id: docker.id,
        project: project.subdomain,
        from: oldStatus,
        to: "sleeping",
        reason: "K8s deployment not found",
      });
      console.log(
        `[reconciler]   ✗ ${project.subdomain}: ${oldStatus} → sleeping (deployment not found in K8s)`
      );
    } else if (health.readyReplicas === 0 && health.replicas === 0) {
      // Deployment exists but scaled to 0 (was sleeping in K8s)
      const oldStatus = docker.status;
      docker.status = "sleeping";
      await docker.save();
      corrected++;
      corrections.push({
        id: docker.id,
        project: project.subdomain,
        from: oldStatus,
        to: "sleeping",
        reason: "Deployment scaled to 0",
      });
      console.log(
        `[reconciler]   ✗ ${project.subdomain}: ${oldStatus} → sleeping (deployment scaled to 0)`
      );
    } else if (health.readyReplicas === 0 && health.replicas > 0) {
      // Deployment exists, has desired replicas, but none are ready yet
      // This could be a pod that's still starting — leave it but log
      console.log(
        `[reconciler]   ⏳ ${project.subdomain}: deployment exists (${health.replicas} desired, 0 ready) — waiting for pod startup`
      );
      verified++;
    } else {
      // Deployment exists and has ready replicas — DB state is correct
      // Refresh lastActivityAt to prevent immediate sleep
      docker.lastActivityAt = new Date();
      await docker.save();
      verified++;
      console.log(
        `[reconciler]   ✓ ${project.subdomain}: verified running (${health.readyReplicas} ready replicas)`
      );
    }
  }

  // Also clean up stale deployment jobs stuck in "building" or "queued"
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000); // 15 min
  const DeploymentJob = require("../Models/Deployment/deploymentJob");
  const staleJobs = await DeploymentJob.update(
    {
      status: "failed",
      errorMessage: "Auto-cleaned by startup reconciler: job was stale after system restart",
      completedAt: new Date(),
    },
    {
      where: {
        status: { [Op.in]: ["queued", "building"] },
        createdAt: { [Op.lt]: staleThreshold },
      },
    }
  );

  const staleCleaned = staleJobs[0] || 0;
  if (staleCleaned > 0) {
    console.log(`[reconciler]   🧹 Cleaned ${staleCleaned} stale deployment job(s)`);
  }

  console.log(
    `[reconciler] ✅ Reconciliation complete: ${corrected} corrected, ${verified} verified, ${staleCleaned} stale jobs cleaned`
  );

  if (corrections.length > 0) {
    console.log("[reconciler] Corrections applied:");
    corrections.forEach((c) =>
      console.log(`   ${c.project}: ${c.from} → ${c.to} (${c.reason})`)
    );
  }

  console.log("");

  return { corrected, verified, staleCleaned, total: activeDockers.length };
}

module.exports = { reconcileOnStartup };
