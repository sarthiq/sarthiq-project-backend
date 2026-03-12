const Sequelize = require("sequelize");
const { errorLog } = require("./Utils/utils");

// Custom logging function for errors only
const logErrors = (msg) => {
  if (msg instanceof Error) {
    errorLog(`\nTime :- ${new Date()}\nSequelize Error: `, msg);
  }
};

console.log(`Database connected : ${process.env.DATABASE_NAME}`);

module.exports = new Sequelize(
  process.env.DATABASE_NAME,
  process.env.DATABASE_USER,
  process.env.DATABASE_PASSWORD,
  {
    dialect: "mysql",
    host: process.env.DATABASE_HOST,
    logging: logErrors, // Log errors only in production
    timezone: "+05:30",
  }
);
