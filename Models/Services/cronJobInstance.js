const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * CronJobInstance — Tracks Kubernetes CronJobs created by users.
 * Supports scheduling, suspension, and execution history.
 */
const CronJobInstance = sequelize.define(
  "CronJobInstance",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ProjectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "User-friendly job name",
    },
    schedule: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Cron expression: */5 * * * *",
    },
    command: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: '["node", "scripts/backup.js"]',
    },
    image: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Docker image to run the job in",
    },
    status: {
      type: DataTypes.ENUM("active", "suspended", "failed"),
      defaultValue: "active",
      allowNull: false,
    },
    lastRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastRunStatus: {
      type: DataTypes.ENUM("success", "failed", "running"),
      allowNull: true,
    },
    resourceLimits: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: { cpu: "100m", memory: "128Mi" },
    },
    kubeResourceName: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "K8s CronJob resource name",
    },
    namespace: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    successfulJobsHistoryLimit: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
    },
    failedJobsHistoryLimit: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: "cronJobInstances",
    timestamps: true,
  }
);

module.exports = CronJobInstance;
