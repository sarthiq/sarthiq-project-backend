/**
 * userManagementController.js
 * ─────────────────────────────────────────────────────────────────────
 * Admin-only REST endpoints for user management.
 * Since the User model lives on sarthiq.com auth service, we reconstruct
 * "virtual user records" by grouping Projects + DockerInfo by UserId.
 *
 * Endpoints:
 *   GET  /admin/users           → list all users with project stats
 *   GET  /admin/users/:userId   → detailed per-user view
 *   POST /admin/users/:userId/sleep/:projectId  → force-sleep a project
 *   POST /admin/users/:userId/wake/:projectId   → force-wake a project
 * ─────────────────────────────────────────────────────────────────────
 */

const Project = require("../../Models/Projects/projects");
const DockerInfo = require("../../Models/Projects/dockerInfo");
const DeploymentJob = require("../../Models/Deployment/deploymentJob");
const UserActivity = require("../../Models/User/userActivity");
const AdminActivity = require("../../Models/User/adminActivity");
const { scaleDeployment } = require("../../Utils/kubeClient");
const { sequelize } = require("../../importantInfo");
const { Op } = require("sequelize");

/* ── Parse helpers ─────────────────────────────────────────────────── */
function parseCpuToMillicores(cpu) {
  if (!cpu) return 0;
  const str = String(cpu);
  if (str.endsWith("m")) return parseInt(str);
  if (str.endsWith("n")) return Math.round(parseInt(str) / 1_000_000);
  const bare = parseFloat(str);
  if (!isNaN(bare)) return Math.round(bare * 1000);
  return 0;
}

function parseMemoryToMi(mem) {
  if (!mem) return 0;
  const str = String(mem);
  if (/^\d+m$/.test(str)) return parseInt(str); // docker "512m" = 512Mi
  if (str.endsWith("Ki")) return Math.round(parseInt(str) / 1024);
  if (str.endsWith("Mi")) return parseInt(str);
  if (str.endsWith("Gi")) return parseInt(str) * 1024;
  if (str.endsWith("Ti")) return parseInt(str) * 1024 * 1024;
  return Math.round(parseInt(str) / (1024 * 1024));
}

/* ── Log admin activity helper ──────────────────────────────────────── */
async function logAdminAction(adminId, type, description) {
  try {
    await AdminActivity.create({ AdminId: adminId, activityType: type, activityDescription: description });
  } catch { /* non-critical */ }
}

/* ================================================================== */
/* GET /admin/users — All users with stats                             */
/* ================================================================== */
exports.getAllUsers = async (req, res) => {
  try {
    // Fetch all projects with their DockerInfo
    const projects = await Project.findAll({
      include: [{ model: DockerInfo, required: false }],
      order: [["UserId", "ASC"], ["createdAt", "DESC"]],
    });

    // Group by UserId
    const userMap = new Map();
    for (const p of projects) {
      const uid = p.UserId;
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          userId: uid,
          projects: [],
          running: 0,
          sleeping: 0,
          building: 0,
          failed: 0,
          idle: 0,
          totalCpuM: 0,
          totalMemMi: 0,
          lastActivity: null,
          createdAt: p.createdAt, // earliest project date as proxy for join date
        });
      }
      const u = userMap.get(uid);
      const di = p.DockerInfo;
      const status = di?.status || "idle";

      u.projects.push({
        id: p.id,
        title: p.title,
        subdomain: p.subdomain,
        status,
        cpu: di?.cpu || "0m",
        memory: di?.memory || "0Mi",
        disk: di?.disk || "0Mi",
        deployedAt: di?.deployedAt,
        lastActivityAt: di?.lastActivityAt,
        nodeId: di?.nodeId,
      });

      u[status] = (u[status] || 0) + 1;
      u.totalCpuM += parseCpuToMillicores(di?.cpu);
      u.totalMemMi += parseMemoryToMi(di?.memory);

      const lat = di?.lastActivityAt ? new Date(di.lastActivityAt) : null;
      if (lat && (!u.lastActivity || lat > u.lastActivity)) {
        u.lastActivity = lat;
      }
    }

    // Fetch last user activity timestamps for each userId
    const userIds = [...userMap.keys()];
    if (userIds.length > 0) {
      const activities = await UserActivity.findAll({
        where: { UserId: { [Op.in]: userIds } },
        order: [["createdAt", "DESC"]],
      });
      const activityMap = new Map();
      for (const a of activities) {
        if (!activityMap.has(a.UserId)) activityMap.set(a.UserId, a.createdAt);
      }
      for (const [uid, user] of userMap) {
        const actAt = activityMap.get(uid);
        if (actAt) {
          const d = new Date(actAt);
          if (!user.lastActivity || d > user.lastActivity) user.lastActivity = d;
        }
      }
    }

    const users = [...userMap.values()].map(u => ({
      userId: u.userId,
      projectCount: u.projects.length,
      running: u.running || 0,
      sleeping: u.sleeping || 0,
      building: u.building || 0,
      failed: u.failed || 0,
      idle: u.idle || 0,
      totalCpuM: u.totalCpuM,
      totalMemMi: u.totalMemMi,
      lastActivity: u.lastActivity,
      createdAt: u.createdAt,
    })).sort((a, b) => b.projectCount - a.projectCount);

    res.json({ success: true, users, total: users.length });
  } catch (err) {
    console.error("[userMgmt] getAllUsers error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ================================================================== */
/* GET /admin/users/:userId — Per-user detail                         */
/* ================================================================== */
exports.getUserDetail = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, message: "Invalid userId" });

    // All projects for this user
    const projects = await Project.findAll({
      where: { UserId: userId },
      include: [{ model: DockerInfo, required: false }],
      order: [["createdAt", "DESC"]],
    });

    if (projects.length === 0) {
      return res.json({ success: true, userId, projects: [], activities: [], summary: {} });
    }

    // Recent deployments
    const projectIds = projects.map(p => p.id);
    const recentJobs = await DeploymentJob.findAll({
      where: { ProjectId: { [Op.in]: projectIds } },
      order: [["createdAt", "DESC"]],
      limit: 20,
    });

    // Recent user activity
    const activities = await UserActivity.findAll({
      where: { UserId: userId },
      order: [["createdAt", "DESC"]],
      limit: 20,
    });

    // Build project detail list
    const projectDetails = projects.map(p => {
      const di = p.DockerInfo;
      const pJobs = recentJobs.filter(j => j.ProjectId === p.id);
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        subdomain: p.subdomain,
        projectRepoUrl: p.projectRepoUrl,
        branch: p.branch,
        frameWork: p.frameWork,
        detectedLanguage: p.detectedLanguage,
        status: di?.status || "idle",
        cpu: di?.cpu || "0m",
        memory: di?.memory || "0Mi",
        disk: di?.disk || "0Mi",
        deployedAt: di?.deployedAt,
        lastActivityAt: di?.lastActivityAt,
        nodeId: di?.nodeId,
        totalCpuM: parseCpuToMillicores(di?.cpu),
        totalMemMi: parseMemoryToMi(di?.memory),
        recentJobs: pJobs.slice(0, 5).map(j => ({
          id: j.id,
          status: j.status,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          errorMessage: j.errorMessage,
        })),
      };
    });

    // Summary
    const summary = {
      projectCount: projects.length,
      running: projectDetails.filter(p => p.status === "running").length,
      sleeping: projectDetails.filter(p => p.status === "sleeping").length,
      failed: projectDetails.filter(p => p.status === "failed").length,
      building: projectDetails.filter(p => p.status === "building" || p.status === "queued").length,
      totalCpuM: projectDetails.reduce((s, p) => s + p.totalCpuM, 0),
      totalMemMi: projectDetails.reduce((s, p) => s + p.totalMemMi, 0),
    };

    res.json({
      success: true,
      userId,
      projects: projectDetails,
      activities: activities.map(a => ({
        id: a.id,
        activityType: a.activityType,
        activityDescription: a.activityDescription,
        createdAt: a.createdAt,
        ipAddress: a.ipAddress,
      })),
      summary,
    });
  } catch (err) {
    console.error("[userMgmt] getUserDetail error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ================================================================== */
/* POST /admin/users/:userId/sleep/:projectId — Force sleep project   */
/* ================================================================== */
exports.forceSleepProject = async (req, res) => {
  try {
    const { userId, projectId } = req.params;
    const project = await Project.findByPk(projectId, { include: [DockerInfo] });
    if (!project || project.UserId !== parseInt(userId)) {
      return res.status(404).json({ success: false, message: "Project not found or user mismatch" });
    }
    const di = project.DockerInfo;
    if (!di) return res.status(400).json({ success: false, message: "No deploy info" });

    await scaleDeployment(project.subdomain, 0);
    di.status = "sleeping";
    await di.save();

    await logAdminAction(
      req.admin.id,
      "FORCE_SLEEP",
      `Admin force-slept project #${projectId} (${project.title}) owned by User #${userId}`
    );

    res.json({ success: true, message: `Project '${project.title}' put to sleep.` });
  } catch (err) {
    console.error("[userMgmt] forceSleep error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ================================================================== */
/* POST /admin/users/:userId/wake/:projectId — Force wake project     */
/* ================================================================== */
exports.forceWakeProject = async (req, res) => {
  try {
    const { userId, projectId } = req.params;
    const project = await Project.findByPk(projectId, { include: [DockerInfo] });
    if (!project || project.UserId !== parseInt(userId)) {
      return res.status(404).json({ success: false, message: "Project not found or user mismatch" });
    }
    const di = project.DockerInfo;
    if (!di) return res.status(400).json({ success: false, message: "No deploy info" });

    await scaleDeployment(project.subdomain, 1);
    di.status = "running";
    await di.save();

    await logAdminAction(
      req.admin.id,
      "FORCE_WAKE",
      `Admin force-woke project #${projectId} (${project.title}) owned by User #${userId}`
    );

    res.json({ success: true, message: `Project '${project.title}' woken up.` });
  } catch (err) {
    console.error("[userMgmt] forceWake error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
