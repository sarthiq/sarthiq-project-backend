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
${truncatedLogs}
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
    const result = JSON.parse(raw);

    // Validate required fields
    return {
      diagnosis: result.diagnosis || "Unable to determine the cause.",
      errorCategory: result.errorCategory || "unknown",
      fixedDockerfile: result.fixedDockerfile || null,
      fixedBuildCommand: result.fixedBuildCommand || null,
      fixedStartCommand: result.fixedStartCommand || null,
      fixedPort: result.fixedPort || null,
      missingEnvVars: result.missingEnvVars || [],
      confidence:
        typeof result.confidence === "number" ? result.confidence : 0.5,
      shouldRetry:
        typeof result.shouldRetry === "boolean" ? result.shouldRetry : false,
    };
  } catch (err) {
    console.error("[aiDebugger] OpenAI call failed:", err.message);

    // Return a safe non-retryable result when AI is unreachable
    return {
      diagnosis: `AI debugger unavailable: ${err.message}. Manual inspection required.`,
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
 * @param {string} podName
 * @param {string} namespace
 * @returns {Promise<string>} logs text
 */
async function collectPodLogs(podName, namespace = "sarthiq-apps") {
  try {
    const k8s = require("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

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
    const logResponse = await coreV1.readNamespacedPodLog({
      name: podRealName,
      namespace,
      tailLines: 100,
    });

    // Also check pod events for OOMKilled, CrashLoopBackOff, etc.
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

    return `--- Pod Events ---\n${eventInfo || "No events"}\n\n--- Container Logs ---\n${logResponse || "No logs available"}`;
  } catch (err) {
    return `Failed to collect pod logs: ${err.message}`;
  }
}

module.exports = {
  diagnoseError,
  collectPodLogs,
};
