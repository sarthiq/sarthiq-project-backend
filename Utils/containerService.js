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

          // Send session info with generic limits (actual limits are enforced by Kubernetes)
          ws.send(JSON.stringify({
            type: "session_started",
            sessionId,
            podName,
            containerName,
            maxDurationMs: terminalManager.MAX_SESSION_DURATION_MS,
            idleTimeoutMs: terminalManager.IDLE_TIMEOUT_MS,
            resourceLimits: {
              cpu: "Governed by K8s",
              memory: "Governed by K8s",
              disk: "Governed by K8s",
              pidsLimit: 100,
            },
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

async function attachExecStream(clientWs, sessionId, podName, containerName, shell) {
  try {
    const execInstance = new k8s.Exec(kc);
    const { PassThrough } = require("stream");

    const launchCmd = [
      "/bin/sh", "-c",
      `export PS1='\\u@\\h:\\w\\$ '; export TERM=xterm; ` +
      `if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh; fi`
    ];

    // These PassThrough streams are used by @kubernetes/client-node to pipe
    // data to/from the K8s exec WebSocket. Test confirmed they work with tty=true.
    const outStream = new PassThrough();
    const errStream = new PassThrough();
    const inStream  = new PassThrough();

    const execWs = await execInstance.exec(
      NAMESPACE,
      podName,
      containerName,
      launchCmd,
      outStream,   // stdout
      errStream,   // stderr
      inStream,    // stdin
      true,        // tty
    );

    if (!execWs) throw new Error("K8s exec returned no WebSocket");
    console.log(`[containerService] Shell connected to ${podName}, execWs.readyState=${execWs.readyState}`);

    // ── STDOUT → client ──────────────────────────────────────────────
    outStream.on("data", (chunk) => {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: "output", data: chunk.toString("utf-8") }));
      }
    });

    // ── STDERR → client (same output channel) ────────────────────────
    errStream.on("data", (chunk) => {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: "output", data: chunk.toString("utf-8") }));
      }
    });

    // ── Exec WS close/error ──────────────────────────────────────────
    execWs.on("close", () => {
      console.log(`[containerService] Shell exited for ${podName}`);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: "session_ended", message: "Shell process exited" }));
      }
      terminalManager.terminateSession(sessionId, "shell_exited");
    });

    execWs.on("error", (err) => {
      console.error("[containerService] execWs error:", err.message);
    });

    // ── Send initial resize via raw frame (channel 4) ────────────────
    // This must be a raw binary frame since there's no stream for resize
    setTimeout(() => {
      if (execWs.readyState === 1) {
        const payload = Buffer.from(JSON.stringify({ Width: 220, Height: 50 }), "utf-8");
        const frame = Buffer.alloc(payload.length + 1);
        frame[0] = 4; // channel 4 = resize
        payload.copy(frame, 1);
        execWs.send(frame);
      }
    }, 200);

    // ── Replace client WS message handler to forward input ───────────
    clientWs.removeAllListeners("message");
    clientWs.on("message", (rawMessage) => {
      let parsed;
      try {
        parsed = JSON.parse(rawMessage.toString());
      } catch {
        // Non-JSON raw data → treat as stdin
        terminalManager.recordActivity(sessionId);
        inStream.write(rawMessage.toString());
        return;
      }

      if (parsed.type === "input") {
        const check = terminalManager.checkSuspiciousInput(parsed.data);
        if (check.suspicious) {
          clientWs.send(JSON.stringify({
            type: "warning",
            message: `⚠ Suspicious pattern blocked: ${check.match}`,
          }));
          return;
        }
        terminalManager.recordActivity(sessionId);
        // Write to stdin PassThrough → K8s exec → container shell
        inStream.write(parsed.data);

      } else if (parsed.type === "resize") {
        if (typeof parsed.cols === "number" && typeof parsed.rows === "number" && execWs.readyState === 1) {
          const payload = Buffer.from(JSON.stringify({ Width: parsed.cols, Height: parsed.rows }), "utf-8");
          const frame = Buffer.alloc(payload.length + 1);
          frame[0] = 4; // channel 4 = resize
          payload.copy(frame, 1);
          execWs.send(frame);
        }

      } else if (parsed.type === "ping") {
        terminalManager.recordActivity(sessionId);
        clientWs.send(JSON.stringify({ type: "pong" }));
      }
    });

    // ── MOTD ─────────────────────────────────────────────────────────
    const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    clientWs.send(JSON.stringify({
      type: "output",
      data:
        `\r\n\x1b[1;36m╔══════════════════════════════════════════╗\x1b[0m\r\n` +
        `\x1b[1;36m║     SarthiQ Interactive Shell            ║\x1b[0m\r\n` +
        `\x1b[1;36m╚══════════════════════════════════════════╝\x1b[0m\r\n` +
        `\r\n` +
        `\x1b[90m  Container : \x1b[97m${containerName}\x1b[0m\r\n` +
        `\x1b[90m  Pod       : \x1b[97m${podName}\x1b[0m\r\n` +
        `\x1b[90m  Connected : \x1b[97m${now}\x1b[0m\r\n` +
        `\x1b[90m  Limit     : \x1b[97m10 min (idle: 3 min)\x1b[0m\r\n` +
        `\r\n`,
    }));

  } catch (err) {
    console.error("[containerService] Exec attach error:", err.message);
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: "error", message: `Failed to start shell: ${err.message}` }));
      clientWs.close(1011, "Exec failed");
    }
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
