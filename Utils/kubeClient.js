/**
 * kubeClient.js
 * ─────────────────────────────────────────────────────────────────────
 * Wrapper around @kubernetes/client-node.
 * Reads kubeconfig from:
 *   - KUBECONFIG env var, OR
 *   - In-cluster service account (when running inside K8s)
 *
 * KEY CHANGES (v2):
 *   - REMOVED nodeSelector from deployment spec (let K8s scheduler decide)
 *   - Added tolerations for single-node control-plane clusters
 *   - Fixed security contexts: permissive-by-default, enforce when safe
 *   - Added startupProbe for slow-starting containers
 *   - Tuned liveness/readiness probe timings
 *   - Completely rewrote waitForReady() with diagnostic pod status checks
 *   - Fixed createService() to accept namespace parameter
 *   - Implemented enforceResourceCap() properly
 * ─────────────────────────────────────────────────────────────────────
 */
const k8s = require("@kubernetes/client-node");

const kc = new k8s.KubeConfig();

// loadFromDefault() handles all environments in priority order:
// 1. KUBECONFIG env var  2. ~/.kube/config  3. WSL kubeconfig  4. In-cluster service account
kc.loadFromDefault();

// Fail fast if the loaded config has no usable cluster server URL
const _cluster = kc.getCurrentCluster();
if (!_cluster || !_cluster.server || _cluster.server.includes("undefined")) {
  console.error(
    "[kubeClient] ⚠ No valid Kubernetes cluster URL found. Server:",
    _cluster?.server,
    "— Ensure ~/.kube/config or KUBECONFIG env var is set correctly.",
  );
} else {
  console.log(
    `[kubeClient] ✓ Connected to cluster: ${_cluster.name} (${_cluster.server})`,
  );
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
  return name
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 52);
}

/* ------------------------------------------------------------------ */
/* Helper: parse resource values to numeric for comparison               */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* Helper: enforce resource caps (actually clamp values now)             */
/* ------------------------------------------------------------------ */
function enforceResourceCap(requested, max, type) {
  if (!requested) return max;
  if (type === "cpu") {
    const reqMilli = parseCpuToMillicores(requested);
    const maxMilli = parseCpuToMillicores(max);
    if (reqMilli > maxMilli) {
      console.log(
        `[kubeClient] Capping CPU: ${requested} → ${max} (exceeds max)`,
      );
      return max;
    }
    return requested;
  }
  if (type === "memory") {
    const reqMi = parseMemoryToMi(requested);
    const maxMi = parseMemoryToMi(max);
    if (reqMi > maxMi) {
      console.log(
        `[kubeClient] Capping Memory: ${requested} → ${max} (exceeds max)`,
      );
      return max;
    }
    return requested;
  }
  return requested;
}

/* ------------------------------------------------------------------ */
/* Helper: ensure a Kubernetes namespace exists (create if missing)      */
/* ------------------------------------------------------------------ */
const _nsCache = new Set(); // avoid repeated API calls for the same NS

async function ensureNamespace(ns) {
  if (_nsCache.has(ns)) return; // already verified this session

  try {
    await coreV1.readNamespace({ name: ns });
    _nsCache.add(ns);
  } catch (err) {
    // Namespace doesn't exist — create it
    try {
      console.log(`[kubeClient] Namespace '${ns}' not found. Creating...`);
      await coreV1.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: ns },
        },
      });
      _nsCache.add(ns);
      console.log(`[kubeClient] ✓ Namespace '${ns}' created successfully`);
    } catch (createErr) {
      // 409 = already exists (race condition with another worker)
      if (createErr.statusCode === 409 || createErr?.body?.code === 409) {
        _nsCache.add(ns);
        return;
      }
      console.error(
        `[kubeClient] ✗ Failed to create namespace '${ns}':`,
        createErr.message,
      );
      throw createErr;
    }
  }
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
  nodeName, // kept for DB tracking but NO LONGER used for nodeSelector
  useConfigMap = false,
  // ── Security configuration from sandboxManager ──
  executionMode = "secure",
  podSecurityContext = null,
  containerSecurityContext = null,
  runtimeClassName = null,
  labels = {},
  namespace = null,
  activeDeadlineSeconds = null,
  // ── NEW: cluster info for tolerations ──
  isSingleNodeCluster = false,
}) {
  const label = safeLabel(name);
  const targetNamespace = namespace || NAMESPACE;

  // ── Ensure namespace exists BEFORE any namespaced operations ──
  await ensureNamespace(targetNamespace);

  // Enforce resource caps
  const enforcedCpuLimit = enforceResourceCap(cpuLimit, MAX_CPU_LIMIT, "cpu");
  const enforcedMemLimit = enforceResourceCap(
    memoryLimit,
    MAX_MEMORY_LIMIT,
    "memory",
  );

  // Build env injection strategy
  let envConfig = {};
  if (useConfigMap) {
    await createOrUpdateConfigMap({
      name: label,
      envVars,
      namespace: targetNamespace,
    });
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

  // ── Security contexts ──
  // Permissive-by-default: let the Dockerfile's USER instruction govern.
  // Only enforce strict non-root when executionMode is "sandbox" with explicit config.
  const defaultPodSecurity = podSecurityContext || {
    // runAsNonRoot: false — most AI-generated Dockerfiles run as root
    // The Dockerfile can set USER 1000 and that will be respected
    seccompProfile: { type: "RuntimeDefault" },
  };

  const defaultContainerSecurity = containerSecurityContext || {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    capabilities: { drop: ["ALL"] },
  };

  // ── Tolerations for single-node control-plane clusters ──
  // In Minikube/Kind/single-node clusters, the only node has a
  // NoSchedule taint. We MUST tolerate it or pods stay Pending forever.
  const tolerations = [];
  if (isSingleNodeCluster) {
    tolerations.push(
      {
        key: "node-role.kubernetes.io/control-plane",
        operator: "Exists",
        effect: "NoSchedule",
      },
      {
        key: "node-role.kubernetes.io/master",
        operator: "Exists",
        effect: "NoSchedule",
      },
    );
  }

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
          // ── NO nodeSelector: let K8s scheduler handle placement ──
          // Previously used nodeSelector with hardcoded/fake node names.
          // The scheduler will find the best node automatically.

          // Tolerations for single-node/control-plane clusters
          ...(tolerations.length > 0 && { tolerations }),

          // RuntimeClass for sandbox mode (gvisor/kata)
          ...(runtimeClassName && { runtimeClassName }),

          // Pod-level security context
          securityContext: defaultPodSecurity,

          // Auto-destroy for sandbox mode
          ...(activeDeadlineSeconds && { activeDeadlineSeconds }),

          // Prevent service account token auto-mount (zero-trust)
          automountServiceAccountToken: false,

          containers: [
            {
              name: label,
              image,
              // Always pull from registry in prod; use local cache in dev
              imagePullPolicy: image.includes("/") ? "Always" : "IfNotPresent",
              ports: [{ containerPort }],
              ...envConfig,

              // Container-level security context
              securityContext: defaultContainerSecurity,

              resources: {
                limits: { cpu: enforcedCpuLimit, memory: enforcedMemLimit },
                requests: { cpu: cpuRequest, memory: memoryRequest },
              },

              // ── Startup probe: handles slow-starting containers ──
              // K8s will wait up to 300s (5 min) for the app to start.
              // During this time, liveness and readiness probes are disabled.
              startupProbe: {
                tcpSocket: { port: containerPort },
                initialDelaySeconds: 5,
                periodSeconds: 5,
                failureThreshold: 60, // 60 * 5s = 300s max startup time
              },

              // ── Liveness probe: restarts the container if unhealthy ──
              // Only runs AFTER startupProbe succeeds
              livenessProbe: {
                tcpSocket: { port: containerPort },
                periodSeconds: 15,
                failureThreshold: 3,
                timeoutSeconds: 3,
              },

              // ── Readiness probe: controls traffic routing ──
              // Only runs AFTER startupProbe succeeds
              readinessProbe: {
                tcpSocket: { port: containerPort },
                periodSeconds: 5,
                failureThreshold: 3,
                timeoutSeconds: 3,
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
async function createService({ name, containerPort, namespace = null }) {
  const label = safeLabel(name);
  const targetNamespace = namespace || NAMESPACE;

  const svc = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: label,
      namespace: targetNamespace,
      labels: { app: label, "managed-by": "sarthiq" },
    },
    spec: {
      selector: { app: label },
      ports: [{ protocol: "TCP", port: 80, targetPort: containerPort }],
      type: "ClusterIP",
    },
  };

  const existing = await coreV1
    .readNamespacedService({ name: label, namespace: targetNamespace })
    .catch(() => null);

  if (existing) {
    await coreV1.replaceNamespacedService({
      name: label,
      namespace: targetNamespace,
      body: svc,
    });
  } else {
    await coreV1.createNamespacedService({
      namespace: targetNamespace,
      body: svc,
    });
  }

  return `${label}.${targetNamespace}.svc.cluster.local`;
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
async function createOrUpdateConfigMap({
  name,
  envVars = {},
  namespace = null,
}) {
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
  const patch = [{ op: "replace", path: "/spec/replicas", value: replicas }];

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
    { headers: { "Content-Type": "application/json-patch+json" } },
  );
}

/* ------------------------------------------------------------------ */
/* WAIT: until deployment has ≥1 ready pod (with FULL DIAGNOSTICS)     */
/* ------------------------------------------------------------------ */

/**
 * Diagnose why a pod is not ready by examining its status, events, and logs.
 * Returns structured diagnostic info.
 */
async function diagnosePodFailure(label, targetNamespace) {
  const diagnostic = {
    phase: "Unknown",
    reason: "Unknown failure",
    details: "",
    containerLogs: "",
    events: [],
    isSchedulingIssue: false,
    isImageIssue: false,
    isAppCrash: false,
    isResourceIssue: false,
    isInfrastructureIssue: false,
  };

  try {
    // Get pods matching the deployment
    const podList = await coreV1.listNamespacedPod({
      namespace: targetNamespace,
      labelSelector: `app=${label}`,
    });

    const pods = podList.items || [];
    if (pods.length === 0) {
      diagnostic.reason =
        "No pods created by the deployment. Check deployment spec.";
      diagnostic.isSchedulingIssue = true;
      return diagnostic;
    }

    const pod = pods[0]; // Most recent pod
    const podName = pod.metadata.name;
    const phase = pod.status?.phase || "Unknown";
    diagnostic.phase = phase;

    // ── Check conditions for scheduling issues ──
    const conditions = pod.status?.conditions || [];
    const podScheduled = conditions.find((c) => c.type === "PodScheduled");
    if (podScheduled?.status === "False") {
      diagnostic.reason = `Pod cannot be scheduled: ${podScheduled.message || podScheduled.reason}`;
      diagnostic.details = podScheduled.message || "";
      diagnostic.isSchedulingIssue = true;

      // Common scheduling failure reasons
      if (diagnostic.details.includes("Insufficient")) {
        diagnostic.isResourceIssue = true;
        diagnostic.reason =
          "Node has insufficient resources (CPU/Memory). " +
          "Reduce resource requests or add more nodes.";
      } else if (
        diagnostic.details.includes("didn't match") ||
        diagnostic.details.includes("taints")
      ) {
        diagnostic.reason =
          "No node matches scheduling constraints. " +
          "Check node taints, tolerations, and nodeSelector. " +
          `Details: ${diagnostic.details}`;
      }
      return diagnostic;
    }

    // ── Check container statuses ──
    const containerStatuses = pod.status?.containerStatuses || [];
    const initContainerStatuses = pod.status?.initContainerStatuses || [];

    // Check init containers first
    for (const cs of initContainerStatuses) {
      const waiting = cs.state?.waiting;
      if (waiting) {
        diagnostic.reason = `Init container '${cs.name}' waiting: ${waiting.reason} — ${waiting.message || ""}`;
        return diagnostic;
      }
    }

    for (const cs of containerStatuses) {
      const waiting = cs.state?.waiting;
      const terminated = cs.state?.terminated;

      if (waiting) {
        const reason = waiting.reason || "Unknown";

        if (reason === "CrashLoopBackOff") {
          diagnostic.isAppCrash = true;
          diagnostic.reason =
            "Container keeps crashing (CrashLoopBackOff). " +
            "The application is failing to start. Check container logs below.";
        } else if (reason === "ImagePullBackOff" || reason === "ErrImagePull") {
          diagnostic.isImageIssue = true;
          diagnostic.reason =
            `Cannot pull Docker image: ${waiting.message || "image not found or registry auth failed"}. ` +
            "Verify the image exists and registry credentials are configured.";
        } else if (reason === "CreateContainerConfigError") {
          diagnostic.reason = `Container config error: ${waiting.message || "check env vars and volume mounts"}`;
        } else if (reason === "RunContainerError") {
          diagnostic.isAppCrash = true;
          diagnostic.reason = `Container failed to start: ${waiting.message || reason}`;
        } else {
          diagnostic.reason = `Container waiting: ${reason} — ${waiting.message || ""}`;
        }
      }

      if (terminated) {
        diagnostic.isAppCrash = true;
        if (terminated.reason === "OOMKilled") {
          diagnostic.isResourceIssue = true;
          diagnostic.reason =
            "Container killed due to Out Of Memory (OOMKilled). " +
            "Increase the memory limit or reduce memory usage.";
        } else {
          diagnostic.reason =
            `Container terminated: ${terminated.reason || "unknown"} ` +
            `(exit code ${terminated.exitCode}). ${terminated.message || ""}`;
        }
      }
    }

    // ── Collect container logs ──
    try {
      const logResp = await coreV1.readNamespacedPodLog({
        name: podName,
        namespace: targetNamespace,
        tailLines: 50,
      });
      diagnostic.containerLogs =
        typeof logResp === "string" ? logResp : logResp?.body || "";
    } catch (logErr) {
      diagnostic.containerLogs = `(Could not retrieve logs: ${logErr.message})`;
    }

    // ── Collect pod events ──
    try {
      const eventList = await coreV1.listNamespacedEvent({
        namespace: targetNamespace,
        fieldSelector: `involvedObject.name=${podName}`,
      });
      diagnostic.events = (eventList.items || [])
        .slice(-10) // last 10 events
        .map(
          (e) =>
            `[${e.type}] ${e.reason}: ${e.message} (${e.lastTimestamp || e.eventTime || ""})`,
        );

      const combinedEventsText = diagnostic.events.join("\n");
      if (
        combinedEventsText.includes('plugin type="loopback" failed') &&
        combinedEventsText.includes('failed to find plugin "loopback" in path [/opt/cni/bin]')
      ) {
        diagnostic.isInfrastructureIssue = true;
        diagnostic.reason =
          "Cluster CNI is misconfigured: missing loopback plugin in /opt/cni/bin. " +
          "This is a node/runtime issue (not an application image issue). " +
          "Install CNI plugins on the node and restart kubelet/container runtime.";
      }
    } catch {
      // Non-fatal
    }

    // If we still don't have a specific reason, provide a generic one with logs
    if (diagnostic.reason === "Unknown failure" && phase === "Pending") {
      diagnostic.reason =
        "Pod is stuck in Pending state. This usually means the scheduler " +
        "cannot find a suitable node. Check node availability and resources.";
      diagnostic.isSchedulingIssue = true;
    }
  } catch (err) {
    diagnostic.reason = `Failed to diagnose pod: ${err.message}`;
  }

  return diagnostic;
}

/**
 * Wait for a deployment to have at least 1 ready pod.
 * Unlike the old version, this provides detailed diagnostics on failure
 * and detects unrecoverable conditions early.
 *
 * @param {string} name - deployment name (will be safeLabel'd)
 * @param {number} timeoutMs - max wait time (default 180s)
 * @param {string} namespace - target namespace (default: NAMESPACE)
 * @returns {Promise<true>}
 * @throws {Error} with diagnostic details
 */
async function waitForReady(name, timeoutMs = 180_000, namespace = null) {
  const label = safeLabel(name);
  const targetNamespace = namespace || NAMESPACE;
  const start = Date.now();
  const pollInterval = 3000; // 3 seconds
  let lastDiagnostic = null;
  let earlyExitChecked = false;

  while (Date.now() - start < timeoutMs) {
    // Check deployment status
    const dep = await appsV1
      .readNamespacedDeployment({ name: label, namespace: targetNamespace })
      .catch(() => null);

    if (dep && dep.status?.readyReplicas >= 1) {
      return true; // ✅ Pod is ready!
    }

    // ── Early exit: detect unrecoverable failures ──
    // Only check after the first 15s (give the scheduler time to work)
    const elapsed = Date.now() - start;
    if (elapsed > 15_000) {
      const diagnostic = await diagnosePodFailure(label, targetNamespace);
      lastDiagnostic = diagnostic;

      // Immediate failures — no point waiting the full timeout
      if (diagnostic.isImageIssue) {
        // ImagePullBackOff won't resolve itself
        const err = new Error(
          `Deployment ${label} failed: ${diagnostic.reason}`,
        );
        err.diagnostic = diagnostic;
        throw err;
      }

      if (diagnostic.isAppCrash && elapsed > 30_000) {
        // CrashLoopBackOff — app keeps crashing, waiting won't help
        const err = new Error(
          `Deployment ${label} failed: ${diagnostic.reason}\n` +
            `Container logs:\n${diagnostic.containerLogs || "(no logs)"}`,
        );
        err.diagnostic = diagnostic;
        throw err;
      }

      if (
        diagnostic.isResourceIssue &&
        diagnostic.phase === "Pending" &&
        elapsed > 30_000
      ) {
        // Resource issues on Pending — no node can accommodate this pod
        const err = new Error(
          `Deployment ${label} failed: ${diagnostic.reason}`,
        );
        err.diagnostic = diagnostic;
        throw err;
      }

      if (diagnostic.isInfrastructureIssue && elapsed > 20_000) {
        // Cluster/CNI runtime problems will not resolve by waiting longer
        const err = new Error(
          `Deployment ${label} failed: ${diagnostic.reason}`,
        );
        err.diagnostic = diagnostic;
        throw err;
      }

      if (diagnostic.isInfrastructureIssue && elapsed > 20_000) {
        // Cluster/CNI runtime problems will not resolve by waiting longer
        const err = new Error(
          `Deployment ${label} failed: ${diagnostic.reason}`
        );
        err.diagnostic = diagnostic;
        throw err;
      }

      // Log progress every 30 seconds
      if (!earlyExitChecked || elapsed % 30_000 < pollInterval) {
        console.log(
          `[kubeClient] waitForReady: ${label} — phase: ${diagnostic.phase}, ` +
            `reason: ${diagnostic.reason.slice(0, 100)}, ` +
            `elapsed: ${Math.round(elapsed / 1000)}s`,
        );
        earlyExitChecked = true;
      }
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // ── Timeout reached — collect final diagnostic ──
  const finalDiagnostic =
    lastDiagnostic || (await diagnosePodFailure(label, targetNamespace));

  const err = new Error(
    `Deployment ${label} did not become ready within ${timeoutMs / 1000}s.\n` +
      `Reason: ${finalDiagnostic.reason}\n` +
      `Phase: ${finalDiagnostic.phase}\n` +
      (finalDiagnostic.containerLogs
        ? `Container logs:\n${finalDiagnostic.containerLogs.slice(0, 500)}\n`
        : "") +
      (finalDiagnostic.events.length > 0
        ? `Pod events:\n${finalDiagnostic.events.join("\n")}\n`
        : ""),
  );
  err.diagnostic = finalDiagnostic;
  throw err;
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
  ensureNamespace,
  safeLabel,
  NAMESPACE,
  diagnosePodFailure,
};
