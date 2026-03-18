const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const UserActivity = sequelize.define(
  "UserActivity",
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
    envVariables: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: "userActivities",
    timestamps: true,
  },
);

module.exports = UserActivity;
