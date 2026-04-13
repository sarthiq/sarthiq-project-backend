/**
 * githubController.js
 * ─────────────────────────────────────────────────────────────────────
 * Handles all GitHub App integration endpoints:
 *  - Connect (redirect to GitHub App install)
 *  - Install callback (store installation → multi-account)
 *  - Save installation (frontend-callback flow)
 *  - Repo listing (via installation token)
 *  - List accounts (multi-account support)
 *  - Switch active account
 *  - Disconnect (remove account)
 *  - Status (backward compat)
 *  - Webhook handler (push → redeploy)
 * ─────────────────────────────────────────────────────────────────────
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY } = require("../../importantInfo");
const GithubAccount = require("../../Models/Projects/githubAccount");

// Backward compat: keep old model import for migration queries
let GithubInstallation;
try {
  GithubInstallation = require("../../Models/Projects/githubInstallation");
} catch {
  GithubInstallation = null;
}

const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const { deployQueue } = require("../../Jobs/queues");
const { Op } = require("sequelize");

const {
  getInstallationRepos,
  verifyWebhookSignature,
  getInstallationInfo,
  deleteInstallation,
} = require("../../Utils/githubApp");

// ── GitHub App name (used in install URL) ──────────────────────────
const GITHUB_APP_SLUG = "sarthiq-project";

/**
 * Returns the configured frontend URL.
 */
function getFrontendUrl() {
  const url = process.env.FRONTEND_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[github] ❌ CRITICAL: FRONTEND_URL env var is not set in production! " +
          "GitHub OAuth callbacks will redirect to localhost. " +
          "Set FRONTEND_URL=https://project.sarthiq.com in your production .env"
      );
    }
    return "http://localhost:3001";
  }
  return url;
}

/**
 * Upsert a GitHub account for a user.
 * - Creates or updates the account
 * - If it's the user's first account, auto-activates it
 * @returns {Object} { account, created }
 */
async function upsertGithubAccount(userId, installId, accountLogin, accountType, avatarUrl) {
  // Check if user has any active accounts
  const existingAccounts = await GithubAccount.findAll({ where: { userId } });
  const shouldActivate = existingAccounts.length === 0;

  const [account, created] = await GithubAccount.findOrCreate({
    where: { userId, installationId: installId },
    defaults: {
      accountLogin,
      accountType,
      avatarUrl,
      isActive: shouldActivate,
    },
  });

  if (!created) {
    // Update existing account info
    account.accountLogin = accountLogin || account.accountLogin;
    account.accountType = accountType || account.accountType;
    account.avatarUrl = avatarUrl || account.avatarUrl;
    await account.save();
  }

  // If this is the first account, make sure it's active
  if (shouldActivate && !account.isActive) {
    account.isActive = true;
    await account.save();
  }

  return { account, created };
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/github/connect
 * Redirect user to GitHub App installation page.
 * Encodes userId into a signed JWT state param for secure callback.
 */
exports.connectGithub = async (req, res) => {
  try {
    const userId = req.user.id;

    // Sign a short-lived state token (5 min) so the callback can map back to this user
    const state = jwt.sign(
      { userId, purpose: "github_install" },
      JWT_SECRET_KEY,
      { expiresIn: "5m" }
    );

    const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=${state}`;

    return res.json({
      success: true,
      redirectUrl: installUrl,
    });
  } catch (err) {
    console.error("[github] connectGithub error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate GitHub connect URL",
    });
  }
};

/**
 * GET /api/github/install/callback
 * GitHub redirects here after user installs the app.
 * Query params: installation_id, setup_action, state
 */
exports.handleInstallCallback = async (req, res) => {
  try {
    const { installation_id, state, setup_action } = req.query;

    if (!installation_id) {
      return res.status(400).json({
        success: false,
        message: "Missing installation_id",
      });
    }

    // Verify state token to identify the user
    let userId;
    if (state) {
      try {
        const payload = jwt.verify(state, JWT_SECRET_KEY);
        if (payload.purpose !== "github_install") {
          throw new Error("Invalid state purpose");
        }
        userId = payload.userId;
      } catch (err) {
        console.error("[github] Invalid state token:", err.message);
        if (req.user) {
          userId = req.user.id;
        } else {
          return res.redirect(
            `${getFrontendUrl()}/github?error=invalid_state`
          );
        }
      }
    } else if (req.user) {
      userId = req.user.id;
    } else {
      return res.redirect(`${getFrontendUrl()}/github?error=no_state`);
    }

    const installId = parseInt(installation_id);

    // Fetch installation info from GitHub to get account details
    let accountLogin = null;
    let accountType = "User";
    let avatarUrl = null;
    try {
      const installInfo = await getInstallationInfo(installId);
      accountLogin = installInfo.account?.login || null;
      accountType = installInfo.account?.type || "User";
      avatarUrl = installInfo.account?.avatar_url || null;
    } catch (err) {
      console.warn(
        "[github] Could not fetch installation info:",
        err.message
      );
    }

    // Upsert into GithubAccount (multi-account)
    const { account, created } = await upsertGithubAccount(
      userId,
      installId,
      accountLogin,
      accountType,
      avatarUrl
    );

    console.log(
      `[github] ${created ? "Created" : "Updated"} account for userId=${userId}, installationId=${installId}, account=${accountLogin}`
    );

    // Redirect to frontend callback page (popup will postMessage + close)
    return res.redirect(`${getFrontendUrl()}/github/callback?status=connected`);
  } catch (err) {
    console.error("[github] handleInstallCallback error:", err.message);
    return res.redirect(`${getFrontendUrl()}/github/callback?error=callback_failed`);
  }
};

/**
 * GET /github/setup
 * GitHub's "Setup URL" redirect — same logic as install callback.
 * This is called both when:
 *  1. User installs fresh (has state JWT)
 *  2. User clicks "Configure" on existing install (may NOT have state JWT)
 */
exports.handleSetupRedirect = async (req, res) => {
  try {
    const { installation_id, state } = req.query;
    const frontendUrl = getFrontendUrl();

    if (!installation_id) {
      return res.redirect(`${frontendUrl}/github`);
    }

    // If there's a state param (fresh install), delegate to install callback handler
    if (state) {
      return exports.handleInstallCallback(req, res);
    }

    // No state = user came from "Configure" button on existing installation.
    // We don't have userId here, so redirect to frontend with installation_id
    // so the frontend can call /api/github/install/save with the user's token.
    console.log(
      `[github] Setup redirect without state, installation_id=${installation_id}`
    );
    return res.redirect(
      `${frontendUrl}/github/callback?installation_id=${installation_id}&setup_action=update`
    );
  } catch (err) {
    console.error("[github] handleSetupRedirect error:", err.message);
    return res.redirect(`${getFrontendUrl()}/github/callback?error=setup_failed`);
  }
};

/**
 * POST /api/github/install/save
 * Called when GitHub redirects back via Setup URL with installation_id but no state.
 * (Happens on reconnect / clicking "Configure" on existing install)
 * Frontend passes the installation_id and user's auth token.
 */
exports.saveInstallation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { installation_id } = req.body;

    if (!installation_id) {
      return res
        .status(400)
        .json({ success: false, message: "Missing installation_id" });
    }

    const installId = parseInt(installation_id);

    // Fetch installation info from GitHub
    let accountLogin = null;
    let accountType = "User";
    let avatarUrl = null;
    try {
      const installInfo = await getInstallationInfo(installId);
      accountLogin = installInfo.account?.login || null;
      accountType = installInfo.account?.type || "User";
      avatarUrl = installInfo.account?.avatar_url || null;
    } catch (err) {
      console.warn(
        "[github] saveInstallation: Could not fetch installation info:",
        err.message
      );
    }

    // Upsert into GithubAccount (multi-account)
    const { account, created } = await upsertGithubAccount(
      userId,
      installId,
      accountLogin,
      accountType,
      avatarUrl
    );

    console.log(
      `[github] ${created ? "Created" : "Updated"} account via save endpoint: userId=${userId}, installationId=${installId}`
    );

    return res.json({ success: true, message: "GitHub installation saved" });
  } catch (err) {
    console.error("[github] saveInstallation error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save installation" });
  }
};

/**
 * GET /api/github/accounts
 * List all connected GitHub accounts for the user.
 */
exports.getAccounts = async (req, res) => {
  try {
    const userId = req.user.id;

    const accounts = await GithubAccount.findAll({
      where: { userId },
      order: [
        ["isActive", "DESC"],
        ["createdAt", "ASC"],
      ],
    });

    const activeAccount = accounts.find((a) => a.isActive) || null;

    return res.json({
      success: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        installationId: a.installationId,
        accountLogin: a.accountLogin,
        accountType: a.accountType,
        avatarUrl: a.avatarUrl,
        isActive: a.isActive,
      })),
      activeAccount: activeAccount
        ? {
            id: activeAccount.id,
            installationId: activeAccount.installationId,
            accountLogin: activeAccount.accountLogin,
            accountType: activeAccount.accountType,
            avatarUrl: activeAccount.avatarUrl,
          }
        : null,
    });
  } catch (err) {
    console.error("[github] getAccounts error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch GitHub accounts",
    });
  }
};

/**
 * POST /api/github/switch-account
 * Switch the active GitHub account for the user.
 * Body: { accountId: number }
 */
exports.switchAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountId } = req.body;

    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accountId" });
    }

    // Verify the account belongs to the user
    const targetAccount = await GithubAccount.findOne({
      where: { id: accountId, userId },
    });

    if (!targetAccount) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // Deactivate all accounts for this user
    await GithubAccount.update({ isActive: false }, { where: { userId } });

    // Activate the target account
    targetAccount.isActive = true;
    await targetAccount.save();

    console.log(
      `[github] Switched active account: userId=${userId}, accountId=${accountId}, login=${targetAccount.accountLogin}`
    );

    return res.json({
      success: true,
      message: `Switched to ${targetAccount.accountLogin}`,
      activeAccount: {
        id: targetAccount.id,
        installationId: targetAccount.installationId,
        accountLogin: targetAccount.accountLogin,
        accountType: targetAccount.accountType,
        avatarUrl: targetAccount.avatarUrl,
      },
    });
  } catch (err) {
    console.error("[github] switchAccount error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to switch account",
    });
  }
};

/**
 * GET /api/github/repos
 * Fetch repos for the active account (or a specific account via query param).
 */
exports.getRepos = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const search = req.query.search || "";
    const filter = req.query.filter || "all";
    const accountId = req.query.accountId
      ? parseInt(req.query.accountId)
      : null;

    // Find the target account
    let account;
    if (accountId) {
      account = await GithubAccount.findOne({
        where: { id: accountId, userId },
      });
    } else {
      // Use active account
      account = await GithubAccount.findOne({
        where: { userId, isActive: true },
      });
    }

    if (!account) {
      // Fallback: try any account for this user
      account = await GithubAccount.findOne({ where: { userId } });
    }

    if (!account) {
      return res.status(404).json({
        success: false,
        message:
          "GitHub not connected. Please install the GitHub App first.",
      });
    }

    // Fetch repos via installation token
    const { repos: rawRepos, totalCount } = await getInstallationRepos(
      account.installationId,
      page,
      limit,
      search,
      filter,
      account.accountLogin,
      account.accountType
    );

    // Sanitize — only return what the frontend needs
    const repos = rawRepos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      description: repo.description || "",
      language: repo.language || "",
      html_url: repo.html_url,
      updated_at: repo.updated_at,
      owner: {
        login: repo.owner?.login,
        avatar_url: repo.owner?.avatar_url,
        type: repo.owner?.type,
      },
    }));

    const hasMore = page * limit < totalCount;

    return res.json({
      success: true,
      accountLogin: account.accountLogin,
      accountType: account.accountType,
      repos,
      totalCount,
      page,
      hasMore,
    });
  } catch (err) {
    console.error("[github] getRepos error:", err.message);

    // Handle specific GitHub errors
    if (err.status === 401 || err.message.includes("Not Found")) {
      return res.status(401).json({
        success: false,
        message:
          "GitHub installation token expired or invalid. Please reconnect GitHub.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to fetch repositories",
    });
  }
};

/**
 * GET /api/github/status
 * Backward-compatible status endpoint.
 * Returns the active account info (or first account if none active).
 */
exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Try active account first
    let account = await GithubAccount.findOne({
      where: { userId, isActive: true },
    });

    // Fallback to any account
    if (!account) {
      account = await GithubAccount.findOne({ where: { userId } });
    }

    if (!account) {
      return res.json({
        success: true,
        connected: false,
      });
    }

    return res.json({
      success: true,
      connected: true,
      accountLogin: account.accountLogin,
      accountType: account.accountType,
      installationId: account.installationId,
      avatarUrl: account.avatarUrl,
    });
  } catch (err) {
    console.error("[github] getStatus error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to check GitHub status",
    });
  }
};

/**
 * DELETE /api/github/disconnect/:accountId?
 * Remove a specific GitHub account, or all accounts if no ID given.
 * Also deletes the installation on GitHub so reconnect triggers fresh install.
 */
exports.disconnect = async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = req.params.accountId
      ? parseInt(req.params.accountId)
      : null;

    if (accountId) {
      // Delete specific account
      const account = await GithubAccount.findOne({
        where: { id: accountId, userId },
      });

      if (!account) {
        return res.status(404).json({
          success: false,
          message: "GitHub account not found",
        });
      }

      // Delete installation on GitHub (so reconnect works as fresh install)
      await deleteInstallation(account.installationId);

      const wasActive = account.isActive;
      await account.destroy();

      // If deleted account was the active one, activate another
      if (wasActive) {
        const nextAccount = await GithubAccount.findOne({
          where: { userId },
          order: [["createdAt", "ASC"]],
        });
        if (nextAccount) {
          nextAccount.isActive = true;
          await nextAccount.save();
        }
      }

      console.log(
        `[github] Disconnected account ${accountId} (${account.accountLogin}) for userId=${userId}`
      );
    } else {
      // Disconnect all — delete each installation on GitHub first
      const allAccounts = await GithubAccount.findAll({ where: { userId } });
      for (const account of allAccounts) {
        await deleteInstallation(account.installationId);
      }

      const deleted = await GithubAccount.destroy({ where: { userId } });
      console.log(
        `[github] Disconnected all GitHub accounts for userId=${userId} (${deleted} removed)`
      );
    }

    return res.json({
      success: true,
      message: "GitHub disconnected successfully",
    });
  } catch (err) {
    console.error("[github] disconnect error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to disconnect GitHub",
    });
  }
};

/**
 * POST /api/github/webhook
 * Handle incoming GitHub webhook events.
 * Called with raw body for signature verification.
 */
exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];
    const deliveryId = req.headers["x-github-delivery"];

    // Verify webhook signature
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error(
        "[github webhook] No raw body available for signature verification"
      );
      return res.status(400).json({ error: "No body" });
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error(
        "[github webhook] Invalid signature for delivery:",
        deliveryId
      );
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody.toString());

    console.log(
      `[github webhook] Event: ${event}, Delivery: ${deliveryId}`
    );

    // ── Handle push event → trigger redeploy ──────────────────────
    if (event === "push") {
      await handlePushEvent(payload);
    }

    // ── Handle installation deleted → clean up DB ─────────────────
    if (event === "installation" && payload.action === "deleted") {
      await handleInstallationDeleted(payload);
    }

    // ── Handle installation repositories changed ──────────────────
    if (event === "installation_repositories") {
      console.log(
        `[github webhook] Repositories ${payload.action} for installation ${payload.installation?.id}`
      );
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[github webhook] Error:", err.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Handle a push event — find matching projects and trigger redeploy.
 */
async function handlePushEvent(payload) {
  const repoFullName = payload.repository?.full_name;
  const branch = payload.ref?.replace("refs/heads/", "");
  const installationId = payload.installation?.id;

  // Extract commit info from webhook payload
  const commitSha = payload.head_commit?.id || payload.after || null;
  const commitMessage = payload.head_commit?.message || null;

  if (!repoFullName || !branch) {
    console.log("[github webhook] Push event missing repo/branch info");
    return;
  }

  console.log(`[github webhook] Push to ${repoFullName}@${branch}`);

  // Find all projects whose repoUrl contains this repo's full name
  const projects = await Project.findAll({
    where: {
      projectRepoUrl: {
        [Op.like]: `%${repoFullName}%`,
      },
      branch: branch,
    },
    include: [{ model: DockerInfo }],
  });

  if (projects.length === 0) {
    console.log(
      `[github webhook] No matching projects for ${repoFullName}@${branch}`
    );
    return;
  }

  for (const project of projects) {
    try {
      // Check if auto-deploy is enabled for this project
      if (project.autoDeployOnPush === false) {
        console.log(
          `[github webhook] Skipping project ${project.id} — autoDeployOnPush is disabled`
        );
        continue;
      }

      // Skip if already deploying
      const inProgress = await DeploymentJob.findOne({
        where: {
          ProjectId: project.id,
          status: { [Op.in]: ["queued", "building"] },
        },
      });

      if (inProgress) {
        console.log(
          `[github webhook] Skipping project ${project.id} — deployment already in progress`
        );
        continue;
      }

      // Create deployment job with commit info
      const dbJob = await DeploymentJob.create({
        ProjectId: project.id,
        UserId: project.UserId,
        status: "queued",
        logs: `[WEBHOOK] Auto-deploy triggered by push to ${repoFullName}@${branch}\n`,
        commitSha: commitSha ? commitSha.slice(0, 40) : null,
        commitMessage: commitMessage ? commitMessage.slice(0, 500) : null,
      });

      // Update docker status
      await DockerInfo.update(
        { status: "queued" },
        { where: { ProjectId: project.id } }
      );

      // Enqueue BullMQ job
      const bullJob = await deployQueue.add(
        "deploy",
        {
          projectId: project.id,
          deploymentJobId: dbJob.id,
          userId: project.UserId,
        },
        { jobId: `deploy-${project.id}-${dbJob.id}` }
      );

      dbJob.bullmqJobId = String(bullJob.id);
      await dbJob.save();

      console.log(
        `[github webhook] ✅ Auto-deploy triggered for project ${project.id} (${project.title})`
      );
    } catch (err) {
      console.error(
        `[github webhook] Failed to trigger deploy for project ${project.id}:`,
        err.message
      );
    }
  }
}

/**
 * Handle installation deleted — remove from DB.
 * Now uses GithubAccount instead of GithubInstallation.
 */
async function handleInstallationDeleted(payload) {
  const installationId = payload.installation?.id;
  if (!installationId) return;

  const deleted = await GithubAccount.destroy({
    where: { installationId },
  });

  console.log(
    `[github webhook] Installation ${installationId} deleted — removed ${deleted} account(s)`
  );
}
