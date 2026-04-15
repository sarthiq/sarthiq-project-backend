/**
 * backendDeployer.js
 * ─────────────────────────────────────────────────────────────────────
 * Optimized backend deployment pipeline.
 *
 * KEY OPTIMIZATION: Build TypeScript and install dependencies OUTSIDE
 * Docker on the host, then generate a minimal runtime-only Dockerfile
 * that copies pre-built artifacts.
 *
 * Pipeline:
 *   1. Install dependencies (npm ci) on host
 *   2. Build TypeScript/project (npm run build) on host
 *   3. Prune devDependencies (npm prune --production)
 *   4. Generate minimal runtime Dockerfile
 *   5. Return Docker build context info
 *
 * The caller (deployWorker) handles the actual Docker build + push + K8s.
 *
 * Expected: Docker build takes ~10–20s (no npm install, no TS compilation)
 * Final image: < 150 MB
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");
const {
  spawnAsync,
  validateDockerfile,
} = require("./securityValidator");

/** Windows needs shell:true for npm/yarn/pnpm (.cmd batch scripts) */
const IS_WIN = process.platform === "win32";

/* ── Helpers ───────────────────────────────────────────────────────── */

/**
 * Detect which package manager to use.
 */
function getPackageManagerCommands(buildContext) {
  if (fs.existsSync(path.join(buildContext, "pnpm-lock.yaml"))) {
    return {
      manager: "pnpm",
      installCmd: "pnpm",
      installArgs: ["install", "--frozen-lockfile"],
      installFallbackArgs: ["install"],
      pruneArgs: ["prune", "--prod"],
    };
  }
  if (fs.existsSync(path.join(buildContext, "yarn.lock"))) {
    return {
      manager: "yarn",
      installCmd: "yarn",
      installArgs: ["install", "--frozen-lockfile", "--prefer-offline"],
      installFallbackArgs: ["install", "--prefer-offline"],
      pruneArgs: [], // yarn doesn't have a prune equivalent in the same way
    };
  }
  const hasLockfile = fs.existsSync(path.join(buildContext, "package-lock.json"));
  return {
    manager: "npm",
    installCmd: "npm",
    installArgs: hasLockfile
      ? ["ci", "--legacy-peer-deps", "--prefer-offline"]
      : ["install", "--legacy-peer-deps", "--prefer-offline"],
    installFallbackArgs: ["install", "--legacy-peer-deps"],
    pruneArgs: ["prune", "--production"],
  };
}

/**
 * Relax TypeScript strict checks that fail builds on unused variables.
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

/**
 * Detect the entry point for the start command.
 * Checks common locations: dist/index.js, dist/main.js, dist/server.js,
 * dist/app.js, or falls back to package.json main field.
 */
function detectEntryPoint(buildContext, detection) {
  const distDir = detection.buildOutputDir || "dist";
  const distPath = path.join(buildContext, distDir);

  // If dist directory exists, check for common entry points
  if (fs.existsSync(distPath)) {
    const candidates = ["index.js", "main.js", "server.js", "app.js", "index.mjs"];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(distPath, candidate))) {
        return `${distDir}/${candidate}`;
      }
    }
    // Check for nested src/ compilation output
    if (fs.existsSync(path.join(distPath, "src", "index.js"))) {
      return `${distDir}/src/index.js`;
    }
    if (fs.existsSync(path.join(distPath, "src", "main.js"))) {
      return `${distDir}/src/main.js`;
    }
  }

  // No dist directory — check for root-level entry points
  const rootCandidates = ["index.js", "app.js", "server.js", "main.js"];
  for (const candidate of rootCandidates) {
    if (fs.existsSync(path.join(buildContext, candidate))) {
      return candidate;
    }
  }

  // Check package.json main field
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(buildContext, "package.json"), "utf-8"));
    if (pkg.main) return pkg.main;
  } catch {}

  // Fallback
  return "dist/index.js";
}

/**
 * Determine the appropriate COPY instructions for files to include
 * in the minimal Docker image.
 *
 * Framework-aware: handles Next.js (.next/), Nuxt (.output/), etc.
 */
function detectFilesToCopy(buildContext, detection) {
  const copies = [];
  const framework = (detection.framework || "").toLowerCase();

  // Always copy package.json (needed for npm start + dependency resolution)
  copies.push("COPY package.json ./");

  // Copy production node_modules
  copies.push("COPY node_modules ./node_modules");

  // ── Framework-specific: Next.js ──
  if (framework === "nextjs" || framework === "next") {
    // Next.js requires .next/ directory at runtime
    if (fs.existsSync(path.join(buildContext, ".next"))) {
      copies.push("COPY .next ./.next");
    }
    // next.config.js/mjs/ts is read at runtime
    for (const cfg of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
      if (fs.existsSync(path.join(buildContext, cfg))) {
        copies.push(`COPY ${cfg} ./`);
      }
    }
    // public/ directory for static assets served by Next.js
    if (fs.existsSync(path.join(buildContext, "public"))) {
      copies.push("COPY public ./public");
    }
    return copies;
  }

  // ── Framework-specific: Nuxt ──
  if (framework === "nuxt") {
    if (fs.existsSync(path.join(buildContext, ".output"))) {
      copies.push("COPY .output ./.output");
    }
    for (const cfg of ["nuxt.config.js", "nuxt.config.ts"]) {
      if (fs.existsSync(path.join(buildContext, cfg))) {
        copies.push(`COPY ${cfg} ./`);
      }
    }
    if (fs.existsSync(path.join(buildContext, "public"))) {
      copies.push("COPY public ./public");
    }
    return copies;
  }

  // ── Generic backend (Express, Fastify, etc.) ──
  const distDir = detection.buildOutputDir || "dist";
  const hasDistDir = fs.existsSync(path.join(buildContext, distDir));
  const hasBuildDir = !hasDistDir && fs.existsSync(path.join(buildContext, "build"));

  if (hasDistDir) {
    copies.push(`COPY ${distDir} ./${distDir}`);
    // Also copy root-level JS files (entry points like index.js, app.js)
    const rootFiles = fs.readdirSync(buildContext).filter((f) =>
      /\.(js|mjs|cjs|ts)$/.test(f) && !f.startsWith(".")
    );
    for (const file of rootFiles) {
      copies.push(`COPY ${file} ./`);
    }
  } else if (hasBuildDir) {
    copies.push("COPY build ./build");
    const rootFiles = fs.readdirSync(buildContext).filter((f) =>
      /\.(js|mjs|cjs|ts)$/.test(f) && !f.startsWith(".")
    );
    for (const file of rootFiles) {
      copies.push(`COPY ${file} ./`);
    }
  } else {
    // No compiled output — app runs from source.
    // Copy everything (the .dockerignore handles exclusions).
    // Remove the explicit package.json and node_modules copies
    // since COPY . . includes them.
    copies.length = 0;
    copies.push("COPY . .");
  }

  return copies;
}

/* ── Main Pipeline ─────────────────────────────────────────────────── */

/**
 * Pre-build a backend project on the host and generate a minimal Dockerfile.
 *
 * @param {object} options
 * @param {string} options.buildContext  Absolute path to the cloned repo
 * @param {object} options.detection    Stack detection result
 * @param {string} options.subdomain    Project subdomain
 * @param {object} options.envVars      User environment variables
 * @param {function} options.onLog      Logging callback
 *
 * @returns {Promise<{
 *   dockerfile: string,
 *   buildDurationMs: number,
 *   entryPoint: string,
 * }>}
 */
async function preBuildBackend({ buildContext, detection, subdomain, envVars = {}, onLog }) {
  const log = onLog || (() => {});
  const startTime = Date.now();

  /* ── Step 1: Install dependencies ──────────────────────────────── */
  await log("  📦 Installing dependencies (host build)...");
  const pm = getPackageManagerCommands(buildContext);

  try {
    await spawnAsync(pm.installCmd, pm.installArgs, {
      timeout: 120_000,
      cwd: buildContext,
      shell: IS_WIN,
    });
    await log(`  → Dependencies installed (${pm.manager})`);
  } catch {
    await log(`  ⚠ Strict install failed, retrying with fallback...`);
    await spawnAsync(pm.installCmd, pm.installFallbackArgs, {
      timeout: 120_000,
      cwd: buildContext,
      shell: IS_WIN,
    });
    await log(`  → Dependencies installed (${pm.manager}, fallback)`);
  }

  /* ── Step 2: Relax TypeScript checks ───────────────────────────── */
  const relaxed = relaxTypeScriptChecks(buildContext);
  if (relaxed) {
    await log("  → Relaxed TypeScript strict checks");
  }

  /* ── Step 3: Build (TypeScript compilation, etc.) ──────────────── */
  const buildCommand = detection.buildCommand;
  if (buildCommand) {
    await log(`  🔨 Building (${buildCommand})...`);

    // Classify build-time env vars
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
    buildEnv.CI = "false";
    buildEnv.TSC_COMPILE_ON_ERROR = "true";
    buildEnv.NODE_OPTIONS = "--max-old-space-size=1536";

    const [cmd, ...args] = buildCommand.split(" ");
    try {
      await spawnAsync(cmd, args, {
        timeout: 180_000,
        cwd: buildContext,
        env: buildEnv,
        shell: IS_WIN,
      });
      await log("  → Build complete");
    } catch (buildErr) {
      throw new Error(`Build failed: ${buildErr.message?.slice(0, 500)}`);
    }
  } else {
    await log("  → No build command detected (plain JS project)");
  }

  /* ── Step 4: Prune devDependencies ─────────────────────────────── */
  await log("  🧹 Pruning devDependencies...");
  if (pm.pruneArgs.length > 0) {
    try {
      await spawnAsync(pm.installCmd, pm.pruneArgs, {
        timeout: 60_000,
        cwd: buildContext,
        shell: IS_WIN,
      });
      await log("  → devDependencies removed");
    } catch {
      await log("  ⚠ Prune failed (non-fatal — image may be slightly larger)");
    }
  }

  /* ── Step 5: Detect entry point ────────────────────────────────── */
  const entryPoint = detectEntryPoint(buildContext, detection);
  await log(`  → Entry point: ${entryPoint}`);

  /* ── Step 6: Generate minimal Dockerfile ───────────────────────── */
  await log("  📄 Generating minimal runtime Dockerfile...");

  const port = detection.port || 3000;
  const copyInstructions = detectFilesToCopy(buildContext, detection);

  // Parse start command into CMD array format
  let startCommand = detection.startCommand || `node ${entryPoint}`;
  // Never use nodemon in production
  startCommand = startCommand.replace(/nodemon/g, "node");
  const cmdParts = startCommand.split(" ").map((s) => `"${s}"`).join(", ");

  const dockerfile = `# Minimal runtime image — built by SarthiQ Optimized Pipeline
# Dependencies installed and TypeScript compiled OUTSIDE Docker
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0

# Copy pre-built artifacts (no npm install, no build step needed)
${copyInstructions.join("\n")}

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup && \\
    chown -R appuser:appgroup /app
USER appuser

EXPOSE ${port}
CMD [${cmdParts}]
`.trim();

  // Validate the generated Dockerfile
  const validation = validateDockerfile(dockerfile);
  if (!validation.safe) {
    throw new Error(
      `Generated Dockerfile validation failed: ${validation.violations.join("; ")}`
    );
  }

  // Write Dockerfile to build context
  const dockerfilePath = path.join(buildContext, "Dockerfile");
  fs.writeFileSync(dockerfilePath, dockerfile);
  await log("  → Minimal Dockerfile generated");

  // Also write an optimized .dockerignore for the minimal build
  const dockerignore = [
    "# SarthiQ Optimized Backend — minimal build context",
    ".git",
    ".gitignore",
    ".github",
    ".vscode",
    ".idea",
    ".env",
    ".env.*",
    "*.md",
    "*.log",
    "*.pem",
    "*.key",
    "coverage",
    "__tests__",
    "tests",
    "test",
    "spec",
    "*.test.*",
    "*.spec.*",
    "docs",
    ".nyc_output",
    "tsconfig.tsbuildinfo",
    ".cache",
    ".turbo",
    ".swc",
  ].join("\n");
  fs.writeFileSync(path.join(buildContext, ".dockerignore"), dockerignore);

  const buildDurationMs = Date.now() - startTime;
  await log(`  → Pre-build time: ${(buildDurationMs / 1000).toFixed(1)}s`);

  return {
    dockerfile,
    buildDurationMs,
    entryPoint,
  };
}

module.exports = {
  preBuildBackend,
  detectEntryPoint,
  detectFilesToCopy,
};
