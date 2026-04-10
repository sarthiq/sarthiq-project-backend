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

// ── Security modules ──────────────────────────────────────────────
const {
  spawnAsync,
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
/* Helper: build Docker image SAFELY (spawn, no shell)                 */
/* ------------------------------------------------------------------ */
async function buildDockerImage({
  imageTag,
  buildContext,
  buildTimeEnvs = {},
  timeout = 600_000,
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

  // Tag and context
  args.push("-t", imageTag, buildContext);

  // Execute via spawn (NEVER exec/shell)
  return await spawnAsync("docker", args, { timeout });
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
      await appendLog(jobRecord, "Step 1/10: Pre-flight cluster health check...");

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
      await appendLog(jobRecord, "Step 2/10: Cloning repository...");
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

      /* ── STEP 4: AI Stack Detection ───────────────────────────────── */
      await appendLog(jobRecord, "Step 3/10: 🤖 Analyzing repository with AI stack detector...");

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
        await appendLog(jobRecord, "Step 4/10: Validating AI-generated Dockerfile...");

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

        await appendLog(jobRecord, "Step 4/10: Using existing Dockerfile from repo (validated).");
      }

      // Save the Dockerfile used to deployment job
      jobRecord.generatedDockerfile = currentDockerfile;
      await jobRecord.save();

      /* ── STEP 5b: Root requirement detection ──────────────────────── */
      await appendLog(jobRecord, "Step 5/10: 🔍 Checking root requirements...");

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

      /* ── STEP 6: Build Docker image (with AI retry loop) ──────────── */
      await appendLog(jobRecord, "Step 6/10: Building Docker image...");
      const imageTag = REGISTRY
        ? `${REGISTRY}/${project.subdomain}:${Date.now()}`
        : `${project.subdomain}:${Date.now()}`;

      // Validate image tag
      validateImageTag(imageTag);

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
          });

          buildSuccess = true;
          await appendLog(jobRecord, `  → Image built: ${imageTag}`);
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

      /* ── STEP 7: Push image ───────────────────────────────────────── */
      if (REGISTRY) {
        await appendLog(jobRecord, "Step 7/10: Pushing image to registry...");
        await spawnAsync("docker", ["push", imageTag], { timeout: 300_000 });
        await appendLog(jobRecord, "  → Push complete.");
      } else {
        await appendLog(jobRecord, "Step 7/10: Local testing mode. Skipping registry push.");
      }

      /* Clean up temp dir */
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
      }

      /* ── STEP 8: Create K8s resources (with security context) ────── */
      await appendLog(jobRecord, "Step 8/10: Creating Kubernetes resources...");

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

      const publicHost = await createIngress({
        name: deployName,
        subdomain: project.subdomain,
        baseDomain: DEPLOY_DOMAIN,
      });
      await appendLog(jobRecord, `  → Ingress created: ${publicHost}`);

      /* ── STEP 9: Wait for pod ready (with diagnostics) ────────────── */
      await appendLog(jobRecord, "Step 9/10: Waiting for pod to become ready...");

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

      /* ── STEP 10: Update dockerInfo ─────────────────────────────── */
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
