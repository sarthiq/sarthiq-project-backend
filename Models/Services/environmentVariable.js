const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * EnvironmentVariable — Per-project env var storage.
 * Replaces the JSON blob approach with a proper table.
 * Supports auto-injection from provisioned services.
 */
const EnvironmentVariable = sequelize.define(
  "EnvironmentVariable",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ProjectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    key: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "ENV var name: DATABASE_URL, REDIS_URL, etc.",
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: "AES-256-GCM encrypted value",
    },
    isAutoInjected: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "true if auto-created from a service connection",
    },
    sourceServiceInstanceId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "FK to ServiceInstance that auto-created this var",
    },
  },
  {
    tableName: "environmentVariables",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["ProjectId", "key"],
        name: "unique_project_env_key",
      },
    ],
  }
);

module.exports = EnvironmentVariable;
