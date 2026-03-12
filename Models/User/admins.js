const Sequelize = require("sequelize");
const { sequelize } = require("../../importantInfo");

const Admin = sequelize.define(
  "Admin",
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    isDeactivated: {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    userName: {
      type: Sequelize.STRING,
      allowNull: false,
      unique: true,
    },
    adminType: {
      type: Sequelize.STRING,
      allowNull: false,
    },
    password: {
      type: Sequelize.STRING,
      allowNull: false,
    },
    phone: {
      type: Sequelize.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isNumeric: true,
        len: [10, 10],
      },
    },
    freezeStatus: {
      type: Sequelize.BOOLEAN,
      allowNull: false,
    },
    email: {
      type: Sequelize.STRING,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    name: {
      type: Sequelize.STRING,
    },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
    tableName: "admins", // Optional: specify table name if different from model name
  }
);

module.exports = Admin;
