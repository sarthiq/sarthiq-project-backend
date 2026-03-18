const Project = require("../Models/Projects/projects");
const DockerInfo = require("../Models/Projects/dockerInfo");
const TierConfig = require("../Models/Projects/tierConfig");
const { logAdminActivity, logUserActivity } = require("../Utils/activityLoggers");

const resolvers = {
  Query: {
    getProjects: async (_, __, context) => {
      // Example restricted query: Only user or admin can see projects
      if (!context.user && !context.admin) {
        throw new Error("Unauthorized");
      }
      return await Project.findAll({
        where: context.user ? { UserId: context.user.id } : {},
        include: [DockerInfo] // Depends on relations being set up properly in Sequelize
      });
    },
    getTierConfigs: async (_, __, context) => {
      return await TierConfig.findAll();
    },
    getUserActivities: async (_, __, context) => {
      if (!context.user) throw new Error("Unauthorized: User token required");
      const UserActivity = require("../Models/User/userActivity");
      return await UserActivity.findAll({
        where: { UserId: context.user.id },
        order: [['createdAt', 'DESC']]
      });
    },
    getAdminActivities: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      const AdminActivity = require("../Models/User/adminActivity");
      return await AdminActivity.findAll({
        where: { AdminId: context.admin.id },
        order: [['createdAt', 'DESC']]
      });
    },
    getAllUserActivities: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      const UserActivity = require("../Models/User/userActivity");
      return await UserActivity.findAll({
        order: [['createdAt', 'DESC']]
      });
    }
  },
  
  Mutation: {
    userCreateProject: async (_, { input }, context) => {
      // 1. Verify User Authentication (Populated by Express Auth Middleware)
      if (!context.user) {
        throw new Error("Unauthorized: User token missing or invalid");
      }

      const userId = context.user.id;

      try {
        // 2. Fetch the Default Free Tier Config (id: 1)
        let freeTier = await TierConfig.findOne({ where: { tierName: 'Free' } });
        
        // Fallback: Create it if it doesn't exist yet to prevent crashes during fresh setups
        if (!freeTier) {
          freeTier = await TierConfig.create({ tierName: 'Free' });
        }

        // 3. Optional: Check limits
        const projectCount = await Project.count({ where: { UserId: userId } });
        if (projectCount >= freeTier.maxProjectsPerUser) {
          throw new Error("Free tier limit reached. Cannot create more projects.");
        }

        // 4. Create the Project
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

        // 5. Create the associated DockerInfo utilizing the FREE Tier Constraints!
        const newDockerInfo = await DockerInfo.create({
          ProjectId: newProject.id, // Associated Project
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

        // 6. Log the User Activity securely
        await logUserActivity(
          userId, 
          'CREATE_PROJECT', 
          `Project created: ${newProject.title} with Free tier limits`
        );

        // Fetch again to include DockerInfo in the GraphQL response
        const projectWithRelations = await Project.findByPk(newProject.id, {
          include: [DockerInfo]
        });

        return projectWithRelations;

      } catch (error) {
        console.error(error);
        throw new Error(error.message || "Failed to create project");
      }
    },

    adminUpdateTierConfig: async (_, { tierName, input }, context) => {
      // 1. Verify Admin Authentication
      if (!context.admin) {
        throw new Error("Unauthorized: Admin token missing or invalid");
      }

      const adminId = context.admin.id;

      try {
        let tier = await TierConfig.findOne({ where: { tierName } });
        
        if (!tier) {
          throw new Error(`TierConfig with name ${tierName} not found`);
        }

        // 2. Update constraints
        await tier.update(input);

        // 3. Log the Admin Activity
        await logAdminActivity(
          adminId,
          'UPDATE_TIER_CONFIG',
          `Admin updated tier limits for: ${tierName}`
        );

        return tier;

      } catch (error) {
        throw new Error(error.message || "Failed to update tier config");
      }
    }
  }
};

module.exports = resolvers;
