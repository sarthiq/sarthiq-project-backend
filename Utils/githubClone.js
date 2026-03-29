/**
 * githubClone.js
 * ─────────────────────────────────────────────────────────────────────
 * Clone a private repository using GitHub App installation tokens.
 * Uses x-access-token authentication with shallow clone for speed.
 * ─────────────────────────────────────────────────────────────────────
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { generateCloneToken } = require("./githubApp");

/**
 * Clone a private repository using a GitHub App installation token.
 *
 * @param {Object} options
 * @param {number} options.installationId - GitHub App installation ID
 * @param {string} options.owner - Repository owner (user or org)
 * @param {string} options.repo - Repository name
 * @param {string} [options.branch="main"] - Branch to clone
 * @param {string} [options.targetDir] - Target directory (auto-generated if not provided)
 * @returns {Promise<string>} Path to the cloned repository
 */
async function clonePrivateRepo({ installationId, owner, repo, branch = "main", targetDir }) {
  // Validate inputs — prevent path traversal
  if (!owner || !repo) {
    throw new Error("Owner and repo are required for cloning");
  }

  const safeOwner = owner.replace(/[^a-zA-Z0-9_.-]/g, "");
  const safeRepo = repo.replace(/[^a-zA-Z0-9_.-]/g, "");
  const safeBranch = branch.replace(/[^a-zA-Z0-9_.\-\/]/g, "");

  if (safeOwner !== owner || safeRepo !== repo) {
    throw new Error("Invalid characters in owner or repo name");
  }

  // Generate short-lived installation token
  let token;
  try {
    token = await generateCloneToken(installationId);
  } catch (err) {
    throw new Error(`Failed to generate clone token: ${err.message}`);
  }

  // Determine clone directory
  const baseDir = path.join(__dirname, "..", "Temp");
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const cloneDir = targetDir || path.join(baseDir, `${safeOwner}-${safeRepo}-${Date.now()}`);

  // Construct authenticated clone URL
  const cloneUrl = `https://x-access-token:${token}@github.com/${safeOwner}/${safeRepo}.git`;

  try {
    console.log(`[githubClone] Cloning ${safeOwner}/${safeRepo} (branch: ${safeBranch}) ...`);

    execSync(
      `git clone --depth=1 --branch "${safeBranch}" "${cloneUrl}" "${cloneDir}"`,
      {
        stdio: "pipe",
        timeout: 120000, // 2 minute timeout
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // Never prompt for credentials
        },
      }
    );

    console.log(`[githubClone] ✅ Cloned to ${cloneDir}`);
    return cloneDir;
  } catch (err) {
    // Clean up partial clone on failure
    try {
      if (fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    // Sanitize error message to not leak the token
    const sanitizedMessage = err.message
      .replace(token, "[REDACTED]")
      .replace(/x-access-token:[^\s@]+/g, "x-access-token:[REDACTED]");

    throw new Error(`Git clone failed: ${sanitizedMessage}`);
  } finally {
    // Ensure token is not retained in memory longer than needed
    token = null;
  }
}

module.exports = { clonePrivateRepo };
