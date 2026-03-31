const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * TerminalSession — Audit log for container shell sessions.
 *
 * Tracks who accessed which pod, when, and how long the session lasted.
 * Used for security auditing and concurrent session enforcement.
 */
const TerminalSession = sequelize.define(
  "TerminalSession",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    sessionId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    podName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    containerName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("active", "closed", "expired", "terminated"),
      defaultValue: "active",
      allowNull: false,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    endedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    commandCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
    terminationReason: {
      type: DataTypes.STRING,
      allowNull: true, // e.g., "timeout", "idle", "user_closed", "suspicious_activity"
    },
    clientIp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "terminalSessions",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["projectId"] },
      { fields: ["status"] },
      { fields: ["userId", "status"] }, // for concurrent session check
    ],
  }
);

module.exports = TerminalSession;
