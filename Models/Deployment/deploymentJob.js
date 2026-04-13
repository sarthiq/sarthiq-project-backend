const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * Tracks every BullMQ deployment job.
 * status transitions:  queued → building → running | failed
 */
const DeploymentJob = sequelize.define(
  "DeploymentJob",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    bullmqJobId: {
      type: DataTypes.STRING,
      allowNull: true, // set once BullMQ job is enqueued
    },
    status: {
      type: DataTypes.ENUM(
        "queued",
        "building",
        "running",
        "sleeping",
        "failed",
        "done",
      ),
      defaultValue: "queued",
      allowNull: false,
    },
    logs: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // ── AI auto-debug tracking ──────────────────────────────────
    retryCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
    aiDiagnosis: {
      type: DataTypes.JSON, // Array of DebugResult objects from each attempt
      allowNull: true,
    },
    generatedDockerfile: {
      type: DataTypes.TEXT("long"), // The Dockerfile actually used for the build
      allowNull: true,
    },
    commitSha: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    commitMessage: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // FK columns
    ProjectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: "deploymentJobs",
    timestamps: true,
  },
);

module.exports = DeploymentJob;
