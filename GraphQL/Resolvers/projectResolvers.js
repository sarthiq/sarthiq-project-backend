const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const TierConfig = require("../../Models/Projects/tierConfig");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const KubeNode = require("../../Models/Deployment/kubeNode");
const ServiceInstance = require("../../Models/Services/serviceInstance");
const EnvironmentVariable = require("../../Models/Services/environmentVariable");
const CronJobInstance = require("../../Models/Services/cronJobInstance");
const { deleteProjectResources, deleteNamespace, NAMESPACE } = require("../../Utils/kubeClient");
const { canonicalServiceName } = require("../../Utils/serviceHostResolver");
const k8s = require("@kubernetes/client-node");
const _kc = new k8s.KubeConfig();
_kc.loadFromDefault();
const _appsV1 = _kc.makeApiClient(k8s.AppsV1Api);
const _coreV1 = _kc.makeApiClient(k8s.CoreV1Api);
const _batchV1 = _kc.makeApiClient(k8s.BatchV1Api);
const { releaseNode } = require("../../Utils/nodeManager");
const { logUserActivity } = require("../../Utils/activityLoggers");
const { deployQueue, wakeQueue } = require("../../Jobs/queues");
const { Op } = require("sequelize");

// ── Security validators ──
const {
  validateRepoUrl,
  validateBranch,
  validateEnvVars,
  validateProjectDirectory,
  validateBuildCommand,
} = require("../../Utils/securityValidator");

module.exports = {
  Project: {
    envVariables: (parent) => {
      // Ensure we return a string since the GraphQL schema expects a String
      if (typeof parent.envVariables === "object" && parent.envVariables !== null) {
        return JSON.stringify(parent.envVariables);
      }
      return parent.envVariables || "{}";
    }
  },

  Query: {
    getProjects: async (_, { search, limit = 10, offset = 0 }, context) => {
      if (!context.user && !context.admin) {
        throw new Error("Unauthorized");
      }

      const whereClause = context.user ? { UserId: context.user.id } : {};
      
      if (search) {
        whereClause[Op.or] = [
          { title: { [Op.like]: `%${search}%` } },
          { description: { [Op.like]: `%${search}%` } }
        ];
      }

      return await Project.findAll({
        where: whereClause,
        limit,
        offset,
        include: [DockerInfo]
      });
    }
  },
  
  Mutation: {
    userCreateProject: async (_, { input }, context) => {
      if (!context.user) throw new Error("Unauthorized: User token missing or invalid");

      const userId = context.user.id;

      try {
        let freeTier = await TierConfig.findOne({ where: { tierName: 'Free' } });
        if (!freeTier) {
          freeTier = await TierConfig.create({ tierName: 'Free' });
        }

        const projectCount = await Project.count({ where: { UserId: userId } });
        if (projectCount >= freeTier.maxProjectsPerUser) {
          throw new Error("Free tier limit reached. Cannot create more projects.");
        }

        // ── Security: Validate all user inputs before DB operations ──
        validateRepoUrl(input.projectRepoUrl);
        validateBranch(input.branch);
        validateProjectDirectory(input.projectDirectory);
        if (input.buildCommand) validateBuildCommand(input.buildCommand);

        // Validate env vars
        let parsedEnvVars = {};
        try {
          parsedEnvVars = JSON.parse(input.envVariables || "{}");
        } catch {
          throw new Error("Invalid envVariables JSON format.");
        }
        validateEnvVars(parsedEnvVars);

        const newProject = await Project.create({
          title: input.title,
          description: input.description,
          projectRepoUrl: input.projectRepoUrl,
          projectLanguage: input.projectLanguage,
          frameWork: input.frameWork,
          branch: input.branch,
          projectDirectory: input.projectDirectory,
          buildCommand: input.buildCommand,
          buildDirectory: input.buildDirectory,
          envVariables: parsedEnvVars,
          UserId: userId,
        });

        const newDockerInfo = await DockerInfo.create({
          ProjectId: newProject.id,
          UserId: userId,
          memory: freeTier.defaultMemory,
          cpu: freeTier.defaultCpu,
          disk: freeTier.defaultDisk,
          pidsLimit: freeTier.defaultPidsLimit,
          ulimit: freeTier.defaultUlimit,
          logOpt: freeTier.defaultLogOpt,
          restartPolicy: freeTier.defaultRestartPolicy,
          workingDir: '/app',
          networkMode: 'bridge',
        });

        await logUserActivity(
          userId, 
          'CREATE_PROJECT', 
          `Project created: ${newProject.title} with Free tier limits`
        );

        return await Project.findByPk(newProject.id, {
          include: [DockerInfo]
        });

      } catch (error) {
        console.error(error);
        throw new Error(error.message || "Failed to create project");
      }
    },

    userUpdateProject: async (_, { projectId, input }, context) => {
      if (!context.user) throw new Error("Unauthorized: User token missing or invalid");

      const project = await Project.findByPk(projectId);
      if (!project) throw new Error("Project not found");
      if (project.UserId !== context.user.id) throw new Error("Unauthorized: Not your project");

      try {
        const updateData = {};
        if (input.title !== undefined) updateData.title = input.title;
        if (input.description !== undefined) updateData.description = input.description;

        // Security: validate inputs that affect deployment
        if (input.projectRepoUrl !== undefined) {
          validateRepoUrl(input.projectRepoUrl);
          updateData.projectRepoUrl = input.projectRepoUrl;
        }
        if (input.projectLanguage !== undefined) updateData.projectLanguage = input.projectLanguage;
        if (input.frameWork !== undefined) updateData.frameWork = input.frameWork;
        if (input.branch !== undefined) {
          validateBranch(input.branch);
          updateData.branch = input.branch;
        }
        if (input.projectDirectory !== undefined) {
          validateProjectDirectory(input.projectDirectory);
          updateData.projectDirectory = input.projectDirectory;
        }
        if (input.buildCommand !== undefined) {
          if (input.buildCommand) validateBuildCommand(input.buildCommand);
          updateData.buildCommand = input.buildCommand;
        }
        if (input.buildDirectory !== undefined) updateData.buildDirectory = input.buildDirectory;
        if (input.envVariables !== undefined) {
          let parsedVars = {};
          try {
            parsedVars = JSON.parse(input.envVariables || "{}");
          } catch {
            throw new Error("Invalid envVariables JSON format.");
          }
          validateEnvVars(parsedVars);
          updateData.envVariables = parsedVars;
        }

        await project.update(updateData);

        await logUserActivity(
          context.user.id, 
          'UPDATE_PROJECT', 
          `Project updated: ${project.title}`
        );

        return await Project.findByPk(projectId, {
          include: [DockerInfo]
        });

      } catch (error) {
        console.error(error);
        throw new Error(error.message || "Failed to update project");
      }
    },

    userDeleteProject: async (_, { projectId }, context) => {
      if (!context.user) throw new Error("Unauthorized: User token missing or invalid");

      const project = await Project.findByPk(projectId);
      if (!project) throw new Error("Project not found");
      if (project.UserId !== context.user.id) throw new Error("Unauthorized: Not your project");

      try {
        console.log(`[deleteProject] Starting full cleanup for project #${projectId} (${project.title})...`);

        // ── 1. Cancel active BullMQ jobs for this project ─────────
        try {
          const activeJobs = await deployQueue.getJobs(["active", "waiting", "delayed"]);
          for (const job of activeJobs) {
            if (job.data?.projectId === projectId || String(job.data?.projectId) === String(projectId)) {
              await job.remove().catch(() => {});
              console.log(`[deleteProject] Removed deploy job ${job.id}`);
            }
          }
          const wakeJobs = await wakeQueue.getJobs(["active", "waiting", "delayed"]);
          for (const job of wakeJobs) {
            if (job.data?.projectId === projectId || String(job.data?.projectId) === String(projectId)) {
              await job.remove().catch(() => {});
              console.log(`[deleteProject] Removed wake job ${job.id}`);
            }
          }
        } catch (qErr) {
          console.warn(`[deleteProject] BullMQ cleanup skipped: ${qErr.message}`);
        }

        // ── 2. Delete K8s resources if deployed ──────────────────
        if (project.subdomain) {
          await deleteProjectResources(project.subdomain).catch((err) => {
            console.warn(`[deleteProject] K8s resource cleanup skipped: ${err.message}`);
          });
        }

        // ── 3. Namespace cleanup ─────────────────────────────────
        // Services now run in the shared sarthiq-apps namespace,
        // so we do NOT delete a per-project namespace here.
        // Service K8s resources are cleaned up via ServiceInstance deletion below.

        // ── 4. Release KubeNode capacity if assigned ─────────────
        const dockerInfo = await DockerInfo.findOne({ where: { ProjectId: projectId } });
        if (dockerInfo?.nodeId) {
          const kubeNode = await KubeNode.findOne({ where: { nodeName: dockerInfo.nodeId } });
          if (kubeNode) {
            await releaseNode(kubeNode.id);
            console.log(`[deleteProject] Released node capacity for ${dockerInfo.nodeId}`);
          }
        }

        // ── 5. Delete services K8s resources + DB records ─────────
        const projectServices = await ServiceInstance.findAll({ where: { ProjectId: projectId } });
        for (const svc of projectServices) {
          const kubeResName = svc.kubeResourceName;
          const svcNs = svc.namespace || NAMESPACE;
          if (kubeResName && svcNs) {
            console.log(`[deleteProject] Cleaning K8s resources for service ${svc.id} (${kubeResName} in ${svcNs})`);
            // Delete StatefulSet or Deployment
            try {
              await _appsV1.deleteNamespacedStatefulSet({ name: kubeResName, namespace: svcNs, body: { propagationPolicy: "Foreground" } });
              console.log(`[deleteProject] ✓ StatefulSet '${kubeResName}' deleted`);
            } catch (ssErr) {
              if (ssErr?.statusCode !== 404) {
                try {
                  await _appsV1.deleteNamespacedDeployment({ name: kubeResName, namespace: svcNs, body: { propagationPolicy: "Foreground" } });
                  console.log(`[deleteProject] ✓ Deployment '${kubeResName}' deleted`);
                } catch (depErr) {
                  if (depErr?.statusCode !== 404) {
                    console.warn(`[deleteProject] Workload '${kubeResName}' delete warning:`, depErr?.body?.message || depErr.message);
                  }
                }
              }
            }
            // Delete K8s Services
            const serviceType = svc.instanceName?.split("-")[0] || "unknown";
            const canonical = canonicalServiceName(serviceType, projectId);
            for (const name of [kubeResName, `${kubeResName}-external`, canonical, `${canonical}-external`]) {
              try { await _coreV1.deleteNamespacedService({ name, namespace: svcNs }); } catch (e) { /* 404 ok */ }
            }
            // Delete Secret + ConfigMap
            try { await _coreV1.deleteNamespacedSecret({ name: `${kubeResName}-secret`, namespace: svcNs }); } catch (e) { /* ok */ }
            try { await _coreV1.deleteNamespacedConfigMap({ name: `${kubeResName}-config`, namespace: svcNs }); } catch (e) { /* ok */ }
          }
          // Delete auto-injected env vars for this service
          await EnvironmentVariable.destroy({ where: { sourceServiceInstanceId: svc.id } }).catch(() => 0);
        }
        const svcCount = await ServiceInstance.destroy({ where: { ProjectId: projectId } }).catch(() => 0);

        // Delete cron jobs K8s resources + DB records
        const projectCrons = await CronJobInstance.findAll({ where: { ProjectId: projectId } });
        for (const cj of projectCrons) {
          if (cj.kubeResourceName && cj.namespace) {
            try {
              await _batchV1.deleteNamespacedCronJob({ name: cj.kubeResourceName, namespace: cj.namespace, body: { propagationPolicy: "Foreground" } });
              console.log(`[deleteProject] ✓ CronJob '${cj.kubeResourceName}' deleted`);
            } catch (cjErr) {
              if (cjErr?.statusCode !== 404) {
                console.warn(`[deleteProject] CronJob '${cj.kubeResourceName}' delete warning:`, cjErr?.body?.message || cjErr.message);
              }
            }
          }
        }
        const cronCount = await CronJobInstance.destroy({ where: { ProjectId: projectId } }).catch(() => 0);
        const envCount = await EnvironmentVariable.destroy({ where: { ProjectId: projectId } }).catch(() => 0);

        if (svcCount || envCount || cronCount) {
          console.log(`[deleteProject] Cleaned: ${svcCount} services, ${envCount} env vars, ${cronCount} cron jobs`);
        }

        // ── 6. Delete core DB records (order matters for FK) ─────
        await DeploymentJob.destroy({ where: { ProjectId: projectId } });
        await DockerInfo.destroy({ where: { ProjectId: projectId } });
        await project.destroy();

        // ── 7. Log activity ──────────────────────────────────────
        await logUserActivity(
          context.user.id,
          'DELETE_PROJECT',
          `Project deleted: ${project.title}`
        );

        console.log(`[deleteProject] ✅ Full cleanup complete for project #${projectId}`);
        return true;
      } catch (error) {
        console.error(`[deleteProject] FAILED for #${projectId}:`, error);
        throw new Error(error.message || "Failed to delete project");
      }
    }
  }
};
