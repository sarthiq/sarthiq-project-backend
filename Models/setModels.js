const DockerInfo = require("./Projects/dockerInfo");
const Project = require("./Projects/projects");
const TierConfig = require("./Projects/tierConfig");
const DeploymentJob = require("./Deployment/deploymentJob");
// KubeNode is standalone (no FK associations needed)
require("./Deployment/kubeNode");

exports.setupModels = async () => {
  // Project ↔ DockerInfo (1:1)
  Project.hasOne(DockerInfo);
  DockerInfo.belongsTo(Project);

  // Project ↔ DeploymentJob (1:N)
  Project.hasMany(DeploymentJob, { foreignKey: "ProjectId" });
  DeploymentJob.belongsTo(Project, { foreignKey: "ProjectId" });

  await DockerInfo.sync({ alter: true });
};
