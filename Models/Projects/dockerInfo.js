const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const DockerInfo = sequelize.define(
  "DockerInfo",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    memory: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    cpu: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    disk: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    pidsLimit: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    ulimit: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    logOpt: {
      type: DataTypes.JSON,
      allowNull: false,
    },

    restartPolicy: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: "dockerInfos",
    timestamps: true,
  },
);

module.exports = DockerInfo;
