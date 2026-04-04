/**
 * metricsController.js
 * ─────────────────────────────────────────────────────────────────────
 * REST API controller for CPU, memory, and pod status metrics.
 * Supports both project apps and infrastructure services.
 * ─────────────────────────────────────────────────────────────────────
 */
const Project = require("../../Models/Projects/projects");
const ServiceInstance = require("../../Models/Services/serviceInstance");
const { safeLabel, NAMESPACE } = require("../../Utils/kubeClient");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const metricsClient = new k8s.Metrics(kc);

/**
 * Get pod metrics and status for a given label selector in a namespace.
 */
async function getPodMetricsForSelector(namespace, labelSelector) {
  const results = [];

  // Get pod list for status
  const podList = await coreV1.listNamespacedPod({
    namespace,
    labelSelector,
  });

  const pods = podList.items || [];

  // Get metrics (may fail if metrics-server is not installed)
  let metricsMap = {};
  try {
    const allMetrics = await metricsClient.getPodMetrics(namespace);
    for (const item of allMetrics.items || []) {
      metricsMap[item.metadata.name] = item.containers.map((c) => ({
        name: c.name,
        cpuUsage: c.usage.cpu,
        memoryUsage: c.usage.memory,
      }));
    }
  } catch {
    // metrics-server not available — report status only
  }

  for (const pod of pods) {
    const podName = pod.metadata.name;
    const phase = pod.status?.phase || "Unknown";
    const conditions = pod.status?.conditions || [];
    const ready = conditions.find((c) => c.type === "Ready");
    const containerStatuses = pod.status?.containerStatuses || [];

    results.push({
      podName,
      phase,
      ready: ready?.status === "True",
      restartCount: containerStatuses.reduce(
        (sum, cs) => sum + (cs.restartCount || 0),
        0
      ),
      startedAt: pod.status?.startTime,
      metrics: metricsMap[podName] || null,
      containerStatuses: containerStatuses.map((cs) => ({
        name: cs.name,
        ready: cs.ready,
        restartCount: cs.restartCount,
        state: cs.state,
      })),
    });
  }

  return results;
}

/* ── GET /api/metrics/:projectId ───────────────────────────────────── */
exports.getProjectMetrics = async (req, res) => {
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

    if (!project.subdomain) {
      return res.json({
        success: true,
        data: { pods: [], message: "Project not deployed" },
      });
    }

    const label = safeLabel(project.subdomain);
    const pods = await getPodMetricsForSelector(NAMESPACE, `app=${label}`);

    return res.json({
      success: true,
      data: {
        projectId: parseInt(projectId),
        namespace: NAMESPACE,
        pods,
      },
    });
  } catch (err) {
    console.error("[metricsController] getProjectMetrics error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get metrics",
      error: err.message,
    });
  }
};

/* ── GET /api/metrics/service/:serviceInstanceId ───────────────────── */
exports.getServiceMetrics = async (req, res) => {
  try {
    const userId = req.user.id;
    const { serviceInstanceId } = req.params;

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
        message: "Metrics are not available for external services",
      });
    }

    const pods = await getPodMetricsForSelector(
      instance.namespace,
      `app=${instance.kubeResourceName}`
    );

    return res.json({
      success: true,
      data: {
        serviceInstanceId: parseInt(serviceInstanceId),
        serviceType: instance.instanceName,
        namespace: instance.namespace,
        status: instance.status,
        resourceLimits: instance.resourceUsage,
        pods,
      },
    });
  } catch (err) {
    console.error("[metricsController] getServiceMetrics error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get service metrics",
      error: err.message,
    });
  }
};
