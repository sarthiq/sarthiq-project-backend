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
/* Helper: build Docker image with BuildKit + caching (OPTIMIZED)       */
/* ------------------------------------------------------------------ */
async function buildDockerImage({
  imageTag,
  buildContext,
  buildTimeEnvs = {},
  timeout = 600_000,
  subdomain = "",
  onProgress = null,
}) {
  // Validate image tag
  validateImageTag(imageTag);

  // Validate env var keys
  validateEnvVars(buildTimeEnvs);

  // Build argument array (NO shell interpolation)
  const args = ["build"];

  // Add build-args safely
  for (const [key, value] of Object.entries(buildTimeEnvs)) {
    args.push("--build-arg", `${key}=${value}`);
  }

  // ── BuildKit cache strategy (dual-mode) ──────────────────────────
  if (REGISTRY) {
    // PRODUCTION: Use registry-based caching
    const cacheRef = `${REGISTRY}/${subdomain || "sarthiq"}:cache`;
    args.push("--cache-from", `type=registry,ref=${cacheRef}`);
    args.push("--cache-to", `type=registry,ref=${cacheRef},mode=max`);
  } else {
    // LOCAL (minikube/dev): Use local directory-based caching
    // IMPORTANT: --cache-from and --cache-to MUST use SEPARATE directories.
    // Using the same dir causes corruption because BuildKit clears dest before writing.
    const cacheBase = path.join(CACHE_DIR, subdomain || "default");
    const cacheSrc = path.join(cacheBase, "current");
    const cacheDest = path.join(cacheBase, "new");

    // Ensure directories exist
    fs.mkdirSync(cacheSrc, { recursive: true });
    fs.mkdirSync(cacheDest, { recursive: true });

    // Only add --cache-from if cache dir has actual content (index.json exists)
    const cacheIndexPath = path.join(cacheSrc, "index.json");
    if (fs.existsSync(cacheIndexPath)) {
      args.push("--cache-from", `type=local,src=${cacheSrc}`);
    }
    // Always write new cache
    args.push("--cache-to", `type=local,dest=${cacheDest},mode=max`);

    // After build completes, swap: move 'new' → 'current' for next build
    // We do this via a post-build hook (caller handles it after success)
    // Store for the caller to swap after successful build
    buildDockerImage._pendingCacheSwap = { src: cacheDest, dest: cacheSrc };
  }

  // Tag and context
  args.push("-t", imageTag, buildContext);

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

        // NOTE: For monorepo deployments, the user selects which service(s)
        // to deploy via the projectDirectory field. The monorepo info is
        // stored for the frontend to display service selection UI.
        // Individual service deployment uses the existing single-app pipeline.
      } else {
        await appendLog(jobRecord, "  → Single-app project (not a monorepo)");
      }

      /* ── STEP 5: AI Stack Detection ───────────────────────────────── */
      await appendLog(jobRecord, "Step 5/12: 🤖 Analyzing repository with AI stack detector...");

      // User overrides (user-provided values take priority over AI)
      const userOverrides = {};
      if (project.buildCommand) userOverrides.buildCommand = project.buildCommand;
      if (project.buildDirectory) userOverrides.buildDirectory = project.buildDirectory;

      // Run AI stack detection
      const detection = await detectStack(buildContext, envVars, userOverrides);

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

      // Update dockerInfo port
      const containerPort = detection.port || dockerInfo.internalPort || 3000;
      dockerInfo.internalPort = containerPort;
      await dockerInfo.save();

      /* ── STEP 5: Dockerfile validation & root detection ───────────── */
      const dockerfilePath = path.join(buildContext, "Dockerfile");
      let currentDockerfile = detection.dockerfile;

      if (!fs.existsSync(dockerfilePath)) {
        await appendLog(jobRecord, "Step 6/12: Validating AI-generated Dockerfile...");

        // VALIDATE Dockerfile content before writing
        const validation = validateDockerfile(currentDockerfile);
        if (!validation.safe) {
          await appendLog(
            jobRecord,
            `  ⚠ Dockerfile blocked: ${validation.violations.join("; ")}`
          );
          throw new Error(
            `Generated Dockerfile contains blocked patterns: ${validation.violations[0]}`
          );
        }

        fs.writeFileSync(dockerfilePath, currentDockerfile);
        await appendLog(jobRecord, `  → Dockerfile generated for ${detection.language}/${detection.framework}`);
      } else {
        currentDockerfile = fs.readFileSync(dockerfilePath, "utf-8");

        // Validate existing Dockerfile too
        const validation = validateDockerfile(currentDockerfile);
        if (!validation.safe) {
          await appendLog(
            jobRecord,
            `  ⚠ Existing Dockerfile contains blocked patterns: ${validation.violations.join("; ")}`
          );
          throw new Error(
            `Repository Dockerfile contains dangerous instructions: ${validation.violations[0]}`
          );
        }

        await appendLog(jobRecord, "Step 6/12: Using existing Dockerfile from repo (validated).");
      }

      // Save the Dockerfile used to deployment job
      jobRecord.generatedDockerfile = currentDockerfile;
      await jobRecord.save();

      /* ── STEP 5b: Root requirement detection ──────────────────────── */
      await appendLog(jobRecord, "Step 7/12: 🔍 Checking root requirements...");

      const rootDetection = detectRootRequirements({
        dockerfileContent: currentDockerfile,
        port: containerPort,
        buildContext,
        isStaticSite: detection.isStaticSite,
      });

      const executionDecision = resolveExecutionMode(rootDetection, {
        userConsentsToSandbox: project.sandboxMode === true, // user must opt-in
      });

      if (executionDecision.mode === "requires_consent") {
        // User hasn't opted in — save detection results and fail gracefully
        await appendLog(
          jobRecord,
          `  ⚠ Project requires root access: ${rootDetection.reasons.join("; ")}`
        );
        await appendLog(
          jobRecord,
          "  ℹ️ User must enable sandbox mode or fix the project for non-root execution."
        );

        // Try auto-patching if possible
        if (rootDetection.canAutoFix) {
          await appendLog(jobRecord, "  🔧 Attempting auto-patch for non-root compatibility...");
          const { patched, applied } = autoPatchDockerfile(currentDockerfile, containerPort);
          if (applied.length > 0) {
            currentDockerfile = patched;
            fs.writeFileSync(dockerfilePath, currentDockerfile);
            await appendLog(jobRecord, `  → Auto-patched: ${applied.join("; ")}`);

            // Re-check after patching
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

        // If still requires consent after auto-fix attempt
        if (executionDecision.mode === "requires_consent") {
          throw new Error(
            "Project requires root access. Enable sandbox mode in project settings or fix for non-root execution. " +
            `Reasons: ${rootDetection.reasons.join("; ")}`
          );
        }
      }

      const execMode = executionDecision.mode;
      const securityConfig = executionDecision.config;

      await appendLog(
        jobRecord,
        `  → Execution mode: ${execMode.toUpperCase()} ${execMode === "sandbox" ? "🔒 (root in isolated sandbox)" : "🟢 (non-root, hardened)"}`
      );

      if (executionDecision.warning) {
        await appendLog(jobRecord, `  → ${executionDecision.warning}`);
      }

      /* ── STEP 7: Build Docker image (with BuildKit + AI retry loop) ── */
      await appendLog(jobRecord, "Step 8/12: 🔨 Building Docker image (BuildKit enabled)...");

      // Smart image tagging: dependency-hash + timestamp for cache reuse
      const depHash = contextOptimization.dependencyHash || Date.now();
      const timestamp = Date.now();
      const imageTag = REGISTRY
        ? `${REGISTRY}/${project.subdomain}:${depHash}-${timestamp}`
        : `${project.subdomain}:${depHash}-${timestamp}`;

      // Validate image tag
      validateImageTag(imageTag);

      const buildStartTime = Date.now();
      let buildSuccess = false;
      let retryCount = 0;
      const allDiagnoses = [];

      while (!buildSuccess && retryCount <= MAX_AI_RETRIES) {
        try {
          if (retryCount > 0) {
            await appendLog(
              jobRecord,
              `  🔄 AI Retry ${retryCount}/${MAX_AI_RETRIES}: Rebuilding with fixes...`
            );
          }

          await buildDockerImage({
            imageTag,
            buildContext,
            buildTimeEnvs: detection.buildTimeEnvs,
            subdomain: project.subdomain,
            onProgress: (line) => {
              // Log significant build progress lines (skip empty/noise)
              if (line && line.trim() && !line.includes("#")) {
                console.log(`[build:${project.subdomain}] ${line.trim().slice(0, 200)}`);
              }
            },
          });

          buildSuccess = true;
          const buildDurationMs = Date.now() - buildStartTime;
          const imageSizeMB = await getImageSizeMB(imageTag);

          // Swap cache directories: 'new' → 'current' for next build
          if (buildDockerImage._pendingCacheSwap) {
            const { src, dest } = buildDockerImage._pendingCacheSwap;
            try {
              // Clear old 'current' cache
              fs.rmSync(dest, { recursive: true, force: true });
              // Rename 'new' → 'current'
              fs.renameSync(src, dest);
              jobRecord.cacheHit = false; // first successful write = miss
            } catch (swapErr) {
              console.warn(`[deployWorker] Cache swap failed (non-fatal): ${swapErr.message}`);
            }
            buildDockerImage._pendingCacheSwap = null;
          }

          jobRecord.buildDurationMs = buildDurationMs;
          jobRecord.imageSizeMB = imageSizeMB;
          await jobRecord.save();

          await appendLog(jobRecord, `  → Image built: ${imageTag}`);
          await appendLog(jobRecord, `  → Build time: ${(buildDurationMs / 1000).toFixed(1)}s | Image size: ${imageSizeMB ? imageSizeMB + " MB" : "unknown"}`);
        } catch (buildErr) {
          const errorLogs = (buildErr.stderr || "") + "\n" + (buildErr.stdout || "") + "\n" + buildErr.message;

          // Check for suspicious activity in build output
          const suspicious = detectSuspiciousActivity(errorLogs);
          if (suspicious.suspicious) {
            await appendLog(
              jobRecord,
              `  🚨 SECURITY: Suspicious activity detected in build output: ${suspicious.matches.join(", ")}`
            );
            throw new Error("Build terminated: suspicious activity detected.");
          }

          await appendLog(
            jobRecord,
            `  ❌ Build failed (attempt ${retryCount + 1}): ${sanitizeLogLine(buildErr.message.slice(0, 200))}`
          );

          // Check if we can retry
          if (retryCount >= MAX_AI_RETRIES) {
            await appendLog(jobRecord, `  ❌ Max retries (${MAX_AI_RETRIES}) exhausted. Marking as failed.`);
            throw buildErr;
          }

          // 🤖 AI Auto-Debug
          await appendLog(jobRecord, "  🤖 Calling AI debugger for diagnosis...");
          const diagnosis = await diagnoseError({
            language: detection.language,
            framework: detection.framework,
            buildCommand: detection.buildCommand,
            startCommand: detection.startCommand,
            dockerfileContent: currentDockerfile,
            errorLogs: sanitizeLogLine(errorLogs), // sanitize before sending to AI
            errorPhase: "build",
            previousAttempts: allDiagnoses,
          });

          allDiagnoses.push(diagnosis);
          await appendLog(jobRecord, `  🤖 Diagnosis: ${diagnosis.diagnosis}`);
          await appendLog(jobRecord, `  🤖 Category: ${diagnosis.errorCategory} | Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%`);

          if (!diagnosis.shouldRetry) {
            await appendLog(jobRecord, "  🤖 AI says this is not auto-fixable. Marking as failed.");
            jobRecord.aiDiagnosis = allDiagnoses;
            jobRecord.retryCount = retryCount;
            await jobRecord.save();
            throw new Error(`Build failed: ${diagnosis.diagnosis}`);
          }

          // Apply fix (with validation!)
          if (diagnosis.fixedDockerfile) {
            // VALIDATE the AI-suggested Dockerfile
            const fixValidation = validateDockerfile(diagnosis.fixedDockerfile);
            if (fixValidation.safe) {
              currentDockerfile = diagnosis.fixedDockerfile;
              fs.writeFileSync(dockerfilePath, currentDockerfile);
              await appendLog(jobRecord, "  🤖 Applied AI-fixed Dockerfile (validated).");
            } else {
              await appendLog(
                jobRecord,
                `  ⚠ AI-suggested Dockerfile REJECTED: ${fixValidation.violations.join("; ")}`
              );
            }
          }

          retryCount++;
        }
      }

      // Save AI diagnosis history
      jobRecord.aiDiagnosis = allDiagnoses.length > 0 ? allDiagnoses : null;
      jobRecord.retryCount = retryCount;
      await jobRecord.save();

      /* ── STEP 9: Push image (with BuildKit --- cache already exported) ─ */
      if (REGISTRY) {
        await appendLog(jobRecord, "Step 9/12: 🚀 Pushing image to registry...");
        // BuildKit cache is already exported during build via --cache-to.
        // We only need to push the main image tag.
        const pushStartTime = Date.now();
        await spawnAsync("docker", ["push", imageTag], {
          timeout: 600_000,
          env: { ...process.env, DOCKER_BUILDKIT: "1" },
        });
        const pushDuration = ((Date.now() - pushStartTime) / 1000).toFixed(1);
        await appendLog(jobRecord, `  → Push complete (${pushDuration}s).`);
      } else {
        await appendLog(jobRecord, "Step 9/12: Local testing mode. Skipping registry push.");
      }

      /* Clean up temp dir */
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
      }

      /* ── STEP 10: Create K8s resources (with security context) ───── */
      await appendLog(jobRecord, "Step 10/12: Creating Kubernetes resources...");

      const cpuLimit = dockerInfo.cpu || securityConfig.maxCpu || "500m";
      let memLimit = dockerInfo.memory || securityConfig.maxMemory || "512Mi";
      if (memLimit.match(/^\d+m$/)) {
        memLimit = memLimit.replace("m", "Mi");
      }

      const deployName = project.subdomain;

      await createDeployment({
        name: deployName,
        image: imageTag,
        containerPort,
        cpuLimit,
        memoryLimit: memLimit,
        cpuRequest: "100m",
        memoryRequest: "128Mi",
        envVars: detection.runtimeEnvs,
        // ── nodeName is for DB tracking only — NOT used for K8s nodeSelector ──
        nodeName: node.nodeName,
        useConfigMap: true,
        // ── Security configuration ──
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
        // ── NEW: pass single-node flag for control-plane toleration ──
        isSingleNodeCluster: isSingleNode,
      });
      await appendLog(jobRecord, `  → Deployment + ConfigMap created (mode: ${execMode}).`);

      // Apply network policy
      if (securityConfig.networkPolicy) {
        try {
          await createOrUpdateNetworkPolicy(securityConfig.networkPolicy);
          await appendLog(jobRecord, "  → NetworkPolicy applied.");
        } catch (npErr) {
          // Non-fatal — NetworkPolicy requires a CNI that supports it
          await appendLog(jobRecord, `  ⚠ NetworkPolicy could not be applied: ${npErr.message}`);
        }
      }

      const svcHost = await createService({ name: deployName, containerPort });
      await appendLog(jobRecord, `  → Service created: ${svcHost}`);

      // Ingress creation is non-fatal: the platform routes traffic via
      // system Nginx → sleepProxy → ClusterIP, not through K8s Ingress.
      let publicHost = `${project.subdomain}.${DEPLOY_DOMAIN}`;
      try {
        publicHost = await createIngress({
          name: deployName,
          subdomain: project.subdomain,
          baseDomain: DEPLOY_DOMAIN,
        });
        await appendLog(jobRecord, `  → Ingress created: ${publicHost}`);
      } catch (ingressErr) {
        await appendLog(jobRecord, `  ⚠ Ingress creation skipped (non-fatal): ${ingressErr.message?.slice(0, 150)}`);
        console.warn(`[deployWorker] Ingress creation failed for ${deployName}: ${ingressErr.message?.slice(0, 200)}`);
      }

      /* ── STEP 11: Wait for pod ready (with diagnostics) ───────────── */
      await appendLog(jobRecord, "Step 11/12: Waiting for pod to become ready...");

      try {
        await waitForReady(deployName, 180_000);
        await appendLog(jobRecord, "  → Pod is running! 🚀");
      } catch (readyErr) {
        // Pod failed to become ready — extract diagnostic details
        const diagnostic = readyErr.diagnostic || {};
        await appendLog(jobRecord, `  ⚠ Pod not ready: ${readyErr.message.slice(0, 300)}`);

        // Log diagnostic details
        if (diagnostic.phase) {
          await appendLog(jobRecord, `  → Pod phase: ${diagnostic.phase}`);
        }
        if (diagnostic.events && diagnostic.events.length > 0) {
          await appendLog(jobRecord, `  → Pod events:\n${diagnostic.events.join("\n")}`);
        }
        if (diagnostic.containerLogs) {
          await appendLog(
            jobRecord,
            `  → Container logs (last lines):\n${diagnostic.containerLogs.slice(0, 500)}`
          );
        }

        // Only run AI diagnosis for app-level issues, not scheduling/infra issues
        if (diagnostic.isSchedulingIssue || diagnostic.isResourceIssue) {
          await appendLog(
            jobRecord,
            "  ℹ️ This is an infrastructure/scheduling issue, not an application error. " +
              "Check cluster node health and resource availability."
          );
        } else {
          // App crash or image issue — AI can potentially help
          await appendLog(jobRecord, "  🤖 Collecting pod logs for AI diagnosis...");

          const podLogs = await collectPodLogs(deployName);

          // Check for suspicious activity in pod logs
          const suspicious = detectSuspiciousActivity(podLogs);
          if (suspicious.suspicious) {
            await appendLog(
              jobRecord,
              `  🚨 SECURITY: Suspicious activity in pod: ${suspicious.matches.join(", ")}. Terminating.`
            );
            // Force delete deployment
            const { deleteProjectResources } = require("../Utils/kubeClient");
            await deleteProjectResources(deployName).catch(() => {});
            throw new Error("Deployment terminated: suspicious activity detected in container.");
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

          await appendLog(jobRecord, `  🤖 Runtime diagnosis: ${runtimeDiagnosis.diagnosis}`);
        }

        throw readyErr;
      }

      /* ── STEP 12: Update dockerInfo ─────────────────────────────── */
      dockerInfo.image = imageTag;
      dockerInfo.status = "running";
      dockerInfo.nodeId = node.nodeName;
      dockerInfo.lastActivityAt = new Date();
      dockerInfo.deployedAt = new Date();
      await dockerInfo.save();

      /* ── Mark job done ───────────────────────────────────────────── */
      jobRecord.status = "done";
      jobRecord.completedAt = new Date();
      await jobRecord.save();

      const urlScheme = DEPLOY_DOMAIN === "localhost" ? "http" : "https";

      // Release optimistic lock. Actual usage is handled by K8s and syncNodeMetrics.
      if (reservedNodeId) {
        await releaseNode(reservedNodeId).catch(console.error);
      }

      await appendLog(
        jobRecord,
        `✅ Deployment complete (${execMode} mode). Live at: ${urlScheme}://${publicHost}`
      );

      return { success: true, url: `${urlScheme}://${publicHost}`, executionMode: execMode };
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
  }
);

deployWorker.on("completed", (job) =>
  console.log(`[deployWorker] Job ${job.id} completed`)
);
deployWorker.on("failed", (job, err) =>
  console.error(`[deployWorker] Job ${job?.id} failed: ${err.message}`)
);

module.exports = deployWorker;
