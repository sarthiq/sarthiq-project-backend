const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const TierConfig = require("../../Models/Projects/tierConfig");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const KubeNode = require("../../Models/Deployment/kubeNode");
const { deleteProjectResources } = require("../../Utils/kubeClient");
const { releaseNode } = require("../../Utils/nodeManager");
const { logUserActivity } = require("../../Utils/activityLoggers");
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
        // 1. Delete K8s resources if deployed
        if (project.subdomain) {
          await deleteProjectResources(project.subdomain).catch((err) => {
            console.warn(`[deleteProject] K8s cleanup skipped: ${err.message}`);
          });
        }

        // 2. Release KubeNode capacity if assigned
        const dockerInfo = await DockerInfo.findOne({ where: { ProjectId: projectId } });
        if (dockerInfo?.nodeId) {
          const kubeNode = await KubeNode.findOne({ where: { nodeName: dockerInfo.nodeId } });
          if (kubeNode) {
            await releaseNode(kubeNode.id);
            console.log(`[deleteProject] Released node capacity for ${dockerInfo.nodeId}`);
          }
        }

        // 3. Delete related DB records (order matters for FK constraints)
        await DeploymentJob.destroy({ where: { ProjectId: projectId } });
        await DockerInfo.destroy({ where: { ProjectId: projectId } });
        await project.destroy();

        // 3. Log activity
        await logUserActivity(
          context.user.id,
          'DELETE_PROJECT',
          `Project deleted: ${project.title}`
        );

        return true;
      } catch (error) {
        console.error(error);
        throw new Error(error.message || "Failed to delete project");
      }
    }
  }
};
