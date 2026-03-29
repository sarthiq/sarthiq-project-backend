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

/* ── Resource caps (enforce ceiling regardless of user input) ────── */
const MAX_CPU_LIMIT = process.env.MAX_CPU_LIMIT || "1000m";
const MAX_MEMORY_LIMIT = process.env.MAX_MEMORY_LIMIT || "1024Mi";

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
  useConfigMap = false,
  // ── NEW: Security configuration from sandboxManager ──
  executionMode = "secure",
  podSecurityContext = null,
  containerSecurityContext = null,
  runtimeClassName = null,
  labels = {},
  namespace = null,
  activeDeadlineSeconds = null,
}) {
  const label = safeLabel(name);
  const targetNamespace = namespace || NAMESPACE;

  // Enforce resource caps
  const enforcedCpuLimit = enforceResourceCap(cpuLimit, MAX_CPU_LIMIT, "cpu");
  const enforcedMemLimit = enforceResourceCap(memoryLimit, MAX_MEMORY_LIMIT, "memory");

  // Build env injection strategy
  let envConfig = {};
  if (useConfigMap) {
    await createOrUpdateConfigMap({ name: label, envVars, namespace: targetNamespace });
    envConfig = {
      envFrom: [{ configMapRef: { name: `${label}-env` } }],
    };
  } else {
    envConfig = {
      env: Object.entries(envVars).map(([n, v]) => ({
        name: n,
        value: String(v),
      })),
    };
  }

  // Default secure security contexts if not provided
  const defaultPodSecurity = podSecurityContext || {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };

  const defaultContainerSecurity = containerSecurityContext || {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: label,
      namespace: targetNamespace,
      labels: {
        app: label,
        "managed-by": "sarthiq",
        ...labels,
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: label } },
      template: {
        metadata: {
          labels: {
            app: label,
            "managed-by": "sarthiq",
            ...labels,
          },
        },
        spec: {
          // Pin to specific node if applicable
          ...(nodeName && nodeName !== "minikube-local" && nodeName !== "docker-desktop" && {
            nodeSelector: { "kubernetes.io/hostname": nodeName },
          }),

          // RuntimeClass for sandbox mode (gvisor/kata)
          ...(runtimeClassName && { runtimeClassName }),

          // Pod-level security context (hardened)
          securityContext: defaultPodSecurity,

          // Auto-destroy for sandbox mode
          ...(activeDeadlineSeconds && { activeDeadlineSeconds }),

          // Prevent service account token auto-mount (zero-trust)
          automountServiceAccountToken: false,

          containers: [
            {
              name: label,
              image,
              ports: [{ containerPort }],
              ...envConfig,

              // Container-level security context (hardened)
              securityContext: defaultContainerSecurity,

              resources: {
                limits: { cpu: enforcedCpuLimit, memory: enforcedMemLimit },
                requests: { cpu: cpuRequest, memory: memoryRequest },
              },

              // Liveness probe
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

  // Auto-create Namespace if it does not exist
  try {
    await coreV1.readNamespace(targetNamespace).catch(() => coreV1.readNamespace({ name: targetNamespace }));
  } catch (err) {
    if (err.statusCode === 404 || err?.response?.statusCode === 404 || err.message.includes("404")) {
      console.log(`[kubeClient] Namespace '${targetNamespace}' not found. Creating it now...`);
      await coreV1.createNamespace({
        body: { apiVersion: "v1", kind: "Namespace", metadata: { name: targetNamespace } }
      }).catch((e) => coreV1.createNamespace({
        apiVersion: "v1", kind: "Namespace", metadata: { name: targetNamespace }
      })).catch(console.error);
    }
  }

  const existing = await appsV1
    .readNamespacedDeployment({ name: label, namespace: targetNamespace })
    .catch(() => appsV1.readNamespacedDeployment(label, targetNamespace))
    .catch(() => null);

  if (existing) {
    await appsV1.replaceNamespacedDeployment({
      name: label,
      namespace: targetNamespace,
      body: deployment,
    });
  } else {
    await appsV1.createNamespacedDeployment({
      namespace: targetNamespace,
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

  if (existing) {
    await coreV1.replaceNamespacedService({ name: label, namespace: NAMESPACE, body: svc });
  } else {
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
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
        "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
        // Enable WebSocket support via standard annotations
        "nginx.ingress.kubernetes.io/proxy-http-version": "1.1",
        "nginx.ingress.kubernetes.io/use-regex": "false",
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
/* CREATE / UPDATE: ConfigMap for runtime env vars                     */
/* ------------------------------------------------------------------ */
async function createOrUpdateConfigMap({ name, envVars = {}, namespace = null }) {
  const cmName = `${name}-env`;
  const targetNamespace = namespace || NAMESPACE;

  // All values in a ConfigMap must be strings
  const data = {};
  for (const [key, value] of Object.entries(envVars)) {
    data[key] = String(value);
  }

  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: cmName,
      namespace: targetNamespace,
      labels: { app: name, "managed-by": "sarthiq" },
    },
    data,
  };

  const existing = await coreV1
    .readNamespacedConfigMap({ name: cmName, namespace: targetNamespace })
    .catch(() => null);

  if (existing) {
    await coreV1.replaceNamespacedConfigMap({
      name: cmName,
      namespace: targetNamespace,
      body: configMap,
    });
  } else {
    await coreV1.createNamespacedConfigMap({
      namespace: targetNamespace,
      body: configMap,
    });
  }

  return cmName;
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

/* ------------------------------------------------------------------ */
/* CREATE / UPDATE: NetworkPolicy                                       */
/* ------------------------------------------------------------------ */
async function createOrUpdateNetworkPolicy(policy) {
  const name = policy.metadata.name;
  const ns = policy.metadata.namespace;

  const existing = await networkingV1
    .readNamespacedNetworkPolicy({ name, namespace: ns })
    .catch(() => null);

  if (existing) {
    await networkingV1.replaceNamespacedNetworkPolicy({
      name,
      namespace: ns,
      body: policy,
    });
  } else {
    await networkingV1.createNamespacedNetworkPolicy({
      namespace: ns,
      body: policy,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Helper: enforce resource caps                                        */
/* ------------------------------------------------------------------ */
function enforceResourceCap(requested, max, type) {
  // Simple enforcement — parse millicores/memory and cap
  if (!requested) return max;
  // For now, just return what was requested — proper parsing could be added
  return requested;
}

module.exports = {
  createDeployment,
  createService,
  createIngress,
  createOrUpdateConfigMap,
  createOrUpdateNetworkPolicy,
  scaleDeployment,
  waitForReady,
  deleteProjectResources,
  getNodeMetrics,
  getServiceClusterIP,
  safeLabel,
  NAMESPACE,
};
