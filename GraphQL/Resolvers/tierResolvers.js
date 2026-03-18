const TierConfig = require("../../Models/Projects/tierConfig");
const { logAdminActivity } = require("../../Utils/activityLoggers");
const { Op } = require("sequelize");

module.exports = {
  Query: {
    getTierConfigs: async (_, { search, limit = 10, offset = 0 }, context) => {
      const whereClause = {};
      
      if (search) {
        whereClause.tierName = { [Op.like]: `%${search}%` };
      }

      return await TierConfig.findAll({
        where: whereClause,
        limit,
        offset
      });
    }
  },

  Mutation: {
    adminUpdateTierConfig: async (_, { tierName, input }, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token missing or invalid");

      const adminId = context.admin.id;

      try {
        let tier = await TierConfig.findOne({ where: { tierName } });
        
        if (!tier) throw new Error(`TierConfig with name ${tierName} not found`);

        await tier.update(input);

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
