const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const TierConfig = sequelize.define(
  "TierConfig",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tierName: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // E.g., 'Free', 'Pro', 'Enterprise'
    },
    // ---- Default Docker Constraints ----
    defaultMemory: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "512m", // Free tier memory limit
    },
    defaultCpu: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "0.5", // Half a CPU core
    },
    defaultDisk: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "1G", // 1 GB disk quota
    },
    defaultPidsLimit: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100, // Limit processes/threads to 100
    },
    defaultUlimit: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: { nofile: { soft: 1024, hard: 2048 } },
    },
    defaultLogOpt: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: { "max-size": "10m", "max-file": "3" },
    },
    defaultRestartPolicy: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "unless-stopped",
    },
    
    // ---- Platform Quota Limits ----
    maxProjectsPerUser: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1, // Number of concurrent projects allowed
    },
    maxEnvsPerProject: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 10, // Number of Env vars allowed
    },
  },
  {
    tableName: "tierConfigs",
    timestamps: true,
  }
);

module.exports = TierConfig;
