/**
 * aiDebugger.js
 * AI-powered build/deploy error diagnosis and auto-fix.
 *
 * Used by deployWorker when a build or pod fails.
 * Sends error logs + context to OpenAI GPT-4o-mini and receives:
 *   1. A human-readable diagnosis
 *   2. A corrected Dockerfile (if applicable)
 *   3. Fixed commands / port / env suggestions
 *   4. A shouldRetry flag
 */
const OpenAI = require("openai");
const { validateDockerfile, sanitizeLogLine } = require("./securityValidator");

// Lazy-init: OpenAI client created on first use (dotenv may not have run yet)
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MAX_LOG_CHARS = 8000; // Truncate logs to stay within token limits

/**
 * Diagnose a deployment failure using AI.
 *
 * @param {Object} params
 * @param {string} params.language          – e.g. "node", "python"
 * @param {string} params.framework         – e.g. "nextjs", "fastapi"
 * @param {string} params.buildCommand      – the build command that was used
 * @param {string} params.startCommand      – the start command
 * @param {string} params.dockerfileContent – the Dockerfile that was used
 * @param {string} params.errorLogs         – stderr/stdout from the failed step
 * @param {string} params.errorPhase        – "build" | "push" | "runtime" | "readiness"
 * @param {Array}  params.previousAttempts  – array of prior diagnosis objects
 *
 * @returns {Promise<DebugResult>}
 *
 * DebugResult = {
 *   diagnosis: string,
 *   errorCategory: "build_error" | "runtime_error" | "dependency_error" |
 *                  "env_missing" | "port_mismatch" | "memory_limit" | "unknown",
 *   fixedDockerfile: string | null,
 *   fixedBuildCommand: string | null,
 *   fixedStartCommand: string | null,
 *   fixedPort: number | null,
 *   missingEnvVars: string[],
 *   confidence: number,
 *   shouldRetry: boolean,
 * }
 */
async function diagnoseError({
  language,
  framework,
  buildCommand,
  startCommand,
  dockerfileContent,
  errorLogs,
  errorPhase = "build",
  previousAttempts = [],
}) {
  // Truncate logs to avoid token explosion
  const truncatedLogs =
    errorLogs.length > MAX_LOG_CHARS
      ? "...(truncated)...\n" + errorLogs.slice(-MAX_LOG_CHARS)
      : errorLogs;

  // Security: sanitize logs before sending to AI (strip secrets)
  const sanitizedLogs = sanitizeLogLine(truncatedLogs);

  const previousAttemptsText =
    previousAttempts.length > 0
      ? previousAttempts
          .map(
            (a, i) =>
              `### Attempt ${i + 1}\nDiagnosis: ${a.diagnosis}\nCategory: ${a.errorCategory}\nFix applied: ${a.fixedDockerfile ? "Dockerfile modified" : "None"}`
          )
          .join("\n\n")
      : "None — this is the first attempt.";

  const prompt = `You are a cloud deployment debugging expert. A deployment has failed during the "${errorPhase}" phase.
Analyze the error and provide a fix.

## SECURITY RULES (MANDATORY — DO NOT VIOLATE):
- NEVER include 'curl | bash', 'wget | sh', or any pipe-to-shell patterns
- NEVER use '--privileged' flag
- NEVER mount /var/run/docker.sock
- NEVER include 'nsenter', 'mount /proc', or host namespace access
- Fixed Dockerfiles MUST use official base images only
- NEVER include secrets, API keys, or credentials in output

## Project Info:
- Language: ${language || "unknown"}
- Framework: ${framework || "unknown"}
- Build Command: ${buildCommand || "none"}
- Start Command: ${startCommand || "none"}

## Current Dockerfile:
\`\`\`dockerfile
${dockerfileContent || "Not available"}
\`\`\`

## Error Logs (last lines):
\`\`\`
${sanitizedLogs}
\`\`\`

## Previous Fix Attempts:
${previousAttemptsText}

## Respond with ONLY valid JSON, no markdown fences:
{
  "diagnosis": "Human-readable explanation of what went wrong",
  "errorCategory": "build_error" | "runtime_error" | "dependency_error" | "env_missing" | "port_mismatch" | "memory_limit" | "unknown",
  "fixedDockerfile": "...corrected full Dockerfile content if Dockerfile needs change, otherwise null...",
  "fixedBuildCommand": "...corrected build command if needed, otherwise null...",
  "fixedStartCommand": "...corrected start command if needed, otherwise null...",
  "fixedPort": null,
  "missingEnvVars": [],
  "confidence": 0.85,
  "shouldRetry": true
}`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.15,
      max_tokens: 3000,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    const result_raw = JSON.parse(raw);

    // Validate required fields
    const result = {
      diagnosis: result_raw.diagnosis || "Unable to determine the cause.",
      errorCategory: result_raw.errorCategory || "unknown",
      fixedDockerfile: result_raw.fixedDockerfile || null,
      fixedBuildCommand: result_raw.fixedBuildCommand || null,
      fixedStartCommand: result_raw.fixedStartCommand || null,
      fixedPort: result_raw.fixedPort || null,
      missingEnvVars: result_raw.missingEnvVars || [],
      confidence:
        typeof result_raw.confidence === "number" ? result_raw.confidence : 0.5,
      shouldRetry:
        typeof result_raw.shouldRetry === "boolean" ? result_raw.shouldRetry : false,
    };

    // Security: Validate AI-returned fixedDockerfile
    if (result.fixedDockerfile) {
      const validation = validateDockerfile(result.fixedDockerfile);
      if (!validation.safe) {
        console.warn(
          `[aiDebugger] AI fixedDockerfile REJECTED: ${validation.violations.join("; ")}`
        );
        result.fixedDockerfile = null; // Discard unsafe suggestion
      }
    }

    return result;
  } catch (err) {
    console.error("[aiDebugger] OpenAI call failed:", err.message);

    // Return a safe non-retryable result when AI is unreachable. Do not leak err.message as it may contain API keys.
    return {
      diagnosis: "AI debugger is currently unavailable (API authentication or network error). Manual inspection of logs required.",
      errorCategory: "unknown",
      fixedDockerfile: null,
      fixedBuildCommand: null,
      fixedStartCommand: null,
      fixedPort: null,
      missingEnvVars: [],
      confidence: 0,
      shouldRetry: false,
    };
  }
}

/**
 * Collect pod error logs from Kubernetes.
 * Used when a pod fails readiness checks or enters CrashLoopBackOff.
 *
 * Reuses the shared K8s client from kubeClient.js instead of creating
 * a new KubeConfig on every call.
 *
 * @param {string} podName - deployment label (will be used as label selector)
 * @param {string} namespace
 * @returns {Promise<string>} logs text
 */
async function collectPodLogs(podName, namespace = "sarthiq-apps") {
  try {
    const k8s = require("@kubernetes/client-node");
    // Reuse singleton KubeConfig
    if (!collectPodLogs._kc) {
      collectPodLogs._kc = new k8s.KubeConfig();
      collectPodLogs._kc.loadFromDefault();
      collectPodLogs._coreV1 = collectPodLogs._kc.makeApiClient(k8s.CoreV1Api);
    }
    const coreV1 = collectPodLogs._coreV1;

    // List pods matching the deployment label
    const pods = await coreV1.listNamespacedPod({
      namespace,
      labelSelector: `app=${podName}`,
    });

    if (!pods.items?.length) {
      return "No pods found for this deployment.";
    }

    const pod = pods.items[0];
    const podRealName = pod.metadata.name;

    // Get logs
    let logText = "";
    try {
      const logResponse = await coreV1.readNamespacedPodLog({
        name: podRealName,
        namespace,
        tailLines: 100,
      });
      logText = typeof logResponse === "string" ? logResponse : (logResponse?.body || "");
    } catch (logErr) {
      logText = `(Could not retrieve container logs: ${logErr.message})`;
    }

    // Check pod events for OOMKilled, CrashLoopBackOff, etc.
    const status = pod.status;
    const containerStatuses = status?.containerStatuses || [];
    const eventInfo = containerStatuses
      .map((cs) => {
        const waiting = cs.state?.waiting;
        const terminated = cs.state?.terminated;
        if (waiting) return `WAITING: ${waiting.reason} — ${waiting.message || ""}`;
        if (terminated) return `TERMINATED: ${terminated.reason} (exit code ${terminated.exitCode}) — ${terminated.message || ""}`;
        return null;
      })
      .filter(Boolean)
      .join("\n");

    // Also get pod conditions for scheduling info
    const conditions = (status?.conditions || [])
      .map((c) => `${c.type}: ${c.status} — ${c.message || c.reason || ""}`)
      .join("\n");

    return (
      `--- Pod Phase: ${status?.phase || "Unknown"} ---\n` +
      `--- Pod Conditions ---\n${conditions || "None"}\n\n` +
      `--- Container Status ---\n${eventInfo || "No events"}\n\n` +
      `--- Container Logs ---\n${logText || "No logs available"}`
    );
  } catch (err) {
    return `Failed to collect pod logs: ${err.message}`;
  }
}

module.exports = {
  diagnoseError,
  collectPodLogs,
};
