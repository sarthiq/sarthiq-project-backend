/**
 * deployWorker.js
 * BullMQ Worker that handles the full deployment pipeline:
 *
 * 1. Check node capacity  → pick best node
 * 2. Build Docker image   → from project repo
 * 3. Push to registry
 * 4. Create K8s Deployment + Service + Ingress
 * 5. Wait for pod ready
 * 6. Update DB            → DockerInfo.status = 'running'
 * 7. Mark DeploymentJob  → 'done'
 *
 * Each step appends to DeploymentJob.logs so the UI can stream progress.
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

const isProd = process.env.NODE_ENV === "production";
const REGISTRY = process.env.DOCKER_REGISTRY || (isProd ? "registry.sarthiq.com" : "");
const BASE_DOMAIN = process.env.BASE_DOMAIN || (isProd ? "sarthiq.com" : "localhost");

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
/* Main worker                                                          */
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

    try {
      /* ---- Mark as building ---------------------------------------- */
      await updateStatus("building");
      jobRecord.startedAt = new Date();
      await jobRecord.save();

      /* ---- STEP 1: Node capacity check ------------------------------ */
      await appendLog(jobRecord, "Step 1/6: Checking cluster node capacity...");
      const node = await getBestNode();
      await appendLog(jobRecord, `  → Assigned to node: ${node.nodeName}`);
      await reserveNode(node.id);
      reservedNodeId = node.id;

      /* ---- STEP 2: Generate subdomain if not set -------------------- */
      if (!project.subdomain) {
        const sub = generateSubdomain(project.title, project.id);
        project.subdomain = sub;
        await project.save();
      }
      await appendLog(jobRecord, `  → Subdomain: ${project.subdomain}.${BASE_DOMAIN}`);

      /* ---- STEP 3: Clone repo + build Docker image ------------------ */
      await appendLog(jobRecord, "Step 2/6: Cloning repository...");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sarthiq-${projectId}-`));
      const cloneCmd = `git clone --branch ${project.branch} --depth 1 ${project.projectRepoUrl} ${tmpDir}`;
      await execAsync(cloneCmd, { timeout: 120_000 });
      await appendLog(jobRecord, "  → Clone complete.");

      /* ---- Build image --------------------------------------------- */
      await appendLog(jobRecord, "Step 3/6: Building Docker image...");
      const imageTag = REGISTRY ? `${REGISTRY}/${project.subdomain}:${Date.now()}` : `${project.subdomain}:${Date.now()}`;
      const buildContext = path.join(tmpDir, project.projectDirectory || ".");
      const buildCmd = `docker build -t ${imageTag} ${buildContext}`;
      await execAsync(buildCmd, { timeout: 600_000 }); // 10 min max
      await appendLog(jobRecord, `  → Image built: ${imageTag}`);

      /* ---- Push image ---------------------------------------------- */
      if (REGISTRY) {
        await appendLog(jobRecord, "Step 4/6: Pushing image to registry...");
        await execAsync(`docker push ${imageTag}`, { timeout: 300_000 });
        await appendLog(jobRecord, "  → Push complete.");
      } else {
        await appendLog(jobRecord, "Step 4/6: Local testing mode. Skipping registry push.");
      }

      /* Clean up temp dir */
      fs.rmSync(tmpDir, { recursive: true, force: true });

      /* ---- STEP 4: Parse env vars for K8s --------------------------- */
      let envVars = {};
      try {
        envVars =
          typeof project.envVariables === "string"
            ? JSON.parse(project.envVariables)
            : project.envVariables || {};
      } catch {}

      const containerPort = dockerInfo.internalPort || 3000;
      const cpuLimit = dockerInfo.cpu || "500m";
      let memLimit = dockerInfo.memory || "512Mi";
      if (memLimit.match(/^\d+m$/)) {
        // "512m" is milli-bytes in K8s (0.5 bytes!). Convert to "512Mi" (Mebibytes)
        memLimit = memLimit.replace("m", "Mi");
      }

      /* ---- STEP 5: Create K8s resources ----------------------------- */
      await appendLog(jobRecord, "Step 5/6: Creating Kubernetes resources...");

      const deployName = project.subdomain;

      await createDeployment({
        name: deployName,
        image: imageTag,
        containerPort,
        cpuLimit,
        memoryLimit: memLimit,
        cpuRequest: "100m",
        memoryRequest: "128Mi",
        envVars,
        nodeName: node.nodeName,
      });
      await appendLog(jobRecord, "  → Deployment created.");

      const svcHost = await createService({ name: deployName, containerPort });
      await appendLog(jobRecord, `  → Service created: ${svcHost}`);

      const publicHost = await createIngress({
        name: deployName,
        subdomain: project.subdomain,
        baseDomain: BASE_DOMAIN,
      });
      await appendLog(jobRecord, `  → Ingress created: ${publicHost}`);

      /* ---- STEP 6: Wait for pod ready ------------------------------- */
      await appendLog(jobRecord, "Step 6/6: Waiting for pod to become ready...");
      await waitForReady(deployName, 180_000);
      await appendLog(jobRecord, "  → Pod is running! 🚀");

      /* ---- Update dockerInfo --------------------------------------- */
      dockerInfo.image = imageTag;
      dockerInfo.status = "running";
      dockerInfo.nodeId = node.nodeName;
      dockerInfo.lastActivityAt = new Date();
      dockerInfo.deployedAt = new Date();
      await dockerInfo.save();

      /* ---- Mark job done ------------------------------------------- */
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
      await appendLog(jobRecord, `Stack: ${err.stack}`);

      if (reservedNodeId) {
        await releaseNode(reservedNodeId).catch(console.error);
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
