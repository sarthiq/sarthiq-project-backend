const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

const UserActivity = sequelize.define(
  "UserActivity",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    info:{
      type: DataTypes.JSON,
      allowNull: true,
    },
    activityType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    activityDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    location: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    deviceType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "userActivities",
    timestamps: false, // If you don't want Sequelize to handle createdAt/updatedAt automatically
  }
);

module.exports = UserActivity;
