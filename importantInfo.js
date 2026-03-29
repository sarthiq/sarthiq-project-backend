/**
 * importantInfo.js
 * ─────────────────────────────────────────────────────────────────────
 * Centralized configuration exports.
 *
 * SECURITY: Only export non-secret configuration values.
 * Secrets (OPENAI_API_KEY, DEVELOPER_PASSWORD) are accessed directly
 * via process.env in the modules that need them — never spread across
 * module exports.
 * ─────────────────────────────────────────────────────────────────────
 */

exports.baseDir = __dirname;

exports.AdminTokenExpiresIn = process.env.NODE_ENV === "testing" ? "30d" : "30d";
exports.UserTokenExpiresIn = process.env.NODE_ENV === "testing" ? "30d" : "30d";
exports.DeveloperTokenExpiresIn =
  process.env.NODE_ENV === "testing" ? "30d" : "5m";

exports.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;

exports.NODE_ENV = process.env.NODE_ENV;
exports.APP_PORT = process.env.APP_PORT;

exports.sequelize = require("./database");

// Developer username (non-secret identifier)
exports.DEVELOPER_USERNAME = process.env.DEVELOPER_USERNAME;

// ── REMOVED (security): DO NOT export secrets via module.exports ──
// exports.DEVELOPER_PASSWORD = process.env.DEVELOPER_PASSWORD;  ← use process.env directly
// exports.OPENAI_API_KEY = process.env.OPENAI_API_KEY;          ← use process.env directly