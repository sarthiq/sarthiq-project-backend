/**
 * githubApp.js
 * ─────────────────────────────────────────────────────────────────────
 * Core GitHub App service — singleton initialization, installation
 * token generation, repo listing, and webhook signature verification.
 *
 * Uses @octokit/app for App-level auth and @octokit/rest for REST calls.
 * ─────────────────────────────────────────────────────────────────────
 */

const { App } = require("@octokit/app");
const { Octokit } = require("@octokit/rest");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Singleton GitHub App instance ─────────────────────────────────────
let githubApp = null;
let cachedPrivateKey = null;

/**
 * Load the GitHub App private key.
 * Priority:
 *   1. GITHUB_PRIVATE_KEY_PATH → read .pem file from disk (recommended)
 *   2. GITHUB_PRIVATE_KEY → base64-encoded string in env (fallback)
 */
function loadPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;

  // Option 1: Read from file path (clean — no env clutter)
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (keyPath) {
    const resolvedPath = path.isAbsolute(keyPath)
      ? keyPath
      : path.join(__dirname, "..", keyPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(`[githubApp] Private key file not found: ${resolvedPath}`);
      return null;
    }

    cachedPrivateKey = fs.readFileSync(resolvedPath, "utf-8");
    console.log(`[githubApp] Private key loaded from file: ${keyPath}`);
    return cachedPrivateKey;
  }

  // Option 2: Base64-encoded in env
  const base64Key = process.env.GITHUB_PRIVATE_KEY;
  if (base64Key) {
    try {
      cachedPrivateKey = Buffer.from(base64Key, "base64").toString("utf-8");
      console.log("[githubApp] Private key loaded from base64 env");
      return cachedPrivateKey;
    } catch (err) {
      console.error("[githubApp] Failed to decode GITHUB_PRIVATE_KEY:", err.message);
      return null;
    }
  }

  return null;
}

/**
 * Initialize the GitHub App singleton.
 * Reads private key from file or base64 env.
 */
function initGithubApp() {
  if (githubApp) return githubApp;

  const appId = process.env.GITHUB_APP_ID;
  if (!appId) {
    console.warn("[githubApp] GITHUB_APP_ID not set — GitHub App features disabled");
    return null;
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    console.warn(
      "[githubApp] No private key found. Set GITHUB_PRIVATE_KEY_PATH (file path) or GITHUB_PRIVATE_KEY (base64)"
    );
    return null;
  }

  githubApp = new App({
    appId: parseInt(appId),
    privateKey,
  });

  console.log("[githubApp] ✅ GitHub App initialized (appId:", appId, ")");
  return githubApp;
}

/**
 * Get an authenticated Octokit instance for a specific installation.
 * @param {number} installationId
 * @returns {Promise<Octokit>}
 */
async function getInstallationOctokit(installationId) {
  const app = initGithubApp();
  if (!app) throw new Error("GitHub App not initialized");

  return await app.getInstallationOctokit(installationId);
}

/**
 * Fetch all repositories accessible to an installation.
 * Handles pagination automatically.
 * @param {number} installationId
 * @returns {Promise<Array>} Array of repository objects
 */
async function getInstallationRepos(installationId) {
  const octokit = await getInstallationOctokit(installationId);

  const repos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.request(
      "GET /installation/repositories",
      {
        per_page: perPage,
        page,
      }
    );

    repos.push(...data.repositories);

    if (repos.length >= data.total_count || data.repositories.length < perPage) {
      break;
    }
    page++;
  }

  return repos;
}

/**
 * Generate a short-lived installation access token for git operations.
 * @param {number} installationId
 * @returns {Promise<string>} The access token
 */
async function generateCloneToken(installationId) {
  const app = initGithubApp();
  if (!app) throw new Error("GitHub App not initialized");

  const octokit = await app.getInstallationOctokit(installationId);

  // The octokit instance already has the token embedded.
  // We need to create a fresh token via the API for clone usage.
  const appOctokit = new Octokit({
    auth: await getAppJwt(),
  });

  const { data } = await appOctokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
    }
  );

  return data.token;
}

/**
 * Generate a JWT for the GitHub App itself (not installation-scoped).
 * @returns {Promise<string>}
 */
async function getAppJwt() {
  const app = initGithubApp();
  if (!app) throw new Error("GitHub App not initialized");

  const jwt = require("jsonwebtoken");
  const privateKey = loadPrivateKey();
  if (!privateKey) throw new Error("Private key not available");

  const appId = process.env.GITHUB_APP_ID;
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iat: now - 60, // issued 60 seconds in the past to allow clock drift
      exp: now + 10 * 60, // expires in 10 minutes
      iss: appId,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  return token;
}

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 * @param {Buffer|string} payload - Raw request body
 * @param {string} signature - Value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[githubApp] GITHUB_WEBHOOK_SECRET not configured");
    return false;
  }

  if (!signature) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Get installation info from GitHub API.
 * @param {number} installationId
 * @returns {Promise<Object>}
 */
async function getInstallationInfo(installationId) {
  const appJwt = await getAppJwt();
  const octokit = new Octokit({ auth: appJwt });

  const { data } = await octokit.request(
    "GET /app/installations/{installation_id}",
    {
      installation_id: installationId,
    }
  );

  return data;
}

/**
 * Check if the necessary GitHub credentials are provided in the environment.
 * @returns {Array} List of missing credentials
 */
function checkGithubCredentials() {
  const missing = [];
  if (!process.env.GITHUB_APP_ID) missing.push("GITHUB_APP_ID");
  if (!process.env.GITHUB_CLIENT_ID) missing.push("GITHUB_CLIENT_ID");
  if (!process.env.GITHUB_CLIENT_SECRET) missing.push("GITHUB_CLIENT_SECRET");
  if (!process.env.GITHUB_WEBHOOK_SECRET) missing.push("GITHUB_WEBHOOK_SECRET");
  
  // Suppress the console.error/warn from loadPrivateKey during this initial check
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  console.error = () => {};
  console.log = () => {};
  const privateKey = loadPrivateKey();
  console.error = originalConsoleError;
  console.log = originalConsoleLog;

  if (!privateKey) {
    missing.push("GITHUB_PRIVATE_KEY_PATH (or base64 GITHUB_PRIVATE_KEY)");
  }
  return missing;
}

module.exports = {
  initGithubApp,
  getInstallationOctokit,
  getInstallationRepos,
  generateCloneToken,
  verifyWebhookSignature,
  getInstallationInfo,
  checkGithubCredentials,
};
