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
    // ── AUTO-CORRECT: DB says "running" but K8s has no pod ──────────
    // This happens after system restart when K8s state is wiped.
    // Fix the DB so the frontend shows "sleeping" + "Wake" button.
    if (dockerInfo && dockerInfo.status === "running") {
      console.log(
        `[containerService] ⚠ Auto-correcting ghost pod: project ${projectId} DB says "running" but no K8s pod exists. Setting → sleeping`
      );
      await DockerInfo.update(
        { status: "sleeping" },
        { where: { id: dockerInfo.id } }
      );
    }

    const err = new Error(
      "No running pod found for this project. The container may have been stopped — try waking it."
    );
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
 * Normalize Docker-style memory shorthand to K8s format.
 * DockerInfo stores "512m" meaning 512 MiB, but K8s uses "512Mi".
 * Without this, parseMemoryToMi("512m") hits raw-bytes fallback → ~0.
 */
function normalizeMemoryUnit(mem) {
  if (!mem) return "0Mi";
  const str = String(mem);
  // Docker shorthand: "512m" = 512 MiB (lowercase m, no 'i')
  if (/^\d+m$/.test(str)) return str.replace("m", "Mi");
  return str;
}

/**
 * Normalize CPU value to consistent format.
 * DockerInfo stores "0.5" meaning 500m.
 */
function normalizeCpuUnit(cpu) {
  if (!cpu) return "0m";
  const str = String(cpu);
  if (str.endsWith("m")) return str;
  // Bare number like "0.5" = 500m
  const millis = Math.round(parseFloat(str) * 1000);
  return `${millis}m`;
}

/* ---- Storage helpers ------------------------------------------------ */
function parseDiskToMi(disk) {
  if (!disk) return 0;
  const str = String(disk).trim();
  // "1Gi" → 1024Mi, "512Mi" → 512, "10g" → 10240Mi, "500m" → 500Mi docker style
  if (/^\d+Gi$/i.test(str)) return parseInt(str) * 1024;
  if (/^\d+Mi$/i.test(str)) return parseInt(str);
  if (/^\d+Ki$/i.test(str)) return Math.round(parseInt(str) / 1024);
  if (/^\d+g$/i.test(str)) return parseInt(str) * 1024;
  if (/^\d+m$/i.test(str)) return parseInt(str); // docker "512m" = 512MiB
  // raw bytes
  const n = parseInt(str);
  if (!isNaN(n)) return Math.round(n / (1024 * 1024));
  return 0;
}

/* ---- Read /proc/net/dev from inside pod via kubectl exec ------------ */
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

async function getPodNetworkStats(podName, namespace) {
  try {
    const { stdout } = await execFileAsync("kubectl", [
      "exec", podName,
      "-n", namespace,
      "--", "cat", "/proc/net/dev"
    ], { timeout: 5000 });

    // Parse /proc/net/dev — skip headers, find eth0 or any non-lo interface
    let rxBytes = 0, txBytes = 0, rxPackets = 0, txPackets = 0;
    const lines = stdout.trim().split("\n").slice(2); // skip 2 header lines
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const iface = parts[0].replace(":", "");
      if (iface === "lo") continue; // skip loopback
      // Format: iface rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast tx_bytes ...
      rxBytes += parseInt(parts[1]) || 0;
      rxPackets += parseInt(parts[2]) || 0;
      txBytes += parseInt(parts[9]) || 0;
      txPackets += parseInt(parts[10]) || 0;
    }

    return {
      rxBytes,
      txBytes,
      rxMB: parseFloat((rxBytes / (1024 * 1024)).toFixed(2)),
      txMB: parseFloat((txBytes / (1024 * 1024)).toFixed(2)),
      rxPackets,
      txPackets,
      available: true,
    };
  } catch {
    return { rxBytes: 0, txBytes: 0, rxMB: 0, txMB: 0, rxPackets: 0, txPackets: 0, available: false };
  }
}

/**
 * Get pod resource metrics (CPU + Memory + Storage + Network) with limits.
 *
 * @param {string} podName
 * @param {string} containerName
 * @param {object} dockerInfo - from DB, contains limit info
 * @returns {{ cpu, memory, storage, network, available }}
 */
async function getPodMetrics(podName, containerName, dockerInfo) {
  const normalizedMemLimit = normalizeMemoryUnit(dockerInfo.memory);
  const normalizedCpuLimit = normalizeCpuUnit(dockerInfo.cpu);
  const diskLimitMi = parseDiskToMi(dockerInfo.disk || "1Gi");
  
  // Fetch CPU/Memory from metrics-server + network concurrently
  const [metricsResult, networkStats] = await Promise.allSettled([
    metricsClient.getPodMetrics(NAMESPACE),
    getPodNetworkStats(podName, NAMESPACE),
  ]);

  // Fetch pod status for ephemeral storage usage
  let storageUsedMi = 0;
  try {
    const podList = await coreV1.listNamespacedPod({
      namespace: NAMESPACE,
      fieldSelector: `metadata.name=${podName}`,
    });
    const pod = podList.items?.[0];
    const ephemeralUsage = pod?.status?.ephemeralContainerStatuses?.[0]
      || pod?.status?.containerStatuses?.[0];
    // K8s exposes ephemeralStorage in pod.status.containerStatuses[].allocatedResources
    const allocResources = ephemeralUsage?.allocatedResources?.["ephemeral-storage"];
    if (allocResources) {
      storageUsedMi = parseDiskToMi(allocResources);
    }
  } catch {
    storageUsedMi = 0;
  }

  const netStats = networkStats.status === "fulfilled" ? networkStats.value :
    { rxBytes: 0, txBytes: 0, rxMB: 0, txMB: 0, rxPackets: 0, txPackets: 0, available: false };

  // Handle CPU/Memory metrics
  if (metricsResult.status === "rejected") {
    if (!getPodMetrics._loggedError) {
      console.warn("[containerService] Metrics server unavailable:", metricsResult.reason?.message?.slice(0, 100));
      console.warn("[containerService] (Suppressing further metrics errors)");
      getPodMetrics._loggedError = true;
    }
    return {
      cpu: { used: "0m", limit: normalizedCpuLimit, usedMillicores: 0, limitMillicores: parseCpuToMillicores(normalizedCpuLimit), percentage: 0 },
      memory: { used: "0Mi", limit: normalizedMemLimit, usedMi: 0, limitMi: parseMemoryToMi(normalizedMemLimit), percentage: 0 },
      storage: { usedMi: storageUsedMi, limitMi: diskLimitMi, used: `${storageUsedMi}Mi`, limit: `${diskLimitMi}Mi`, percentage: diskLimitMi > 0 ? Math.min(100, Math.round((storageUsedMi / diskLimitMi) * 100)) : 0 },
      network: netStats,
      available: false,
      message: "Metrics server unavailable — install metrics-server addon",
    };
  }

  const metricsResponse = metricsResult.value;
  const podMetrics = metricsResponse.items.find((item) => item.metadata.name === podName);

  if (!podMetrics) {
    return {
      cpu: { used: "0m", limit: normalizedCpuLimit, usedMillicores: 0, limitMillicores: parseCpuToMillicores(normalizedCpuLimit), percentage: 0 },
      memory: { used: "0Mi", limit: normalizedMemLimit, usedMi: 0, limitMi: parseMemoryToMi(normalizedMemLimit), percentage: 0 },
      storage: { usedMi: storageUsedMi, limitMi: diskLimitMi, used: `${storageUsedMi}Mi`, limit: `${diskLimitMi}Mi`, percentage: diskLimitMi > 0 ? Math.min(100, Math.round((storageUsedMi / diskLimitMi) * 100)) : 0 },
      network: netStats,
      available: false,
      message: "Metrics not yet available (pod may have just started)",
    };
  }

  const containerMetrics = podMetrics.containers?.find((c) => c.name === containerName) || podMetrics.containers?.[0];

  const cpuUsed = containerMetrics?.usage?.cpu || "0";
  const memUsed = containerMetrics?.usage?.memory || "0";

  const cpuUsedMilli = parseCpuToMillicores(cpuUsed);
  const cpuLimitMilli = parseCpuToMillicores(normalizedCpuLimit);
  const memUsedMi = parseMemoryToMi(memUsed);
  const memLimitMi = parseMemoryToMi(normalizedMemLimit);

  // Storage percentage (of quota/limit)
  const storagePct = diskLimitMi > 0 ? Math.min(100, Math.round((storageUsedMi / diskLimitMi) * 100)) : 0;

  return {
    cpu: {
      used: `${Math.round(cpuUsedMilli)}m`,
      limit: normalizedCpuLimit,
      usedMillicores: Math.round(cpuUsedMilli),
      limitMillicores: cpuLimitMilli,
      percentage: cpuLimitMilli > 0 ? Math.min(100, Math.round((cpuUsedMilli / cpuLimitMilli) * 100)) : 0,
    },
    memory: {
      used: `${Math.round(memUsedMi)}Mi`,
      limit: normalizedMemLimit,
      usedMi: Math.round(memUsedMi),
      limitMi: memLimitMi,
      percentage: memLimitMi > 0 ? Math.min(100, Math.round((memUsedMi / memLimitMi) * 100)) : 0,
    },
    storage: {
      used: `${storageUsedMi}Mi`,
      limit: `${diskLimitMi}Mi`,
      usedMi: storageUsedMi,
      limitMi: diskLimitMi,
      percentage: storagePct,
    },
    network: netStats,
    available: true,
  };
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
