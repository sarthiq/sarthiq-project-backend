/**
 * securityValidator.js
 * ─────────────────────────────────────────────────────────────────────
 * Centralized security validation for the SarthiQ deployment platform.
 *
 * DESIGN PRINCIPLE: Every user-controlled string that touches a shell,
 * filesystem path, Kubernetes label, or log output MUST pass through
 * one of these validators BEFORE use.
 * ─────────────────────────────────────────────────────────────────────
 */
const { spawn } = require("child_process");
const net = require("net");
const url = require("url");

/* ================================================================== */
/* 1. SHELL-SAFE EXECUTION (replaces execSync / execAsync everywhere) */
/* ================================================================== */

/**
 * Execute a command safely using `spawn` (no shell interpolation).
 * Returns { stdout, stderr }.
 *
 * @param {string}   cmd      – binary name (e.g. "git", "docker")
 * @param {string[]} args     – argument array (NEVER a single string)
 * @param {object}   options  – { timeout, cwd, maxBuffer, env }
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function spawnAsync(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 300_000; // 5 min default
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024; // 10 MB

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // CRITICAL: never use shell
      timeout,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > maxBuffer) {
        child.kill("SIGKILL");
        killed = true;
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > maxBuffer) {
        child.kill("SIGKILL");
        killed = true;
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      killed = true;
      reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(
          new Error(`Command killed (buffer exceeded or timeout): ${cmd}`)
        );
      }
      if (code !== 0) {
        const err = new Error(
          `Command "${cmd}" exited with code ${code}: ${stderr.slice(0, 500)}`
        );
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ================================================================== */
/* 2. REPO URL VALIDATION                                              */
/* ================================================================== */

/** Allowed git hosting providers (HTTPS only) */
const ALLOWED_GIT_HOSTS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "gitlab.sarthiq.com", // self-hosted is OK if explicitly listed
];

/**
 * Validate that a repository URL is a safe HTTPS URL pointing to an
 * allowed hosting provider. Blocks file://, git://, ssh://, IPs, and
 * SSRF targets.
 *
 * @param {string} repoUrl
 * @throws {Error} if the URL is disallowed
 */
function validateRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") {
    throw new Error("Repository URL is required.");
  }

  // Must start with https://
  if (!repoUrl.startsWith("https://")) {
    throw new Error(
      "Only HTTPS repository URLs are allowed. Got: " +
        repoUrl.slice(0, 30) +
        "..."
    );
  }

  let parsed;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error("Invalid repository URL format.");
  }

  // Block IP-based URLs (prevent SSRF to internal services / metadata)
  if (net.isIP(parsed.hostname)) {
    throw new Error("IP-based repository URLs are not allowed.");
  }

  // Block reserved / internal hostnames
  const blocked = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.internal",
    "[::1]",
  ];
  if (blocked.some((b) => parsed.hostname.includes(b))) {
    throw new Error("Repository URL points to a blocked address.");
  }

  // Hostname must be in the allowlist
  if (!ALLOWED_GIT_HOSTS.includes(parsed.hostname)) {
    throw new Error(
      `Repository host '${parsed.hostname}' is not in the allowlist. ` +
        `Allowed: ${ALLOWED_GIT_HOSTS.join(", ")}`
    );
  }

  // Path must look like /owner/repo or /owner/repo.git
  const pathParts = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error("Repository URL must include owner and repo name.");
  }

  // Block path traversal
  if (parsed.pathname.includes("..")) {
    throw new Error("Path traversal detected in repository URL.");
  }

  // No query string or fragments (prevents ? injection)
  if (parsed.search || parsed.hash) {
    throw new Error("Repository URL must not contain query strings or fragments.");
  }
}

/* ================================================================== */
/* 3. BRANCH NAME VALIDATION                                           */
/* ================================================================== */

/**
 * Ensure a branch name contains only safe characters.
 * Git allows a lot of characters but we restrict for safety.
 *
 * @param {string} branch
 * @throws {Error} if branch name is unsafe
 */
function validateBranch(branch) {
  if (!branch || typeof branch !== "string") {
    throw new Error("Branch name is required.");
  }
  if (branch.length > 128) {
    throw new Error("Branch name too long (max 128 characters).");
  }
  // Allow: letters, digits, dots, hyphens, underscores, slashes
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(
      `Branch name contains illegal characters: '${branch.slice(0, 30)}'`
    );
  }
  // Block dangerous patterns
  if (branch.startsWith("-") || branch.includes("..") || branch.includes("~")) {
    throw new Error("Branch name contains forbidden patterns.");
  }
}

/* ================================================================== */
/* 4. IMAGE TAG VALIDATION                                             */
/* ================================================================== */

/**
 * Ensure a Docker image tag contains only safe characters.
 * @param {string} tag
 * @throws {Error}
 */
function validateImageTag(tag) {
  if (!tag || typeof tag !== "string") {
    throw new Error("Image tag is required.");
  }
  if (tag.length > 256) {
    throw new Error("Image tag too long.");
  }
  // Allow: lowercase letters, digits, dots, hyphens, underscores, colons, slashes
  if (!/^[a-z0-9._:\/\-]+$/.test(tag)) {
    throw new Error(`Image tag contains illegal characters: '${tag.slice(0, 30)}'`);
  }
}

/* ================================================================== */
/* 5. ENV-VAR KEY VALIDATION                                           */
/* ================================================================== */

/**
 * Validate an environment variable key.
 * @param {string} key
 * @throws {Error}
 */
function validateEnvVarKey(key) {
  if (!key || typeof key !== "string") {
    throw new Error("Env var key is required.");
  }
  if (key.length > 128) {
    throw new Error("Env var key too long.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Env var key invalid: '${key.slice(0, 30)}'`);
  }
}

/**
 * Validate all keys + values in an env vars object.
 * @param {object} envVars - { KEY: "value", ... }
 * @throws {Error}
 */
function validateEnvVars(envVars) {
  if (!envVars || typeof envVars !== "object") return;
  for (const [key, value] of Object.entries(envVars)) {
    validateEnvVarKey(key);
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Env var value for '${key}' must be a string or number.`);
    }
    // Block values > 10KB (prevent abuse)
    if (String(value).length > 10_240) {
      throw new Error(`Env var '${key}' value is too large (max 10KB).`);
    }
  }
}

/* ================================================================== */
/* 6. DOCKERFILE CONTENT VALIDATION                                    */
/* ================================================================== */

/** Dangerous patterns that should NEVER appear in a Dockerfile */
const DOCKERFILE_BLOCKLIST = [
  /--privileged/i,
  /\/var\/run\/docker\.sock/i,
  /docker\.sock/i,
  /--cap-add\s+(ALL|SYS_ADMIN|SYS_PTRACE)/i,
  /--security-opt\s+seccomp[=:]unconfined/i,
  /--pid\s*=\s*host/i,
  /--network\s*=\s*host/i,
  /--uts\s*=\s*host/i,
  /--ipc\s*=\s*host/i,
  /nsenter/i,
  /mount\s+.*\/proc/i,
  /mount\s+.*\/sys/i,
  /mount\s+.*\/dev/i,
  // Block downloading + executing from untrusted sources
  /curl\s+.*\|\s*(ba)?sh/i,
  /wget\s+.*\|\s*(ba)?sh/i,
  /curl\s+.*\|\s*python/i,
  /wget\s+.*\|\s*python/i,
];

/**
 * Validate Dockerfile content for dangerous instructions.
 * @param {string} content
 * @returns {{ safe: boolean, violations: string[] }}
 */
function validateDockerfile(content) {
  if (!content || typeof content !== "string") {
    return { safe: false, violations: ["Empty or invalid Dockerfile content."] };
  }

  const violations = [];

  for (const pattern of DOCKERFILE_BLOCKLIST) {
    if (pattern.test(content)) {
      violations.push(`Blocked pattern detected: ${pattern.source}`);
    }
  }

  // Limit Dockerfile size (prevent abuse)
  if (content.length > 50_000) {
    violations.push("Dockerfile exceeds maximum size (50KB).");
  }

  // Limit number of RUN instructions (prevent resource abuse)
  const runCount = (content.match(/^RUN\s/gim) || []).length;
  if (runCount > 30) {
    violations.push(`Too many RUN instructions (${runCount}, max 30).`);
  }

  return { safe: violations.length === 0, violations };
}

/* ================================================================== */
/* 7. LOG SANITIZATION                                                 */
/* ================================================================== */

/** Patterns that look like secrets — redact them from logs */
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth)[\s]*[=:]\s*['"]?[a-zA-Z0-9_\-\/.+=]{8,}/gi,
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI key
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub PAT
  /glpat-[a-zA-Z0-9\-_]{20,}/g, // GitLab PAT
  /Bearer\s+[a-zA-Z0-9\-_\.]+/gi, // JWT/Bearer tokens
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
];

/**
 * Scrub potential secrets from a log line.
 * @param {string} line
 * @returns {string}
 */
function sanitizeLogLine(line) {
  if (!line || typeof line !== "string") return line;
  let sanitized = line;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

/* ================================================================== */
/* 8. SUBDOMAIN VALIDATION                                             */
/* ================================================================== */

/**
 * Validate a subdomain string.
 * @param {string} subdomain
 * @throws {Error}
 */
function validateSubdomain(subdomain) {
  if (!subdomain || typeof subdomain !== "string") {
    throw new Error("Subdomain is required.");
  }
  if (subdomain.length > 63) {
    throw new Error("Subdomain too long (max 63 characters).");
  }
  if (!/^[a-z0-9]([a-z0-9\-]*[a-z0-9])?$/.test(subdomain)) {
    throw new Error(`Invalid subdomain format: '${subdomain.slice(0, 30)}'`);
  }
}

/* ================================================================== */
/* 9. PROJECT DIRECTORY VALIDATION (path traversal prevention)         */
/* ================================================================== */

/**
 * Validate a project sub-directory path. Must be relative, no traversal.
 * @param {string} dir
 * @throws {Error}
 */
function validateProjectDirectory(dir) {
  // Accept common "root of repo" values
  if (!dir || dir === "." || dir === "./" || dir === "/") return;

  if (typeof dir !== "string") {
    throw new Error("Project directory must be a string.");
  }

  // Block absolute paths (but "/" alone is OK — handled above)
  if (/^\/[a-zA-Z]/.test(dir) || /^[a-zA-Z]:/.test(dir)) {
    throw new Error("Absolute paths are not allowed for project directory.");
  }

  // Normalize: strip leading "/" if user sends "/subdir" (treat as relative)
  const normalized = dir.startsWith("/") ? dir.slice(1) : dir;
  if (!normalized) return; // was just "/"

  // Block path traversal
  if (dir.includes("..")) {
    throw new Error("Path traversal ('..') detected in project directory.");
  }

  // Only allow safe characters
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(dir)) {
    throw new Error("Project directory contains illegal characters.");
  }
}

/* ================================================================== */
/* 10. BUILD COMMAND VALIDATION                                        */
/* ================================================================== */

/** Safe build commands (prefix match) */
const ALLOWED_BUILD_COMMANDS = [
  "npm run",
  "npm ci",
  "npm install",
  "npm start",
  "yarn",
  "pnpm",
  "npx",
  "node",
  "python",
  "pip install",
  "go build",
  "go run",
  "cargo build",
  "cargo run",
  "mvn",
  "gradle",
  "make",
  "dotnet",
  "gunicorn",
  "uvicorn",
];

/**
 * Validate a user-provided build/start command.
 * @param {string} cmd
 * @throws {Error}
 */
function validateBuildCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return; // null/empty is OK

  const trimmed = cmd.trim().toLowerCase();

  // Check against allowlist
  const allowed = ALLOWED_BUILD_COMMANDS.some((prefix) =>
    trimmed.startsWith(prefix)
  );
  if (!allowed) {
    throw new Error(
      `Build command '${cmd.slice(0, 40)}' is not in the allowlist. ` +
        `Allowed prefixes: ${ALLOWED_BUILD_COMMANDS.join(", ")}`
    );
  }

  // Block shell injection characters
  if (/[;|&`$(){}]/.test(cmd)) {
    throw new Error(
      "Build command contains potentially dangerous shell characters."
    );
  }
}

/* ================================================================== */
/* 11. IP BLOCKLIST (SSRF / metadata prevention)                       */
/* ================================================================== */

const BLOCKED_IP_RANGES = [
  "169.254.", // AWS/GCP metadata
  "127.",     // localhost
  "10.",      // private
  "172.16.",  // private
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.168.", // private
  "0.",
  "::1",
  "fc00:",    // IPv6 private
  "fe80:",    // IPv6 link-local
  "fd",       // IPv6 unique-local
];

/**
 * Check if an IP address is in the blocklist.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIP(ip) {
  if (!ip) return false;
  return BLOCKED_IP_RANGES.some((range) => ip.startsWith(range));
}

/* ================================================================== */
/* 12. HTML ESCAPING (XSS prevention for HTML templates)               */
/* ================================================================== */

/**
 * Escape HTML special characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ================================================================== */
/* EXPORTS                                                             */
/* ================================================================== */

module.exports = {
  // Shell-safe execution
  spawnAsync,

  // Input validators
  validateRepoUrl,
  validateBranch,
  validateImageTag,
  validateEnvVarKey,
  validateEnvVars,
  validateDockerfile,
  validateSubdomain,
  validateProjectDirectory,
  validateBuildCommand,
  isBlockedIP,

  // Sanitizers
  sanitizeLogLine,
  escapeHtml,

  // Constants (for testing)
  ALLOWED_GIT_HOSTS,
  ALLOWED_BUILD_COMMANDS,
  DOCKERFILE_BLOCKLIST,
};
