const Sequelize = require("sequelize");
const { sequelize } = require("../../importantInfo");

const User = sequelize.define(
  "User",
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    uniqueId: {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
    },

    isBlocked: {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    isActive: {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: true,
    },

    name: {
      type: Sequelize.STRING,
      allowNull: false,
    },
    email: {
      type: Sequelize.STRING,
      allowNull: true,
    },

    phone: {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
      validate: {
        isNumeric: true,
        len: [10, 11], // Adjust based on your requirements
      },
    },
    password: {
      type: Sequelize.STRING,
      allowNull: true,
    },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
    tableName: "users", // Optional: specify table name if different from model name
  }
);

module.exports = User;
