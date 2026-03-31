const {
  validateAndGetPod,
  streamPodLogs,
  getFullPodLogs,
  getPodMetrics,
} = require("../../Utils/containerService");
const terminalManager = require("../../Utils/terminalManager");

/**
 * GET /api/container/:projectId/logs
 * Server-Sent Events endpoint for streaming pod logs in real time.
 */
exports.streamPodLogsHandler = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;
  const tailLines = parseInt(req.query.tailLines) || 200;
  const sinceSeconds = req.query.sinceSeconds
    ? parseInt(req.query.sinceSeconds)
    : null;

  try {
    // Validate ownership
    const { podName, containerName } = await validateAndGetPod(userId, projectId);

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // for nginx proxy
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial connection event
    res.write(
      `data: ${JSON.stringify({ type: "connected", podName, containerName })}\n\n`
    );

    // Start streaming
    const logStream = await streamPodLogs(podName, containerName, {
      tailLines,
      sinceSeconds,
    });

    // Buffer for assembling partial lines
    let lineBuffer = "";

    logStream.on("data", (chunk) => {
      const text = chunk.toString();
      lineBuffer += text;

      // Split into complete lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (line.trim()) {
          // Parse timestamp from Kubernetes log format
          const tsMatch = line.match(
            /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)/
          );
          const timestamp = tsMatch ? tsMatch[1] : null;
          const content = tsMatch ? tsMatch[2] : line;

          // Determine log level
          let level = "info";
          if (/error|ERR|FATAL|panic|exception/i.test(content))
            level = "error";
          else if (/warn|WARNING/i.test(content)) level = "warn";
          else if (/debug|DEBUG/i.test(content)) level = "debug";

          res.write(
            `data: ${JSON.stringify({
              type: "log",
              timestamp,
              content,
              level,
              raw: line,
            })}\n\n`
          );
        }
      }
    });

    logStream.on("error", (err) => {
      console.error("[containerController] Log stream error:", err.message);
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          message: "Log stream interrupted: " + err.message,
        })}\n\n`
      );
      res.end();
    });

    logStream.on("end", () => {
      res.write(
        `data: ${JSON.stringify({ type: "stream_ended" })}\n\n`
      );
      res.end();
    });

    // Clean up on client disconnect
    req.on("close", () => {
      logStream.destroy();
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
    });
  } catch (err) {
    console.error("[containerController] Log stream setup error:", err.message);

    // If headers haven't been sent yet, send JSON error
    if (!res.headersSent) {
      return res.status(err.statusCode || 500).json({
        success: false,
        message: err.message,
      });
    }

    // Otherwise send SSE error
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message: err.message,
      })}\n\n`
    );
    res.end();
  }
};

/**
 * GET /api/container/:projectId/logs/download
 * Download full pod logs as a .log text file.
 */
exports.downloadPodLogsHandler = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;

  try {
    const { podName, containerName, label } = await validateAndGetPod(
      userId,
      projectId
    );

    const logs = await getFullPodLogs(podName, containerName);

    const filename = `${label}-${new Date()
      .toISOString()
      .slice(0, 10)}.log`;

    res.setHeader("Content-Type", "text/plain");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.send(logs);
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * GET /api/container/:projectId/metrics
 * Returns current CPU + Memory usage vs limits.
 */
exports.getPodMetricsHandler = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;

  try {
    const { podName, containerName, dockerInfo } = await validateAndGetPod(
      userId,
      projectId
    );

    const metrics = await getPodMetrics(podName, containerName, dockerInfo);

    return res.json({
      success: true,
      data: {
        ...metrics,
        podName,
        containerName,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * GET /api/container/:projectId/terminal/info
 * Returns terminal session configuration and current session count.
 */
exports.getTerminalInfoHandler = async (req, res) => {
  const userId = req.user.id;

  try {
    const activeSessions = terminalManager.getUserSessionCount(userId);

    return res.json({
      success: true,
      data: {
        maxConcurrentSessions: terminalManager.MAX_CONCURRENT_SESSIONS,
        maxSessionDurationMs: terminalManager.MAX_SESSION_DURATION_MS,
        idleTimeoutMs: terminalManager.IDLE_TIMEOUT_MS,
        activeSessions,
        canCreateSession:
          activeSessions < terminalManager.MAX_CONCURRENT_SESSIONS,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
    });
  }
};
