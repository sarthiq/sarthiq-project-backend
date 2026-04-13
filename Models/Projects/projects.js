const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const Project = sequelize.define(
  "Project",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    projectRepoUrl: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    projectLanguage: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    frameWork: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    branch: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    projectDirectory: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    buildCommand: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    buildDirectory: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    subdomain: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true, // E.g., 'user-app-xyz.sarthiq.com'
    },
    customDomain: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true, // E.g., 'www.my-awesome-app.com'
    },
    envVariables: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    // ── AI-detected metadata (auto-populated by aiStackDetector) ──
    detectedLanguage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    detectedFramework: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    detectedBuildCommand: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    detectedStartCommand: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    detectedPort: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    isStaticSite: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    autoDeployOnPush: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: "projects",
    timestamps: true,
  },
);

module.exports = Project;
