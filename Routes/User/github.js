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
  saveInstallation,
  getRepos,
  getStatus,
  getAccounts,
  switchAccount,
  disconnect,
} = require("../../Controller/User/githubController");

// Connect — redirect URL for GitHub App install
router.get("/connect", userAuthentication, connectGithub);

// Install callback — GitHub redirects here after install (no auth header, uses state JWT)
router.get("/install/callback", handleInstallCallback);

// Save installation — called by frontend when coming back from Configure flow (no state JWT)
// Frontend sends the installation_id with user's auth token
router.post("/install/save", userAuthentication, saveInstallation);

// Fetch repositories — requires authenticated user
router.get("/repos", userAuthentication, getRepos);

// Accounts — list all connected GitHub accounts (multi-account)
router.get("/accounts", userAuthentication, getAccounts);

// Switch active account
router.post("/switch-account", userAuthentication, switchAccount);

// Status — backward-compatible check (returns active account info)
router.get("/status", userAuthentication, getStatus);

// Disconnect — remove a specific GitHub account (or all if no param)
router.delete("/disconnect/:accountId?", userAuthentication, disconnect);

module.exports = router;
