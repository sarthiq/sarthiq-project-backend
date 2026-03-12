const AdminActivity = require("../Models/User/adminActivity");
const UserActivity = require("../Models/User/userActivity");



exports.createUserActivity = async (
  req,
  activityType,
  activityDescription,
  transaction,
  info={}
) => {
  const activityData = {
    activityType: activityType,
    activityDescription: activityDescription,
    ipAddress: req?.clientInfo?.primaryIpAddress || 'N/A', // Safe access with optional chaining
    userAgent: req?.clientInfo?.userAgent || 'N/A', // Safe access with optional chaining
    location: req?.clientInfo?.location || 'N/A', // Safe access with optional chaining
    deviceType: req?.clientInfo?.deviceType || 'N/A', // Safe access with optional chaining
    createdAt: new Date(),
    UserId: req?.user?.id || null, // Link activity to the User
    MentorId: req?.mentor?.id || null, // Link activity to the Mentor
    CollegeMentorId: req?.collegeMentor?.id || null, // Link activity to the College Mentor
    info: info,
  };

  if (transaction) {
    return await UserActivity.create(activityData, { transaction });
  } else {
    return await UserActivity.create(activityData);
  }
};


exports.createAdminActivity = async (
  req,
  activityType,
  activityDescription,
  transaction,
  info={}
) => {
  const activityData = {
    activityType: activityType,
    activityDescription: activityDescription,
    ipAddress: req?.clientInfo?.primaryIpAddress || 'N/A', // Safe access with optional chaining
    userAgent: req?.clientInfo?.userAgent || 'N/A', // Safe access with optional chaining
    location: req?.clientInfo?.location || 'N/A', // Safe access with optional chaining
    deviceType: req?.clientInfo?.deviceType || 'N/A', // Safe access with optional chaining
    createdAt: new Date(),
    AdminId: req?.admin?.id || null, // Link activity to the Admin performing the action
    info: info,
  };

  //console.log(activityData);

  if (transaction) {
    return await AdminActivity.create(activityData, { transaction });
  } else {
    return await AdminActivity.create(activityData);
  }
};

