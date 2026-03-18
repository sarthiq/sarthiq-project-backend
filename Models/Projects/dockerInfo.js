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

    image: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cmd: {
      type: DataTypes.JSON, // E.g., ['npm', 'start']
      allowNull: true,
    },
    workingDir: {
      type: DataTypes.STRING,
      defaultValue: "/app",
      allowNull: true,
    },
    networkMode: {
      type: DataTypes.STRING,
      defaultValue: "bridge",
      allowNull: true,
    },
    portBindings: {
      type: DataTypes.JSON, // E.g., { "3000/tcp": [{ "HostPort": "8080" }] }
      allowNull: true,
    },
    internalPort: {
      type: DataTypes.INTEGER,
      allowNull: true, // E.g., 3000 (The port the app exposes inside the container)
    },
    containerId: {
      type: DataTypes.STRING,
      allowNull: true, // The actual Docker Container ID (e.g., 'a1b2c3d4e5f6')
    },
    containerUser: {
      type: DataTypes.STRING, // Prevents root execution e.g., "1000:1000"
      allowNull: true,
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
