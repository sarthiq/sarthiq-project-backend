const UserActivity = require("../../Models/User/userActivity");
const AdminActivity = require("../../Models/User/adminActivity");
const { Op } = require("sequelize");

const buildActivityWhere = (baseWhere, search) => {
  if (!search) return baseWhere;
  return {
    ...baseWhere,
    [Op.or]: [
      { activityType: { [Op.like]: `%${search}%` } },
      { activityDescription: { [Op.like]: `%${search}%` } },
      { ipAddress: { [Op.like]: `%${search}%` } }
    ]
  };
};

module.exports = {
  Query: {
    getUserActivities: async (_, { search, limit = 10, offset = 0 }, context) => {
      if (!context.user) throw new Error("Unauthorized: User token required");
      const whereClause = buildActivityWhere({ UserId: context.user.id }, search);
      return await UserActivity.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit,
        offset
      });
    },
    getAdminActivities: async (_, { search, limit = 10, offset = 0 }, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      const whereClause = buildActivityWhere({ AdminId: context.admin.id }, search);
      return await AdminActivity.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit,
        offset
      });
    },
    getAllUserActivities: async (_, { search, limit = 10, offset = 0 }, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      const whereClause = buildActivityWhere({}, search);
      return await UserActivity.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit,
        offset
      });
    }
  }
};
