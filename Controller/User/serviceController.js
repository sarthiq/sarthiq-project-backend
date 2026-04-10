/**
 * serviceController.js
 * ─────────────────────────────────────────────────────────────────────
 * REST API controller for infrastructure service management.
 * Handles CRUD operations, plan enforcement, and K8s lifecycle.
 * ─────────────────────────────────────────────────────────────────────
 */
const ServiceCatalog = require("../../Models/Services/serviceCatalog");
const ServiceInstance = require("../../Models/Services/serviceInstance");
const EnvironmentVariable = require("../../Models/Services/environmentVariable");
const Project = require("../../Models/Projects/projects");

const { serviceQueue } = require("../../Jobs/queues");
const {
  checkServiceCreationAllowed,
  getResourceUsage,
  getUserPlan,
} = require("../../Utils/planEnforcer");
const {
  encrypt,
  decrypt,
  randomAlphanumeric,
  generateCredentials,
  buildConnectionDetails,
  getAutoInjectMapping,
} = require("../../Utils/credentialManager");
const { canonicalServiceName } = require("../../Utils/serviceHostResolver");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

/* ── POST /api/services/create ─────────────────────────────────────── */
exports.createService = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      projectId,
      serviceType,
      config,
      template,
      externalAccessEnabled,
      externalAccessConfig = null,
    } = req.body;
    // Backward compatibility:
    // If the frontend has not yet shipped explicit external toggle support,
    // keep historical behavior (external access enabled).
    const shouldEnableExternal =
      externalAccessEnabled === undefined ? true : Boolean(externalAccessEnabled);

    // Validation
    if (!serviceType) {
      return res.status(400).json({
        success: false,
        message: "serviceType is required",
      });
    }

    // Verify project belongs to user (if projectId provided)
    let project = null;
    if (projectId) {
      project = await Project.findOne({
        where: { id: projectId, UserId: userId },
      });
      if (!project) {
        return res.status(404).json({
          success: false,
          message: "Project not found or access denied",
        });
      }
    }

    // Verify service exists in catalog and is active
    const catalogEntry = await ServiceCatalog.findOne({
      where: { name: serviceType, isActive: true },
    });
    if (!catalogEntry) {
      return res.status(400).json({
        success: false,
        message: `Service type "${serviceType}" is not available`,
      });
    }

    // Resolve resources from template
    const templates = catalogEntry.templates || {};
    const selectedTemplate = template || "small";
    const templateResources =
      templates[selectedTemplate] || catalogEntry.requiredResources;

    // Enforce plan limits
    const enforcement = await checkServiceCreationAllowed(
      userId,
      serviceType,
      templateResources
    );

    if (!enforcement.allowed) {
      return res.status(403).json({
        success: false,
        message: enforcement.reason,
        plan: enforcement.plan?.name,
        usage: enforcement.usage,
      });
    }

    // Generate instance name and namespace
    const instanceSuffix = randomAlphanumeric(4);
    const instanceName = projectId
      ? `${serviceType}-${projectId}-${instanceSuffix}`
      : `${serviceType}-standalone-${instanceSuffix}`;
    const namespace = projectId ? `project-${projectId}` : `user-${userId}-svc`;

    // Create ServiceInstance record
    const instance = await ServiceInstance.create({
      UserId: userId,
      ProjectId: projectId || null,
      ServiceCatalogId: catalogEntry.id,
      instanceName,
      status: "provisioning",
      config: config || null,
      namespace,
      template: selectedTemplate,
      resourceUsage: {
        cpu: templateResources.cpu,
        memory: templateResources.memory,
        storage: templateResources.storage,
      },
      externalAccessEnabled: shouldEnableExternal,
      externalAccessConfig: externalAccessConfig || null,
    });

    // Enqueue provisioning job
    await serviceQueue.add(
      `provision-${instanceName}`,
      { serviceInstanceId: instance.id },
      { jobId: `svc-${instance.id}-${Date.now()}` }
    );

    return res.status(202).json({
      success: true,
      message: "Service provisioning started",
      data: {
        id: instance.id,
        instanceName,
        status: "provisioning",
        serviceType,
        template: selectedTemplate,
        namespace,
        externalAccessEnabled: shouldEnableExternal,
        estimatedTime: "30-60s",
      },
    });
  } catch (err) {
    console.error("[serviceController] createService error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create service",
      error: err.message,
    });
  }
};

/* ── DELETE /api/services/:id ──────────────────────────────────────── */
exports.deleteService = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const instance = await ServiceInstance.findOne({
      where: { id, UserId: userId },
    });
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Service not found or access denied",
      });
    }

    // Mark as deleting
    instance.status = "deleting";
    await instance.save();

    // Delete K8s resources
    const kubeResName = instance.kubeResourceName;
    const namespace = instance.namespace;
    const canonicalService = canonicalServiceName(
      instance.ServiceCatalog?.name || instance.instanceName.split("-")[0],
      instance.ProjectId
    );

    if (kubeResName && namespace) {
      try {
        // Delete StatefulSet or Deployment
        await appsV1
          .deleteNamespacedStatefulSet({ name: kubeResName, namespace })
          .catch(() =>
            appsV1.deleteNamespacedDeployment({ name: kubeResName, namespace })
          )
          .catch(() => {});

        // Delete Service (ClusterIP)
        await coreV1
          .deleteNamespacedService({ name: kubeResName, namespace })
          .catch(() => {});

        // Delete NodePort Service (external access)
        await coreV1
          .deleteNamespacedService({ name: `${kubeResName}-external`, namespace })
          .catch(() => {});

        await coreV1
          .deleteNamespacedService({ name: canonicalService, namespace })
          .catch(() => {});

        await coreV1
          .deleteNamespacedService({ name: `${canonicalService}-external`, namespace })
          .catch(() => {});

        // Delete Secret
        await coreV1
          .deleteNamespacedSecret({ name: `${kubeResName}-secret`, namespace })
          .catch(() => {});

        // Delete ConfigMap
        await coreV1
          .deleteNamespacedConfigMap({ name: `${kubeResName}-config`, namespace })
          .catch(() => {});

        // PVCs: retain for 24h (handled by cleanup cron)
        // Mark them for deferred deletion via label
        try {
          const pvcList = await coreV1.listNamespacedPersistentVolumeClaim({
            namespace,
            labelSelector: `sarthiq.com/instanceId=${instance.id}`,
          });
          for (const pvc of (pvcList.items || [])) {
            const pvcName = pvc.metadata.name;
            await coreV1.patchNamespacedPersistentVolumeClaim(
              { name: pvcName, namespace, body: [
                { op: "add", path: "/metadata/annotations/sarthiq.com~1delete-after", value: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
              ] },
              undefined, undefined, undefined, undefined, undefined, undefined,
              { headers: { "Content-Type": "application/json-patch+json" } }
            );
          }
        } catch (pvcErr) {
          // Non-fatal — PVC cleanup is best-effort
          console.warn("[serviceController] PVC label error:", pvcErr.message);
        }

        console.log(`[serviceController] K8s resources deleted for ${kubeResName}`);
      } catch (k8sErr) {
        console.error("[serviceController] K8s deletion error:", k8sErr.message);
      }
    }

    // Delete auto-injected env vars
    await EnvironmentVariable.destroy({
      where: { sourceServiceInstanceId: instance.id },
    });

    // Delete the instance record
    await instance.destroy();

    return res.json({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (err) {
    console.error("[serviceController] deleteService error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to delete service",
      error: err.message,
    });
  }
};

/* ── GET /api/services/project/:projectId ──────────────────────────── */
exports.listServices = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId } = req.params;

    // Verify project belongs to user
    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    const instances = await ServiceInstance.findAll({
      where: { ProjectId: projectId, UserId: userId },
      include: [{ model: ServiceCatalog, attributes: ["name", "displayName", "category", "defaultPort"] }],
      order: [["createdAt", "DESC"]],
    });

    const data = instances.map((inst) => ({
      id: inst.id,
      instanceName: inst.instanceName,
      status: inst.status,
      serviceType: inst.ServiceCatalog?.name,
      displayName: inst.ServiceCatalog?.displayName,
      category: inst.ServiceCatalog?.category,
      template: inst.template,
      resourceUsage: inst.resourceUsage,
      isExternal: inst.isExternal,
      namespace: inst.namespace,
      createdAt: inst.createdAt,
      errorMessage: inst.status === "failed" ? inst.errorMessage : undefined,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[serviceController] listServices error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to list services",
      error: err.message,
    });
  }
};

/* ── GET /api/services/:id ─────────────────────────────────────────── */
exports.getService = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const instance = await ServiceInstance.findOne({
      where: { id, UserId: userId },
      include: [{ model: ServiceCatalog }],
    });

    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Service not found or access denied",
      });
    }

    // Decrypt connection details
    let connectionDetails = null;
    if (instance.connectionDetails) {
      try {
        connectionDetails = JSON.parse(decrypt(instance.connectionDetails));
        // Mask password in response
        if (connectionDetails.password) {
          connectionDetails.passwordMasked =
            connectionDetails.password.slice(0, 4) + "****";
        }
        if (connectionDetails.secretKey) {
          connectionDetails.secretKeyMasked =
            connectionDetails.secretKey.slice(0, 4) + "****";
        }
      } catch {
        connectionDetails = { error: "Unable to decrypt credentials" };
      }
    }

    // Get auto-injected env vars
    const envVars = await EnvironmentVariable.findAll({
      where: { sourceServiceInstanceId: instance.id },
      attributes: ["key", "isAutoInjected"],
    });

    return res.json({
      success: true,
      data: {
        id: instance.id,
        instanceName: instance.instanceName,
        status: instance.status,
        serviceType: instance.ServiceCatalog?.name,
        displayName: instance.ServiceCatalog?.displayName,
        category: instance.ServiceCatalog?.category,
        template: instance.template,
        connectionDetails,
        resourceUsage: instance.resourceUsage,
        isExternal: instance.isExternal,
        namespace: instance.namespace,
        config: instance.config,
        autoInjectedEnvVars: envVars.map((v) => v.key),
        provisionLogs: instance.provisionLogs,
        errorMessage: instance.status === "failed" ? instance.errorMessage : undefined,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      },
    });
  } catch (err) {
    console.error("[serviceController] getService error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get service",
      error: err.message,
    });
  }
};

/* ── GET /api/services/catalog ─────────────────────────────────────── */
exports.getCatalog = async (req, res) => {
  try {
    const catalog = await ServiceCatalog.findAll({
      where: { isActive: true },
      attributes: [
        "id",
        "name",
        "displayName",
        "category",
        "defaultPort",
        "requiredResources",
        "templates",
        "configSchema",
      ],
      order: [["category", "ASC"], ["name", "ASC"]],
    });

    return res.json({ success: true, data: catalog });
  } catch (err) {
    console.error("[serviceController] getCatalog error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get catalog",
      error: err.message,
    });
  }
};

/* ── POST /api/services/:id/stop ───────────────────────────────────── */
exports.stopService = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const instance = await ServiceInstance.findOne({
      where: { id, UserId: userId, status: "running" },
    });
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Running service not found",
      });
    }

    // Scale to 0
    const kubeResName = instance.kubeResourceName;
    const namespace = instance.namespace;
    const patch = [{ op: "replace", path: "/spec/replicas", value: 0 }];

    try {
      await appsV1.patchNamespacedStatefulSet(
        { name: kubeResName, namespace, body: patch },
        undefined, undefined, undefined, undefined, undefined, undefined,
        { headers: { "Content-Type": "application/json-patch+json" } }
      );
    } catch {
      await appsV1.patchNamespacedDeployment(
        { name: kubeResName, namespace, body: patch },
        undefined, undefined, undefined, undefined, undefined, undefined,
        { headers: { "Content-Type": "application/json-patch+json" } }
      );
    }

    instance.status = "stopped";
    await instance.save();

    return res.json({
      success: true,
      message: "Service stopped",
    });
  } catch (err) {
    console.error("[serviceController] stopService error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to stop service",
      error: err.message,
    });
  }
};

/* ── POST /api/services/:id/start ──────────────────────────────────── */
exports.startService = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const instance = await ServiceInstance.findOne({
      where: { id, UserId: userId, status: "stopped" },
    });
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Stopped service not found",
      });
    }

    // Scale to 1
    const kubeResName = instance.kubeResourceName;
    const namespace = instance.namespace;
    const patch = [{ op: "replace", path: "/spec/replicas", value: 1 }];

    try {
      await appsV1.patchNamespacedStatefulSet(
        { name: kubeResName, namespace, body: patch },
        undefined, undefined, undefined, undefined, undefined, undefined,
        { headers: { "Content-Type": "application/json-patch+json" } }
      );
    } catch {
      await appsV1.patchNamespacedDeployment(
        { name: kubeResName, namespace, body: patch },
        undefined, undefined, undefined, undefined, undefined, undefined,
        { headers: { "Content-Type": "application/json-patch+json" } }
      );
    }

    instance.status = "running";
    await instance.save();

    return res.json({
      success: true,
      message: "Service started",
    });
  } catch (err) {
    console.error("[serviceController] startService error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to start service",
      error: err.message,
    });
  }
};

/* ── GET /api/services/usage ───────────────────────────────────────── */
exports.getUsage = async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = await getUserPlan(userId);
    const usage = await getResourceUsage(userId);

    return res.json({
      success: true,
      data: {
        plan: {
          name: plan.name,
          maxServices: plan.maxServices,
          maxCpuMillicores: plan.maxCpuMillicores,
          maxMemoryMi: plan.maxMemoryMi,
          maxStorageGi: plan.maxStorageGi,
          maxCronJobs: plan.maxCronJobs,
          allowedServices: plan.allowedServices,
        },
        usage,
      },
    });
  } catch (err) {
    console.error("[serviceController] getUsage error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get usage",
      error: err.message,
    });
  }
};

/* ── GET /api/services/user ─────────────────────────────────────── */
exports.listUserServices = async (req, res) => {
  try {
    const userId = req.user.id;

    const instances = await ServiceInstance.findAll({
      where: { UserId: userId },
      include: [
        { model: ServiceCatalog, attributes: ["name", "displayName", "category", "defaultPort"] },
        { model: Project, attributes: ["id", "title", "subdomain"], required: false },
      ],
      order: [["createdAt", "DESC"]],
    });

    const data = instances.map((inst) => ({
      id: inst.id,
      instanceName: inst.instanceName,
      status: inst.status,
      serviceType: inst.ServiceCatalog?.name,
      displayName: inst.ServiceCatalog?.displayName,
      category: inst.ServiceCatalog?.category,
      template: inst.template,
      resourceUsage: inst.resourceUsage,
      isExternal: inst.isExternal,
      namespace: inst.namespace,
      projectId: inst.ProjectId,
      projectTitle: inst.Project?.title || null,
      projectSubdomain: inst.Project?.subdomain || null,
      createdAt: inst.createdAt,
      errorMessage: inst.status === "failed" ? inst.errorMessage : undefined,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[serviceController] listUserServices error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to list services",
      error: err.message,
    });
  }
};

/* ── PATCH /api/services/:id/project ───────────────────────────── */
exports.assignServiceProject = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { projectId } = req.body; // null to make standalone, or ID to assign

    const instance = await ServiceInstance.findOne({
      where: { id, UserId: userId },
    });
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: "Service not found or access denied",
      });
    }

    // Validate project if provided
    if (projectId) {
      const project = await Project.findOne({
        where: { id: projectId, UserId: userId },
      });
      if (!project) {
        return res.status(404).json({
          success: false,
          message: "Project not found or access denied",
        });
      }
    }

    // Update the project assignment
    instance.ProjectId = projectId || null;
    await instance.save();

    return res.json({
      success: true,
      message: projectId
        ? "Service assigned to project"
        : "Service detached from project (standalone)",
      data: { id: instance.id, ProjectId: instance.ProjectId },
    });
  } catch (err) {
    console.error("[serviceController] assignServiceProject error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to update service project",
      error: err.message,
    });
  }
};

/* ── POST /api/services/external ───────────────────────────────────── */
exports.registerExternalService = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId, serviceType, connectionUri, displayName } = req.body;

    if (!projectId || !serviceType || !connectionUri) {
      return res.status(400).json({
        success: false,
        message: "projectId, serviceType, and connectionUri are required",
      });
    }

    // Verify project
    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    // Find catalog entry (even inactive ones for BYOS)
    const catalogEntry = await ServiceCatalog.findOne({
      where: { name: serviceType },
    });

    const instance = await ServiceInstance.create({
      UserId: userId,
      ProjectId: projectId,
      ServiceCatalogId: catalogEntry ? catalogEntry.id : null,
      instanceName: `ext-${serviceType}-${projectId}-${randomAlphanumeric(4)}`,
      status: "running",
      namespace: "external",
      isExternal: true,
      externalConnectionUri: encrypt(connectionUri),
      resourceUsage: { cpu: "0", memory: "0", storage: "0" },
    });

    // Auto-inject env vars if we know the service type
    if (catalogEntry) {
      const mapping = getAutoInjectMapping(serviceType);
      // For external, just inject the URI
      const mainUriKey = Object.keys(mapping).find(
        (k) => mapping[k] === "uri"
      );
      if (mainUriKey) {
        await EnvironmentVariable.upsert({
          ProjectId: projectId,
          key: mainUriKey,
          value: encrypt(connectionUri),
          isAutoInjected: true,
          sourceServiceInstanceId: instance.id,
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: "External service registered",
      data: {
        id: instance.id,
        instanceName: instance.instanceName,
        status: "running",
        isExternal: true,
      },
    });
  } catch (err) {
    console.error("[serviceController] registerExternal error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to register external service",
      error: err.message,
    });
  }
};
