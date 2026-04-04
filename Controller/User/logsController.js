/**
 * logsController.js
 * ─────────────────────────────────────────────────────────────────────
 * REST API controller for streaming pod logs.
 * Supports both project apps and infrastructure services.
 * Enforces log retention limits from UserPlan.
 * ─────────────────────────────────────────────────────────────────────
 */
const Project = require("../../Models/Projects/projects");
const ServiceInstance = require("../../Models/Services/serviceInstance");
const { getUserPlan } = require("../../Utils/planEnforcer");
const { safeLabel, NAMESPACE } = require("../../Utils/kubeClient");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

/**
 * Stream logs from pods matching a label selector.
 * Uses Server-Sent Events (SSE) for real-time streaming.
 */
async function streamPodLogs(res, namespace, labelSelector, tailLines, sinceSeconds) {
  try {
    // Find pods
    const podList = await coreV1.listNamespacedPod({
      namespace,
      labelSelector,
    });

    const pods = podList.items || [];
    if (pods.length === 0) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "No pods found" })}\n\n`);
      res.end();
      return;
    }

    // Stream logs from the first pod
    const podName = pods[0].metadata.name;

    res.write(
      `data: ${JSON.stringify({ type: "info", message: `Streaming logs from pod: ${podName}`, pod: podName })}\n\n`
    );

    try {
      const logResp = await coreV1.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines: tailLines || 100,
        ...(sinceSeconds && { sinceSeconds }),
      });

      const logText = typeof logResp === "string" ? logResp : logResp?.body || "";
      const lines = logText.split("\n").filter(Boolean);

      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ type: "log", line, pod: podName })}\n\n`);
      }
    } catch (logErr) {
      res.write(
        `data: ${JSON.stringify({ type: "error", message: `Log read error: ${logErr.message}` })}\n\n`
      );
    }

    res.write(`data: ${JSON.stringify({ type: "end", message: "Log stream complete" })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
    res.end();
  }
}

/* ── GET /api/logs/:projectId ──────────────────────────────────────── */
exports.getProjectLogs = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId } = req.params;
    const { tailLines, sinceSeconds } = req.query;

    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    // Enforce log retention
    const plan = await getUserPlan(userId);
    const maxSince = plan.logRetentionHours * 3600;
    const effectiveSince = sinceSeconds
      ? Math.min(parseInt(sinceSeconds), maxSince)
      : maxSince;

    // Cap tailLines to prevent memory blowup
    const effectiveTailLines = Math.min(parseInt(tailLines) || 200, 1000);

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (!project.subdomain) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Project not deployed" })}\n\n`);
      res.end();
      return;
    }

    const label = safeLabel(project.subdomain);
    await streamPodLogs(
      res,
      NAMESPACE,
      `app=${label}`,
      effectiveTailLines,
      effectiveSince
    );
  } catch (err) {
    console.error("[logsController] getProjectLogs error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to get logs",
        error: err.message,
      });
    }
  }
};

/* ── GET /api/logs/service/:serviceInstanceId ──────────────────────── */
exports.getServiceLogs = async (req, res) => {
  try {
    const userId = req.user.id;
    const { serviceInstanceId } = req.params;
    const { tailLines, sinceSeconds } = req.query;

    const instance = await ServiceInstance.findOne({
      where: { id: serviceInstanceId, UserId: userId },
    });
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Service not found or access denied",
      });
    }

    if (instance.isExternal) {
      return res.status(400).json({
        success: false,
        message: "Logs are not available for external services",
      });
    }

    // Enforce log retention
    const plan = await getUserPlan(userId);
    const maxSince = plan.logRetentionHours * 3600;
    const effectiveSince = sinceSeconds
      ? Math.min(parseInt(sinceSeconds), maxSince)
      : maxSince;

    const effectiveTailLines = Math.min(parseInt(tailLines) || 200, 1000);

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await streamPodLogs(
      res,
      instance.namespace,
      `app=${instance.kubeResourceName}`,
      effectiveTailLines,
      effectiveSince
    );
  } catch (err) {
    console.error("[logsController] getServiceLogs error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to get service logs",
        error: err.message,
      });
    }
  }
};
