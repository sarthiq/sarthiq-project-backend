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
 * Fetch a page of repositories accessible to an installation.
 * @param {number} installationId
 * @param {number} page
 * @param {number} perPage
 * @param {string} search
 * @param {string} filter
 * @param {string} accountLogin
 * @param {string} accountType
 * @returns {Promise<{repos: Array, totalCount: number}>} Object containing repositories and total count
 */
async function getInstallationRepos(installationId, page = 1, perPage = 30, search = "", filter = "all", accountLogin = "", accountType = "") {
  const octokit = await getInstallationOctokit(installationId);

  if (search || filter !== "all") {
    let q = "";
    if (search) {
      q += `${search} in:name,description`;
    }

    if (accountType === "Organization") {
      q += ` org:${accountLogin}`;
    } else if (accountLogin) {
      q += ` user:${accountLogin}`;
    }

    if (filter === "private") {
      q += " is:private";
    } else if (filter === "public") {
      q += " is:public";
    }

    const { data } = await octokit.request("GET /search/repositories", {
      q: q.trim(),
      per_page: perPage,
      page,
    });
    return { repos: data.items || [], totalCount: data.total_count || 0 };
  } else {
    const { data } = await octokit.request(
      "GET /installation/repositories",
      {
        per_page: perPage,
        page,
      }
    );
    return { repos: data.repositories || [], totalCount: data.total_count || 0 };
  }
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
 * Delete a GitHub App installation via the API.
 * This fully removes the app from the user's GitHub account,
 * so the next "Connect GitHub" triggers a fresh install flow with redirect.
 * @param {number} installationId
 * @returns {Promise<boolean>} true if deleted successfully
 */
async function deleteInstallation(installationId) {
  try {
    const appJwt = await getAppJwt();
    const octokit = new Octokit({ auth: appJwt });

    await octokit.request(
      "DELETE /app/installations/{installation_id}",
      {
        installation_id: installationId,
      }
    );

    console.log(`[githubApp] ✅ Deleted installation ${installationId} from GitHub`);
    return true;
  } catch (err) {
    console.error(`[githubApp] Failed to delete installation ${installationId}:`, err.message);
    return false;
  }
}

/**
 * List ALL installations of this GitHub App.
 * Used to find installations that exist on GitHub but aren't saved in our DB.
 * @returns {Promise<Array>} List of installation objects
 */
async function listAllInstallations() {
  try {
    const appJwt = await getAppJwt();
    const octokit = new Octokit({ auth: appJwt });

    const installations = [];
    let page = 1;

    // Paginate to get all installations
    while (true) {
      const { data } = await octokit.request("GET /app/installations", {
        per_page: 100,
        page,
      });

      installations.push(...data);

      if (data.length < 100) break;
      page++;
    }

    return installations;
  } catch (err) {
    console.error("[githubApp] Failed to list installations:", err.message);
    return [];
  }
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
  deleteInstallation,
  listAllInstallations,
  checkGithubCredentials,
};

