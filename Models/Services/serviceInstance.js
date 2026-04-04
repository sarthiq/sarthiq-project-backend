const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * ServiceInstance — A provisioned infrastructure service.
 * One per user+project+serviceType combination.
 * Tracks K8s resource names, credentials (encrypted), and status.
 */
const ServiceInstance = sequelize.define(
  "ServiceInstance",
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
    ServiceCatalogId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    instanceName: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Human-friendly unique name per project, e.g. postgresql-42-a7f3",
    },
    status: {
      type: DataTypes.ENUM(
        "provisioning",
        "running",
        "stopped",
        "failed",
        "deleting"
      ),
      defaultValue: "provisioning",
      allowNull: false,
    },
    config: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Runtime config overrides (max_connections, etc.)",
    },
    connectionDetails: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
      comment: "AES-256-GCM encrypted JSON with host, port, user, pass, uri",
    },
    namespace: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "K8s namespace: sarthiq-svc-{projectId}",
    },
    kubeResourceName: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Name of the K8s StatefulSet/Deployment",
    },
    resourceUsage: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
      comment: "Allocated resources for plan enforcement",
    },
    template: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "small",
      comment: "small, medium, large, or custom",
    },
    isExternal: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "true for BYOS (Bring Your Own Service)",
    },
    externalConnectionUri: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Encrypted URI for BYOS external services",
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Last error message if status is failed",
    },
    provisionLogs: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
      comment: "Provisioning log trail",
    },
  },
  {
    tableName: "serviceInstances",
    timestamps: true,
  }
);

module.exports = ServiceInstance;
