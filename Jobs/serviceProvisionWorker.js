/**
 * serviceProvisionWorker.js
 * ─────────────────────────────────────────────────────────────────────
 * BullMQ Worker — Async infrastructure service provisioning.
 *
 * Pipeline:
 *   1. Load ServiceInstance + ServiceCatalog from DB
 *   2. Generate credentials
 *   3. Build K8s resource specs
 *   4. Create namespace (if needed)
 *   5. Create Secret → PVC → StatefulSet/Deployment → Service
 *   6. Wait for pod readiness
 *   7. Build + encrypt connection details
 *   8. Auto-inject env vars into project
 *   9. Update ServiceInstance status → running
 *
 * Failure:
 *   - Update status → failed
 *   - Store error message
 *   - BullMQ retries up to 2 times
 * ─────────────────────────────────────────────────────────────────────
 */
const { Worker } = require("bullmq");
const { connection } = require("./queues");

const ServiceInstance = require("../Models/Services/serviceInstance");
const ServiceCatalog = require("../Models/Services/serviceCatalog");
const EnvironmentVariable = require("../Models/Services/environmentVariable");

const {
  generateCredentials,
  buildConnectionDetails,
  getAutoInjectMapping,
  encrypt,
} = require("../Utils/credentialManager");

const {
  buildServiceResources,
  buildNodePortService,
  buildClusterIPService,
  resourceName,
  standardLabels,
} = require("../Utils/kubeServiceBuilder");
const {
  generateServiceHost,
  canonicalServiceName,
  canonicalNamespace,
} = require("../Utils/serviceHostResolver");

const {
  ensureNamespace,
  waitForReady,
  NAMESPACE,
} = require("../Utils/kubeClient");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const batchV1 = kc.makeApiClient(k8s.BatchV1Api);

/* ── Helper: append provisioning log ───────────────────────────────── */
async function appendLog(instance, line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  console.log(`[serviceProvision] ${msg}`);
  instance.provisionLogs = (instance.provisionLogs || "") + msg + "\n";
  await instance.save();
}

/* ── Helper: wait for PVC to bind (with clear timeout error) ──────── */
async function waitForPvcBound(pvcName, namespace, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pvc = await coreV1.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
      const phase = pvc.status?.phase;
      if (phase === "Bound") return { bound: true };
      // Collect diagnostic info for better error messages
      if (Date.now() - start > 30_000 && phase === "Pending") {
        // Check if there are events explaining why PVC is stuck
        try {
          const events = await coreV1.listNamespacedEvent({
            namespace,
            fieldSelector: `involvedObject.name=${pvcName},involvedObject.kind=PersistentVolumeClaim`,
          });
          const warnings = (events.items || [])
            .filter(e => e.type === "Warning")
            .map(e => e.message)
            .slice(-3);
          if (warnings.length > 0) {
            console.log(`[serviceProvision] PVC '${pvcName}' pending — events: ${warnings.join("; ")}`);
          }
        } catch { /* non-fatal */ }
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return { bound: false };
}

/* ── Helper: create or replace K8s resource (idempotent) ───────────── */
async function applyResource(kind, spec, namespace) {
  const name = spec.metadata.name;

  switch (kind) {
    case "Secret": {
      const existing = await coreV1
        .readNamespacedSecret({ name, namespace })
        .catch(() => null);
      if (existing) {
        await coreV1.replaceNamespacedSecret({ name, namespace, body: spec });
      } else {
        await coreV1.createNamespacedSecret({ namespace, body: spec });
      }
      break;
    }
    case "ConfigMap": {
      const existing = await coreV1
        .readNamespacedConfigMap({ name, namespace })
        .catch(() => null);
      if (existing) {
        await coreV1.replaceNamespacedConfigMap({ name, namespace, body: spec });
      } else {
        await coreV1.createNamespacedConfigMap({ namespace, body: spec });
      }
      break;
    }
    case "PersistentVolumeClaim": {
      const existing = await coreV1
        .readNamespacedPersistentVolumeClaim({ name, namespace })
        .catch(() => null);
      if (!existing) {
        await coreV1.createNamespacedPersistentVolumeClaim({ namespace, body: spec });
      }
      // PVCs cannot be updated once created
      break;
    }
    case "StatefulSet": {
      const existing = await appsV1
        .readNamespacedStatefulSet({ name, namespace })
        .catch(() => null);
      if (existing) {
        await appsV1.replaceNamespacedStatefulSet({ name, namespace, body: spec });
      } else {
        await appsV1.createNamespacedStatefulSet({ namespace, body: spec });
      }
      break;
    }
    case "Deployment": {
      const existing = await appsV1
        .readNamespacedDeployment({ name, namespace })
        .catch(() => null);
      if (existing) {
        await appsV1.replaceNamespacedDeployment({ name, namespace, body: spec });
      } else {
        await appsV1.createNamespacedDeployment({ namespace, body: spec });
      }
      break;
    }
    case "Service": {
      const existing = await coreV1
        .readNamespacedService({ name, namespace })
        .catch(() => null);
      if (existing) {
        await coreV1.replaceNamespacedService({ name, namespace, body: spec });
      } else {
        await coreV1.createNamespacedService({ namespace, body: spec });
      }
      break;
    }
    case "CronJob": {
      const existing = await batchV1
        .readNamespacedCronJob({ name, namespace })
        .catch(() => null);
      if (existing) {
        await batchV1.replaceNamespacedCronJob({ name, namespace, body: spec });
      } else {
        await batchV1.createNamespacedCronJob({ namespace, body: spec });
      }
      break;
    }
    default:
      throw new Error(`Unknown resource kind: ${kind}`);
  }
}

/* ── Helper: auto-inject env vars into project ─────────────────────── */
async function autoInjectEnvVars(projectId, serviceInstanceId, serviceType, connectionDetails) {
  const mapping = getAutoInjectMapping(serviceType);

  for (const [envKey, fieldKey] of Object.entries(mapping)) {
    const value = connectionDetails[fieldKey];
    if (value === undefined || value === null) continue;

    const encryptedValue = encrypt(String(value));

    await EnvironmentVariable.upsert({
      ProjectId: projectId,
      key: envKey,
      value: encryptedValue,
      isAutoInjected: true,
      sourceServiceInstanceId: serviceInstanceId,
    });
  }
}

/* ── Main Worker ───────────────────────────────────────────────────── */
const serviceProvisionWorker = new Worker(
  "serviceQueue",
  async (job) => {
    const { serviceInstanceId } = job.data;

    const instance = await ServiceInstance.findByPk(serviceInstanceId);
    if (!instance) {
      throw new Error(`ServiceInstance ${serviceInstanceId} not found`);
    }

    const catalog = await ServiceCatalog.findByPk(instance.ServiceCatalogId);
    if (!catalog) {
      throw new Error(`ServiceCatalog ${instance.ServiceCatalogId} not found`);
    }

    try {
      await appendLog(instance, `Provisioning ${catalog.displayName}...`);

      /* ── Step 1: Resolve resources from template ────────────────── */
      const templates = catalog.templates || {};
      const templateName = instance.template || "small";
      const templateResources = templates[templateName] || catalog.requiredResources;

      const resources = {
        cpu: templateResources.cpu || "250m",
        memory: templateResources.memory || "256Mi",
        storage: templateResources.storage || "1Gi",
        cpuRequest: "100m",
        memoryRequest: "128Mi",
      };

      // Update instance with actual allocated resources
      instance.resourceUsage = {
        cpu: resources.cpu,
        memory: resources.memory,
        storage: resources.storage,
      };
      await instance.save();

      await appendLog(instance, `  → Template: ${templateName} (CPU: ${resources.cpu}, Mem: ${resources.memory}, Storage: ${resources.storage})`);

      /* ── Step 2: Generate credentials ───────────────────────────── */
      await appendLog(instance, "  → Generating credentials...");
      const credentials = generateCredentials(catalog.name);

      /* ── Step 3: Build K8s resource specs ───────────────────────── */
      await appendLog(instance, "  → Building Kubernetes resources...");

      const kubeResName = resourceName(catalog.name, instance.id);
      const canonicalService = canonicalServiceName(catalog.name, instance.ProjectId);
      const canonicalNs = canonicalNamespace(instance.ProjectId);
      if (instance.namespace !== canonicalNs) {
        instance.namespace = canonicalNs;
      }
      instance.kubeResourceName = kubeResName;
      await instance.save();

      const k8sResources = buildServiceResources(catalog, {
        instanceId: instance.id,
        namespace: instance.namespace,
        credentials,
        resources,
        projectId: instance.ProjectId,
        config: instance.config,
      });

      /* ── Step 4: Create namespace ───────────────────────────────── */
      await appendLog(instance, `  → Ensuring namespace: ${instance.namespace}`);
      await ensureNamespace(instance.namespace);

      /* ── Step 5: Apply K8s resources in order ──────────────────── */
      // 5a. Secret
      if (k8sResources.secret) {
        await applyResource("Secret", k8sResources.secret, instance.namespace);
        await appendLog(instance, "  → Secret created");
      }

      // 5b. ConfigMap
      if (k8sResources.configMap) {
        await applyResource("ConfigMap", k8sResources.configMap, instance.namespace);
        await appendLog(instance, "  → ConfigMap created");
      }

      // 5c. PVC (for Deployment-based services with standalone PVC)
      if (k8sResources.pvc) {
        await applyResource("PersistentVolumeClaim", k8sResources.pvc, instance.namespace);
        await appendLog(instance, "  → PVC created");

        // Wait for PVC to bind before proceeding
        const pvcName = k8sResources.pvc.metadata.name;
        const storageClass = k8sResources.pvc.spec?.storageClassName || "(cluster default)";
        await appendLog(instance, `  → Waiting for PVC '${pvcName}' to bind (storageClass: ${storageClass})...`);
        const pvcResult = await waitForPvcBound(pvcName, instance.namespace, 120_000);
        if (!pvcResult.bound) {
          throw new Error(
            `PVC '${pvcName}' stuck in Pending after 120s. StorageClass: ${storageClass}. ` +
            `This usually means no StorageClass provisioner is running on the cluster. ` +
            `Fix: (1) kubectl get sc — check if a StorageClass exists and is marked (default). ` +
            `(2) If not, install one: kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml ` +
            `(3) Set as default: kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' ` +
            `(4) Verify provisioner pods: kubectl -n local-path-storage get pods`
          );
        }
        await appendLog(instance, "  → PVC bound successfully");
      }

      // 5d. StatefulSet or Deployment
      if (k8sResources.statefulSet) {
        await applyResource("StatefulSet", k8sResources.statefulSet, instance.namespace);
        await appendLog(instance, "  → StatefulSet created");
      } else if (k8sResources.deployment) {
        await applyResource("Deployment", k8sResources.deployment, instance.namespace);
        await appendLog(instance, "  → Deployment created");
      }

      // 5e. Service
      if (k8sResources.service) {
        await applyResource("Service", k8sResources.service, instance.namespace);
        await appendLog(instance, "  → ClusterIP Service created");
      }

      // Stable canonical ClusterIP service for in-cluster DNS:
      // <serviceType>-<projectId>.<namespace>.svc.cluster.local
      const stableService = buildClusterIPService(
        canonicalService,
        instance.namespace,
        catalog.defaultPort,
        catalog.defaultPort,
        standardLabels(instance.id, catalog.name, instance.ProjectId),
      );
      stableService.spec.selector = { app: kubeResName };
      await applyResource("Service", stableService, instance.namespace);
      await appendLog(instance, `  → Stable Service created (${canonicalService})`);

      /* ── Step 5e (cont): Create NodePort for external access ──────── */
      // Per-service port mapping (includes secondary ports like console/management UIs)
      const SERVICE_PORTS = {
        mysql:         [{ name: "mysql", port: 3306, targetPort: 3306 }],
        postgresql:    [{ name: "postgres", port: 5432, targetPort: 5432 }],
        mongodb:       [{ name: "mongo", port: 27017, targetPort: 27017 }],
        redis:         [{ name: "redis", port: 6379, targetPort: 6379 }],
        rabbitmq:      [{ name: "amqp", port: 5672, targetPort: 5672 }, { name: "management", port: 15672, targetPort: 15672 }],
        kafka:         [{ name: "kafka", port: 9092, targetPort: 9092 }],
        minio:         [{ name: "api", port: 9000, targetPort: 9000 }, { name: "console", port: 9001, targetPort: 9001 }],
        meilisearch:   [{ name: "http", port: 7700, targetPort: 7700 }],
        elasticsearch: [{ name: "http", port: 9200, targetPort: 9200 }],
        opensearch:    [{ name: "http", port: 9200, targetPort: 9200 }],
      };

      const servicePorts = SERVICE_PORTS[catalog.name] || [{ name: "default", port: catalog.defaultPort, targetPort: catalog.defaultPort }];

      if (instance.externalAccessEnabled) {
        const nodePortSpec = buildNodePortService(
          canonicalService,
          instance.namespace,
          servicePorts,
          standardLabels(instance.id, catalog.name, instance.ProjectId),
        );
        nodePortSpec.spec.selector = { app: kubeResName };
        await applyResource("Service", nodePortSpec, instance.namespace);
        await appendLog(instance, "  → NodePort Service created (external access)");
      } else {
        await appendLog(instance, "  → External access disabled (skipping NodePort)");
      }

      // Read back ALL auto-assigned NodePorts
      const externalPorts = {}; // { portName: nodePort }
      try {
        if (instance.externalAccessEnabled) {
          const npSvc = await coreV1.readNamespacedService({
            name: `${canonicalService}-external`,
            namespace: instance.namespace,
          });
          for (const p of (npSvc?.spec?.ports || [])) {
            if (p.nodePort) {
              externalPorts[p.name] = p.nodePort;
              await appendLog(instance, `  → External ${p.name}: localhost:${p.nodePort}`);
            }
          }
        }
      } catch {
        await appendLog(instance, "  ⚠ Could not read NodePort (non-fatal)");
      }

      /* ── Step 6: Wait for readiness ────────────────────────────── */
      // Per-service readiness timeouts — heavy services like ES need more time
      const READINESS_TIMEOUTS = {
        elasticsearch: 180_000,
        opensearch: 180_000,
        kafka: 180_000,
        rabbitmq: 150_000,
        mysql: 120_000,
        postgresql: 120_000,
        mongodb: 120_000,
        minio: 90_000,
        meilisearch: 90_000,
        redis: 60_000,
      };
      const readinessTimeout = READINESS_TIMEOUTS[catalog.name] || 120_000;
      await appendLog(instance, `  → Waiting for pod readiness (timeout: ${readinessTimeout / 1000}s)...`);

      try {
        await waitForReady(kubeResName, readinessTimeout, instance.namespace);
        await appendLog(instance, "  → Pod is ready! 🚀");
      } catch (readyErr) {
        await appendLog(instance, `  ⚠ Pod readiness check failed: ${readyErr.message.slice(0, 300)}`);
        throw readyErr;
      }

      /* ── Step 7: Build + encrypt connection details ────────────── */
      const hostDetails = generateServiceHost(
        {
          ...instance.toJSON(),
          serviceType: catalog.name,
          port: catalog.defaultPort,
        },
        process.env.APP_ENV || process.env.NODE_ENV,
      );
      const internalHost = hostDetails.internal_host;
      const externalHost = hostDetails.external_host;
      const fallbackHost = hostDetails.fallback_host;

      // Primary external port (first port in the map)
      const primaryPortName = servicePorts[0].name;
      const primaryExternalPort = externalPorts[primaryPortName] || null;

      const connDetails = buildConnectionDetails(
        catalog.name,
        credentials,
        internalHost,
        catalog.defaultPort,
        (primaryExternalPort && externalHost) ? externalHost : null,
        primaryExternalPort,
      );
      connDetails.internal_host = internalHost;
      connDetails.external_host = externalHost;
      connDetails.fallback_host = fallbackHost;

      if (primaryExternalPort && fallbackHost) {
        const fallbackUri = buildConnectionDetails(
          catalog.name,
          credentials,
          internalHost,
          catalog.defaultPort,
          fallbackHost,
          primaryExternalPort,
        );
        connDetails.fallbackHost = fallbackHost;
        connDetails.fallbackPort = primaryExternalPort;
        connDetails.fallbackUri = fallbackUri.externalUri;
      }

      // Add secondary external ports (console, management, etc.)
      for (const sp of servicePorts.slice(1)) {
        const np = externalPorts[sp.name];
        if (np) {
          connDetails[`${sp.name}Port`] = np;
          connDetails[`${sp.name}Uri`] = `http://${externalHost}:${np}`;
        }
      }

      instance.connectionDetails = encrypt(JSON.stringify(connDetails));
      instance.status = "running";
      await instance.save();

      await appendLog(instance, `  → Internal: ${internalHost}:${catalog.defaultPort}`);
      if (primaryExternalPort) {
        await appendLog(instance, `  → External: ${externalHost}:${primaryExternalPort}`);
      }

      /* ── Step 8: Auto-inject env vars ──────────────────────────── */
      await appendLog(instance, "  → Auto-injecting environment variables...");
      await autoInjectEnvVars(
        instance.ProjectId,
        instance.id,
        catalog.name,
        connDetails
      );

      await appendLog(instance, `✅ ${catalog.displayName} provisioned successfully!`);

      return { success: true, instanceId: instance.id, host: internalHost };
    } catch (err) {
      console.error(`[serviceProvision] FATAL for instance ${serviceInstanceId}:`, err.message);

      instance.status = "failed";
      instance.errorMessage = err.message.slice(0, 1000);
      await instance.save();

      await appendLog(instance, `❌ Provisioning failed: ${err.message.slice(0, 500)}`);

      throw err; // Let BullMQ retry
    }
  },
  {
    connection,
    concurrency: parseInt(process.env.SERVICE_PROVISION_CONCURRENCY || "2"),
  }
);

serviceProvisionWorker.on("completed", (job) =>
  console.log(`[serviceProvision] Job ${job.id} completed`)
);
serviceProvisionWorker.on("failed", (job, err) =>
  console.error(`[serviceProvision] Job ${job?.id} failed: ${err.message}`)
);

module.exports = serviceProvisionWorker;
