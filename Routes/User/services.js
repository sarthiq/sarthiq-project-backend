/**
 * services.js (Routes)
 * ─────────────────────────────────────────────────────────────────────
 * Express router for all PaaS service infrastructure endpoints.
 * All routes require userAuthentication.
 * ─────────────────────────────────────────────────────────────────────
 */
const express = require("express");
const router = express.Router();
const { userAuthentication } = require("../../Middleware/auth");

// ── Service controllers ──────────────────────────────────────────────
const {
  createService,
  deleteService,
  listServices,
  getService,
  getCatalog,
  stopService,
  startService,
  getUsage,
  registerExternalService,
} = require("../../Controller/User/serviceController");

// ── Environment controllers ──────────────────────────────────────────
const {
  setEnvVars,
  getEnvVars,
  deleteEnvVar,
  syncEnvVars,
} = require("../../Controller/User/envController");

// ── Logs controllers ─────────────────────────────────────────────────
const {
  getProjectLogs,
  getServiceLogs,
} = require("../../Controller/User/logsController");

// ── Metrics controllers ──────────────────────────────────────────────
const {
  getProjectMetrics,
  getServiceMetrics,
} = require("../../Controller/User/metricsController");

// ── Jobs controllers ─────────────────────────────────────────────────
const {
  createJob,
  deleteJob,
  listJobs,
  suspendJob,
  resumeJob,
  getJobHistory,
} = require("../../Controller/User/jobsController");

// ── All routes require authentication ────────────────────────────────
router.use(userAuthentication);

/* ═══════════════════════════════════════════════════════════════════
 * SERVICE MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════ */

// Service catalog (public listing of available services)
router.get("/catalog", getCatalog);

// Resource usage summary
router.get("/usage", getUsage);

// CRUD
router.post("/create", createService);
router.delete("/:id", deleteService);
router.get("/project/:projectId", listServices);
router.get("/:id", getService);

// Lifecycle
router.post("/:id/stop", stopService);
router.post("/:id/start", startService);

// BYOS — Bring Your Own Service
router.post("/external", registerExternalService);

/* ═══════════════════════════════════════════════════════════════════
 * ENVIRONMENT VARIABLES
 * ═══════════════════════════════════════════════════════════════════ */
router.post("/env/set", setEnvVars);
router.get("/env/:projectId", getEnvVars);
router.delete("/env/:projectId/:key", deleteEnvVar);
router.post("/env/:projectId/sync", syncEnvVars);

/* ═══════════════════════════════════════════════════════════════════
 * LOGS
 * ═══════════════════════════════════════════════════════════════════ */
router.get("/logs/:projectId", getProjectLogs);
router.get("/logs/service/:serviceInstanceId", getServiceLogs);

/* ═══════════════════════════════════════════════════════════════════
 * METRICS
 * ═══════════════════════════════════════════════════════════════════ */
router.get("/metrics/:projectId", getProjectMetrics);
router.get("/metrics/service/:serviceInstanceId", getServiceMetrics);

/* ═══════════════════════════════════════════════════════════════════
 * CRON JOBS
 * ═══════════════════════════════════════════════════════════════════ */
router.post("/jobs/create", createJob);
router.delete("/jobs/:id", deleteJob);
router.get("/jobs/project/:projectId", listJobs);
router.post("/jobs/:id/suspend", suspendJob);
router.post("/jobs/:id/resume", resumeJob);
router.get("/jobs/:id/history", getJobHistory);

module.exports = router;
