const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * UserPlan — Defines plan tiers (free, pro, enterprise) with resource limits.
 * Controls how many services a user can create and how much resources they consume.
 */
const UserPlan = sequelize.define(
  "UserPlan",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // "free", "pro", "enterprise"
    },
    maxServices: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
      comment: "Maximum number of services a user can create",
    },
    maxCpuMillicores: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1000,
      comment: "Total CPU budget across all services (millicores)",
    },
    maxMemoryMi: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1024,
      comment: "Total memory budget across all services (MiB)",
    },
    maxStorageGi: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
      comment: "Total persistent storage budget (GiB)",
    },
    allowedServices: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: ["*"],
      comment: 'Array of allowed service names, or ["*"] for all',
    },
    maxCronJobs: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2,
    },
    logRetentionHours: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 24,
      comment: "How long to retain streamed logs",
    },
  },
  {
    tableName: "userPlans",
    timestamps: true,
  }
);

module.exports = UserPlan;
