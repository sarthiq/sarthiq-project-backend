/**
 * GithubAccount model
 * ─────────────────────────────────────────────────────────────────────
 * Supports multiple GitHub accounts (personal + orgs) per user.
 * Each row maps a userId → one GitHub App installation.
 * Only one account per user is "active" at a time.
 * ─────────────────────────────────────────────────────────────────────
 */

const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const GithubAccount = sequelize.define(
  "GithubAccount",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    installationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    accountLogin: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "GitHub username or org name",
    },
    accountType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "User",
      comment: "User or Organization",
    },
    avatarUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: "GitHub avatar URL for the account",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "Only one account per user should be active",
    },
  },
  {
    tableName: "github_accounts",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["userId", "installationId"],
        name: "unique_user_installation",
      },
    ],
  }
);

module.exports = GithubAccount;
