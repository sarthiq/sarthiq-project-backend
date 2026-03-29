/**
 * rootDetector.js
 * ─────────────────────────────────────────────────────────────────────
 * Detects whether a project REQUIRES root access to run.
 *
 * Detection signals:
 *   1. Dockerfile: USER root, apt-get/apk/yum package installs
 *   2. Privileged ports: < 1024 (80, 443, etc.)
 *   3. Global package installs: npm -g, pip install (system-wide)
 *   4. Build error logs: EACCES, Permission denied
 *   5. Systemd / service management commands
 *
 * Returns a RootDetectionResult with:
 *   - requiresRoot: boolean
 *   - reasons: string[]          (human-readable)
 *   - canAutoFix: boolean        (can we auto-patch?)
 *   - autoFixSuggestions: string[] (what to change)
 *   - executionMode: "secure" | "sandbox"
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");

/* ── Signal patterns in Dockerfile ──────────────────────────────── */
const DOCKERFILE_ROOT_SIGNALS = [
  {
    pattern: /^\s*USER\s+root\s*$/im,
    reason: "Dockerfile explicitly sets USER root",
    canAutoFix: true,
    fix: "Change 'USER root' to 'USER 1000' or 'USER node'",
  },
  {
    pattern: /^\s*RUN\s+(apt-get|apt)\s+(install|update|upgrade)/im,
    reason: "Dockerfile uses apt-get (requires root for package installation)",
    canAutoFix: false,
    fix: "Move installs to a multi-stage build or use USER root only during install, then switch back",
  },
  {
    pattern: /^\s*RUN\s+apk\s+add/im,
    reason: "Dockerfile uses apk add (requires root for package installation)",
    canAutoFix: false,
    fix: "Install packages in build stage, then COPY to runtime image",
  },
  {
    pattern: /^\s*RUN\s+yum\s+install/im,
    reason: "Dockerfile uses yum install (requires root)",
    canAutoFix: false,
    fix: "Install packages in build stage, then COPY to runtime image",
  },
  {
    pattern: /^\s*RUN\s+dnf\s+install/im,
    reason: "Dockerfile uses dnf install (requires root)",
    canAutoFix: false,
    fix: "Install packages in build stage, then COPY to runtime image",
  },
  {
    pattern: /^\s*RUN\s+.*npm\s+.*(-g|--global)\s+install/im,
    reason: "Dockerfile installs npm packages globally (requires root)",
    canAutoFix: true,
    fix: "Use npx instead of global install, or install to user directory",
  },
  {
    pattern: /^\s*RUN\s+pip\s+install(?!\s+--user)/im,
    reason: "Dockerfile uses system-wide pip install",
    canAutoFix: true,
    fix: "Add --user flag to pip install or use a virtual environment",
  },
  {
    pattern: /^\s*RUN\s+.*chmod\s+.*[0-7]{3,4}\s+\//im,
    reason: "Dockerfile changes permissions on system paths",
    canAutoFix: false,
    fix: "Only change permissions on /app or application directories",
  },
  {
    pattern: /^\s*RUN\s+.*chown\s+root/im,
    reason: "Dockerfile changes ownership to root",
    canAutoFix: true,
    fix: "Change ownership to non-root user (e.g., 1000:1000)",
  },
  {
    pattern: /^\s*RUN\s+.*systemctl|service\s+/im,
    reason: "Dockerfile uses systemd/service management (requires root)",
    canAutoFix: false,
    fix: "Use direct command execution instead of systemd",
  },
];

/* ── Privileged port detection ──────────────────────────────────── */
const PRIVILEGED_PORT_THRESHOLD = 1024;

/* ── Error log patterns that indicate root was needed ────────────── */
const ROOT_ERROR_PATTERNS = [
  {
    pattern: /EACCES/i,
    reason: "Permission denied (EACCES) — likely needs root or writable directory",
  },
  {
    pattern: /permission\s+denied/i,
    reason: "Permission denied error in build/runtime logs",
  },
  {
    pattern: /operation\s+not\s+permitted/i,
    reason: "Operation not permitted — may need additional capabilities",
  },
  {
    pattern: /EPERM/i,
    reason: "EPERM error — permission restriction hit",
  },
  {
    pattern: /failed\s+to\s+bind.*port\s+\d{1,3}\b/i,
    reason: "Failed to bind to a privileged port (< 1024)",
  },
];

/**
 * Analyze a Dockerfile for root requirements.
 *
 * @param {string} dockerfileContent
 * @returns {{ signals: Array<{ reason: string, canAutoFix: boolean, fix: string }> }}
 */
function analyzeDockerfile(dockerfileContent) {
  const signals = [];

  if (!dockerfileContent) return { signals };

  for (const entry of DOCKERFILE_ROOT_SIGNALS) {
    if (entry.pattern.test(dockerfileContent)) {
      signals.push({
        reason: entry.reason,
        canAutoFix: entry.canAutoFix,
        fix: entry.fix,
      });
    }
  }

  return { signals };
}

/**
 * Analyze the detected port for root requirements.
 *
 * @param {number} port
 * @returns {{ signals: Array<{ reason: string, canAutoFix: boolean, fix: string }> }}
 */
function analyzePort(port) {
  const signals = [];

  if (port && port < PRIVILEGED_PORT_THRESHOLD) {
    // Ports 80 and 443 in containers are typically handled by nginx running
    // as non-root on modern images — mark as auto-fixable
    const isCommonWebPort = port === 80 || port === 443;

    signals.push({
      reason: `Application uses privileged port ${port} (< ${PRIVILEGED_PORT_THRESHOLD})`,
      canAutoFix: isCommonWebPort,
      fix: isCommonWebPort
        ? `Port ${port} is handled by nginx-alpine which supports non-root mode. No action needed for static sites.`
        : `Change application to listen on port >= 1024 (e.g., 3000, 8080)`,
    });
  }

  return { signals };
}

/**
 * Analyze error logs for root-related failures.
 *
 * @param {string} errorLogs
 * @returns {{ signals: Array<{ reason: string }> }}
 */
function analyzeErrorLogs(errorLogs) {
  const signals = [];

  if (!errorLogs) return { signals };

  for (const entry of ROOT_ERROR_PATTERNS) {
    if (entry.pattern.test(errorLogs)) {
      signals.push({ reason: entry.reason, canAutoFix: false, fix: "Review error and adjust permissions" });
    }
  }

  return { signals };
}

/**
 * Analyze project files for root requirements.
 *
 * @param {string} buildContext - path to cloned repo
 * @returns {{ signals: Array<{ reason: string, canAutoFix: boolean, fix: string }> }}
 */
function analyzeProjectFiles(buildContext) {
  const signals = [];

  try {
    // Check for .dockerignore (good practice)
    // Check package.json for postinstall scripts that might need root
    const pkgPath = path.join(buildContext, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};

        // Check for scripts that might need root
        for (const [name, cmd] of Object.entries(scripts)) {
          if (/sudo\s+/i.test(cmd)) {
            signals.push({
              reason: `package.json script '${name}' uses sudo`,
              canAutoFix: false,
              fix: "Remove sudo from npm scripts",
            });
          }
        }
      } catch {
        /* malformed package.json — skip */
      }
    }
  } catch {
    /* ignore file read errors */
  }

  return { signals };
}

/* ================================================================== */
/* PUBLIC API                                                          */
/* ================================================================== */

/**
 * Full root requirement detection for a project.
 *
 * @param {object} params
 * @param {string} params.dockerfileContent  – Dockerfile content
 * @param {number} params.port               – detected application port
 * @param {string} params.buildContext       – path to cloned repo
 * @param {string} params.errorLogs          – previous build/runtime error logs (optional)
 * @param {boolean} params.isStaticSite      – if true, port 80/443 doesn't need root
 *
 * @returns {RootDetectionResult}
 *
 * RootDetectionResult = {
 *   requiresRoot: boolean,
 *   reasons: string[],
 *   canAutoFix: boolean,
 *   autoFixSuggestions: string[],
 *   executionMode: "secure" | "sandbox",
 *   signals: Array<{ reason, canAutoFix, fix }>
 * }
 */
function detectRootRequirements({
  dockerfileContent,
  port,
  buildContext,
  errorLogs,
  isStaticSite = false,
}) {
  const allSignals = [];

  // 1. Dockerfile analysis
  const dfResult = analyzeDockerfile(dockerfileContent);
  allSignals.push(...dfResult.signals);

  // 2. Port analysis (skip for static sites — nginx handles port 80 as non-root)
  if (!isStaticSite) {
    const portResult = analyzePort(port);
    allSignals.push(...portResult.signals);
  }

  // 3. Project file analysis
  if (buildContext) {
    const projResult = analyzeProjectFiles(buildContext);
    allSignals.push(...projResult.signals);
  }

  // 4. Error log analysis (if provided)
  if (errorLogs) {
    const errResult = analyzeErrorLogs(errorLogs);
    allSignals.push(...errResult.signals);
  }

  // Filter out signals that are auto-fixable for non-root mode
  const nonAutoFixable = allSignals.filter((s) => !s.canAutoFix);
  const autoFixable = allSignals.filter((s) => s.canAutoFix);

  const requiresRoot = nonAutoFixable.length > 0;
  const executionMode = requiresRoot ? "sandbox" : "secure";

  return {
    requiresRoot,
    reasons: allSignals.map((s) => s.reason),
    canAutoFix: nonAutoFixable.length === 0 && autoFixable.length > 0,
    autoFixSuggestions: autoFixable.map((s) => s.fix),
    executionMode,
    signals: allSignals,
  };
}

/**
 * Auto-patch a Dockerfile to run as non-root where possible.
 *
 * @param {string} dockerfile
 * @param {number} port
 * @returns {{ patched: string, applied: string[] }}
 */
function autoPatchDockerfile(dockerfile, port = 3000) {
  if (!dockerfile) return { patched: dockerfile, applied: [] };

  let patched = dockerfile;
  const applied = [];

  // 1. Replace "USER root" with "USER 1000" at the end
  if (/^\s*USER\s+root\s*$/im.test(patched)) {
    // Check if there's a later USER <non-root>, if not, add one
    const lines = patched.split("\n");
    const lastUserIdx = lines.findLastIndex((l) => /^\s*USER\s+/i.test(l));
    if (lastUserIdx >= 0 && /^\s*USER\s+root\s*$/i.test(lines[lastUserIdx])) {
      // Add a non-root user at the end, just before CMD/ENTRYPOINT
      const cmdIdx = lines.findIndex((l) =>
        /^\s*(CMD|ENTRYPOINT)\s+/i.test(l)
      );
      const insertAt = cmdIdx >= 0 ? cmdIdx : lines.length;
      lines.splice(insertAt, 0, "USER 1000");
      patched = lines.join("\n");
      applied.push("Added 'USER 1000' before CMD to drop root");
    }
  }

  // 2. Add --user to pip install
  patched = patched.replace(
    /^(\s*RUN\s+pip\s+install)\s+(?!--user)/gim,
    "$1 --user "
  );
  if (patched !== dockerfile) {
    applied.push("Added --user to pip install commands");
  }

  return { patched, applied };
}

module.exports = {
  detectRootRequirements,
  autoPatchDockerfile,
  analyzeDockerfile,
  analyzePort,
  analyzeErrorLogs,
  analyzeProjectFiles,

  // Constants for testing
  DOCKERFILE_ROOT_SIGNALS,
  ROOT_ERROR_PATTERNS,
};
