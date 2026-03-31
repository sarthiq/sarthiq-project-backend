/**
 * terminalManager.js
 * ─────────────────────────────────────────────────────────────────────
 * Manages terminal session lifecycle:
 *   - Tracks active sessions per user
 *   - Enforces max concurrent sessions (2 per user)
 *   - Auto-expires sessions after 10 minutes total or 3 min idle
 *   - Detects suspicious commands
 *   - Logs sessions for audit
 * ─────────────────────────────────────────────────────────────────────
 */
const { v4: uuidv4 } = require("uuid");
const { SUSPICIOUS_COMMANDS } = require("./sandboxManager");

/* ── Configuration ─────────────────────────────────────────────────── */
const MAX_SESSION_DURATION_MS = parseInt(process.env.TERMINAL_MAX_SESSION_MS || String(10 * 60 * 1000)); // 10 min
const IDLE_TIMEOUT_MS = parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || String(3 * 60 * 1000));          // 3 min
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.TERMINAL_MAX_CONCURRENT || "2");

/* ── In-memory session store ───────────────────────────────────────── */

/**
 * Map<sessionId, SessionInfo>
 * SessionInfo: { userId, projectId, podName, startedAt, lastActivityAt, timers, ws }
 */
const activeSessions = new Map();

/**
 * Map<userId, Set<sessionId>>
 */
const userSessions = new Map();

/* ── Session management ────────────────────────────────────────────── */

/**
 * Create a new terminal session.
 * @param {number} userId
 * @param {number} projectId
 * @param {string} podName
 * @returns {{ sessionId: string } | { error: string }}
 */
function createSession(userId, projectId, podName) {
  // Check concurrent session limit
  const existing = userSessions.get(userId) || new Set();
  if (existing.size >= MAX_CONCURRENT_SESSIONS) {
    return {
      error: `Maximum ${MAX_CONCURRENT_SESSIONS} concurrent terminal sessions allowed. Close an existing session first.`,
    };
  }

  const sessionId = uuidv4();
  const now = Date.now();

  const session = {
    sessionId,
    userId,
    projectId,
    podName,
    startedAt: now,
    lastActivityAt: now,
    commandCount: 0,
    timers: {},
    ws: null,       // assigned later
    k8sExec: null,  // assigned later
    onExpire: null,  // callback assigned later
  };

  // Set absolute session timeout (10 min)
  session.timers.absolute = setTimeout(() => {
    terminateSession(sessionId, "timeout");
  }, MAX_SESSION_DURATION_MS);

  // Set idle timeout (3 min)
  session.timers.idle = setTimeout(() => {
    terminateSession(sessionId, "idle");
  }, IDLE_TIMEOUT_MS);

  activeSessions.set(sessionId, session);

  // Track per-user
  if (!userSessions.has(userId)) {
    userSessions.set(userId, new Set());
  }
  userSessions.get(userId).add(sessionId);

  return { sessionId, session };
}

/**
 * Record activity on a session (resets idle timer).
 * @param {string} sessionId
 */
function recordActivity(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  session.lastActivityAt = Date.now();
  session.commandCount++;

  // Reset idle timer
  clearTimeout(session.timers.idle);
  session.timers.idle = setTimeout(() => {
    terminateSession(sessionId, "idle");
  }, IDLE_TIMEOUT_MS);
}

/**
 * Terminate a session and clean up resources.
 * @param {string} sessionId
 * @param {string} reason - "timeout" | "idle" | "user_closed" | "suspicious_activity"
 */
function terminateSession(sessionId, reason = "user_closed") {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Clear timers
  clearTimeout(session.timers.absolute);
  clearTimeout(session.timers.idle);

  // Close WebSocket if still open
  if (session.ws && session.ws.readyState <= 1) {
    try {
      session.ws.send(JSON.stringify({
        type: "session_ended",
        reason,
        message: reason === "timeout"
          ? "Session expired (10 minute limit reached)"
          : reason === "idle"
            ? "Session expired due to inactivity (3 minutes)"
            : reason === "suspicious_activity"
              ? "Session terminated — suspicious activity detected"
              : "Session closed",
      }));
      session.ws.close(1000, reason);
    } catch {
      // ws may already be closed
    }
  }

  // Invoke expire callback (saves to DB)
  if (session.onExpire) {
    session.onExpire(reason, session.commandCount);
  }

  // Remove from tracking
  activeSessions.delete(sessionId);
  const userSet = userSessions.get(session.userId);
  if (userSet) {
    userSet.delete(sessionId);
    if (userSet.size === 0) userSessions.delete(session.userId);
  }

  console.log(
    `[terminalManager] Session ${sessionId} terminated: ${reason} ` +
    `(user=${session.userId}, pod=${session.podName}, commands=${session.commandCount})`
  );
}

/**
 * Check if input contains suspicious commands.
 * @param {string} input
 * @returns {{ suspicious: boolean, match: string | null }}
 */
function checkSuspiciousInput(input) {
  if (!input || typeof input !== "string") {
    return { suspicious: false, match: null };
  }
  for (const pattern of SUSPICIOUS_COMMANDS) {
    if (pattern.test(input)) {
      return { suspicious: true, match: pattern.source };
    }
  }
  return { suspicious: false, match: null };
}

/**
 * Get session info for the remaining time display.
 * @param {string} sessionId
 * @returns {object|null}
 */
function getSessionInfo(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  const elapsed = now - session.startedAt;
  const remaining = Math.max(0, MAX_SESSION_DURATION_MS - elapsed);
  const idleTime = now - session.lastActivityAt;
  const idleRemaining = Math.max(0, IDLE_TIMEOUT_MS - idleTime);

  return {
    sessionId,
    userId: session.userId,
    podName: session.podName,
    commandCount: session.commandCount,
    elapsedMs: elapsed,
    remainingMs: remaining,
    idleMs: idleTime,
    idleRemainingMs: idleRemaining,
  };
}

/**
 * Get active session count for a user.
 */
function getUserSessionCount(userId) {
  return (userSessions.get(userId) || new Set()).size;
}

/**
 * Clean up all sessions for a user (e.g., on disconnect).
 */
function cleanupUserSessions(userId) {
  const sessions = userSessions.get(userId);
  if (!sessions) return;
  for (const sid of sessions) {
    terminateSession(sid, "user_closed");
  }
}

module.exports = {
  createSession,
  recordActivity,
  terminateSession,
  checkSuspiciousInput,
  getSessionInfo,
  getUserSessionCount,
  cleanupUserSessions,

  // Constants for frontend
  MAX_SESSION_DURATION_MS,
  IDLE_TIMEOUT_MS,
  MAX_CONCURRENT_SESSIONS,
};
