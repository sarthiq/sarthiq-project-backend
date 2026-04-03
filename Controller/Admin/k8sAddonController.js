const k8s = require("@kubernetes/client-node");
const { spawn } = require("child_process");

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

/* ── Well-known K8s addons ──────────────────────────────────────────── */
const KNOWN_ADDONS = [
  {
    id: "metrics-server",
    name: "Metrics Server",
    description: "Provides CPU/Memory metrics for pods and nodes. Required for `kubectl top`, HPA auto-scaling, and resource monitoring dashboards.",
    namespace: "kube-system",
    detectLabel: "k8s-app=metrics-server",
    detectDeployment: "metrics-server",
    category: "monitoring",
    importance: "critical",
    installUrl: "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml",
    consequences: "Without this, no CPU/Memory usage data is available. All monitoring dashboards, auto-scaling (HPA), and `kubectl top` commands will stop working.",
  },
  {
    id: "ingress-nginx",
    name: "NGINX Ingress Controller",
    description: "Routes external HTTP/HTTPS traffic to services inside the cluster using Ingress rules. Essential for subdomain-based routing.",
    namespace: "ingress-nginx",
    detectDeployment: "ingress-nginx-controller",
    category: "networking",
    importance: "critical",
    installCmd: "kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml",
    consequences: "ALL external HTTP routing will stop. User project subdomains (*.sarthiq.in) will become unreachable. This breaks the entire deployment platform.",
  },
  {
    id: "coredns",
    name: "CoreDNS",
    description: "Provides DNS resolution inside the cluster. Pods use it to resolve service names (e.g., my-service.default.svc.cluster.local).",
    namespace: "kube-system",
    detectDeployment: "coredns",
    category: "networking",
    importance: "critical",
    consequences: "ALL internal DNS resolution breaks. Pods cannot find other services. The entire cluster networking collapses. DO NOT remove this.",
  },
  {
    id: "cert-manager",
    name: "cert-manager",
    description: "Automatically provisions and manages TLS certificates (e.g., Let's Encrypt). Needed for HTTPS on user project domains.",
    namespace: "cert-manager",
    detectDeployment: "cert-manager",
    category: "security",
    importance: "recommended",
    installCmd: "kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml",
    consequences: "Automatic HTTPS certificate provisioning stops. Existing certificates will still work until they expire, but new ones won't be issued.",
  },
  {
    id: "dashboard",
    name: "Kubernetes Dashboard",
    description: "Web-based UI for managing Kubernetes resources. Provides a visual overview of the cluster.",
    namespace: "kubernetes-dashboard",
    detectDeployment: "kubernetes-dashboard",
    category: "management",
    importance: "optional",
    installCmd: "kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.7.0/aio/deploy/recommended.yaml",
    consequences: "Only the K8s native dashboard UI is removed. SarthiQ admin panel and kubectl CLI continue to work normally.",
  },
  {
    id: "storage-provisioner",
    name: "Storage Provisioner",
    description: "Dynamically provisions persistent volumes for pods that need persistent storage (databases, file uploads, etc.).",
    namespace: "kube-system",
    detectDeployment: "storage-provisioner",
    category: "storage",
    importance: "recommended",
    consequences: "Pods that request PersistentVolumeClaims won't get storage assigned automatically. Manual provisioning would be needed.",
  },
  {
    id: "kube-proxy",
    name: "kube-proxy",
    description: "Manages network rules on nodes. Implements Service load balancing and forwarding. Core Kubernetes component.",
    namespace: "kube-system",
    detectLabel: "k8s-app=kube-proxy",
    category: "networking",
    importance: "critical",
    consequences: "ALL Service networking breaks. Pods can't communicate via ClusterIP services. The cluster becomes non-functional. NEVER remove this.",
  },
];

/* ── Detect if an addon is installed ────────────────────────────────── */
async function detectAddon(addon) {
  try {
    if (addon.detectDeployment) {
      // Try as Deployment
      try {
        const dep = await appsV1.readNamespacedDeployment({
          name: addon.detectDeployment,
          namespace: addon.namespace,
        });
        if (dep) {
          const replicas = dep.status?.readyReplicas || 0;
          const desired = dep.spec?.replicas || 1;
          return {
            installed: true,
            healthy: replicas >= desired,
            replicas: `${replicas}/${desired}`,
            version: dep.metadata?.labels?.["app.kubernetes.io/version"] || dep.spec?.template?.spec?.containers?.[0]?.image?.split(":")?.[1] || "unknown",
          };
        }
      } catch {
        // Not a deployment, try DaemonSet
        try {
          const ds = await appsV1.readNamespacedDaemonSet({
            name: addon.detectDeployment,
            namespace: addon.namespace,
          });
          if (ds) {
            const ready = ds.status?.numberReady || 0;
            const desired = ds.status?.desiredNumberScheduled || 1;
            return {
              installed: true,
              healthy: ready >= desired,
              replicas: `${ready}/${desired}`,
              version: ds.metadata?.labels?.["app.kubernetes.io/version"] || "unknown",
            };
          }
        } catch {
          // Not found
        }
      }
    }

    if (addon.detectLabel) {
      const pods = await coreV1.listNamespacedPod({
        namespace: addon.namespace,
        labelSelector: addon.detectLabel,
      });
      if (pods.items && pods.items.length > 0) {
        const running = pods.items.filter(p => p.status?.phase === "Running").length;
        return {
          installed: true,
          healthy: running > 0,
          replicas: `${running}/${pods.items.length}`,
          version: "detected",
        };
      }
    }

    return { installed: false, healthy: false, replicas: "0/0", version: null };
  } catch {
    return { installed: false, healthy: false, replicas: "0/0", version: null };
  }
}

/* ── Execute kubectl command ────────────────────────────────────────── */
function execKubectl(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", args, { timeout });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`kubectl exited with code ${code}: ${stderr || stdout}`));
    });

    proc.on("error", reject);
  });
}

/* ── GET /admin/k8s/addons ──────────────────────────────────────────── */
exports.getAddons = async (req, res) => {
  try {
    const results = [];
    for (const addon of KNOWN_ADDONS) {
      const detection = await detectAddon(addon);
      results.push({
        ...addon,
        ...detection,
        canInstall: !!addon.installCmd || !!addon.installUrl,
        canUninstall: detection.installed && addon.importance !== "critical",
      });
    }
    res.status(200).json({ success: true, addons: results });
  } catch (error) {
    console.error("[k8sAddonController] getAddons Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ── POST /admin/k8s/addons/install ─────────────────────────────────── */
exports.installAddon = async (req, res) => {
  try {
    const { addonId } = req.body;
    const addon = KNOWN_ADDONS.find(a => a.id === addonId);
    if (!addon) return res.status(404).json({ success: false, message: "Unknown addon" });

    if (!addon.installCmd && !addon.installUrl) {
      return res.status(400).json({ success: false, message: "This addon cannot be installed automatically" });
    }

    let result;
    if (addon.installUrl) {
      result = await execKubectl(["apply", "-f", addon.installUrl]);
    } else {
      // Parse the installCmd into args
      const parts = addon.installCmd.split(" ").slice(1); // Remove "kubectl"
      result = await execKubectl(parts);
    }

    res.status(200).json({
      success: true,
      message: `${addon.name} installation initiated`,
      output: result.stdout,
    });
  } catch (error) {
    console.error("[k8sAddonController] installAddon Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ── POST /admin/k8s/addons/uninstall ───────────────────────────────── */
exports.uninstallAddon = async (req, res) => {
  try {
    const { addonId, confirmed } = req.body;
    const addon = KNOWN_ADDONS.find(a => a.id === addonId);
    if (!addon) return res.status(404).json({ success: false, message: "Unknown addon" });

    if (addon.importance === "critical") {
      return res.status(400).json({
        success: false,
        message: `Cannot uninstall ${addon.name} — it is a critical cluster component. ${addon.consequences}`,
      });
    }

    if (!confirmed) {
      return res.status(200).json({
        success: false,
        requiresConfirmation: true,
        warning: addon.consequences,
        addonName: addon.name,
      });
    }

    // Delete the namespace (which deletes all resources in it)
    let result;
    if (addon.installUrl) {
      result = await execKubectl(["delete", "-f", addon.installUrl, "--ignore-not-found"]);
    } else if (addon.installCmd) {
      const parts = addon.installCmd.split(" ").slice(1);
      parts[0] = "delete"; // Replace "apply" with "delete"
      parts.push("--ignore-not-found");
      result = await execKubectl(parts);
    } else {
      // Fallback: delete the namespace
      result = await execKubectl(["delete", "namespace", addon.namespace, "--ignore-not-found"]);
    }

    res.status(200).json({
      success: true,
      message: `${addon.name} uninstall initiated`,
      output: result.stdout,
    });
  } catch (error) {
    console.error("[k8sAddonController] uninstallAddon Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
