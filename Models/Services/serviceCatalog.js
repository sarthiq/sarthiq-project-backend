const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * ServiceCatalog — Master registry of all infrastructure services
 * the platform can provision. Seeded once; referenced by ServiceInstance.
 */
const ServiceCatalog = sequelize.define(
  "ServiceCatalog",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // e.g. "postgresql", "redis", "meilisearch"
    },
    displayName: {
      type: DataTypes.STRING,
      allowNull: false, // e.g. "PostgreSQL 16"
    },
    category: {
      type: DataTypes.ENUM(
        "database",
        "cache",
        "queue",
        "storage",
        "search",
        "monitoring",
        "logging",
        "job"
      ),
      allowNull: false,
    },
    dockerImage: {
      type: DataTypes.STRING,
      allowNull: false, // e.g. "postgres:16-alpine"
    },
    defaultPort: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    requiredResources: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
      comment: "Default resource allocation { cpu, memory, storage }",
    },
    configSchema: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "User-configurable knobs (max_connections, etc.)",
    },
    volumeMounts: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Array of { mountPath, subPath } for persistent data",
    },
    healthCheck: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "{ command: [...], interval: 10, timeout: 5 }",
    },
    templates: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Predefined sizes: { small: {...}, medium: {...}, large: {...} }",
    },
    envVarMapping: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Auto-inject mapping: { DATABASE_URL: 'uri', PGHOST: 'host', ... }",
    },
    useStatefulSet: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "true for DBs, Elasticsearch, Kafka — uses StatefulSet instead of Deployment",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: "Toggle service availability in the catalog",
    },
  },
  {
    tableName: "serviceCatalogs",
    timestamps: true,
  }
);

module.exports = ServiceCatalog;
