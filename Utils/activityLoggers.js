const AdminActivity = require("../Models/User/adminActivity");
const UserActivity = require("../Models/User/userActivity");

const logAdminActivity = async (adminId, activityType, description, req = null) => {
  try {
    await AdminActivity.create({
      AdminId: adminId,
      activityType: activityType,
      activityDescription: description,
      ipAddress: req ? req.ip : null,
      userAgent: req ? req.headers["user-agent"] : null,
      info: {},
    });
  } catch (error) {
    console.error("Failed to log admin activity:", error);
  }
};

const logUserActivity = async (userId, activityType, description, req = null) => {
  try {
    await UserActivity.create({
      UserId: userId,
      activityType: activityType,
      activityDescription: description,
      ipAddress: req ? req.ip : null,
      userAgent: req ? req.headers["user-agent"] : null,
      info: {},
    });
  } catch (error) {
    console.error("Failed to log user activity:", error);
  }
};

module.exports = {
  logAdminActivity,
  logUserActivity,
};
