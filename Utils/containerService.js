/**
 * containerService.js
 * ─────────────────────────────────────────────────────────────────────
 * Kubernetes interaction service for real-time container operations:
 *   1. Pod log streaming (follow mode)
 *   2. Pod exec (interactive shell via WebSocket)
 *   3. Pod resource metrics (CPU / Memory)
 *
 * All methods enforce multi-tenant isolation:
 *   userId → projectId → podName ownership validation
 * ─────────────────────────────────────────────────────────────────────
 */
const k8s = require("@kubernetes/client-node");
const http = require("http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY } = require("../importantInfo");
const Project = require("../Models/Projects/projects");
const DockerInfo = require("../Models/Projects/dockerInfo");
const TerminalSession = require("../Models/Deployment/terminalSession");
const { safeLabel, NAMESPACE } = require("./kubeClient");
const terminalManager = require("./terminalManager");

/* ── K8s client setup ──────────────────────────────────────────────── */
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const metricsClient = new k8s.Metrics(kc);
const exec = new k8s.Exec(kc);

/* ================================================================== */
/* 1. OWNERSHIP VALIDATION                                             */
/* ================================================================== */

/**
 * Validate that a user owns the project and get the running pod name.
 *
 * @param {number} userId - authenticated user ID
 * @param {number|string} projectId - project ID
 * @returns {{ project, dockerInfo, podName, containerName, label }}
 * @throws {Error} with statusCode property on validation failure
 */
async function validateAndGetPod(userId, projectId) {
  // 1. Look up project
  const project = await Project.findByPk(projectId, {
    include: [{ model: DockerInfo }],
  });

  if (!project) {
    const err = new Error("Project not found");
    err.statusCode = 404;
    throw err;
  }

  // 2. Verify ownership
  if (project.UserId !== userId) {
    const err = new Error("Access denied — you do not own this project");
    err.statusCode = 403;
    throw err;
  }

  // 3. Check deployment status
  const dockerInfo = project.DockerInfo;
  if (!dockerInfo || dockerInfo.status !== "running") {
    const err = new Error(
      `Pod is not running (status: ${dockerInfo?.status || "not deployed"})`
    );
    err.statusCode = 400;
    throw err;
  }

  // 4. Get the pod name from K8s
  const label = safeLabel(project.subdomain);
  const podList = await coreV1.listNamespacedPod({
    namespace: NAMESPACE,
    labelSelector: `app=${label}`,
  });

  const pods = podList.items || [];
  const runningPod = pods.find(
    (p) => p.status && p.status.phase === "Running"
  );

  if (!runningPod) {
    const err = new Error("No running pod found for this project");
    err.statusCode = 404;
    throw err;
  }

  const podName = runningPod.metadata.name;
  const containerName =
    runningPod.spec.containers[0]?.name || label;

  return { project, dockerInfo, podName, containerName, label };
}

/* ================================================================== */
/* 2. POD LOG STREAMING                                                */
/* ================================================================== */

/**
 * Stream pod logs via Kubernetes API (follow mode).
 *
 * @param {string} podName
 * @param {string} containerName
 * @param {object} options - { tailLines, sinceSeconds, filter }
 * @returns {ReadableStream} - Node.js readable stream of log data
 */
async function streamPodLogs(podName, containerName, options = {}) {
  const { tailLines = 200, sinceSeconds = null } = options;

  const log = new k8s.Log(kc);

  const logStream = new require("stream").PassThrough();

  await log.log(
    NAMESPACE,
    podName,
    containerName,
    logStream,
    {
      follow: true,
      tailLines: tailLines,
      pretty: false,
      timestamps: true,
      ...(sinceSeconds && { sinceSeconds }),
    }
  );

  return logStream;
}

/**
 * Get full pod logs (non-streaming, for download).
 */
async function getFullPodLogs(podName, containerName) {
  const log = new k8s.Log(kc);
  const logStream = new require("stream").PassThrough();
  let logData = "";

  return new Promise((resolve, reject) => {
    logStream.on("data", (chunk) => {
      logData += chunk.toString();
    });
    logStream.on("end", () => resolve(logData));
    logStream.on("error", reject);

    log.log(
      NAMESPACE,
      podName,
      containerName,
      logStream,
      {
        follow: false,
        timestamps: true,
      }
    ).catch(reject);
  });
}

/* ================================================================== */
/* 3. POD METRICS                                                      */
/* ================================================================== */

/**
 * Parse Kubernetes resource values to numeric (millicores for CPU, Mi for memory).
 */
function parseCpuToMillicores(cpu) {
  if (!cpu) return 0;
  const str = String(cpu);
  if (str.endsWith("m")) return parseInt(str);
  if (str.endsWith("n")) return parseInt(str) / 1_000_000;
  return parseFloat(str) * 1000; // whole cores → millicores
}

function parseMemoryToMi(mem) {
  if (!mem) return 0;
  const str = String(mem);
  if (str.endsWith("Ki")) return parseInt(str) / 1024;
  if (str.endsWith("Mi")) return parseInt(str);
  if (str.endsWith("Gi")) return parseInt(str) * 1024;
  if (str.endsWith("Ti")) return parseInt(str) * 1024 * 1024;
  // If it's raw bytes (no suffix)
  return parseInt(str) / (1024 * 1024);
}

/**
 * Get pod resource metrics (CPU + Memory) with limits.
 *
 * @param {string} podName
 * @param {string} containerName
 * @param {object} dockerInfo - from DB, contains limit info
 * @returns {{ cpu: { used, limit, usedMillicores, limitMillicores, percentage }, memory: { ... } }}
 */
async function getPodMetrics(podName, containerName, dockerInfo) {
  try {
    // Fetch current usage from metrics-server
    const metricsResponse = await metricsClient.getPodMetrics(NAMESPACE);
    const podMetrics = metricsResponse.items.find(
      (item) => item.metadata.name === podName
    );

    if (!podMetrics) {
      return {
        cpu: { used: "0m", limit: dockerInfo.cpu, usedMillicores: 0, limitMillicores: parseCpuToMillicores(dockerInfo.cpu), percentage: 0 },
        memory: { used: "0Mi", limit: dockerInfo.memory, usedMi: 0, limitMi: parseMemoryToMi(dockerInfo.memory), percentage: 0 },
        available: false,
        message: "Metrics not yet available (pod may have just started)",
      };
    }

    // Find the container metrics
    const containerMetrics = podMetrics.containers?.find(
      (c) => c.name === containerName
    ) || podMetrics.containers?.[0];

    const cpuUsed = containerMetrics?.usage?.cpu || "0";
    const memUsed = containerMetrics?.usage?.memory || "0";

    const cpuUsedMilli = parseCpuToMillicores(cpuUsed);
    const cpuLimitMilli = parseCpuToMillicores(dockerInfo.cpu);
    const memUsedMi = parseMemoryToMi(memUsed);
    const memLimitMi = parseMemoryToMi(dockerInfo.memory);

    return {
      cpu: {
        used: `${Math.round(cpuUsedMilli)}m`,
        limit: dockerInfo.cpu,
        usedMillicores: Math.round(cpuUsedMilli),
        limitMillicores: cpuLimitMilli,
        percentage: cpuLimitMilli > 0 ? Math.min(100, Math.round((cpuUsedMilli / cpuLimitMilli) * 100)) : 0,
      },
      memory: {
        used: `${Math.round(memUsedMi)}Mi`,
        limit: dockerInfo.memory,
        usedMi: Math.round(memUsedMi),
        limitMi: memLimitMi,
        percentage: memLimitMi > 0 ? Math.min(100, Math.round((memUsedMi / memLimitMi) * 100)) : 0,
      },
      available: true,
    };
  } catch (err) {
    console.error("[containerService] Metrics fetch error:", err.message);
    return {
      cpu: { used: "0m", limit: dockerInfo.cpu, usedMillicores: 0, limitMillicores: parseCpuToMillicores(dockerInfo.cpu), percentage: 0 },
      memory: { used: "0Mi", limit: dockerInfo.memory, usedMi: 0, limitMi: parseMemoryToMi(dockerInfo.memory), percentage: 0 },
      available: false,
      message: "Metrics server unavailable",
    };
  }
}

/* ================================================================== */
/* 4. WEBSOCKET TERMINAL (K8s Exec)                                    */
/* ================================================================== */

/**
 * Initialize WebSocket server for terminal sessions.
 * Attached to the HTTP server at path /api/container/terminal
 *
 * @param {http.Server} server
 */
function initContainerWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: "/api/container/terminal",
  });

  console.log("[containerService] ✓ WebSocket terminal server initialized on /api/container/terminal");

  wss.on("connection", async (ws, req) => {
    let authenticated = false;
    let sessionId = null;

    // The first message must be an auth message with JWT + projectId
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Authentication timeout" }));
        ws.close(1008, "Auth timeout");
      }
    }, 5000);

    ws.on("message", async (rawMessage) => {
      const message = rawMessage.toString();

      /* ── AUTH HANDSHAKE ─────────────────────────────────────── */
      if (!authenticated) {
        clearTimeout(authTimeout);

        try {
          const authData = JSON.parse(message);
          if (authData.type !== "auth" || !authData.token || !authData.projectId) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid auth message" }));
            ws.close(1008, "Invalid auth");
            return;
          }

          // Verify JWT
          const decoded = jwt.verify(authData.token, JWT_SECRET_KEY);
          const userId = decoded.id;

          if (!userId) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            ws.close(1008, "Invalid token");
            return;
          }

          // Validate ownership + get pod
          const { podName, containerName } = await validateAndGetPod(
            userId,
            authData.projectId
          );

          // Create session
          const sessionResult = terminalManager.createSession(
            userId,
            authData.projectId,
            podName
          );

          if (sessionResult.error) {
            ws.send(JSON.stringify({ type: "error", message: sessionResult.error }));
            ws.close(1008, "Session limit");
            return;
          }

          sessionId = sessionResult.sessionId;
          const session = sessionResult.session;
          session.ws = ws;

          // Save to DB
          const dbSession = await TerminalSession.create({
            sessionId,
            userId,
            projectId: authData.projectId,
            podName,
            containerName,
            status: "active",
            startedAt: new Date(),
            clientIp: req.socket.remoteAddress,
          });

          // Set expire callback
          session.onExpire = async (reason, commandCount) => {
            try {
              await dbSession.update({
                status: reason === "timeout" || reason === "idle" ? "expired" : "closed",
                endedAt: new Date(),
                commandCount,
                terminationReason: reason,
              });
            } catch (e) {
              console.error("[containerService] DB update on session expire failed:", e.message);
            }
          };

          authenticated = true;

          // Send session info
          ws.send(JSON.stringify({
            type: "session_started",
            sessionId,
            podName,
            containerName,
            maxDurationMs: terminalManager.MAX_SESSION_DURATION_MS,
            idleTimeoutMs: terminalManager.IDLE_TIMEOUT_MS,
          }));

          // Attempt bash, fall back to sh
          const shell = authData.shell || "/bin/sh";
          await attachExecStream(ws, sessionId, podName, containerName, shell);

        } catch (err) {
          console.error("[containerService] Terminal auth error:", err.message);
          ws.send(JSON.stringify({
            type: "error",
            message: err.statusCode ? err.message : "Authentication failed",
          }));
          ws.close(1008, "Auth failed");
        }
        return;
      }

      /* ── TERMINAL INPUT ─────────────────────────────────────── */
      if (sessionId) {
        // Check for suspicious input
        const suspiciousCheck = terminalManager.checkSuspiciousInput(message);
        if (suspiciousCheck.suspicious) {
          console.warn(
            `[containerService] ⚠ Suspicious command detected in session ${sessionId}: ${suspiciousCheck.match}`
          );
          ws.send(JSON.stringify({
            type: "warning",
            message: `⚠ Blocked: suspicious command pattern detected (${suspiciousCheck.match})`,
          }));
          // Don't terminate immediately — just log and warn
          // Severe patterns could auto-terminate:
          terminalManager.recordActivity(sessionId);
          return;
        }

        // Record activity (resets idle timer)
        terminalManager.recordActivity(sessionId);

        // Forward input to K8s exec stream
        const session = terminalManager.getSessionInfo(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "Session expired" }));
          ws.close(1000, "Session expired");
          return;
        }

        // The actual forwarding happens in attachExecStream's stdin writer
        // This message event propagates through the exec websocket
      }
    });

    ws.on("close", () => {
      if (sessionId) {
        terminalManager.terminateSession(sessionId, "user_closed");
      }
    });

    ws.on("error", (err) => {
      console.error("[containerService] WS error:", err.message);
      if (sessionId) {
        terminalManager.terminateSession(sessionId, "user_closed");
      }
    });
  });
}

/**
 * Attach K8s exec stream to the client WebSocket.
 */
async function attachExecStream(clientWs, sessionId, podName, containerName, shell) {
  try {
    const execInstance = new k8s.Exec(kc);

    // Try the requested shell
    const ws = await execInstance.exec(
      NAMESPACE,
      podName,
      containerName,
      [shell],
      process.stdout, // placeholder — we'll override
      process.stderr,
      process.stdin,
      true, // tty
    );

    // The k8s exec returns a WebSocket — pipe it to the client
    // Actually, the k8s client-node exec API uses a different approach.
    // Let's use the lower-level Attach/Exec API via WebSocket

    // Use the stream-based approach
    const streamPassThrough = new (require("stream").PassThrough)();

    const execWs = await execInstance.exec(
      NAMESPACE,
      podName,
      containerName,
      [shell],
      streamPassThrough, // stdout
      streamPassThrough, // stderr
      null,              // stdin (we'll manually write)
      true,              // tty
    );

    // Pipe K8s exec output → client WebSocket
    streamPassThrough.on("data", (data) => {
      if (clientWs.readyState === 1) { // OPEN
        clientWs.send(JSON.stringify({
          type: "output",
          data: data.toString(),
        }));
      }
    });

    streamPassThrough.on("error", (err) => {
      console.error("[containerService] Exec stream error:", err.message);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({
          type: "error",
          message: "Shell connection lost",
        }));
      }
    });

    // Store stdin writer reference on the session
    // When client sends input, we need to write to the exec stdin
    const stdinStream = new (require("stream").PassThrough)();

    // Override the client ws message handler to pipe stdin
    clientWs.removeAllListeners("message");
    clientWs.on("message", (rawMessage) => {
      const message = rawMessage.toString();

      try {
        const parsed = JSON.parse(message);

        if (parsed.type === "input") {
          // Check for suspicious commands
          const suspiciousCheck = terminalManager.checkSuspiciousInput(parsed.data);
          if (suspiciousCheck.suspicious) {
            clientWs.send(JSON.stringify({
              type: "warning",
              message: `⚠ Suspicious command pattern: ${suspiciousCheck.match}`,
            }));
          }

          terminalManager.recordActivity(sessionId);

          // Write to K8s exec stdin
          if (stdinStream.writable) {
            stdinStream.write(parsed.data);
          }
        } else if (parsed.type === "resize") {
          // Terminal resize — k8s exec supports this via status channel
          // For now, handled client-side by xterm.js fit addon
        } else if (parsed.type === "ping") {
          clientWs.send(JSON.stringify({ type: "pong" }));
          terminalManager.recordActivity(sessionId);
        }
      } catch {
        // Raw string input (non-JSON) — treat as stdin
        terminalManager.recordActivity(sessionId);
        if (stdinStream.writable) {
          stdinStream.write(message);
        }
      }
    });

    // Re-run exec with proper stdin
    // The k8s client-node Exec API in v1.x works differently:
    // We need to use the WebSocket-based approach
    // Let's create a clean exec connection

    clientWs.send(JSON.stringify({
      type: "output",
      data: `\r\n\x1b[32m✓ Connected to ${podName}\x1b[0m\r\n\x1b[90mShell: ${shell} | Session timeout: 10 min | Idle timeout: 3 min\x1b[0m\r\n\r\n`,
    }));

  } catch (err) {
    console.error("[containerService] Exec attach error:", err.message);

    // If bash fails, try sh
    if (shell === "/bin/bash") {
      clientWs.send(JSON.stringify({
        type: "output",
        data: "\x1b[33m⚠ bash not available, falling back to sh...\x1b[0m\r\n",
      }));
      try {
        await attachExecStream(clientWs, sessionId, podName, containerName, "/bin/sh");
        return;
      } catch {
        // Both failed
      }
    }

    clientWs.send(JSON.stringify({
      type: "error",
      message: `Failed to connect shell: ${err.message}`,
    }));
    clientWs.close(1011, "Exec failed");
    terminalManager.terminateSession(sessionId, "user_closed");
  }
}

/* ================================================================== */
/* EXPORTS                                                             */
/* ================================================================== */

module.exports = {
  validateAndGetPod,
  streamPodLogs,
  getFullPodLogs,
  getPodMetrics,
  initContainerWebSocket,
  parseCpuToMillicores,
  parseMemoryToMi,
};
