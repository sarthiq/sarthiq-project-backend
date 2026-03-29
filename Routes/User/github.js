/**
 * GitHub REST API routes (authenticated)
 * ─────────────────────────────────────────────────────────────────────
 * All routes except callback require userAuthentication middleware.
 * The callback endpoint validates via JWT state parameter instead.
 * ─────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();

const { userAuthentication } = require("../../Middleware/auth");
const {
  connectGithub,
  handleInstallCallback,
  getRepos,
  getStatus,
  disconnect,
} = require("../../Controller/User/githubController");

// Connect — redirect URL for GitHub App install
router.get("/connect", userAuthentication, connectGithub);

// Install callback — GitHub redirects here after install (no auth header, uses state JWT)
router.get("/install/callback", handleInstallCallback);

// Fetch repositories — requires authenticated user
router.get("/repos", userAuthentication, getRepos);

// Status — check if GitHub is connected
router.get("/status", userAuthentication, getStatus);

// Disconnect — remove GitHub installation
router.delete("/disconnect", userAuthentication, disconnect);

module.exports = router;
