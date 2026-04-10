/**
 * sleepProxy.js  ──  Production Sleep/Wake Proxy Middleware
 *
 * How it works (Render.com-style cold start):
 * ─────────────────────────────────────────────────────────
 * 1. Every request to *.sarthiq.com passes through this middleware.
 * 2. We look up the project by its subdomain.
 * 3. STATUS ROUTING:
 *    a) 'running'  → pass through to K8s ClusterIP via http-proxy-middleware
 *    b) 'sleeping' → immediately return an HTML loading page with SSE polling
 *                    + queue a wakeQueue job (deduplicated via Redis key)
 *    c) 'building' → return a "Deploy in progress" HTML page
 *    d) 'queued'   → return a "Queued" page
 *    e) 'failed'   → return a 503 error page
 *    f) not found  → return 404
 * 4. After waking, the browser auto-polls /api/proxy/wake-status/:projectId
 *    every 2 seconds and reloads when status becomes 'running'.
 * 5. Every proxied request touches dockerInfo.lastActivityAt so the
 *    sleep watcher knows the container is active.
 *
 * IMPORTANT: This must run as a SEPARATE Express micro-server
 * (e.g. on port 7070) placed BEHIND your Nginx/K8s Ingress so that
 * wildcard subdomain traffic routes to it.
 *
 * Alternatively, mount it in app.js with a vhost middleware check.
 */

const express = require("express");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const IORedis = require("ioredis");

const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const DeploymentJob = require("../Models/Deployment/deploymentJob");
const { wakeQueue } = require("../Jobs/queues");
const { getServiceNodePort } = require("../Utils/kubeClient");
const { escapeHtml } = require("../Utils/securityValidator");
const { Op } = require("sequelize");

const { PROJECT_DOMAIN } = require("./subdomainParser");
const NAMESPACE = process.env.K8S_NAMESPACE || "sarthiq-apps";

/* ── Redis client for wake-job deduplication keys ────────────────── */
const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

/* ── HTML Templates (─ SECURITY: all dynamic values HTML-escaped) ── */
const loadingPage = (projectTitle, projectId) => {
  const safeTitle = escapeHtml(projectTitle);
  const safeId = escapeHtml(String(projectId));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Waking ${safeTitle}… | SarthiQ</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: #0a0a0f;
      font-family: 'Inter', system-ui, sans-serif; color: #e4e4e7;
    }
    .card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; padding: 48px 56px;
      text-align: center; max-width: 440px;
    }
    .icon { font-size: 48px; margin-bottom: 20px; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.6;transform:scale(0.96)} }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; }
    p  { color: #71717a; font-size: 14px; line-height: 1.6; margin-bottom: 28px; }
    .bar-wrap {
      background: rgba(255,255,255,0.06); border-radius: 99px;
      height: 6px; overflow: hidden; margin-bottom: 16px;
    }
    .bar {
      height: 100%; width: 0%; border-radius: 99px;
      background: linear-gradient(90deg,#7c3aed,#a78bfa);
      animation: progress 25s ease-in-out forwards;
    }
    @keyframes progress { 0%{width:0%} 80%{width:85%} 100%{width:88%} }
    .status { font-size: 13px; color: #a78bfa; }
    .logo { position:fixed; top:20px; left:20px; font-weight:800;
            background:linear-gradient(135deg,#7c3aed,#a78bfa);
            -webkit-background-clip:text; -webkit-text-fill-color:transparent; font-size:18px; }
  </style>
</head>
<body>
  <div class="logo">SarthiQ</div>
  <div class="card">
    <div class="icon">🚀</div>
    <h1>Waking <em>${safeTitle}</em></h1>
    <p>
      This service was asleep due to inactivity.<br>
      It's booting up — this usually takes 5–30 seconds.
    </p>
    <div class="bar-wrap"><div class="bar"></div></div>
    <div class="status" id="status-text">Starting container…</div>
  </div>
  <script>
    const messages = [
      'Starting container…',
      'Pulling image…',
      'Allocating resources…',
      'Running health checks…',
      'Almost there…',
    ];
    let i = 0;
    const statusEl = document.getElementById('status-text');
    const interval = setInterval(() => {
      i = (i + 1) % messages.length;
      statusEl.textContent = messages[i];
    }, 4000);

    // Poll wake status every 2 seconds
    async function poll() {
      try {
        const r = await fetch('/api/proxy/wake-status/${safeId}');
        const data = await r.json();
        if (data.status === 'running') {
          clearInterval(interval);
          statusEl.textContent = '✅ Ready! Redirecting…';
          setTimeout(() => window.location.reload(), 500);
        }
      } catch {}
      setTimeout(poll, 2000);
    }
    setTimeout(poll, 3000); // first check after 3s
  </script>
</body>
</html>`;
};

const buildingPage = (projectTitle) => {
  const safeTitle = escapeHtml(projectTitle);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Building ${safeTitle} | SarthiQ</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0f;font-family:system-ui;color:#e4e4e7}
    .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
          border-radius:20px;padding:48px 56px;text-align:center;max-width:440px}
    .icon{font-size:48px;margin-bottom:20px}
    h1{font-size:22px;font-weight:700;margin-bottom:10px}
    p{color:#71717a;font-size:14px;line-height:1.6}
    .pulse{animation:p 1.5s infinite} @keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon pulse">⚙️</div>
    <h1>Deploying <em>${safeTitle}</em></h1>
    <p>Your project is currently being built and deployed.<br>
       This page will auto-refresh every 5 seconds.</p>
  </div>
  <script>setTimeout(()=>location.reload(),5000)</script>
</body>
</html>`;
};

const errorPage = (projectTitle, errorMsg) => {
  const safeTitle = escapeHtml(projectTitle);
  const safeError = escapeHtml(errorMsg || "");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Deploy Failed | SarthiQ</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0a0a0f;font-family:system-ui;color:#e4e4e7}
  .card{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);
        border-radius:20px;padding:48px 56px;text-align:center;max-width:440px}
  h1{font-size:22px;font-weight:700;margin-bottom:10px;color:#fca5a5}
  p{color:#71717a;font-size:14px;line-height:1.6}
  .err{color:#ef4444;font-size:12px;font-family:monospace;margin-top:16px;
       background:rgba(239,68,68,.1);padding:10px;border-radius:8px;white-space:pre-wrap}
</style>
</head>
<body>
  <div class="card">
    <div style="font-size:48px;margin-bottom:20px">❌</div>
    <h1>Deploy failed for <em>${safeTitle}</em></h1>
    <p>The last deployment encountered an error. Please check your project settings.</p>
    ${safeError ? `<div class="err">${safeError}</div>` : ""}
  </div>
</body>
</html>`;
};

const notFoundPage = (subdomain) => {
  const safeSub = escapeHtml(subdomain);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Not Found | SarthiQ</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0f;font-family:'Inter',system-ui,sans-serif;color:#e4e4e7}
    .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
          border-radius:20px;padding:48px 56px;text-align:center;max-width:480px}
    .icon{font-size:48px;margin-bottom:20px}
    h1{font-size:22px;font-weight:700;margin-bottom:10px}
    p{color:#71717a;font-size:14px;line-height:1.6;margin-bottom:12px}
    code{background:rgba(124,58,237,.15);color:#a78bfa;padding:2px 8px;border-radius:6px;font-size:13px}
    .logo{position:fixed;top:20px;left:20px;font-weight:800;
          background:linear-gradient(135deg,#7c3aed,#a78bfa);
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:18px}
  </style>
</head>
<body>
  <div class="logo">SarthiQ</div>
  <div class="card">
    <div class="icon">🔍</div>
    <h1>Project Not Found</h1>
    <p>There is no project deployed at <code>${safeSub}.${PROJECT_DOMAIN}</code>.</p>
    <p>If you just created this project, it may not have been deployed yet.</p>
  </div>
</body>
</html>`;
};

/* ── Dynamic in-memory proxy cache ──────────────────────────────── */
// Map<subdomain, proxyMiddleware>
const proxyCache = new Map();

function getOrCreateProxy(subdomain, nodePort) {
  if (proxyCache.has(subdomain)) {
    // Verify existing proxy's target is still correct
    const existingProxy = proxyCache.get(subdomain);
    return existingProxy;
  }

  // Use the NodePort mapped to 127.0.0.1 to avoid host routing issues
  const target = `http://127.0.0.1:${nodePort}`;

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true, // WebSocket support
    on: {
      error: async (err, req, res) => {
        console.error(`[sleepProxy] Proxy error for ${subdomain}: ${err.message}`);

        // ── AUTO-CORRECT: If proxy fails, the K8s service/pod likely doesn't exist ──
        // Mark the project as sleeping so the next request serves the wake page
        try {
          const project = await Project.findOne({ where: { subdomain } });
          if (project) {
            const docker = await DockerInfo.findOne({
              where: { ProjectId: project.id, status: "running" },
            });
          if (docker) {
              // Don't auto-correct if a wake/deploy is in progress
              const activeJob = await DeploymentJob.findOne({
                where: {
                  ProjectId: project.id,
                  status: { [Op.in]: ["queued", "building"] },
                  createdAt: { [Op.gt]: new Date(Date.now() - 2 * 60 * 1000) },
                },
              });
              if (!activeJob) {
                console.log(
                  `[sleepProxy] ⚠ Auto-correcting ${subdomain}: proxy 502 → marking as sleeping`
                );
                docker.status = "sleeping";
                await docker.save();
                // Invalidate proxy cache so next request re-evaluates
                proxyCache.delete(subdomain);
              } else {
                console.log(
                  `[sleepProxy] ⚠ Proxy 502 for ${subdomain} but wake/deploy in progress (job #${activeJob.id}) — skipping auto-correction`
                );
              }
            }
          }
        } catch (dbErr) {
          console.error(`[sleepProxy] DB correction failed: ${dbErr.message}`);
        }

        // Use native Node.js http methods because res may not be an Express response object.
        // During WebSocket upgrades, res is a net.Socket which doesn't have headersSent.
        if (res.writeHead) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html' });
            res.end(
              `<meta http-equiv="refresh" content="2">` +
              `<div style="font-family:system-ui;background:#0a0a0f;color:#e4e4e7;min-height:100vh;display:flex;align-items:center;justify-content:center;">` +
              `<div style="text-align:center"><p style="font-size:48px;margin-bottom:16px">🔄</p>` +
              `<h2>Container restarting…</h2><p style="color:#71717a;font-size:14px">This page will reload automatically.</p></div></div>`
            );
          }
        } else if (res.write) {
          // WebSocket socket fallback
          res.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          res.end();
        }
      },
    },
  });

  proxyCache.set(subdomain, proxy);
  return proxy;
}

/* ── Main middleware factory ────────────────────────────────────── */
async function sleepProxyHandler(req, res, next) {
  // Use subdomain parsed by subdomainParser middleware
  const subdomain = req.subdomain;

  // Skip if no user subdomain (root domain, reserved, or invalid)
  if (!subdomain) {
    return next();
  }

  // Lookup project
  const project = await Project.findOne({
    where: { subdomain },
    include: [DockerInfo],
  }).catch(() => null);

  if (!project) {
    console.log(`[subdomain] ❌ No project mapped for subdomain: ${subdomain}`);
    return res.status(404).send(notFoundPage(subdomain));
  }

  // Log the mapped service for observability
  console.log(
    `[subdomain] ✅ ${subdomain} → project "${project.title}" (id: ${project.id}, status: ${project.DockerInfo?.status || "no-docker"})`,
  );

  const docker = project.DockerInfo;
  if (!docker) {
    return res.status(503).send("Service not deployed yet.");
  }

  /* ── Handle /api/proxy/wake-status/:projectId ─────────────────── */
  // (this route is also registered in proxyRoutes.js but handle it early)
  if (req.path.startsWith("/api/proxy/wake-status/")) {
    const freshDocker = await DockerInfo.findOne({
      where: { ProjectId: project.id },
    });
    return res.json({ status: freshDocker?.status || "unknown" });
  }

  /* ── Routing by status ─────────────────────────────────────────── */
  switch (docker.status) {
    case "running": {
      // Touch lastActivityAt (throttled: only write if >30s old)
      const now = Date.now();
      const last = docker.lastActivityAt ? new Date(docker.lastActivityAt).getTime() : 0;
      if (now - last > 30_000) {
        DockerInfo.update(
          { lastActivityAt: new Date() },
          { where: { id: docker.id } }
        ).catch(() => {});
      }

      try {
        // Resolve the assigned NodePort of the service first via Kubernetes API
        const nodePort = await getServiceNodePort(subdomain);
        if (!nodePort) {
            console.error(`[sleepProxy] ❌ Could not find NodePort for ${subdomain}. Service may be deleted.`);
            // Auto correct status
            docker.status = "sleeping";
            await docker.save();
            return res.status(502).send(
              `<meta http-equiv="refresh" content="2">` +
              `<div style="font-family:system-ui;background:#0a0a0f;color:#e4e4e7;min-height:100vh;display:flex;align-items:center;justify-content:center;">` +
              `<div style="text-align:center"><p style="font-size:48px;margin-bottom:16px">🔄</p>` +
              `<h2>Container restarting…</h2><p style="color:#71717a;font-size:14px">Service port binding...</p></div></div>`
            );
        }

        // Proxy using the localhost NodePort bypassing Host machine's isolated DNS
        const proxy = getOrCreateProxy(subdomain, nodePort);
        return proxy(req, res, next);
      } catch (err) {
        console.error(`[sleepProxy] K8s API Error resolving service port: ${err.message}`);
        return res.status(502).send("Service unroutable");
      }
    }

    case "sleeping": {
      // Deduplicate wake jobs: only enqueue once per subdomain per 30s
      const wakeKey = `wake:dedup:${project.id}`;
      const alreadyWaking = await redis.set(
        wakeKey,
        "1",
        "EX",
        30,
        "NX" // set only if Not eXists
      );

      if (alreadyWaking === "OK") {
        // Create a tracking job record
        const dbJob = await DeploymentJob.create({
          ProjectId: project.id,
          UserId: docker.UserId,
          status: "queued",
          logs: "[WAKE] Wake requested by incoming traffic\n",
        });

        const bullJob = await wakeQueue.add("wake", {
          projectId: project.id,
          deploymentJobId: dbJob.id,
        });

        await DeploymentJob.update(
          { bullmqJobId: String(bullJob.id) },
          { where: { id: dbJob.id } }
        );

        console.log(
          `[sleepProxy] Wake job enqueued for ${subdomain} (bullmq: ${bullJob.id})`
        );
      }

      return res.status(503).send(loadingPage(project.title, project.id));
    }

    case "building":
    case "queued": {
      return res.status(503).send(buildingPage(project.title));
    }

    case "failed": {
      // Get last failure reason
      const lastFail = await DeploymentJob.findOne({
        where: { ProjectId: project.id, status: "failed" },
        order: [["createdAt", "DESC"]],
      });
      return res
        .status(503)
        .send(errorPage(project.title, lastFail?.errorMessage));
    }

    default:
      return res.status(503).send("Service unavailable.");
  }
}

/* ── Export as Express router (for wake-status REST endpoint) ────── */
const router = express.Router();

// Wake status polling endpoint (called by loading page JS)
router.get("/wake-status/:projectId", async (req, res) => {
  const { projectId } = req.params;
  // Security: validate projectId is numeric
  if (!/^\d+$/.test(projectId)) {
    return res.status(400).json({ error: "Invalid project ID" });
  }
  const docker = await DockerInfo.findOne({ where: { ProjectId: projectId } });

  // Get latest deployment job for progress info
  const latestJob = await DeploymentJob.findOne({
    where: { ProjectId: parseInt(projectId) },
    order: [["createdAt", "DESC"]],
    attributes: ["status", "logs", "createdAt"],
  });

  // Extract last meaningful log line as the phase
  const logs = latestJob?.logs || "";
  const lines = logs.trim().split("\n").filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  const phase = lastLine.replace(/^\[.*?\]\s*/, "").slice(0, 120);

  res.json({
    status: docker?.status || "unknown",
    phase: latestJob?.status === "building" ? phase : null,
    jobStatus: latestJob?.status || null,
  });
});

module.exports = { sleepProxyHandler, router };
