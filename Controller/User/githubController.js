/**
 * githubController.js
 * ─────────────────────────────────────────────────────────────────────
 * Handles all GitHub App integration endpoints:
 *  - Connect (redirect to GitHub App install)
 *  - Install callback (store installation mapping)
 *  - Repo listing (via installation token)
 *  - Status check (is GitHub connected?)
 *  - Disconnect (remove installation)
 *  - Webhook handler (push → redeploy)
 * ─────────────────────────────────────────────────────────────────────
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY } = require("../../importantInfo");
const GithubInstallation = require("../../Models/Projects/githubInstallation");
const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const { deployQueue } = require("../../Jobs/queues");
const { Op } = require("sequelize");

const {
  getInstallationRepos,
  verifyWebhookSignature,
  getInstallationInfo,
} = require("../../Utils/githubApp");

// ── GitHub App name (used in install URL) ──────────────────────────
const GITHUB_APP_SLUG = "sarthiq-project";

/**
 * GET /api/github/connect
 * Redirect user to GitHub App installation page.
 * Encodes userId into a signed JWT state param for secure callback.
 */
exports.connectGithub = async (req, res) => {
  try {
    const userId = req.user.id;

    // Sign a short-lived state token (5 min) so the callback can map back to this user
    const state = jwt.sign({ userId, purpose: "github_install" }, JWT_SECRET_KEY, {
      expiresIn: "5m",
    });

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
        // Fallback: check if user is authenticated via header
        if (req.user) {
          userId = req.user.id;
        } else {
          const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
          return res.redirect(`${frontendUrl}/github?error=invalid_state`);
        }
      }
    } else if (req.user) {
      userId = req.user.id;
    } else {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/github?error=no_state`);
    }

    const installId = parseInt(installation_id);

    // Fetch installation info from GitHub to get account details
    let accountLogin = null;
    let accountType = "User";
    try {
      const installInfo = await getInstallationInfo(installId);
      accountLogin = installInfo.account?.login || null;
      accountType = installInfo.account?.type || "User";
    } catch (err) {
      console.warn("[github] Could not fetch installation info:", err.message);
    }

    // Upsert: update if exists, create if not
    const [installation, created] = await GithubInstallation.findOrCreate({
      where: { userId },
      defaults: {
        installationId: installId,
        accountLogin,
        accountType,
      },
    });

    if (!created) {
      // Update existing installation
      installation.installationId = installId;
      installation.accountLogin = accountLogin;
      installation.accountType = accountType;
      await installation.save();
    }

    console.log(
      `[github] ${created ? "Created" : "Updated"} installation for userId=${userId}, installationId=${installId}, account=${accountLogin}`
    );

    // Redirect to frontend
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(`${frontendUrl}/github?github=connected`);
  } catch (err) {
    console.error("[github] handleInstallCallback error:", err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(`${frontendUrl}/github?error=callback_failed`);
  }
};

/**
 * GET /github/setup
 * GitHub's "Setup URL" redirect — same logic as install callback.
 */
exports.handleSetupRedirect = async (req, res) => {
  try {
    const { installation_id } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    if (!installation_id) {
      return res.redirect(`${frontendUrl}/github`);
    }

    // If there's a state param, process like callback
    if (req.query.state) {
      return exports.handleInstallCallback(req, res);
    }

    // Otherwise just redirect to frontend github page
    return res.redirect(`${frontendUrl}/github?installation_id=${installation_id}`);
  } catch (err) {
    console.error("[github] handleSetupRedirect error:", err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(`${frontendUrl}/github?error=setup_failed`);
  }
};

/**
 * GET /api/github/repos
 * Fetch all repos accessible to the user's GitHub App installation.
 */
exports.getRepos = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const search = req.query.search || "";
    const filter = req.query.filter || "all";

    // Find the user's installation
    const installation = await GithubInstallation.findOne({
      where: { userId },
    });

    if (!installation) {
      return res.status(404).json({
        success: false,
        message: "GitHub not connected. Please install the GitHub App first.",
      });
    }

    // Fetch repos via installation token
    const { repos: rawRepos, totalCount } = await getInstallationRepos(
      installation.installationId,
      page,
      limit,
      search,
      filter,
      installation.accountLogin,
      installation.accountType
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
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
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
 * Check if the user has a connected GitHub installation.
 */
exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const installation = await GithubInstallation.findOne({
      where: { userId },
    });

    if (!installation) {
      return res.json({
        success: true,
        connected: false,
      });
    }

    return res.json({
      success: true,
      connected: true,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      installationId: installation.installationId,
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
 * DELETE /api/github/disconnect
 * Remove the user's GitHub installation from the DB.
 */
exports.disconnect = async (req, res) => {
  try {
    const userId = req.user.id;

    const deleted = await GithubInstallation.destroy({
      where: { userId },
    });

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: "No GitHub installation found to disconnect",
      });
    }

    console.log(`[github] Disconnected GitHub for userId=${userId}`);

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
      console.error("[github webhook] No raw body available for signature verification");
      return res.status(400).json({ error: "No body" });
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error("[github webhook] Invalid signature for delivery:", deliveryId);
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody.toString());

    console.log(`[github webhook] Event: ${event}, Delivery: ${deliveryId}`);

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
    console.log(`[github webhook] No matching projects for ${repoFullName}@${branch}`);
    return;
  }

  for (const project of projects) {
    try {
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

      // Create deployment job
      const dbJob = await DeploymentJob.create({
        ProjectId: project.id,
        UserId: project.UserId,
        status: "queued",
        logs: `[WEBHOOK] Auto-deploy triggered by push to ${repoFullName}@${branch}\n`,
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
 */
async function handleInstallationDeleted(payload) {
  const installationId = payload.installation?.id;
  if (!installationId) return;

  const deleted = await GithubInstallation.destroy({
    where: { installationId },
  });

  console.log(
    `[github webhook] Installation ${installationId} deleted — removed ${deleted} record(s)`
  );
}
