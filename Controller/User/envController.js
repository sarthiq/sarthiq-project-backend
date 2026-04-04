/**
 * envController.js
 * ─────────────────────────────────────────────────────────────────────
 * REST API controller for environment variable management.
 * Stores encrypted values, syncs with K8s ConfigMaps/Secrets,
 * and supports rolling restarts.
 * ─────────────────────────────────────────────────────────────────────
 */
const EnvironmentVariable = require("../../Models/Services/environmentVariable");
const Project = require("../../Models/Projects/projects");
const { encrypt, decrypt } = require("../../Utils/credentialManager");
const { createOrUpdateConfigMap, safeLabel, NAMESPACE } = require("../../Utils/kubeClient");

const k8s = require("@kubernetes/client-node");
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

/* ── POST /api/env/set ─────────────────────────────────────────────── */
exports.setEnvVars = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId, variables } = req.body;

    if (!projectId || !variables || typeof variables !== "object") {
      return res.status(400).json({
        success: false,
        message: "projectId and variables (object) are required",
      });
    }

    // Verify project
    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    const results = [];
    for (const [key, value] of Object.entries(variables)) {
      // Validate key format
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        results.push({ key, status: "skipped", reason: "Invalid key format" });
        continue;
      }

      const encryptedValue = encrypt(String(value));

      await EnvironmentVariable.upsert({
        ProjectId: projectId,
        key,
        value: encryptedValue,
        isAutoInjected: false,
      });

      results.push({ key, status: "set" });
    }

    return res.json({
      success: true,
      message: `${results.filter((r) => r.status === "set").length} variable(s) set`,
      data: results,
    });
  } catch (err) {
    console.error("[envController] setEnvVars error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to set environment variables",
      error: err.message,
    });
  }
};

/* ── GET /api/env/:projectId ───────────────────────────────────────── */
exports.getEnvVars = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId } = req.params;

    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    const envVars = await EnvironmentVariable.findAll({
      where: { ProjectId: projectId },
      order: [["key", "ASC"]],
    });

    const data = envVars.map((env) => {
      let decryptedValue;
      try {
        decryptedValue = decrypt(env.value);
      } catch {
        decryptedValue = "[decryption error]";
      }

      return {
        id: env.id,
        key: env.key,
        value: decryptedValue,
        isAutoInjected: env.isAutoInjected,
        sourceServiceInstanceId: env.sourceServiceInstanceId,
        updatedAt: env.updatedAt,
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[envController] getEnvVars error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to get environment variables",
      error: err.message,
    });
  }
};

/* ── DELETE /api/env/:projectId/:key ───────────────────────────────── */
exports.deleteEnvVar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId, key } = req.params;

    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    const deleted = await EnvironmentVariable.destroy({
      where: { ProjectId: projectId, key },
    });

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: `Environment variable "${key}" not found`,
      });
    }

    return res.json({
      success: true,
      message: `Environment variable "${key}" deleted`,
    });
  } catch (err) {
    console.error("[envController] deleteEnvVar error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to delete environment variable",
      error: err.message,
    });
  }
};

/* ── POST /api/env/:projectId/sync ─────────────────────────────────── */
exports.syncEnvVars = async (req, res) => {
  try {
    const userId = req.user.id;
    const { projectId } = req.params;

    const project = await Project.findOne({
      where: { id: projectId, UserId: userId },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: "Project not found or access denied",
      });
    }

    // Collect all env vars for this project
    const envVars = await EnvironmentVariable.findAll({
      where: { ProjectId: projectId },
    });

    const envMap = {};
    for (const env of envVars) {
      try {
        envMap[env.key] = decrypt(env.value);
      } catch {
        envMap[env.key] = "";
      }
    }

    // Also include the original project envVariables (legacy support)
    if (project.envVariables) {
      const legacy =
        typeof project.envVariables === "string"
          ? JSON.parse(project.envVariables)
          : project.envVariables;
      for (const [k, v] of Object.entries(legacy)) {
        if (!envMap[k]) envMap[k] = String(v); // Don't overwrite managed vars
      }
    }

    // Sync to K8s ConfigMap
    if (project.subdomain) {
      const label = safeLabel(project.subdomain);
      await createOrUpdateConfigMap({
        name: label,
        envVars: envMap,
      });

      // Trigger rolling restart by patching the deployment annotation
      try {
        const patch = [
          {
            op: "replace",
            path: "/spec/template/metadata/annotations",
            value: { "sarthiq.com/restartedAt": new Date().toISOString() },
          },
        ];
        await appsV1.patchNamespacedDeployment(
          { name: label, namespace: NAMESPACE, body: patch },
          undefined, undefined, undefined, undefined, undefined, undefined,
          { headers: { "Content-Type": "application/json-patch+json" } }
        );
      } catch (patchErr) {
        // Non-fatal — deployment might not exist yet
        console.warn("[envController] Rolling restart patch failed:", patchErr.message);
      }
    }

    return res.json({
      success: true,
      message: `Synced ${Object.keys(envMap).length} variables to Kubernetes`,
      syncedCount: Object.keys(envMap).length,
    });
  } catch (err) {
    console.error("[envController] syncEnvVars error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to sync environment variables",
      error: err.message,
    });
  }
};
