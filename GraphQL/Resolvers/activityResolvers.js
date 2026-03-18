const UserActivity = require("../../Models/User/userActivity");
const AdminActivity = require("../../Models/User/adminActivity");

module.exports = {
  Query: {
    getUserActivities: async (_, __, context) => {
      if (!context.user) throw new Error("Unauthorized: User token required");
      return await UserActivity.findAll({
        where: { UserId: context.user.id },
        order: [['createdAt', 'DESC']]
      });
    },
    getAdminActivities: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      return await AdminActivity.findAll({
        where: { AdminId: context.admin.id },
        order: [['createdAt', 'DESC']]
      });
    },
    getAllUserActivities: async (_, __, context) => {
      if (!context.admin) throw new Error("Unauthorized: Admin token required");
      return await UserActivity.findAll({
        order: [['createdAt', 'DESC']]
      });
    }
  }
};
