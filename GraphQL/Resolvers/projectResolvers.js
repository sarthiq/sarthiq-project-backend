const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const TierConfig = require("../../Models/Projects/tierConfig");
const { logUserActivity } = require("../../Utils/activityLoggers");
const { Op } = require("sequelize");

module.exports = {
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
          envVariables: JSON.parse(input.envVariables || "{}"),
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
    }
  }
};
