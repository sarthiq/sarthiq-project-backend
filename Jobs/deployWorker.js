/**
 * deployWorker.js
 * BullMQ Worker — AI-Powered Deployment Pipeline
 *
 * Pipeline Steps:
 *   1. Check node capacity  → pick best node
 *   2. Clone repo           → git clone --depth 1
 *   3. AI Stack Detection   → detect language, framework, commands, port
 *   4. Generate Dockerfile   → template-based or AI-generated
 *   5. Build Docker image   → with build-time env injection (--build-arg)
 *   6. Push to registry
 *   7. Create K8s resources → ConfigMap + Deployment + Service + Ingress
 *   8. Wait for pod ready
 *   9. Update DB            → DockerInfo.status = 'running'
 *
 * On failure, the AI Auto-Debugger kicks in:
 *   - Analyzes error logs
 *   - Generates a fixed Dockerfile / command
 *   - Retries up to MAX_AI_RETRIES times
 *
 * Each step appends to DeploymentJob.logs for real-time UI streaming.
 */
const { Worker } = require("bullmq");
const { execSync, exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const os = require("os");

const execAsync = promisify(exec);

const { connection } = require("./queues");
const DockerInfo = require("../Models/Projects/dockerInfo");
const Project = require("../Models/Projects/projects");
const DeploymentJob = require("../Models/Deployment/deploymentJob");
const {
  createDeployment,
  createService,
  createIngress,
  waitForReady,
} = require("../Utils/kubeClient");
const { getBestNode, reserveNode, releaseNode } = require("../Utils/nodeManager");
const { detectStack, classifyEnvVars } = require("../Utils/aiStackDetector");
const { diagnoseError, collectPodLogs } = require("../Utils/aiDebugger");

const isProd = process.env.NODE_ENV === "production";
const REGISTRY = process.env.DOCKER_REGISTRY || (isProd ? "registry.sarthiq.com" : "");
const BASE_DOMAIN = process.env.BASE_DOMAIN || (isProd ? "sarthiq.com" : "localhost");
const MAX_AI_RETRIES = parseInt(process.env.MAX_AI_RETRIES || "3");

/* ------------------------------------------------------------------ */
/* Helper: append a log line to the DeploymentJob record               */
/* ------------------------------------------------------------------ */
async function appendLog(jobRecord, line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
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
    .slice(0, 28);
  return `${slug}-${projectId}`;
}

/* ------------------------------------------------------------------ */
/* Helper: build Docker image with build-time env injection            */
/* ------------------------------------------------------------------ */
async function buildDockerImage({
  imageTag,
  buildContext,
  buildTimeEnvs = {},
  timeout = 600_000,
}) {
  // Construct --build-arg flags for build-time env vars
  const buildArgFlags = Object.entries(buildTimeEnvs)
    .map(([key, value]) => `--build-arg ${key}="${value}"`)
    .join(" ");

  const buildCmd = `docker build ${buildArgFlags} -t ${imageTag} ${buildContext}`;
  const result = await execAsync(buildCmd, {
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10MB stdout/stderr
  });
  return result;
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
      /* ---- Mark as building ---------------------------------------- */
      await updateStatus("building");
      jobRecord.startedAt = new Date();
      await jobRecord.save();

      /* ── STEP 1: Node capacity check ──────────────────────────────── */
      await appendLog(jobRecord, "Step 1/8: Checking cluster node capacity...");
      const node = await getBestNode();
      await appendLog(jobRecord, `  → Assigned to node: ${node.nodeName}`);
      await reserveNode(node.id);
      reservedNodeId = node.id;

      /* ── STEP 2: Generate subdomain if not set ────────────────────── */
      if (!project.subdomain) {
        const sub = generateSubdomain(project.title, project.id);
        project.subdomain = sub;
        await project.save();
      }
      await appendLog(jobRecord, `  → Subdomain: ${project.subdomain}.${BASE_DOMAIN}`);

      /* ── STEP 3: Clone repository ─────────────────────────────────── */
      await appendLog(jobRecord, "Step 2/8: Cloning repository...");
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sarthiq-${projectId}-`));
      const cloneCmd = `git clone --branch ${project.branch} --depth 1 ${project.projectRepoUrl} ${tmpDir}`;
      await execAsync(cloneCmd, { timeout: 120_000 });
      await appendLog(jobRecord, "  → Clone complete.");

      const buildContext = path.join(tmpDir, project.projectDirectory || ".");

      /* ── STEP 4: AI Stack Detection ───────────────────────────────── */
      await appendLog(jobRecord, "Step 3/8: 🤖 Analyzing repository with AI stack detector...");

      // Parse env vars
      let envVars = {};
      try {
        envVars =
          typeof project.envVariables === "string"
            ? JSON.parse(project.envVariables)
            : project.envVariables || {};
      } catch {}

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

      /* ── STEP 5: Write Dockerfile ─────────────────────────────────── */
      const dockerfilePath = path.join(buildContext, "Dockerfile");
      let currentDockerfile = detection.dockerfile;

      if (!fs.existsSync(dockerfilePath)) {
        await appendLog(jobRecord, "Step 4/8: Writing AI-generated Dockerfile...");
        fs.writeFileSync(dockerfilePath, currentDockerfile);
        await appendLog(jobRecord, `  → Dockerfile generated for ${detection.language}/${detection.framework}`);
      } else {
        currentDockerfile = fs.readFileSync(dockerfilePath, "utf-8");
        await appendLog(jobRecord, "Step 4/8: Using existing Dockerfile from repo.");
      }

      // Save the Dockerfile used to deployment job
      jobRecord.generatedDockerfile = currentDockerfile;
      await jobRecord.save();

      /* ── STEP 6: Build Docker image (with AI retry loop) ──────────── */
      await appendLog(jobRecord, "Step 5/8: Building Docker image...");
      const imageTag = REGISTRY
        ? `${REGISTRY}/${project.subdomain}:${Date.now()}`
        : `${project.subdomain}:${Date.now()}`;

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
          await appendLog(
            jobRecord,
            `  ❌ Build failed (attempt ${retryCount + 1}): ${buildErr.message.slice(0, 200)}`
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
            errorLogs,
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

          // Apply fix
          if (diagnosis.fixedDockerfile) {
            currentDockerfile = diagnosis.fixedDockerfile;
            fs.writeFileSync(dockerfilePath, currentDockerfile);
            await appendLog(jobRecord, "  🤖 Applied fixed Dockerfile.");
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
        await appendLog(jobRecord, "Step 6/8: Pushing image to registry...");
        await execAsync(`docker push ${imageTag}`, { timeout: 300_000 });
        await appendLog(jobRecord, "  → Push complete.");
      } else {
        await appendLog(jobRecord, "Step 6/8: Local testing mode. Skipping registry push.");
      }

      /* Clean up temp dir */
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
      }

      /* ── STEP 8: Create K8s resources ─────────────────────────────── */
      await appendLog(jobRecord, "Step 7/8: Creating Kubernetes resources...");

      const cpuLimit = dockerInfo.cpu || "500m";
      let memLimit = dockerInfo.memory || "512Mi";
      if (memLimit.match(/^\d+m$/)) {
        memLimit = memLimit.replace("m", "Mi");
      }

      const deployName = project.subdomain;

      // Use ConfigMap for runtime env vars (cleaner than inline env arrays)
      await createDeployment({
        name: deployName,
        image: imageTag,
        containerPort,
        cpuLimit,
        memoryLimit: memLimit,
        cpuRequest: "100m",
        memoryRequest: "128Mi",
        envVars: detection.runtimeEnvs, // Only runtime vars go to K8s
        nodeName: node.nodeName,
        useConfigMap: true, // ← NEW: use ConfigMap instead of inline env
      });
      await appendLog(jobRecord, "  → Deployment + ConfigMap created.");

      const svcHost = await createService({ name: deployName, containerPort });
      await appendLog(jobRecord, `  → Service created: ${svcHost}`);

      const publicHost = await createIngress({
        name: deployName,
        subdomain: project.subdomain,
        baseDomain: BASE_DOMAIN,
      });
      await appendLog(jobRecord, `  → Ingress created: ${publicHost}`);

      /* ── STEP 9: Wait for pod ready ───────────────────────────────── */
      await appendLog(jobRecord, "Step 8/8: Waiting for pod to become ready...");

      try {
        await waitForReady(deployName, 180_000);
        await appendLog(jobRecord, "  → Pod is running! 🚀");
      } catch (readyErr) {
        // Pod failed to become ready — try AI debugging on runtime error
        await appendLog(jobRecord, `  ⚠ Pod not ready: ${readyErr.message}`);
        await appendLog(jobRecord, "  🤖 Collecting pod logs for AI diagnosis...");

        const podLogs = await collectPodLogs(deployName);
        const runtimeDiagnosis = await diagnoseError({
          language: detection.language,
          framework: detection.framework,
          buildCommand: detection.buildCommand,
          startCommand: detection.startCommand,
          dockerfileContent: currentDockerfile,
          errorLogs: podLogs,
          errorPhase: "readiness",
          previousAttempts: allDiagnoses,
        });

        allDiagnoses.push(runtimeDiagnosis);
        jobRecord.aiDiagnosis = allDiagnoses;
        await jobRecord.save();

        await appendLog(jobRecord, `  🤖 Runtime diagnosis: ${runtimeDiagnosis.diagnosis}`);

        // For runtime errors, we don't auto-retry (would need full rebuild).
        // Save the diagnosis for the user to act on.
        throw readyErr;
      }

      /* ── Update dockerInfo ──────────────────────────────────────── */
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

      await appendLog(
        jobRecord,
        `✅ Deployment complete. Live at: https://${publicHost}`
      );

      return { success: true, url: `https://${publicHost}` };
    } catch (err) {
      console.error("[deployWorker] FATAL:", err.stack);
      await appendLog(jobRecord, `❌ Error: ${err.message}`);

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
      jobRecord.errorMessage = err.message;
      jobRecord.completedAt = new Date();
      await jobRecord.save();

      throw err; // allow BullMQ retry
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
