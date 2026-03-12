const AdminActivity = require("./User/adminActivity");
const Admin = require("./User/admins");
const UserActivity = require("./User/userActivity");
const User = require("./User/users");

exports.setupModels = async () => {
  // Define associations
  Admin.hasMany(AdminActivity);
  AdminActivity.belongsTo(Admin);

  User.hasMany(UserActivity);
  UserActivity.belongsTo(User);

 
};
