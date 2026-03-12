exports.baseDir = __dirname;

exports.AdminTokenExpiresIn = process.env.NODE_ENV === "testing" ? "30d" : "30d";
exports.UserTokenExpiresIn = process.env.NODE_ENV === "testing" ? "30d" : "30d";
exports.DeveloperTokenExpiresIn =
  process.env.NODE_ENV === "testing" ? "30d" : "5m";

exports.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;


exports.NODE_ENV = process.env.NODE_ENV;
exports.APP_PORT = process.env.APP_PORT;

exports.sequelize = require("./database");

//Developer Credentials
exports.DEVELOPER_USERNAME = process.env.DEVELOPER_USERNAME;
exports.DEVELOPER_PASSWORD = process.env.DEVELOPER_PASSWORD;

exports.OPENAI_API_KEY=process.env.OPENAI_API_KEY