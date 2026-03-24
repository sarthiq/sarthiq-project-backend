/**
 * deployResolvers.js
 * Handles:
 *  - triggerDeploy / wakeProject mutations
 *  - getDeployStatus / getProjectDeployJobs / getAdminStats queries
 *  - registerKubeNode / deleteProjectDeploy mutations (admin)
 */
const { Op } = require("sequelize");
const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const KubeNode = require("../../Models/Deployment/kubeNode");
const { deployQueue, wakeQueue } = require("../../Jobs/queues");
const { deleteProjectResources } = require("../../Utils/kubeClient");
const { registerNode } = require("../../Utils/nodeManager");

// We'll try to pull user count from the existing User model
let User;
try {
  User = require("../../Models/User/user"); // adjust path if needed
} catch {
  User = null;
}

module.exports = {
  Query: {
    /* ── Get a single deployment job by ID ─────────────────────── */
    getDeployStatus: async (_, { jobId }, context) => {
      if (!context.user && !context.admin) throw new Error("Unauthorized");
      return await DeploymentJob.findByPk(jobId);
    },

    /* ── Get all deploy jobs for a project ─────────────────────── */
    getProjectDeployJobs: async (
      _,
      { projectId, limit = 10, offset = 0 },
      context
    ) => {
      if (!context.user && !context.admin) throw new Error("Unauthorized");

      const whereClause = { ProjectId: projectId };
      // Regular users can only see their own project's jobs
      if (context.user) {
        const project = await Project.findByPk(projectId);
        if (!project || project.UserId !== context.user.id) {
          throw new Error("Unauthorized");
        }
      }

      return await DeploymentJob.findAll({
        where: whereClause,
        order: [["createdAt", "DESC"]],
        limit,
        offset,
      });
    },

    /* ── Admin-only stats dashboard ─────────────────────────────── */
    getAdminStats: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin only");

      const [
        totalProjects,
        runningContainers,
        sleepingContainers,
        buildingContainers,
        failedContainers,
        totalDeployments,
        successfulDeployments,
        failedDeployments,
        projectsByLanguageRaw,
        projectsByFrameworkRaw,
        nodes,
      ] = await Promise.all([
        Project.count(),
        DockerInfo.count({ where: { status: "running" } }),
        DockerInfo.count({ where: { status: "sleeping" } }),
        DockerInfo.count({ where: { status: { [Op.in]: ["building", "queued"] } } }),
        DockerInfo.count({ where: { status: "failed" } }),
        DeploymentJob.count(),
        DeploymentJob.count({ where: { status: "done" } }),
        DeploymentJob.count({ where: { status: "failed" } }),
        // Group by language
        Project.findAll({
          attributes: [
            "projectLanguage",
            [require("../../database").literal("COUNT(*)"), "count"],
          ],
          group: ["projectLanguage"],
          raw: true,
        }),
        // Group by framework
        Project.findAll({
          attributes: [
            "frameWork",
            [require("../../database").literal("COUNT(*)"), "count"],
          ],
          group: ["frameWork"],
          raw: true,
        }),
        KubeNode.findAll(),
      ]);

      // User count (non-fatal if model not available)
      let totalUsers = 0;
      if (User) {
        totalUsers = await User.count().catch(() => 0);
      }

      return {
        totalUsers,
        totalProjects,
        runningContainers,
        sleepingContainers,
        buildingContainers,
        failedContainers,
        totalDeployments,
        successfulDeployments,
        failedDeployments,
        projectsByLanguage: projectsByLanguageRaw.map((r) => ({
          language: r.projectLanguage,
          count: parseInt(r.count),
        })),
        projectsByFramework: projectsByFrameworkRaw.map((r) => ({
          framework: r.frameWork,
          count: parseInt(r.count),
        })),
        nodeUtilization: nodes,
      };
    },

    /* ── List cluster nodes ─────────────────────────────────────── */
    getKubeNodes: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin only");
      return await KubeNode.findAll();
    },
  },

  Mutation: {
    /* ── Trigger a new deployment ──────────────────────────────── */
    triggerDeploy: async (_, { projectId }, context) => {
      if (!context.user && !context.admin) throw new Error("Unauthorized");

      const userId = context.user?.id || context.admin?.id;

      // Verify project ownership
      const project = await Project.findByPk(projectId);
      if (!project) throw new Error("Project not found");
      if (context.user && project.UserId !== context.user.id) {
        throw new Error("Unauthorized: Not your project");
      }

      // Check for an in-progress deployment
      const inProgress = await DeploymentJob.findOne({
        where: {
          ProjectId: projectId,
          status: { [Op.in]: ["queued", "building"] },
        },
      });
      if (inProgress) {
        throw new Error("A deployment is already in progress for this project");
      }

      // Create DB tracking record
      const dbJob = await DeploymentJob.create({
        ProjectId: parseInt(projectId),
        UserId: userId,
        status: "queued",
        logs: "[DEPLOY] Deployment queued by user\n",
      });

      // Update dockerInfo to queued
      await DockerInfo.update(
        { status: "queued" },
        { where: { ProjectId: projectId } }
      );

      // Enqueue BullMQ job
      const bullJob = await deployQueue.add(
        "deploy",
        {
          projectId: parseInt(projectId),
          deploymentJobId: dbJob.id,
          userId,
        },
        { jobId: `deploy-${projectId}-${dbJob.id}` } // prevent exact duplicates
      );

      // Store bullmq job ID
      dbJob.bullmqJobId = String(bullJob.id);
      await dbJob.save();

      return dbJob;
    },

    /* ── Wake a sleeping project ───────────────────────────────── */
    wakeProject: async (_, { projectId }, context) => {
      if (!context.user && !context.admin) throw new Error("Unauthorized");
      const userId = context.user?.id || context.admin?.id;

      const docker = await DockerInfo.findOne({
        where: { ProjectId: projectId },
      });
      if (!docker) throw new Error("DockerInfo not found");
      if (!["sleeping", "failed"].includes(docker.status)) {
        throw new Error(
          `Project is currently '${docker.status}', not sleeping or failed`
        );
      }

      const dbJob = await DeploymentJob.create({
        ProjectId: parseInt(projectId),
        UserId: userId,
        status: "queued",
        logs: "[WAKE] Manual wake triggered by user\n",
      });

      const bullJob = await wakeQueue.add("wake", {
        projectId: parseInt(projectId),
        deploymentJobId: dbJob.id,
      });

      dbJob.bullmqJobId = String(bullJob.id);
      await dbJob.save();

      return dbJob;
    },

    /* ── Delete all K8s resources for a project ────────────────── */
    deleteProjectDeploy: async (_, { projectId }, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin only");

      const project = await Project.findByPk(projectId);
      if (!project) throw new Error("Project not found");
      if (!project.subdomain) return true;

      await deleteProjectResources(project.subdomain).catch(() => {});
      await DockerInfo.update(
        { status: "idle", containerId: null, nodeId: null },
        { where: { ProjectId: projectId } }
      );

      return true;
    },

    /* ── Register a new K8s node into the DB ───────────────────── */
    registerKubeNode: async (
      _,
      { nodeName, totalCpuMillicores = 2000, totalMemoryMi = 4096 },
      context
    ) => {
      if (!context.admin) throw new Error("Unauthorized: Admin only");
      return await registerNode(nodeName, totalCpuMillicores, totalMemoryMi);
    },
  },
};
