const TierConfig = require("../../Models/Projects/tierConfig");
const { logAdminActivity } = require("../../Utils/activityLoggers");

module.exports = {
  Query: {
    getTierConfigs: async (_, __, context) => {
      return await TierConfig.findAll();
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
