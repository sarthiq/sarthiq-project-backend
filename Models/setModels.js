const DockerInfo = require("./Projects/dockerInfo");
const Project = require("./Projects/projects");
const TierConfig = require("./Projects/tierConfig");

exports.setupModels = async () => {
  Project.hasOne(DockerInfo);
  DockerInfo.belongsTo(Project);
  
  // You can define User-Tier relations elsewhere or uncomment when ready:
  // User.belongsTo(TierConfig);
  // TierConfig.hasMany(User);
};
