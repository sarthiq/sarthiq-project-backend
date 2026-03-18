const DockerInfo = require("./Projects/dockerInfo");
const Project = require("./Projects/projects");

exports.setupModels = async () => {
  Project.hasOne(DockerInfo);
  DockerInfo.belongsTo(Project);
};
