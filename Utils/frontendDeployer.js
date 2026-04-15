/**
 * frontendDeployer.js
 * ─────────────────────────────────────────────────────────────────────
 * Complete frontend static-site deployment pipeline.
 * NO Docker, NO Kubernetes — just build and copy files to disk.
 *
 * Pipeline:
 *   1. Install dependencies (npm ci / yarn / pnpm)
 *   2. Build the project (npm run build)
 *   3. Detect build output directory (dist, build, .next, etc.)
 *   4. Copy output to static serving directory
 *   5. Return deployment result
 *
 * Expected deployment time: 20–40 seconds (first deploy, no cache)
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnAsync } = require("./securityValidator");

/** Windows needs shell:true for npm/yarn/pnpm (.cmd batch scripts) */
const IS_WIN = process.platform === "win32";

/* ── Configuration ─────────────────────────────────────────────────── */

/**
 * Root directory for static site storage.
 * Each project gets: {STATIC_SITES_DIR}/{subdomain}/
 */
const STATIC_SITES_DIR =
  process.env.STATIC_SITES_DIR ||
  path.join(os.homedir(), "sarthiq-static-sites");

// Ensure the root directory exists on startup
if (!fs.existsSync(STATIC_SITES_DIR)) {
  fs.mkdirSync(STATIC_SITES_DIR, { recursive: true });
  console.log(`[frontendDeployer] ✓ Created static sites dir: ${STATIC_SITES_DIR}`);
}

/* ── Build output directory candidates ─────────────────────────────── */
const BUILD_OUTPUT_CANDIDATES = [
  "dist",       // Vite, Angular, generic
  "build",      // CRA (Create React App)
  ".next",      // Next.js (static export)
  "out",        // Next.js (export output)
  ".output",    // Nuxt 3
  "public",     // Some static generators
  "www",        // Ionic
  "_site",      // Jekyll, Eleventy
  "storybook-static",
];

/* ── Helpers ───────────────────────────────────────────────────────── */

/**
 * Detect which package manager to use and return the install/build commands.
 */
function getPackageManagerCommands(buildContext) {
  if (fs.existsSync(path.join(buildContext, "pnpm-lock.yaml"))) {
    return {
      manager: "pnpm",
      installCmd: "pnpm",
      installArgs: ["install", "--frozen-lockfile"],
      installFallbackArgs: ["install"],
    };
  }
  if (fs.existsSync(path.join(buildContext, "yarn.lock"))) {
    return {
      manager: "yarn",
      installCmd: "yarn",
      installArgs: ["install", "--frozen-lockfile", "--prefer-offline"],
      installFallbackArgs: ["install", "--prefer-offline"],
    };
  }
  // npm (default)
  const hasLockfile = fs.existsSync(path.join(buildContext, "package-lock.json"));
  return {
    manager: "npm",
    installCmd: "npm",
    installArgs: hasLockfile
      ? ["ci", "--legacy-peer-deps", "--prefer-offline"]
      : ["install", "--legacy-peer-deps", "--prefer-offline"],
    installFallbackArgs: ["install", "--legacy-peer-deps"],
  };
}

/**
 * Detect the build output directory from the built project.
 * Checks detection.buildOutputDir first, then probes common candidates.
 *
 * @param {string} buildContext  Path to the project root
 * @param {object} detection    Stack detection result
 * @returns {string|null}  Absolute path to the build output, or null
 */
function detectBuildOutput(buildContext, detection) {
  // 1. Use detection's buildOutputDir if set and exists
  if (detection.buildOutputDir) {
    const detected = path.join(buildContext, detection.buildOutputDir);
    if (fs.existsSync(detected)) {
      return detected;
    }
  }

  // 2. Probe common candidates
  for (const candidate of BUILD_OUTPUT_CANDIDATES) {
    const candidatePath = path.join(buildContext, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      // Verify it has files (not an empty directory)
      const entries = fs.readdirSync(candidatePath);
      if (entries.length > 0) {
        return candidatePath;
      }
    }
  }

  return null;
}

/**
 * Recursively copy a directory (like cp -r).
 * Replaces the destination if it exists.
 */
function copyDirSync(src, dest) {
  // Clean destination first
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Relax TypeScript strict checks that fail builds on unused variables.
 * Same logic as the Dockerfile templates in aiStackDetector.js.
 */
function relaxTypeScriptChecks(buildContext) {
  const tsconfigPath = path.join(buildContext, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return false;

  try {
    const content = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
    if (!content.compilerOptions) content.compilerOptions = {};
    content.compilerOptions.noUnusedLocals = false;
    content.compilerOptions.noUnusedParameters = false;
    fs.writeFileSync(tsconfigPath, JSON.stringify(content, null, 2));
    return true;
  } catch {
    return false;
  }
}

/* ── Main Pipeline ─────────────────────────────────────────────────── */

/**
 * Deploy a frontend (static site) project.
 *
 * @param {object} options
 * @param {string} options.buildContext    Absolute path to the cloned repo
 * @param {object} options.detection      Stack detection result from aiStackDetector
 * @param {string} options.subdomain      Project subdomain (e.g., "my-app-42")
 * @param {object} options.envVars        User-provided environment variables
 * @param {function} options.onLog        Logging callback: (line: string) => Promise<void>
 *
 * @returns {Promise<{
 *   staticFilesPath: string,
 *   buildOutputDir: string,
 *   buildDurationMs: number,
 *   fileCount: number,
 *   totalSizeBytes: number,
 * }>}
 */
async function deployFrontend({ buildContext, detection, subdomain, envVars = {}, onLog }) {
  const log = onLog || (() => {});
  const startTime = Date.now();

  /* ── Step 1: Install dependencies ──────────────────────────────── */
  await log("  📦 Installing dependencies...");
  const pm = getPackageManagerCommands(buildContext);

  try {
    await spawnAsync(pm.installCmd, pm.installArgs, {
      timeout: 120_000,
      cwd: buildContext,
      shell: IS_WIN,
    });
    await log(`  → Dependencies installed (${pm.manager})`);
  } catch (installErr) {
    // Retry with fallback (non-strict install)
    await log(`  ⚠ Strict install failed, retrying with ${pm.manager} install...`);
    try {
      await spawnAsync(pm.installCmd, pm.installFallbackArgs, {
        timeout: 120_000,
        cwd: buildContext,
        shell: IS_WIN,
      });
      await log(`  → Dependencies installed (${pm.manager}, fallback mode)`);
    } catch (fallbackErr) {
      throw new Error(
        `Dependency installation failed: ${fallbackErr.message?.slice(0, 300)}`
      );
    }
  }

  /* ── Step 2: Relax TypeScript strict checks ────────────────────── */
  const relaxed = relaxTypeScriptChecks(buildContext);
  if (relaxed) {
    await log("  → Relaxed TypeScript strict checks");
  }

  /* ── Step 3: Build the project ─────────────────────────────────── */
  await log("  🔨 Building project...");

  // Classify env vars — inject build-time vars
  const BUILD_TIME_PREFIXES = [
    "REACT_APP_", "NEXT_PUBLIC_", "VITE_", "VUE_APP_", "GATSBY_", "NUXT_ENV_",
  ];
  const buildEnv = { ...process.env };
  for (const [key, value] of Object.entries(envVars)) {
    const isBuildTime = BUILD_TIME_PREFIXES.some((p) => key.startsWith(p));
    if (isBuildTime) {
      buildEnv[key] = String(value);
    }
  }

  // Always set CI=false to prevent treating warnings as errors
  buildEnv.CI = "false";
  buildEnv.TSC_COMPILE_ON_ERROR = "true";
  buildEnv.ESLINT_NO_DEV_ERRORS = "true";
  buildEnv.NODE_OPTIONS = "--max-old-space-size=1536";

  const buildCommand = detection.buildCommand || "npm run build";
  const [buildCmd, ...buildArgs] = buildCommand.split(" ");

  try {
    await spawnAsync(buildCmd, buildArgs, {
      timeout: 180_000,
      cwd: buildContext,
      env: buildEnv,
      shell: IS_WIN,
    });
    await log("  → Build complete");
  } catch (buildErr) {
    throw new Error(
      `Build failed: ${buildErr.message?.slice(0, 500)}`
    );
  }

  /* ── Step 4: Detect build output ───────────────────────────────── */
  const buildOutput = detectBuildOutput(buildContext, detection);
  if (!buildOutput) {
    throw new Error(
      `Build output not found. Checked: ${detection.buildOutputDir || "auto"}, ` +
      `${BUILD_OUTPUT_CANDIDATES.join(", ")}. ` +
      "Ensure your build command produces output in one of these directories."
    );
  }

  const buildOutputRelative = path.relative(buildContext, buildOutput);
  await log(`  → Build output: ${buildOutputRelative}/`);

  /* ── Step 5: Deploy to static serving directory ────────────────── */
  await log("  🚀 Deploying static files...");

  const staticFilesPath = path.join(STATIC_SITES_DIR, subdomain);

  // Atomic deploy: copy to temp, then rename (prevents serving partial files)
  const tempDeployPath = `${staticFilesPath}-deploying-${Date.now()}`;
  try {
    copyDirSync(buildOutput, tempDeployPath);

    // Swap: remove old, rename temp to final
    if (fs.existsSync(staticFilesPath)) {
      fs.rmSync(staticFilesPath, { recursive: true, force: true });
    }
    fs.renameSync(tempDeployPath, staticFilesPath);
  } catch (copyErr) {
    // Clean up temp on failure
    if (fs.existsSync(tempDeployPath)) {
      fs.rmSync(tempDeployPath, { recursive: true, force: true });
    }
    throw new Error(`Failed to deploy static files: ${copyErr.message}`);
  }

  /* ── Step 6: Calculate stats ───────────────────────────────────── */
  const stats = getDirectoryStats(staticFilesPath);
  const buildDurationMs = Date.now() - startTime;

  await log(`  → Deployed ${stats.fileCount} files (${(stats.totalSizeBytes / 1024).toFixed(1)} KB)`);
  await log(`  → Static path: ${staticFilesPath}`);
  await log(`  → Total time: ${(buildDurationMs / 1000).toFixed(1)}s`);

  return {
    staticFilesPath,
    buildOutputDir: buildOutputRelative,
    buildDurationMs,
    fileCount: stats.fileCount,
    totalSizeBytes: stats.totalSizeBytes,
  };
}

/**
 * Get file count and total size of a directory (recursive).
 */
function getDirectoryStats(dirPath) {
  let fileCount = 0;
  let totalSizeBytes = 0;

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          fileCount++;
          try {
            totalSizeBytes += fs.statSync(fullPath).size;
          } catch {}
        } else if (entry.isDirectory()) {
          walk(fullPath);
        }
      }
    } catch {}
  }

  walk(dirPath);
  return { fileCount, totalSizeBytes };
}

/**
 * Remove static files for a project (used during cleanup/delete).
 */
function removeStaticFiles(subdomain) {
  const staticPath = path.join(STATIC_SITES_DIR, subdomain);
  if (fs.existsSync(staticPath)) {
    fs.rmSync(staticPath, { recursive: true, force: true });
    console.log(`[frontendDeployer] ✓ Removed static files for: ${subdomain}`);
    return true;
  }
  return false;
}

module.exports = {
  deployFrontend,
  removeStaticFiles,
  detectBuildOutput,
  STATIC_SITES_DIR,
};
