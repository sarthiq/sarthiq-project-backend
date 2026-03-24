/**
 * kubeClient.js
 * Wrapper around @kubernetes/client-node.
 * Reads kubeconfig from:
 *   - KUBECONFIG env var, OR
 *   - In-cluster service account (when running inside K8s)
 */
const k8s = require("@kubernetes/client-node");

const kc = new k8s.KubeConfig();

// loadFromDefault() handles all environments in priority order:
// 1. KUBECONFIG env var  2. ~/.kube/config  3. WSL kubeconfig  4. In-cluster service account
kc.loadFromDefault();

// Fail fast if the loaded config has no usable cluster server URL
const _cluster = kc.getCurrentCluster();
if (
  !_cluster ||
  !_cluster.server ||
  _cluster.server.includes("undefined")
) {
  console.error(
    "[kubeClient] ⚠ No valid Kubernetes cluster URL found. Server:",
    _cluster?.server,
    "— Ensure ~/.kube/config or KUBECONFIG env var is set correctly."
  );
} else {
  console.log(`[kubeClient] ✓ Connected to cluster: ${_cluster.name} (${_cluster.server})`);
}

const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
const metricsClient = new k8s.Metrics(kc);

const NAMESPACE = process.env.K8S_NAMESPACE || "sarthiq-apps";

/* ------------------------------------------------------------------ */
/* Helper: safe label name from project subdomain                       */
/* ------------------------------------------------------------------ */
function safeLabel(name) {
  return name.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 52);
}

/* ------------------------------------------------------------------ */
/* CREATE: Kubernetes Deployment                                        */
/* ------------------------------------------------------------------ */
async function createDeployment({
  name,
  image,
  containerPort,
  cpuLimit,
  memoryLimit,
  cpuRequest,
  memoryRequest,
  envVars = {},
  nodeName,
}) {
  const label = safeLabel(name);
  const envArray = Object.entries(envVars).map(([n, v]) => ({
    name: n,
    value: String(v),
  }));

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: label,
      namespace: NAMESPACE,
      labels: { app: label, "managed-by": "sarthiq" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: label } },
      template: {
        metadata: { labels: { app: label } },
        spec: {
          // optionally pin to specific node, but ignore local dummy fallback nodes
          ...(nodeName && nodeName !== "minikube-local" && nodeName !== "docker-desktop" && {
            nodeSelector: { "kubernetes.io/hostname": nodeName },
          }),
          containers: [
            {
              name: label,
              image,
              ports: [{ containerPort }],
              env: envArray,
              resources: {
                limits: { cpu: cpuLimit, memory: memoryLimit },
                requests: { cpu: cpuRequest, memory: memoryRequest },
              },
              // Liveness probe (use tcpSocket as the generic default for user apps)
              livenessProbe: {
                tcpSocket: { port: containerPort },
                initialDelaySeconds: 30,
                periodSeconds: 15,
                failureThreshold: 3,
              },
              // Readiness probe
              readinessProbe: {
                tcpSocket: { port: containerPort },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                failureThreshold: 3,
              },
            },
          ],
        },
      },
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      },
    },
  };

  // ✅ Auto-create Namespace if it does not exist on a fresh production server
  try {
    await coreV1.readNamespace(NAMESPACE).catch(() => coreV1.readNamespace({ name: NAMESPACE }));
  } catch (err) {
    if (err.statusCode === 404 || err?.response?.statusCode === 404 || err.message.includes("404")) {
      console.log(`[kubeClient] Namespace '${NAMESPACE}' not found. Creating it now...`);
      await coreV1.createNamespace({
        body: { apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } } // Support for older clients
      }).catch((e) => coreV1.createNamespace({
        apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } // Support for newer clients
      })).catch(console.error);
    }
  }

  const existing = await appsV1
    .readNamespacedDeployment({ name: label, namespace: NAMESPACE })
    .catch(() => appsV1.readNamespacedDeployment(label, NAMESPACE))
    .catch(() => null);

  if (existing) {
    // Update image on redeploy
    await appsV1.replaceNamespacedDeployment({
      name: label,
      namespace: NAMESPACE,
      body: deployment,
    });
  } else {
    await appsV1.createNamespacedDeployment({
      namespace: NAMESPACE,
      body: deployment,
    });
  }

  return label;
}

/* ------------------------------------------------------------------ */
/* CREATE: ClusterIP Service                                            */
/* ------------------------------------------------------------------ */
async function createService({ name, containerPort }) {
  const label = safeLabel(name);

  const svc = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: label,
      namespace: NAMESPACE,
      labels: { app: label, "managed-by": "sarthiq" },
    },
    spec: {
      selector: { app: label },
      ports: [{ protocol: "TCP", port: 80, targetPort: containerPort }],
      type: "ClusterIP",
    },
  };

  const existing = await coreV1
    .readNamespacedService({ name: label, namespace: NAMESPACE })
    .catch(() => null);

  if (!existing) {
    await coreV1.createNamespacedService({ namespace: NAMESPACE, body: svc });
  }

  return `${label}.${NAMESPACE}.svc.cluster.local`;
}

/* ------------------------------------------------------------------ */
/* CREATE: Nginx Ingress (subdomain routing)                            */
/* ------------------------------------------------------------------ */
async function createIngress({ name, subdomain, baseDomain }) {
  const label = safeLabel(name);
  const host = `${subdomain}.${baseDomain}`;
  const isProd = process.env.NODE_ENV === "production";

  const ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: label,
      namespace: NAMESPACE,
      labels: { "managed-by": "sarthiq" },
      annotations: {
        "nginx.ingress.kubernetes.io/rewrite-target": "/",
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
        "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
        // Enable WebSocket support
        "nginx.ingress.kubernetes.io/proxy-http-version": "1.1",
        "nginx.ingress.kubernetes.io/proxy-set-headers":
          "Upgrade $http_upgrade,Connection upgrade",
        // Automatic HTTPS assignment via cert-manager in production
        ...(isProd && { "cert-manager.io/cluster-issuer": "letsencrypt-prod" }),
      },
    },
    spec: {
      ingressClassName: "nginx",
      ...(isProd && {
        tls: [
          {
            hosts: [host],
            secretName: `${label}-tls`,
          },
        ],
      }),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: label,
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };

  const existing = await networkingV1
    .readNamespacedIngress({ name: label, namespace: NAMESPACE })
    .catch(() => null);

  if (existing) {
    await networkingV1.replaceNamespacedIngress({
      name: label,
      namespace: NAMESPACE,
      body: ingress,
    });
  } else {
    await networkingV1.createNamespacedIngress({
      namespace: NAMESPACE,
      body: ingress,
    });
  }

  return host;
}

/* ------------------------------------------------------------------ */
/* SCALE: replicas (0 = sleep, 1 = wake)                               */
/* ------------------------------------------------------------------ */
async function scaleDeployment(name, replicas) {
  const label = safeLabel(name);
  const patch = [
    { op: "replace", path: "/spec/replicas", value: replicas },
  ];

  await appsV1.patchNamespacedDeployment(
    {
      name: label,
      namespace: NAMESPACE,
      body: patch,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { "Content-Type": "application/json-patch+json" } }
  );
}

/* ------------------------------------------------------------------ */
/* WAIT: until deployment has ≥1 ready pod (with timeout)              */
/* ------------------------------------------------------------------ */
async function waitForReady(name, timeoutMs = 180_000) {
  const label = safeLabel(name);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const dep = await appsV1
      .readNamespacedDeployment({ name: label, namespace: NAMESPACE })
      .catch(() => null);

    if (dep && dep.status?.readyReplicas >= 1) return true;

    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(
    `Deployment ${label} did not become ready within ${timeoutMs / 1000}s`
  );
}

/* ------------------------------------------------------------------ */
/* DELETE: all K8s resources for a project                             */
/* ------------------------------------------------------------------ */
async function deleteProjectResources(name) {
  const label = safeLabel(name);

  await appsV1
    .deleteNamespacedDeployment({ name: label, namespace: NAMESPACE })
    .catch(() => {});
  await coreV1
    .deleteNamespacedService({ name: label, namespace: NAMESPACE })
    .catch(() => {});
  await networkingV1
    .deleteNamespacedIngress({ name: label, namespace: NAMESPACE })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* READ: node metrics from metrics-server                              */
/* ------------------------------------------------------------------ */
async function getNodeMetrics() {
  try {
    const metrics = await metricsClient.getNodeMetrics();
    return metrics.items.map((item) => ({
      nodeName: item.metadata.name,
      cpuUsage: item.usage.cpu, // e.g. "150m"
      memUsage: item.usage.memory, // e.g. "512Mi"
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* GET: clusterIP of a service (for internal proxy)                    */
/* ------------------------------------------------------------------ */
async function getServiceClusterIP(name) {
  const label = safeLabel(name);
  const svc = await coreV1
    .readNamespacedService({ name: label, namespace: NAMESPACE })
    .catch(() => null);
  return svc?.spec?.clusterIP || null;
}

module.exports = {
  createDeployment,
  createService,
  createIngress,
  scaleDeployment,
  waitForReady,
  deleteProjectResources,
  getNodeMetrics,
  getServiceClusterIP,
  safeLabel,
  NAMESPACE,
};
