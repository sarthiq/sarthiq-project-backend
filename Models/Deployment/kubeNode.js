const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * Tracks each Kubernetes worker node's total vs used resources.
 * Populated on startup and updated on every deploy/undeploy.
 *
 * cpuMillicores: e.g. 2000 = 2 vCPU total
 * usedCpuMillicores: how many m are currently allocated
 * memoryMi: total RAM in MiB
 * usedMemoryMi: currently allocated RAM in MiB
 */
const KubeNode = sequelize.define(
  "KubeNode",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nodeName: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // K8s node name, e.g. "worker-node-1"
    },
    totalCpuMillicores: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2000, // 2 vCPU = 2000m
    },
    usedCpuMillicores: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    totalMemoryMi: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 4096, // 4 GiB
    },
    usedMemoryMi: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "kubeNodes",
    timestamps: true,
  }
);

module.exports = KubeNode;
