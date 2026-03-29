const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const GithubInstallation = sequelize.define(
  "GithubInstallation",
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
    },
    accountType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "User",
    },
  },
  {
    tableName: "github_installations",
    timestamps: true,
  }
);

module.exports = GithubInstallation;
