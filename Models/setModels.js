const DockerInfo = require("./Projects/dockerInfo");
const Project = require("./Projects/projects");
const TierConfig = require("./Projects/tierConfig");
const DeploymentJob = require("./Deployment/deploymentJob");
const TerminalSession = require("./Deployment/terminalSession");
const GithubInstallation = require("./Projects/githubInstallation");
const GithubAccount = require("./Projects/githubAccount");
// KubeNode is standalone (no FK associations needed)
require("./Deployment/kubeNode");

// ── PaaS Service Infrastructure Models ───────────────────────────────
const ServiceCatalog = require("./Services/serviceCatalog");
const UserPlan = require("./Services/userPlan");
const UserPlanMapping = require("./Services/userPlanMapping");
const ServiceInstance = require("./Services/serviceInstance");
const EnvironmentVariable = require("./Services/environmentVariable");
const CronJobInstance = require("./Services/cronJobInstance");

exports.setupModels = async () => {
  // ── Existing associations ──────────────────────────────────────────

  // Project ↔ DockerInfo (1:1)
  Project.hasOne(DockerInfo);
  DockerInfo.belongsTo(Project);

  // Project ↔ DeploymentJob (1:N)
  Project.hasMany(DeploymentJob, { foreignKey: "ProjectId" });
  DeploymentJob.belongsTo(Project, { foreignKey: "ProjectId" });

  // ── PaaS Service associations ──────────────────────────────────────

  // ServiceCatalog ↔ ServiceInstance (1:N)
  ServiceCatalog.hasMany(ServiceInstance, { foreignKey: "ServiceCatalogId" });
  ServiceInstance.belongsTo(ServiceCatalog, { foreignKey: "ServiceCatalogId" });

  // Project ↔ ServiceInstance (1:N)
  Project.hasMany(ServiceInstance, { foreignKey: "ProjectId" });
  ServiceInstance.belongsTo(Project, { foreignKey: "ProjectId" });

  // Project ↔ EnvironmentVariable (1:N)
  Project.hasMany(EnvironmentVariable, { foreignKey: "ProjectId" });
  EnvironmentVariable.belongsTo(Project, { foreignKey: "ProjectId" });

  // Project ↔ CronJobInstance (1:N)
  Project.hasMany(CronJobInstance, { foreignKey: "ProjectId" });
  CronJobInstance.belongsTo(Project, { foreignKey: "ProjectId" });

  // UserPlan ↔ UserPlanMapping (1:N)
  UserPlan.hasMany(UserPlanMapping, { foreignKey: "UserPlanId" });
  UserPlanMapping.belongsTo(UserPlan, { foreignKey: "UserPlanId" });
};
