/**
 * jobsController.js
 * ─────────────────────────────────────────────────────────────────────
 * REST API controller for Kubernetes CronJob management.
 * Supports create, delete, suspend, resume, and execution history.
 * ─────────────────────────────────────────────────────────────────────
 */
const CronJobInstance = require("../../Models/Services/cronJobInstance");
const Project = require("../../Models/Projects/projects");
const { checkCronJobCreationAllowed } = require("../../Utils/planEnforcer");
const { buildCronJobResources } = require("../../Utils/kubeServiceBuilder");
const { ensureNamespace } = require("../../Utils/kubeClient");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const batchV1 = kc.makeApiClient(k8s.BatchV1Api);

/* ── POST /api/jobs/create ─────────────────────────────────────────── */
exports.createJob = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      projectId,
      name,
      schedule,
      command,
      image,
      resourceLimits,
      envVars,
    } = req.body;

    // Validation
    if (!projectId || !name || !schedule || !command || !image) {
      return res.status(400).json({
        success: false,
        message: "projectId, name, schedule, command, and image are required",
      });
    }

    // Validate cron expression (basic check)
    const cronParts = schedule.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      return res.status(400).json({
        success: false,
        message: "Invalid cron schedule format. Use standard 5-field cron: '* * * * *'",
      });
    }

    // Verify project
    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    // Enforce plan limits
    const enforcement = await checkCronJobCreationAllowed(userId);
    if (!enforcement.allowed) {
      return res.status(403).json({
        success: false,
        message: enforcement.reason,
      });
    }

    // Build K8s CronJob spec
    const namespace = `sarthiq-svc-${projectId}`;
    await ensureNamespace(namespace);

    const { cronJob, kubeResourceName } = buildCronJobResources({
      instanceId: Date.now(),
      namespace,
      projectId,
      name,
      schedule,
      command: Array.isArray(command) ? command : command.split(" "),
      image,
      resourceLimits: resourceLimits || { cpu: "100m", memory: "128Mi" },
      envVars: envVars || {},
    });

    // Create in K8s
    await batchV1.createNamespacedCronJob({ namespace, body: cronJob });

    // Create DB record
    const jobInstance = await CronJobInstance.create({
      UserId: userId,
      ProjectId: projectId,
      name,
      schedule,
      command: Array.isArray(command) ? command : command.split(" "),
      image,
      status: "active",
      resourceLimits: resourceLimits || { cpu: "100m", memory: "128Mi" },
      kubeResourceName,
      namespace,
    });

    return res.status(201).json({
      success: true,
      message: "CronJob created",
      data: {
        id: jobInstance.id,
        name: jobInstance.name,
        schedule: jobInstance.schedule,
        status: "active",
        kubeResourceName,
        namespace,
      },
    });
  } catch (err) {
    console.error("[jobsController] createJob error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create cron job",
      error: err.message,
    });
  }
};

/* ── DELETE /api/jobs/:id ──────────────────────────────────────────── */
exports.deleteJob = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const jobInstance = await CronJobInstance.findOne({
      where: { id, UserId: userId },
    });
    if (!jobInstance) {
      return res.status(404).json({
        success: false,
        message: "CronJob not found or access denied",
      });
    }

    // Delete from K8s
    if (jobInstance.kubeResourceName && jobInstance.namespace) {
      try {
        await batchV1.deleteNamespacedCronJob({
          name: jobInstance.kubeResourceName,
          namespace: jobInstance.namespace,
          body: { propagationPolicy: "Foreground" },
        });
      } catch (k8sErr) {
        console.warn("[jobsController] K8s CronJob delete warning:", k8sErr.message);
      }
    }

    await jobInstance.destroy();

    return res.json({
      success: true,
      message: "CronJob deleted",
    });
  } catch (err) {
    console.error("[jobsController] deleteJob error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to delete cron job",
      error: err.message,
    });
  }
};

/* ── GET /api/jobs/project/:projectId ──────────────────────────────── */
exports.listJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId } = req.params;

    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    const jobs = await CronJobInstance.findAll({
      where: { ProjectId: projectId, UserId: userId },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      success: true,
      data: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        command: j.command,
        image: j.image,
        status: j.status,
        lastRunAt: j.lastRunAt,
        lastRunStatus: j.lastRunStatus,
        resourceLimits: j.resourceLimits,
        createdAt: j.createdAt,
      })),
    });
  } catch (err) {
    console.error("[jobsController] listJobs error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to list cron jobs",
      error: err.message,
    });
  }
};

/* ── POST /api/jobs/:id/suspend ────────────────────────────────────── */
exports.suspendJob = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const jobInstance = await CronJobInstance.findOne({
      where: { id, UserId: userId, status: "active" },
    });
    if (!jobInstance) {
      return res.status(404).json({
        success: false,
        message: "Active CronJob not found",
      });
    }

    // Patch K8s CronJob to suspend
    const patch = [{ op: "replace", path: "/spec/suspend", value: true }];
    await batchV1.patchNamespacedCronJob(
      { name: jobInstance.kubeResourceName, namespace: jobInstance.namespace, body: patch },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/json-patch+json" } }
    );

    jobInstance.status = "suspended";
    await jobInstance.save();

    return res.json({
      success: true,
      message: "CronJob suspended",
    });
  } catch (err) {
    console.error("[jobsController] suspendJob error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to suspend cron job",
      error: err.message,
    });
  }
};

/* ── POST /api/jobs/:id/resume ─────────────────────────────────────── */
exports.resumeJob = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const jobInstance = await CronJobInstance.findOne({
      where: { id, UserId: userId, status: "suspended" },
    });
    if (!jobInstance) {
      return res.status(404).json({
        success: false,
        message: "Suspended CronJob not found",
      });
    }

    // Patch K8s CronJob to resume
    const patch = [{ op: "replace", path: "/spec/suspend", value: false }];
    await batchV1.patchNamespacedCronJob(
      { name: jobInstance.kubeResourceName, namespace: jobInstance.namespace, body: patch },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/json-patch+json" } }
    );

    jobInstance.status = "active";
    await jobInstance.save();

    return res.json({
      success: true,
      message: "CronJob resumed",
    });
  } catch (err) {
    console.error("[jobsController] resumeJob error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to resume cron job",
      error: err.message,
    });
  }
};

/* ── GET /api/jobs/:id/history ─────────────────────────────────────── */
exports.getJobHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const jobInstance = await CronJobInstance.findOne({
      where: { id, UserId: userId },
    });
    if (!jobInstance) {
      return res.status(404).json({
        success: false,
        message: "CronJob not found or access denied",
      });
    }

    // Get K8s Job history from the CronJob
    const history = [];
    try {
      const jobList = await batchV1.listNamespacedJob({
        namespace: jobInstance.namespace,
        labelSelector: `sarthiq.com/instanceId=${id}`,
      });

      for (const job of (jobList.items || [])) {
        const conditions = job.status?.conditions || [];
        const completedCondition = conditions.find((c) => c.type === "Complete");
        const failedCondition = conditions.find((c) => c.type === "Failed");

        history.push({
          name: job.metadata.name,
          startTime: job.status?.startTime,
          completionTime: job.status?.completionTime,
          succeeded: job.status?.succeeded || 0,
          failed: job.status?.failed || 0,
          status: completedCondition
            ? "completed"
            : failedCondition
              ? "failed"
              : "running",
        });
      }
    } catch (k8sErr) {
      console.warn("[jobsController] Job history K8s error:", k8sErr.message);
    }

    return res.json({
      success: true,
      data: {
        jobDetails: {
          id: jobInstance.id,
          name: jobInstance.name,
          schedule: jobInstance.schedule,
          status: jobInstance.status,
          lastRunAt: jobInstance.lastRunAt,
          lastRunStatus: jobInstance.lastRunStatus,
        },
        history,
      },
    });
  } catch (err) {
    console.error("[jobsController] getJobHistory error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get job history",
      error: err.message,
    });
  }
};
