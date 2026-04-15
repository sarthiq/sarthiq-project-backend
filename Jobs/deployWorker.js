/**
 * deployWorker.js
 * BullMQ Worker — AI-Powered Deployment Pipeline (SECURITY-HARDENED)
 *
 * Pipeline Steps:
 *   1. Validate inputs          → reject malicious data before any work
 *   2. Pre-flight cluster check → verify cluster can schedule pods
 *   3. Clone repo               → via spawn (no shell injection)
 *   4. AI Stack Detection       → detect language, framework, commands, port
 *   5. Root Requirement Check   → detect if sandbox mode needed
 *   6. Validate & write Dockerfile → block dangerous instructions
 *   7. Build Docker image       → via spawn (no shell injection)
 *   8. Push to registry
 *   9. Create K8s resources     → with security context + network policy
 *  10. Wait for pod ready       → with full diagnostics
 *  11. Update DB                → DockerInfo.status = 'running'
 *
 * KEY CHANGES (v2):
 *   - Pre-flight cluster check BEFORE creating resources
 *   - Removed nodeName pinning from createDeployment (let scheduler decide)
 *   - Improved waitForReady error handling with diagnostic info
 *   - Pass isSingleNodeCluster for control-plane toleration
 *   - Fixed URL scheme (http for localhost, https for prod)
 */
const { Worker } = require("bullmq");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { connection } = require("./queues");
const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const DeploymentJob = require("../Models/Deployment/deploymentJob");
const {
  createDeployment,
  createService,
  createIngress,
  waitForReady,
  createOrUpdateNetworkPolicy,
  patchDeploymentImage,
  deploymentExists,
} = require("../Utils/kubeClient");
const {
  getBestNode,
  reserveNode,
  releaseNode,
  preflightClusterCheck,
} = require("../Utils/nodeManager");
const { detectStack, classifyEnvVars } = require("../Utils/aiStackDetector");
const { diagnoseError, collectPodLogs } = require("../Utils/aiDebugger");

// ── Build Optimization modules ───────────────────────────────────────
const { optimizeBuildContext } = require("../Utils/buildContextOptimizer");
const { detectMonorepo } = require("../Utils/monorepoDetector");

// ── Pipeline Split modules ───────────────────────────────────────────
const { detectProjectType } = require("../Utils/projectTypeDetector");
const { deployFrontend, removeStaticFiles } = require("../Utils/frontendDeployer");
const { preBuildBackend } = require("../Utils/backendDeployer");

// ── Security modules ──────────────────────────────────────────────────
const {
  spawnAsync,
  spawnAsyncWithProgress,
  spawnAsyncWithEnv,
  validateRepoUrl,
  validateBranch,
  validateImageTag,
  validateDockerfile,
  validateEnvVars,
  sanitizeLogLine,
} = require("../Utils/securityValidator");
const { detectRootRequirements, autoPatchDockerfile } = require("../Utils/rootDetector");
const { resolveExecutionMode, detectSuspiciousActivity } = require("../Utils/sandboxManager");
const { clonePrivateRepo } = require("../Utils/githubClone");
const GithubAccount = require("../Models/Projects/githubAccount");

const isProd = process.env.NODE_ENV === "production";
const REGISTRY = process.env.DOCKER_REGISTRY || (isProd ? "registry.sarthiq.com" : "");
const { PROJECT_DOMAIN } = require("../Middleware/subdomainParser");
const DEPLOY_DOMAIN = isProd ? PROJECT_DOMAIN : "localhost";
const MAX_AI_RETRIES = Math.min(parseInt(process.env.MAX_AI_RETRIES || "3"), 5); // Cap at 5

// ── BuildKit cache directory (for local/minikube mode) ─────────────────
const CACHE_DIR = process.env.SARTHIQ_CACHE_DIR || path.join(os.tmpdir(), "sarthiq-cache");

// ── Pre-pull common base images in background ──────────────────────────
// This prevents the first build from waiting 10-30s to download node:20-alpine.
// Runs async on worker start — non-blocking.
(async () => {
  const baseImages = ["node:20-alpine", "nginxinc/nginx-unprivileged:alpine", "python:3.12-slim"];
  for (const img of baseImages) {
    try {
      await spawnAsync("docker", ["pull", img], { timeout: 120_000 });
      console.log(`[deployWorker] ✓ Pre-pulled base image: ${img}`);
    } catch {
      // Non-fatal — image will be pulled during build if needed
      console.log(`[deployWorker] ⚠ Pre-pull skipped: ${img} (will download during build)`);
    }
  }
})();

/* ------------------------------------------------------------------ */
/* Helper: append a SANITIZED log line to the DeploymentJob record     */
/* ------------------------------------------------------------------ */
async function appendLog(jobRecord, line) {
  const ts = new Date().toISOString();
  const sanitized = sanitizeLogLine(line); // ← Scrub secrets
  const msg = `[${ts}] ${sanitized}`;
  console.log(`[deployWorker] ${msg}`);
  jobRecord.logs = (jobRecord.logs || "") + msg + "\n";
  await jobRecord.save();
}

/* ------------------------------------------------------------------ */
/* Helper: generate a unique subdomain if not already set              */
/* ------------------------------------------------------------------ */
function generateSubdomain(title, projectId) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 28);
  return `${slug}-${projectId}`;
}

/* ------------------------------------------------------------------ */
/* Helper: ensure buildx builder is ready                               */
/* ------------------------------------------------------------------ */
let _buildxReady = false;
async function ensureBuildxBuilder() {
  if (_buildxReady) return;

  if (REGISTRY) {
    // PRODUCTION: Use docker-container driver for --push support
    try {
      await spawnAsync("docker", ["buildx", "inspect", "sarthiq-builder"], { timeout: 5000 });
      await spawnAsync("docker", ["buildx", "use", "sarthiq-builder"], { timeout: 5000 });
    } catch {
      try {
        await spawnAsync("docker", [
          "buildx", "create", "--name", "sarthiq-builder",
          "--driver", "docker-container", "--use",
        ], { timeout: 30000 });
        console.log("[deployWorker] ✓ Created buildx builder (docker-container driver)");
      } catch (e) {
        console.warn(`[deployWorker] ⚠ Buildx builder creation failed: ${e.message?.slice(0, 100)}`);
      }
    }
  } else {
    // LOCAL: Use default 'docker' driver — it has direct access to
    // local image cache, so --cache-from with local tags works correctly.
    // The docker-container driver runs in its own container and CANNOT
    // access local images, breaking all cache hits.
    try {
      await spawnAsync("docker", ["buildx", "use", "default"], { timeout: 5000 });
      console.log("[deployWorker] ✓ Using default buildx driver (local cache access)");
    } catch {
      // Default driver is always available
    }
  }

  _buildxReady = true;
}

/* ------------------------------------------------------------------ */
/* Helper: build Docker image with BuildKit + caching (OPTIMIZED v3)    */
/* ------------------------------------------------------------------ */
/*
 * OPTIMIZATION SUMMARY (vs v1):
 *   1. Uses `docker buildx build` instead of `docker build`
 *      → parallel multi-stage builds, better cache handling
 *   2. In PRODUCTION: uses `--push` to combine build+push in one step
 *      → eliminates separate `docker push` (saves 30-60s)
 *   3. In LOCAL: uses `--load` to import into local docker daemon
 *   4. Uses `mode=max` caching to cache ALL layers, not just final
 *   5. Adds `--progress=plain` for better log streaming
 */
async function buildDockerImage({
  imageTag,
  buildContext,
  buildTimeEnvs = {},
  timeout = 900_000,
  subdomain = "",
  cacheTag = "",
  onProgress = null,
  pushToRegistry = false, // NEW: combined build+push
}) {
  // Validate image tag
  validateImageTag(imageTag);

  // Validate env var keys
  validateEnvVars(buildTimeEnvs);

  // Ensure buildx builder is ready
  await ensureBuildxBuilder();

  // Build argument array (NO shell interpolation)
  const args = ["buildx", "build", "--progress=plain"];

  // Add build-args safely
  for (const [key, value] of Object.entries(buildTimeEnvs)) {
    args.push("--build-arg", `${key}=${value}`);
  }

  // ── BuildKit cache strategy ────────────────────────────────────────
  if (REGISTRY) {
    // PRODUCTION: Use registry-based caching with mode=max (cache ALL layers)
    const cacheRef = `${REGISTRY}/${subdomain || "sarthiq"}:cache`;
    args.push("--cache-from", `type=registry,ref=${cacheRef}`);
    args.push("--cache-to", `type=registry,ref=${cacheRef},mode=max`);
  } else {
    // LOCAL (Docker Desktop): Use inline cache
    const stableTag = cacheTag || `${subdomain || "sarthiq"}:latest`;
    args.push("--cache-from", stableTag);
    args.push("--build-arg", "BUILDKIT_INLINE_CACHE=1");
  }

  // Tag with both the unique tag AND the stable :latest tag for future cache
  args.push("-t", imageTag);
  if (cacheTag) {
    args.push("-t", cacheTag); // also tag as :latest for next build's --cache-from
  }

  // ── OUTPUT STRATEGY ────────────────────────────────────────────────
  if (pushToRegistry && REGISTRY) {
    // PRODUCTION: Combined build+push — streams layers directly to registry
    // This ELIMINATES the separate `docker push` step (saves 30-60 seconds!)
    args.push("--push");
  } else {
    // LOCAL / no registry: Load image into local docker daemon
    args.push("--load");
  }

  args.push(buildContext);

  // Enable BuildKit via environment variable
  const buildEnv = { ...process.env, DOCKER_BUILDKIT: "1" };

  // Execute via spawn with progress streaming + BuildKit enabled
  if (onProgress) {
    return await spawnAsyncWithProgress("docker", args, {
      timeout,
      env: buildEnv,
      onLine: onProgress,
    });
  }

  return await spawnAsync("docker", args, { timeout, env: buildEnv });
}

/* ------------------------------------------------------------------ */
/* Helper: get Docker image size in MB                                  */
/* ------------------------------------------------------------------ */
async function getImageSizeMB(imageTag) {
  try {
    const { stdout } = await spawnAsync("docker", ["image", "inspect", imageTag, "--format", "{{.Size}}"], { timeout: 10_000 });
    const bytes = parseInt(stdout.trim());
    return isNaN(bytes) ? null : parseFloat((bytes / (1024 * 1024)).toFixed(2));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Main worker                                                         */
/* ------------------------------------------------------------------ */
const deployWorker = new Worker(
  "deployQueue",
  async (job) => {
    const { projectId, deploymentJobId, userId } = job.data;

    // Load DB records
    const project = await Project.findByPk(projectId);
    const dockerInfo = await DockerInfo.findOne({
      where: { ProjectId: projectId },
    });
    const jobRecord = await DeploymentJob.findByPk(deploymentJobId);

    if (!project || !dockerInfo || !jobRecord) {
      throw new Error("Project, DockerInfo, or DeploymentJob not found");
    }

    const updateStatus = async (status) => {
      dockerInfo.status = status;
      await dockerInfo.save();
      jobRecord.status = status;
      await jobRecord.save();
    };

    let reservedNodeId = null;
    let tmpDir = null;

    try {
      await updateStatus("building");
      /* ── STEP 0: Input validation (BEFORE any work) ──────────────── */
      await appendLog(jobRecord, "Step 0: Validating project inputs...");

      // Validate repo URL (blocks SSRF, file://, IPs, etc.)
      validateRepoUrl(project.projectRepoUrl);

      // Validate branch name (blocks shell metacharacters)
      validateBranch(project.branch);

      // Validate env vars
      let envVars = {};
      try {
        envVars =
          typeof project.envVariables === "string"
            ? JSON.parse(project.envVariables)
            : project.envVariables || {};
      } catch {}
      validateEnvVars(envVars);

      await appendLog(jobRecord, "  → All inputs validated.");

      /* ---- Mark as building ---------------------------------------- */
      await updateStatus("building");
      jobRecord.startedAt = new Date();
      await jobRecord.save();

      /* ── STEP 1: Pre-flight cluster check ──────────────────────────── */
      await appendLog(jobRecord, "Step 1/12: Pre-flight cluster health check...");

      const clusterCheck = await preflightClusterCheck();

      if (!clusterCheck.ok) {
        await appendLog(jobRecord, `  ❌ Cluster check failed: ${clusterCheck.reason}`);
        throw new Error(`Pre-flight cluster check failed: ${clusterCheck.reason}`);
      }

      const isSingleNode = clusterCheck.isSingleNode;
      await appendLog(
        jobRecord,
        `  → Cluster OK: ${clusterCheck.totalSchedulableNodes} schedulable node(s)` +
          (isSingleNode ? " (single-node cluster)" : "") +
          (clusterCheck.controlPlaneOnly ? " (control-plane only — tolerations will be applied)" : "")
      );

      /* ── STEP 1b: Node capacity reservation ───────────────────────── */
      const node = await getBestNode();
      await appendLog(jobRecord, `  → Capacity reserved on node: ${node.nodeName}`);
      await reserveNode(node.id);
      reservedNodeId = node.id;

      /* ── STEP 2: Generate subdomain if not set ────────────────────── */
      if (!project.subdomain) {
        const sub = generateSubdomain(project.title, project.id);
        project.subdomain = sub;
        await project.save();
      }
      await appendLog(jobRecord, `  → Subdomain: ${project.subdomain}.${DEPLOY_DOMAIN}`);

      /* ── STEP 3: Clone repository (SECURE — via spawn) ────────────── */
      await appendLog(jobRecord, "Step 2/12: Cloning repository...");
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sarthiq-${projectId}-`));

      // Determine if this is a private GitHub repo that needs authenticated clone
      const isGithubUrl = project.projectRepoUrl.includes("github.com");
      let cloneSucceeded = false;

      if (isGithubUrl) {
        // Find the user's active GitHub account for installation token
        const ghAccount = await GithubAccount.findOne({
          where: { userId: project.UserId, isActive: true },
        });
        if (ghAccount) {
          try {
            // Extract owner/repo from URL
            const match = project.projectRepoUrl.match(
              /github\.com[\/:]([^\/]+)\/([^\/.]+)/
            );
            if (match) {
              await appendLog(jobRecord, "  → Using GitHub App token for authenticated clone...");
              await clonePrivateRepo({
                installationId: ghAccount.installationId,
                owner: match[1],
                repo: match[2],
                branch: project.branch,
                targetDir: tmpDir,
              });
              cloneSucceeded = true;
              await appendLog(jobRecord, "  → Authenticated clone complete.");
            }
          } catch (ghErr) {
            await appendLog(jobRecord, `  ⚠ GitHub App clone failed: ${ghErr.message.slice(0, 200)}. Falling back to public clone...`);
          }
        }
      }

      if (!cloneSucceeded) {
        // Fallback: public clone via spawn (no shell interpolation)
        await spawnAsync(
          "git",
          ["clone", "--branch", project.branch, "--depth", "1", project.projectRepoUrl, tmpDir],
          { timeout: 120_000 }
        );
        await appendLog(jobRecord, "  → Clone complete.");
      }

      const buildContext = path.join(tmpDir, project.projectDirectory || ".");

      // Verify buildContext is inside tmpDir (path traversal check)
      const resolvedCtx = path.resolve(buildContext);
      const resolvedTmp = path.resolve(tmpDir);
      if (!resolvedCtx.startsWith(resolvedTmp)) {
        throw new Error("Path traversal detected: projectDirectory escapes temp directory.");
      }

      /* ── STEP 3b: Build Context Optimization ────────────────────── */
      await appendLog(jobRecord, "Step 3/12: ⚡ Optimizing build context...");

      // Auto-detect language for .dockerignore generation
      const quickLang = fs.existsSync(path.join(buildContext, "package.json")) ? "node"
        : fs.existsSync(path.join(buildContext, "requirements.txt")) ? "python"
        : fs.existsSync(path.join(buildContext, "go.mod")) ? "go"
        : fs.existsSync(path.join(buildContext, "pom.xml")) ? "java"
        : fs.existsSync(path.join(buildContext, "Gemfile")) ? "ruby"
        : "node"; // safe default

      const contextOptimization = await optimizeBuildContext(buildContext, quickLang, {
        useAI: true,
        cleanup: true,
      });

      for (const opt of contextOptimization.optimizations) {
        await appendLog(jobRecord, `  → ${opt}`);
      }

      // Save optimization metadata
      jobRecord.dockerignoreGenerated = contextOptimization.dockerignoreGenerated;
      jobRecord.optimizationsApplied = contextOptimization.optimizations;
      jobRecord.dependencyHash = contextOptimization.dependencyHash;
      await jobRecord.save();

      /* ── STEP 3c: Monorepo Detection ──────────────────────────────── */
      await appendLog(jobRecord, "Step 4/12: 🔍 Detecting monorepo structure...");

      const monorepoResult = await detectMonorepo(buildContext);
      if (monorepoResult.isMonorepo) {
        await appendLog(jobRecord, `  → Monorepo detected (${monorepoResult.type}): ${monorepoResult.services.length} services found`);
        for (const svc of monorepoResult.services) {
          await appendLog(jobRecord, `    • ${svc.name}: ${svc.language}/${svc.framework} on port ${svc.port}`);
        }
        jobRecord.servicesDetected = monorepoResult.services;
        await jobRecord.save();

        // ── BLOCK: If user has NOT selected a specific service yet ──
        // projectDirectory is still "/" or "." → user needs to pick which service to deploy
        const projDir = project.projectDirectory || "/";
        const isRootDir = projDir === "/" || projDir === "." || projDir === "./";

        if (monorepoResult.services.length > 1 && isRootDir) {
          await appendLog(jobRecord, "");
          await appendLog(jobRecord, "  ⚠️  MONOREPO DETECTED — SERVICE SELECTION REQUIRED");
          await appendLog(jobRecord, "  Multiple services found in this repository.");
          await appendLog(jobRecord, "  Please select which service you want to deploy from the project overview page.");
          await appendLog(jobRecord, "");

          // Mark the job as done (DB ENUM only allows: queued/building/running/sleeping/failed/done)
          // Use errorMessage as the flag for the frontend to detect
          jobRecord.status = "done";
          jobRecord.errorMessage = "MONOREPO_SELECTION_REQUIRED";
          jobRecord.completedAt = new Date();
          await jobRecord.save();

          // Reset container status to idle (not failed — this is a user flow, not an error)
          const DockerInfoModel = require("../Models/Projects/dockerInfo");
          await DockerInfoModel.update(
            { status: "idle" },
            { where: { ProjectId: project.id } }
          );

          // Clean up temp dir
          if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
          }

          // Release node capacity
          if (node) {
            releaseNode(node.id).catch(() => {});
          }

          return; // ← STOP the deployment pipeline here
        }
      } else {
        await appendLog(jobRecord, "  → Single-app project (not a monorepo)");
      }

      /* ── STEP 5: AI Stack Detection ───────────────────────────────── */
      // ── RE-DEPLOY FAST PATH: Skip AI/monorepo if detection is cached ──
      const isRedeploy = project.detectedLanguage && project.detectedFramework;
      let detection;

      if (isRedeploy) {
        await appendLog(jobRecord, "Step 5/12: ⚡ Re-deploy — using cached detection metadata");
        const { classifyEnvVars } = require("../Utils/aiStackDetector");
        const { buildTime: buildTimeEnvs, runtime: runtimeEnvs } = classifyEnvVars(envVars);
        detection = {
          language: project.detectedLanguage,
          framework: project.detectedFramework,
          buildCommand: project.buildCommand || project.detectedBuildCommand,
          startCommand: project.detectedStartCommand,
          port: project.detectedPort || 3000,
          isStaticSite: project.isStaticSite || false,
          buildOutputDir: project.buildDirectory || null,
          buildTimeEnvs,
          runtimeEnvs,
          detectedBy: "cached",
        };
        await appendLog(jobRecord, `  → Cached: ${detection.language}/${detection.framework} (static: ${detection.isStaticSite})`);
      } else {
        await appendLog(jobRecord, "Step 5/12: 🤖 Analyzing repository with AI stack detector...");

        // User overrides (user-provided values take priority over AI)
        const userOverrides = {};
        if (project.buildCommand) userOverrides.buildCommand = project.buildCommand;
        if (project.buildDirectory) userOverrides.buildDirectory = project.buildDirectory;

        // Run AI stack detection
        detection = await detectStack(buildContext, envVars, userOverrides);

        await appendLog(
          jobRecord,
          `  → Detected: ${detection.language}/${detection.framework} (by: ${detection.detectedBy})`
        );
        await appendLog(
          jobRecord,
          `  → Build: ${detection.buildCommand || "none"} | Start: ${detection.startCommand} | Port: ${detection.port}`
        );
        await appendLog(
          jobRecord,
          `  → Static site: ${detection.isStaticSite ? "Yes" : "No"} | Build-time vars: ${Object.keys(detection.buildTimeEnvs).length} | Runtime vars: ${Object.keys(detection.runtimeEnvs).length}`
        );

        // Save detected metadata to Project
        await project.update({
          detectedLanguage: detection.language,
          detectedFramework: detection.framework,
          detectedBuildCommand: detection.buildCommand,
          detectedStartCommand: detection.startCommand,
          detectedPort: detection.port,
          isStaticSite: detection.isStaticSite || false,
        });
      }

      // Update dockerInfo port
      const containerPort = detection.port || dockerInfo.internalPort || 3000;
      dockerInfo.internalPort = containerPort;
      await dockerInfo.save();

      /* ══════════════════════════════════════════════════════════════ */
      /* ── STEP 6: PROJECT TYPE DISPATCH ────────────────────────────── */
      /* ══════════════════════════════════════════════════════════════ */
      const projectType = detectProjectType(buildContext, detection);
      await appendLog(jobRecord, `Step 6/12: 🎯 Project type: ${projectType.type.toUpperCase()} (${projectType.reason})`);

      if (projectType.type === "frontend") {
        /* ══════════════════════════════════════════════════════════ */
        /* ── FRONTEND PIPELINE (No Docker, No K8s) ──────────────── */
        /* ══════════════════════════════════════════════════════════ */
        await appendLog(jobRecord, "Step 7/12: ⚡ FRONTEND PIPELINE — Skipping Docker & K8s");

        const frontendResult = await deployFrontend({
          buildContext,
          detection,
          subdomain: project.subdomain,
          envVars,
          onLog: (line) => appendLog(jobRecord, line),
        });

        // Save build metrics
        jobRecord.buildDurationMs = frontendResult.buildDurationMs;
        jobRecord.generatedDockerfile = null; // No Docker used
        await jobRecord.save();

        // Clean up any old K8s resources from previous Docker deployment
        try {
          const prevDeployExists = await deploymentExists(project.subdomain);
          if (prevDeployExists) {
            await appendLog(jobRecord, "  🧹 Cleaning up old K8s resources (switching to static)...");
            const { deleteProjectResources } = require("../Utils/kubeClient");
            await deleteProjectResources(project.subdomain).catch((e) =>
              console.warn(`[deployWorker] K8s cleanup warning: ${e.message}`)
            );
            await appendLog(jobRecord, "  → Old K8s resources removed");
          }
        } catch {
          // Non-fatal — old resources may not exist
        }

        /* ── Clean up temp dir ── */
        if (tmpDir) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          tmpDir = null;
        }

        /* ── Update DB for static serving ── */
        dockerInfo.deploymentType = "static";
        dockerInfo.staticFilesPath = frontendResult.staticFilesPath;
        dockerInfo.status = "running";
        dockerInfo.image = null; // No Docker image
        dockerInfo.lastActivityAt = new Date();
        dockerInfo.deployedAt = new Date();
        await dockerInfo.save();

        /* ── Mark job done ── */
        jobRecord.status = "done";
        jobRecord.completedAt = new Date();
        await jobRecord.save();

        // Release node reservation (unused for frontend)
        if (reservedNodeId) {
          await releaseNode(reservedNodeId).catch(console.error);
        }

        const urlScheme = DEPLOY_DOMAIN === "localhost" ? "http" : "https";
        const publicHost = `${project.subdomain}.${DEPLOY_DOMAIN}`;

        await appendLog(
          jobRecord,
          `✅ Frontend deployed in ${(frontendResult.buildDurationMs / 1000).toFixed(1)}s! ` +
          `Live at: ${urlScheme}://${publicHost} (${frontendResult.fileCount} files, static serving)`
        );

        return { success: true, url: `${urlScheme}://${publicHost}`, executionMode: "static", deploymentType: "static" };

      } else {
        /* ══════════════════════════════════════════════════════════ */
        /* ── BACKEND PIPELINE (Optimized Docker) ────────────────── */
        /* ══════════════════════════════════════════════════════════ */
        await appendLog(jobRecord, "Step 7/12: 🐳 BACKEND PIPELINE — Optimized Docker Build");

        let currentDockerfile;
        const dockerfilePath = path.join(buildContext, "Dockerfile");
        let preBuildDurationMs = 0;

        // ── Optimized pre-build ONLY for Node.js backends ──
        // Non-Node.js (Python, Java, PHP, Go, etc.) use the original AI Dockerfile
        const isNodeProject = detection.language === "node" || detection.language === "javascript";

        if (isNodeProject) {
          // ── Step 7a: Pre-build on host (Node.js only) ──
          await appendLog(jobRecord, "  ⚡ Node.js detected — using host pre-build optimization");
          const preBuildResult = await preBuildBackend({
            buildContext,
            detection,
            subdomain: project.subdomain,
            envVars,
            onLog: (line) => appendLog(jobRecord, line),
          });

          currentDockerfile = preBuildResult.dockerfile;
          preBuildDurationMs = preBuildResult.buildDurationMs || 0;
        } else {
          // ── Step 7a: Use AI-generated Dockerfile (non-Node.js) ──
          await appendLog(jobRecord, `  📋 ${detection.language}/${detection.framework} — using AI-generated Dockerfile`);

          if (fs.existsSync(dockerfilePath)) {
            // Project has its own Dockerfile — use it
            currentDockerfile = fs.readFileSync(dockerfilePath, "utf-8");
            await appendLog(jobRecord, "  → Using existing Dockerfile from repo");
          } else if (detection.dockerfile) {
            // Use AI-generated Dockerfile from detection
            currentDockerfile = detection.dockerfile;
            fs.writeFileSync(dockerfilePath, currentDockerfile);
            await appendLog(jobRecord, `  → Dockerfile generated for ${detection.language}/${detection.framework}`);
          } else {
            // Cached re-deploy has no dockerfile — run AI detection to generate one
            await appendLog(jobRecord, `  → No Dockerfile found, running AI detection for ${detection.language}/${detection.framework}...`);
            const freshDetection = await detectStack(buildContext, envVars, {});
            if (freshDetection.dockerfile) {
              currentDockerfile = freshDetection.dockerfile;
              fs.writeFileSync(dockerfilePath, currentDockerfile);
              await appendLog(jobRecord, `  → Dockerfile generated by AI for ${freshDetection.language}/${freshDetection.framework}`);
            } else {
              throw new Error(
                `No Dockerfile found or generated for ${detection.language}/${detection.framework}. ` +
                "Add a Dockerfile to your repository."
              );
            }
          }

          // Validate the Dockerfile
          const validation = validateDockerfile(currentDockerfile);
          if (!validation.safe) {
            throw new Error(`Dockerfile blocked: ${validation.violations.join("; ")}`);
          }
        }

        // Save the Dockerfile used to deployment job
        jobRecord.generatedDockerfile = currentDockerfile;
        await jobRecord.save();

        // ── Step 7b: Root requirement detection ──
        await appendLog(jobRecord, "Step 8/12: 🔍 Checking root requirements...");

        const rootDetection = detectRootRequirements({
          dockerfileContent: currentDockerfile,
          port: containerPort,
          buildContext,
          isStaticSite: detection.isStaticSite,
        });

        const executionDecision = resolveExecutionMode(rootDetection, {
          userConsentsToSandbox: project.sandboxMode === true,
        });

        if (executionDecision.mode === "requires_consent") {
          await appendLog(
            jobRecord,
            `  ⚠ Project requires root access: ${rootDetection.reasons.join("; ")}`
          );

          if (rootDetection.canAutoFix) {
            await appendLog(jobRecord, "  🔧 Attempting auto-patch for non-root compatibility...");
            const { patched, applied } = autoPatchDockerfile(currentDockerfile, containerPort);
            if (applied.length > 0) {
              currentDockerfile = patched;
              fs.writeFileSync(dockerfilePath, currentDockerfile);
              await appendLog(jobRecord, `  → Auto-patched: ${applied.join("; ")}`);

              const recheck = detectRootRequirements({
                dockerfileContent: currentDockerfile,
                port: containerPort,
                buildContext,
                isStaticSite: detection.isStaticSite,
              });
              if (!recheck.requiresRoot) {
                await appendLog(jobRecord, "  ✅ Auto-patch successful! Proceeding in secure mode.");
                executionDecision.mode = "secure";
                executionDecision.config = require("../Utils/sandboxManager").getSecureConfig();
              }
            }
          }

          if (executionDecision.mode === "requires_consent") {
            throw new Error(
              "Project requires root access. Enable sandbox mode or fix for non-root execution. " +
              `Reasons: ${rootDetection.reasons.join("; ")}`
            );
          }
        }

        const execMode = executionDecision.mode;
        const securityConfig = executionDecision.config;

        await appendLog(
          jobRecord,
          `  → Execution mode: ${execMode.toUpperCase()} ${execMode === "sandbox" ? "🔒" : "🟢"}`
        );

        /* ── Step 8: Docker build (minimal image, pre-built on host) ── */
        await appendLog(jobRecord, "Step 9/12: 🔨 Building minimal Docker image...");

        const depHash = contextOptimization.dependencyHash || Date.now();
        const timestamp = Date.now();
        const imageTag = REGISTRY
          ? `${REGISTRY}/${project.subdomain}:${depHash}-${timestamp}`
          : `${project.subdomain}:${depHash}-${timestamp}`;
        const cacheTag = REGISTRY
          ? `${REGISTRY}/${project.subdomain}:latest`
          : `${project.subdomain}:latest`;

        validateImageTag(imageTag);

        let previousImageExists = false;
        try {
          await spawnAsync("docker", ["image", "inspect", cacheTag], { timeout: 5000 });
          previousImageExists = true;
        } catch {
          previousImageExists = false;
        }
        buildDockerImage._previousImageExisted = previousImageExists;

        const buildStartTime = Date.now();
        let buildSuccess = false;
        let retryCount = 0;
        const allDiagnoses = [];

        while (!buildSuccess && retryCount <= MAX_AI_RETRIES) {
          try {
            if (retryCount > 0) {
              await appendLog(jobRecord, `  🔄 AI Retry ${retryCount}/${MAX_AI_RETRIES}: Rebuilding with fixes...`);
            }

            await buildDockerImage({
              imageTag,
              buildContext,
              buildTimeEnvs: detection.buildTimeEnvs || {},
              subdomain: project.subdomain,
              cacheTag,
              pushToRegistry: !!REGISTRY,
              onProgress: (line) => {
                if (line && line.trim() && !line.includes("#")) {
                  console.log(`[build:${project.subdomain}] ${line.trim().slice(0, 200)}`);
                }
              },
            });

            buildSuccess = true;
            const buildDurationMs = Date.now() - buildStartTime;
            const imageSizeMB = await getImageSizeMB(imageTag);

            jobRecord.cacheHit = !!buildDockerImage._previousImageExisted;
            jobRecord.buildDurationMs = preBuildDurationMs + buildDurationMs;
            jobRecord.imageSizeMB = imageSizeMB;
            await jobRecord.save();

            await appendLog(jobRecord, `  → Image built: ${imageTag}`);
            await appendLog(jobRecord, `  → Build time: ${(buildDurationMs / 1000).toFixed(1)}s | Image size: ${imageSizeMB ? imageSizeMB + " MB" : "unknown"}`);
          } catch (buildErr) {
            const errorLogs = (buildErr.stderr || "") + "\n" + (buildErr.stdout || "") + "\n" + buildErr.message;

            const suspicious = detectSuspiciousActivity(errorLogs);
            if (suspicious.suspicious) {
              await appendLog(jobRecord, `  🚨 SECURITY: Suspicious activity: ${suspicious.matches.join(", ")}`);
              throw new Error("Build terminated: suspicious activity detected.");
            }

            await appendLog(jobRecord, `  ❌ Build failed (attempt ${retryCount + 1}): ${sanitizeLogLine(buildErr.message.slice(0, 200))}`);

            if (retryCount >= MAX_AI_RETRIES) {
              await appendLog(jobRecord, `  ❌ Max retries (${MAX_AI_RETRIES}) exhausted.`);
              throw buildErr;
            }

            await appendLog(jobRecord, "  🤖 Calling AI debugger...");
            const diagnosis = await diagnoseError({
              language: detection.language,
              framework: detection.framework,
              buildCommand: detection.buildCommand,
              startCommand: detection.startCommand,
              dockerfileContent: currentDockerfile,
              errorLogs: sanitizeLogLine(errorLogs),
              errorPhase: "build",
              previousAttempts: allDiagnoses,
            });

            allDiagnoses.push(diagnosis);
            await appendLog(jobRecord, `  🤖 Diagnosis: ${diagnosis.diagnosis}`);

            if (!diagnosis.shouldRetry) {
              jobRecord.aiDiagnosis = allDiagnoses;
              jobRecord.retryCount = retryCount;
              await jobRecord.save();
              throw new Error(`Build failed: ${diagnosis.diagnosis}`);
            }

            if (diagnosis.fixedDockerfile) {
              const fixValidation = validateDockerfile(diagnosis.fixedDockerfile);
              if (fixValidation.safe) {
                currentDockerfile = diagnosis.fixedDockerfile;
                fs.writeFileSync(dockerfilePath, currentDockerfile);
                await appendLog(jobRecord, "  🤖 Applied AI-fixed Dockerfile.");
              }
            }
            retryCount++;
          }
        }

        jobRecord.aiDiagnosis = allDiagnoses.length > 0 ? allDiagnoses : null;
        jobRecord.retryCount = retryCount;
        await jobRecord.save();

        /* ── Step 9: Push image ── */
        if (REGISTRY) {
          await appendLog(jobRecord, "Step 10/12: ⚡ Image already pushed during build (buildx --push).");
        } else {
          await appendLog(jobRecord, "Step 10/12: Local testing mode. Skipping registry push.");
        }

        /* Clean up temp dir */
        if (tmpDir) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          tmpDir = null;
        }

        /* ── Step 10: Create/Update K8s resources ── */
        const deployName = project.subdomain;
        const isRedeployK8s = await deploymentExists(deployName);

        if (isRedeployK8s) {
          await appendLog(jobRecord, "Step 11/12: ⚡ Rolling update (re-deploy detected)...");

          const cpuLimit = dockerInfo.cpu || securityConfig.maxCpu || "500m";
          let memLimit = dockerInfo.memory || securityConfig.maxMemory || "512Mi";
          if (memLimit.match(/^\d+m$/)) memLimit = memLimit.replace("m", "Mi");

          await createDeployment({
            name: deployName,
            image: imageTag,
            containerPort,
            cpuLimit,
            memoryLimit: memLimit,
            cpuRequest: "100m",
            memoryRequest: "128Mi",
            envVars: detection.runtimeEnvs || {},
            nodeName: node.nodeName,
            useConfigMap: true,
            executionMode: execMode,
            podSecurityContext: securityConfig.podSecurityContext,
            containerSecurityContext: securityConfig.containerSecurityContext,
            runtimeClassName: securityConfig.runtimeClassName,
            labels: {
              ...securityConfig.labels,
              "sarthiq.com/userId": String(userId),
              "sarthiq.com/projectId": String(projectId),
            },
            namespace: securityConfig.namespace,
            activeDeadlineSeconds: securityConfig.activeDeadlineSeconds,
            isSingleNodeCluster: isSingleNode,
          });
          await appendLog(jobRecord, `  → Deployment updated. ⚡ Skipped Service/Ingress.`);

        } else {
          await appendLog(jobRecord, "Step 11/12: Creating Kubernetes resources...");

          const cpuLimit = dockerInfo.cpu || securityConfig.maxCpu || "500m";
          let memLimit = dockerInfo.memory || securityConfig.maxMemory || "512Mi";
          if (memLimit.match(/^\d+m$/)) memLimit = memLimit.replace("m", "Mi");

          await createDeployment({
            name: deployName,
            image: imageTag,
            containerPort,
            cpuLimit,
            memoryLimit: memLimit,
            cpuRequest: "100m",
            memoryRequest: "128Mi",
            envVars: detection.runtimeEnvs || {},
            nodeName: node.nodeName,
            useConfigMap: true,
            executionMode: execMode,
            podSecurityContext: securityConfig.podSecurityContext,
            containerSecurityContext: securityConfig.containerSecurityContext,
            runtimeClassName: securityConfig.runtimeClassName,
            labels: {
              ...securityConfig.labels,
              "sarthiq.com/userId": String(userId),
              "sarthiq.com/projectId": String(projectId),
            },
            namespace: securityConfig.namespace,
            activeDeadlineSeconds: securityConfig.activeDeadlineSeconds,
            isSingleNodeCluster: isSingleNode,
          });
          await appendLog(jobRecord, `  → Deployment + ConfigMap created (mode: ${execMode}).`);

          if (securityConfig.networkPolicy) {
            try {
              await createOrUpdateNetworkPolicy(securityConfig.networkPolicy);
              await appendLog(jobRecord, "  → NetworkPolicy applied.");
            } catch (npErr) {
              await appendLog(jobRecord, `  ⚠ NetworkPolicy: ${npErr.message}`);
            }
          }

          const svcHost = await createService({ name: deployName, containerPort });
          await appendLog(jobRecord, `  → Service created: ${svcHost}`);

          try {
            await createIngress({
              name: deployName,
              subdomain: project.subdomain,
              baseDomain: DEPLOY_DOMAIN,
            });
            await appendLog(jobRecord, `  → Ingress created.`);
          } catch (ingressErr) {
            await appendLog(jobRecord, `  ⚠ Ingress: ${ingressErr.message?.slice(0, 150)}`);
          }
        }

        let publicHost = `${project.subdomain}.${DEPLOY_DOMAIN}`;

        /* ── Step 11: Wait for pod ready ── */
        const readyTimeout = isRedeployK8s ? 60_000 : 180_000;
        await appendLog(jobRecord, `Step 12/12: Waiting for pod ready${isRedeployK8s ? " (⚡ fast)" : ""}...`);

        try {
          await waitForReady(deployName, readyTimeout);
          await appendLog(jobRecord, "  → Pod is running! 🚀");
        } catch (readyErr) {
          const diagnostic = readyErr.diagnostic || {};
          await appendLog(jobRecord, `  ⚠ Pod not ready: ${readyErr.message.slice(0, 300)}`);

          if (diagnostic.phase) await appendLog(jobRecord, `  → Pod phase: ${diagnostic.phase}`);
          if (diagnostic.events?.length > 0) await appendLog(jobRecord, `  → Events:\n${diagnostic.events.join("\n")}`);
          if (diagnostic.containerLogs) await appendLog(jobRecord, `  → Logs:\n${diagnostic.containerLogs.slice(0, 500)}`);

          if (diagnostic.isSchedulingIssue || diagnostic.isResourceIssue) {
            await appendLog(jobRecord, "  ℹ️ Infrastructure/scheduling issue. Check cluster health.");
          } else {
            await appendLog(jobRecord, "  🤖 Collecting pod logs for AI diagnosis...");
            const podLogs = await collectPodLogs(deployName);

            const suspicious = detectSuspiciousActivity(podLogs);
            if (suspicious.suspicious) {
              await appendLog(jobRecord, `  🚨 SECURITY: ${suspicious.matches.join(", ")}`);
              const { deleteProjectResources } = require("../Utils/kubeClient");
              await deleteProjectResources(deployName).catch(() => {});
              throw new Error("Deployment terminated: suspicious activity.");
            }

            const runtimeDiagnosis = await diagnoseError({
              language: detection.language,
              framework: detection.framework,
              buildCommand: detection.buildCommand,
              startCommand: detection.startCommand,
              dockerfileContent: currentDockerfile,
              errorLogs: sanitizeLogLine(podLogs),
              errorPhase: "readiness",
              previousAttempts: allDiagnoses,
            });

            allDiagnoses.push(runtimeDiagnosis);
            jobRecord.aiDiagnosis = allDiagnoses;
            await jobRecord.save();
            await appendLog(jobRecord, `  🤖 Diagnosis: ${runtimeDiagnosis.diagnosis}`);
          }
          throw readyErr;
        }

        /* ── Step 12: Update dockerInfo ── */
        dockerInfo.deploymentType = "docker";
        dockerInfo.staticFilesPath = null;
        dockerInfo.image = imageTag;
        dockerInfo.status = "running";
        dockerInfo.nodeId = node.nodeName;
        dockerInfo.lastActivityAt = new Date();
        dockerInfo.deployedAt = new Date();
        await dockerInfo.save();

        /* ── Mark job done ── */
        jobRecord.status = "done";
        jobRecord.completedAt = new Date();
        await jobRecord.save();

        const urlScheme = DEPLOY_DOMAIN === "localhost" ? "http" : "https";

        if (reservedNodeId) {
          await releaseNode(reservedNodeId).catch(console.error);
        }

        await appendLog(
          jobRecord,
          `✅ Backend deployed (${execMode} mode). Live at: ${urlScheme}://${publicHost}`
        );

        return { success: true, url: `${urlScheme}://${publicHost}`, executionMode: execMode, deploymentType: "docker" };
      } // end backend pipeline
    } catch (err) {
      console.error("[deployWorker] FATAL:", err.stack);
      await appendLog(jobRecord, `❌ Error: ${sanitizeLogLine(err.message)}`);

      if (reservedNodeId) {
        await releaseNode(reservedNodeId).catch(console.error);
      }

      // Clean up temp dir on failure
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      dockerInfo.status = "failed";
      await dockerInfo.save();

      jobRecord.status = "failed";
      jobRecord.errorMessage = sanitizeLogLine(err.message);
      jobRecord.completedAt = new Date();
      await jobRecord.save();

      // ── Mark infrastructure errors as unrecoverable ──
      // BullMQ will NOT retry these (they won't self-heal).
      // Prevents: deploy → fail(CNI) → retry → fail(CNI) → log spam
      const infraPatterns = [
        "CNI is misconfigured",
        "missing loopback plugin",
        "Pre-flight cluster check failed",
        "No active, schedulable Kubernetes nodes",
        "All cluster nodes are at capacity",
        "Cannot reach Kubernetes cluster",
        "node(s) are NotReady",
        "No worker nodes available",
        "cannot be used for student projects",
      ];
      const isInfraError = infraPatterns.some((p) =>
        err.message.includes(p)
      );
      if (isInfraError) {
        await appendLog(
          jobRecord,
          "ℹ️ This is an infrastructure error (not an application issue). " +
            "Auto-retry is disabled. Fix the cluster and re-deploy manually."
        );
        // Throw UnrecoverableError to prevent BullMQ retry
        const { UnrecoverableError } = require("bullmq");
        throw new UnrecoverableError(err.message);
      }

      throw err; // allow BullMQ retry for non-infra errors
    }
  },
  {
    connection,
    concurrency: parseInt(process.env.DEPLOY_CONCURRENCY || "3"),
    limiter: { max: 5, duration: 60_000 }, // max 5 deploys/minute globally
    stalledInterval: 60_000, // check for stalled jobs every 60 seconds
    lockDuration: 300_000,   // job lock expires after 5 minutes (if worker dies)
  }
);

deployWorker.on("completed", (job) =>
  console.log(`[deployWorker] Job ${job.id} completed`)
);
deployWorker.on("failed", (job, err) =>
  console.error(`[deployWorker] Job ${job?.id} failed: ${err.message}`)
);

module.exports = deployWorker;
