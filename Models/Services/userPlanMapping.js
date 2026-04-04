const { DataTypes } = require("sequelize");
const sequelize = require("../../database");

/**
 * UserPlanMapping — Links a user (by JWT userId) to a UserPlan.
 * Defaults to 'free' plan if no mapping exists.
 * Updatable by admin endpoints.
 */
const UserPlanMapping = sequelize.define(
  "UserPlanMapping",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      comment: "JWT user id from auth system",
    },
    UserPlanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "FK to UserPlan",
    },
  },
  {
    tableName: "userPlanMappings",
    timestamps: true,
  }
);

module.exports = UserPlanMapping;
