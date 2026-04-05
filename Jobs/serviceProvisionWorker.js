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
  resourceName,
  standardLabels,
} = require("../Utils/kubeServiceBuilder");

const {
  ensureNamespace,
  waitForReady,
  NAMESPACE,
} = require("../Utils/kubeClient");

const isProd = process.env.NODE_ENV === "production";

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
      };

      const servicePorts = SERVICE_PORTS[catalog.name] || [{ name: "default", port: catalog.defaultPort, targetPort: catalog.defaultPort }];

      const nodePortSpec = buildNodePortService(
        kubeResName,
        instance.namespace,
        servicePorts,
        standardLabels(instance.id, catalog.name, instance.ProjectId),
      );
      await applyResource("Service", nodePortSpec, instance.namespace);
      await appendLog(instance, "  → NodePort Service created (external access)");

      // Read back ALL auto-assigned NodePorts
      const externalPorts = {}; // { portName: nodePort }
      try {
        const npSvc = await coreV1.readNamespacedService({
          name: `${kubeResName}-external`,
          namespace: instance.namespace,
        });
        for (const p of (npSvc?.spec?.ports || [])) {
          if (p.nodePort) {
            externalPorts[p.name] = p.nodePort;
            await appendLog(instance, `  → External ${p.name}: localhost:${p.nodePort}`);
          }
        }
      } catch {
        await appendLog(instance, "  ⚠ Could not read NodePort (non-fatal)");
      }

      /* ── Step 6: Wait for readiness ────────────────────────────── */
      await appendLog(instance, "  → Waiting for pod readiness (timeout: 120s)...");

      try {
        await waitForReady(kubeResName, 120_000, instance.namespace);
        await appendLog(instance, "  → Pod is ready! 🚀");
      } catch (readyErr) {
        await appendLog(instance, `  ⚠ Pod readiness check failed: ${readyErr.message.slice(0, 300)}`);
        throw readyErr;
      }

      /* ── Step 7: Build + encrypt connection details ────────────── */
      const internalHost = `${kubeResName}.${instance.namespace}.svc.cluster.local`;
      const externalHost = "localhost";

      // Primary external port (first port in the map)
      const primaryPortName = servicePorts[0].name;
      const primaryExternalPort = externalPorts[primaryPortName] || null;

      const connDetails = buildConnectionDetails(
        catalog.name,
        credentials,
        internalHost,
        catalog.defaultPort,
        primaryExternalPort ? externalHost : null,
        primaryExternalPort,
      );

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
