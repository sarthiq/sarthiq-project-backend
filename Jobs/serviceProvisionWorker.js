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
  canonicalServiceName,
  canonicalNamespace,
} = require("../Utils/serviceHostResolver");
const {
  getServiceEndpoints,
  generateServiceConnection,
} = require("../Utils/serviceConnectionResolver");

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
      const endpointConfig = getServiceEndpoints(catalog.name, catalog.defaultPort);
      const servicePorts = [endpointConfig.primary, ...endpointConfig.secondary];

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
      await appendLog(instance, "  → Waiting for pod readiness (timeout: 120s)...");

      try {
        await waitForReady(kubeResName, 120_000, instance.namespace);
        await appendLog(instance, "  → Pod is ready! 🚀");
      } catch (readyErr) {
        await appendLog(instance, `  ⚠ Pod readiness check failed: ${readyErr.message.slice(0, 300)}`);
        throw readyErr;
      }

      /* ── Step 7: Build + encrypt connection details ────────────── */
      const { hostDetails, result: connDetails } = generateServiceConnection({
        serviceInstance: instance.toJSON(),
        serviceType: catalog.name,
        credentials,
        defaultPort: catalog.defaultPort,
        environment: process.env.APP_ENV || process.env.NODE_ENV,
        externalPorts,
      });
      const internalHost = hostDetails.internal_host;
      const externalHost = hostDetails.external_host;

      instance.connectionDetails = encrypt(JSON.stringify(connDetails));
      instance.status = "running";
      await instance.save();

      await appendLog(instance, `  → Internal: ${internalHost}:${catalog.defaultPort}`);
      if (connDetails.externalPort) {
        await appendLog(instance, `  → External: ${externalHost}:${connDetails.externalPort}`);
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
