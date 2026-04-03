const { getNodes, getPods, getNodeMetrics, getPodMetrics } = require("../../Utils/kubeClient");
const Project = require("../../Models/Projects/projects");

/* ── Parsing helpers ────────────────────────────────────────────────── */
function parseCpuToMillicores(cpu) {
  if (!cpu) return 0;
  const str = String(cpu);
  if (str.endsWith("m")) return parseInt(str);
  if (str.endsWith("n")) return Math.round(parseInt(str) / 1_000_000);
  return Math.round(parseFloat(str) * 1000);
}

function parseMemoryToMi(mem) {
  if (!mem) return 0;
  const str = String(mem);
  if (str.endsWith("Ki")) return Math.round(parseInt(str) / 1024);
  if (str.endsWith("Mi")) return parseInt(str);
  if (str.endsWith("Gi")) return parseInt(str) * 1024;
  if (str.endsWith("Ti")) return parseInt(str) * 1024 * 1024;
  return Math.round(parseInt(str) / (1024 * 1024));
}

function parseStorageToGi(raw) {
  if (!raw) return 0;
  const str = String(raw).trim();
  if (/^\d+Ki$/i.test(str)) return parseFloat((parseInt(str) / (1024 * 1024)).toFixed(2));
  if (/^\d+Mi$/i.test(str)) return parseFloat((parseInt(str) / 1024).toFixed(2));
  if (/^\d+Gi$/i.test(str)) return parseFloat(str);
  if (/^\d+Ti$/i.test(str)) return parseInt(str) * 1024;
  // raw bytes
  return parseFloat((parseInt(str) / (1024 * 1024 * 1024)).toFixed(2));
}

function formatCpu(raw) { return `${parseCpuToMillicores(raw)}m`; }
function formatMem(raw) { return `${parseMemoryToMi(raw)}Mi`; }
function formatStorage(raw) {
  const gi = parseStorageToGi(raw);
  return gi >= 1 ? `${gi.toFixed(1)}Gi` : `${Math.round(gi * 1024)}Mi`;
}

const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease", "ingress-nginx", "default", "cert-manager"];

/* ── GET /admin/k8s/nodes ───────────────────────────────────────────── */
exports.getAdminNodes = async (req, res) => {
  try {
    const k8sNodes = await getNodes();
    const metrics = await getNodeMetrics();
    const allPods = await getPods();

    const nodes = k8sNodes.map((node) => {
      const metric = metrics.find(m => m.nodeName === node.metadata.name);

      const allocCpu = parseCpuToMillicores(node.status?.allocatable?.cpu);
      const allocMem = parseMemoryToMi(node.status?.allocatable?.memory);
      const usageCpu = parseCpuToMillicores(metric?.cpuUsage || "0");
      const usageMem = parseMemoryToMi(metric?.memUsage || "0");
      const allocStorageRaw = node.status?.allocatable?.["ephemeral-storage"] || "0";
      const capacityStorageRaw = node.status?.capacity?.["ephemeral-storage"] || "0";
      const allocStorageGi = parseStorageToGi(allocStorageRaw);
      const capacityStorageGi = parseStorageToGi(capacityStorageRaw);
      const capacityPods = parseInt(node.status?.allocatable?.pods || "110");

      const readyCondition = (node.status?.conditions || []).find(c => c.type === "Ready");
      const pressureConditions = (node.status?.conditions || []).filter(
        c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"
      ).map(c => c.type);
      const status = readyCondition?.status === "True" ? "Ready" : "NotReady";

      // Count pods on this node
      const nodePods = allPods.filter(p => p.spec?.nodeName === node.metadata.name);

      return {
        name: node.metadata.name,
        status,
        pressures: pressureConditions,
        roles: Object.keys(node.metadata?.labels || {})
          .filter(l => l.startsWith("node-role.kubernetes.io/"))
          .map(l => l.replace("node-role.kubernetes.io/", "")),
        allocatable: {
          cpu: `${allocCpu}m`,
          memory: `${allocMem}Mi`,
          storage: formatStorage(allocStorageRaw),
          storageGi: allocStorageGi,
          pods: capacityPods,
        },
        capacity: {
          storage: formatStorage(capacityStorageRaw),
          storageGi: capacityStorageGi,
        },
        usage: {
          cpu: `${usageCpu}m`,
          memory: `${usageMem}Mi`,
        },
        usagePercent: {
          cpu: allocCpu > 0 ? Math.min(100, Math.round((usageCpu / allocCpu) * 100)) : 0,
          memory: allocMem > 0 ? Math.min(100, Math.round((usageMem / allocMem) * 100)) : 0,
          pods: capacityPods > 0 ? Math.round((nodePods.length / capacityPods) * 100) : 0,
        },
        podsCount: nodePods.length,
        osImage: node.status?.nodeInfo?.osImage || "N/A",
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion || "N/A",
        containerRuntime: node.status?.nodeInfo?.containerRuntimeVersion || "N/A",
        architecture: node.status?.nodeInfo?.architecture || "N/A",
      };
    });

    res.status(200).json({ success: true, nodes });
  } catch (error) {
    console.error("[k8sController] getAdminNodes Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ── GET /admin/k8s/pods ────────────────────────────────────────────── */
exports.getAdminPods = async (req, res) => {
  try {
    const k8sPods = await getPods();
    const metrics = await getPodMetrics();

    const pods = k8sPods.map((pod) => {
      const metric = metrics.find(m => m.podName === pod.metadata?.name && m.namespace === pod.metadata?.namespace);

      let cpuUsage = 0;
      let memUsage = 0;
      if (metric && metric.containers) {
        cpuUsage = metric.containers.reduce((acc, c) => acc + parseCpuToMillicores(c.cpuUsage), 0);
        memUsage = metric.containers.reduce((acc, c) => acc + parseMemoryToMi(c.memUsage), 0);
      }

      let restartCount = 0;
      if (pod.status?.containerStatuses) {
        restartCount = pod.status.containerStatuses.reduce((acc, curr) => acc + (curr.restartCount || 0), 0);
      }

      // Determine effective status (handle Completed jobs)
      let effectiveStatus = pod.status?.phase || "Unknown";
      if (pod.status?.containerStatuses) {
        const terminated = pod.status.containerStatuses.find(cs => cs.state?.terminated);
        if (terminated?.state?.terminated?.reason === "Completed") {
          effectiveStatus = "Completed";
        }
      }

      const ns = pod.metadata?.namespace || "";
      const isSystem = SYSTEM_NAMESPACES.includes(ns);

      return {
        name: pod.metadata?.name,
        namespace: ns,
        nodeName: pod.spec?.nodeName,
        status: effectiveStatus,
        startTime: pod.status?.startTime,
        labels: pod.metadata?.labels || {},
        usage: { cpu: `${cpuUsage}m`, memory: `${memUsage}Mi` },
        restarts: restartCount,
        isSystem,
      };
    });

    res.status(200).json({ success: true, pods });
  } catch (error) {
    console.error("[k8sController] getAdminPods Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ── GET /admin/k8s/user-projects ───────────────────────────────────── */
exports.getAdminWorkloads = async (req, res) => {
  try {
    const k8sPods = await getPods();
    const metrics = await getPodMetrics();

    // Fetch all projects with title + UserId
    const projects = await Project.findAll({ attributes: ['id', 'title', 'UserId', 'subdomain'] });
    const projectMap = {};
    projects.forEach(p => {
      projectMap[p.id] = { title: p.title, userId: p.UserId, subdomain: p.subdomain };
    });

    const workloads = [];

    k8sPods.forEach((pod) => {
      const labels = pod.metadata?.labels || {};
      const projectIdStr = labels["sarthiq.com/projectId"];
      const userIdStr = labels["sarthiq.com/userId"];

      if (projectIdStr && userIdStr) {
        const projectId = parseInt(projectIdStr, 10);
        const userId = parseInt(userIdStr, 10);

        const metric = metrics.find(m => m.podName === pod.metadata?.name && m.namespace === pod.metadata?.namespace);

        let cpuUsage = 0;
        let memUsage = 0;
        if (metric && metric.containers) {
          cpuUsage = metric.containers.reduce((acc, c) => acc + parseCpuToMillicores(c.cpuUsage), 0);
          memUsage = metric.containers.reduce((acc, c) => acc + parseMemoryToMi(c.memUsage), 0);
        }

        let restartCount = 0;
        if (pod.status?.containerStatuses) {
          restartCount = pod.status.containerStatuses.reduce((acc, curr) => acc + (curr.restartCount || 0), 0);
        }

        const projectDetails = projectMap[projectId] || { title: "Unknown Project" };

        workloads.push({
          userId,
          projectId,
          projectTitle: projectDetails.title,
          subdomain: projectDetails.subdomain,
          podName: pod.metadata?.name,
          nodeName: pod.spec?.nodeName,
          namespace: pod.metadata?.namespace,
          status: pod.status?.phase,
          usage: { cpu: `${cpuUsage}m`, memory: `${memUsage}Mi` },
          restarts: restartCount,
          uptime: pod.status?.startTime,
        });
      }
    });

    res.status(200).json({ success: true, workloads });
  } catch (error) {
    console.error("[k8sController] getAdminWorkloads Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
