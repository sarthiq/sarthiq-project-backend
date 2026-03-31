/**
 * containerRoutes.js
 * ─────────────────────────────────────────────────────────────────────
 * REST + SSE endpoints for container interaction:
 *   - GET  /:projectId/logs          → SSE stream of pod logs
 *   - GET  /:projectId/logs/download → Download full logs as file
 *   - GET  /:projectId/metrics       → Current CPU/Memory usage
 *   - GET  /:projectId/terminal/info → Terminal session info
 *
 * Terminal WebSocket is handled separately in Utils/containerService.js
 * All endpoints require JWT authentication.
 * ─────────────────────────────────────────────────────────────────────
 */
const express = require("express");
const router = express.Router();
const { userAuthentication } = require("../../Middleware/auth");
const {
  streamPodLogsHandler,
  downloadPodLogsHandler,
  getPodMetricsHandler,
  getTerminalInfoHandler,
} = require("../../Controller/User/containerController");

/* ================================================================== */
/* 1. REAL-TIME LOG STREAMING (SSE)                                    */
/* ================================================================== */
router.get("/:projectId/logs", userAuthentication, streamPodLogsHandler);

/* ================================================================== */
/* 2. LOG DOWNLOAD                                                     */
/* ================================================================== */
router.get("/:projectId/logs/download", userAuthentication, downloadPodLogsHandler);

/* ================================================================== */
/* 3. POD METRICS                                                      */
/* ================================================================== */
router.get("/:projectId/metrics", userAuthentication, getPodMetricsHandler);

/* ================================================================== */
/* 4. TERMINAL SESSION INFO                                            */
/* ================================================================== */
router.get("/:projectId/terminal/info", userAuthentication, getTerminalInfoHandler);

module.exports = router;
