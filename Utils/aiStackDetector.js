/**
 * aiStackDetector.js
 * AI-powered repository analysis for automatic stack detection and Dockerfile generation.
 *
 * Strategy:
 *   1. HEURISTIC-FIRST: Scan for well-known files (package.json, requirements.txt, etc.)
 *      and infer language/framework/commands WITHOUT calling an API.
 *   2. AI FALLBACK: If heuristic is inconclusive OR no Dockerfile exists,
 *      call OpenAI GPT-4o-mini for structured analysis.
 *   3. DOCKERFILE GENERATION: Use built-in templates when possible;
 *      fall back to AI-generated Dockerfile for exotic stacks.
 */
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

// Lazy-init: OpenAI client created on first use (dotenv may not have run yet)
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/* ── Build-time env-var prefix patterns ─────────────────────────── */
const BUILD_TIME_PREFIXES = [
  "REACT_APP_",
  "NEXT_PUBLIC_",
  "VITE_",
  "VUE_APP_",
  "GATSBY_",
  "NUXT_ENV_",
];

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * Classify env vars into build-time and runtime buckets.
 * @param {Object} envVars  { KEY: "value", ... }
 * @returns {{ buildTime: Object, runtime: Object }}
 */
function classifyEnvVars(envVars = {}) {
  const buildTime = {};
  const runtime = {};

  for (const [key, value] of Object.entries(envVars)) {
    const isBuildTime = BUILD_TIME_PREFIXES.some((prefix) =>
      key.startsWith(prefix)
    );
    if (isBuildTime) {
      buildTime[key] = value;
    } else {
      runtime[key] = value;
    }
  }

  return { buildTime, runtime };
}

/**
 * Safely read a file's content (returns null if missing or too large).
 */
function safeRead(filePath, maxBytes = 20_000) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get a shallow directory listing (max 2 levels deep, max 200 items).
 */
function getFileTree(dir, depth = 0, maxDepth = 2) {
  const result = [];
  if (depth > maxDepth) return result;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "__pycache__" ||
        entry.name === "venv" ||
        entry.name === ".venv"
      )
        continue;

      const rel = path.relative(dir, path.join(dir, entry.name));
      const indent = "  ".repeat(depth);

      if (entry.isDirectory()) {
        result.push(`${indent}${rel}/`);
        const sub = getFileTree(
          path.join(dir, entry.name),
          depth + 1,
          maxDepth
        );
        result.push(...sub);
      } else {
        result.push(`${indent}${rel}`);
      }

      if (result.length > 200) break;
    }
  } catch {}
  return result;
}

/* ================================================================ */
/* HEURISTIC DETECTION                                               */
/* ================================================================ */

/**
 * Attempt to detect the stack using only file system heuristics.
 * Returns a partial DetectionResult or null if inconclusive.
 */
function heuristicDetect(buildContext) {
  const pkgPath = path.join(buildContext, "package.json");
  const reqPath = path.join(buildContext, "requirements.txt");
  const pipfilePath = path.join(buildContext, "Pipfile");
  const goModPath = path.join(buildContext, "go.mod");
  const gemfilePath = path.join(buildContext, "Gemfile");
  const cargoPath = path.join(buildContext, "Cargo.toml");
  const pomPath = path.join(buildContext, "pom.xml");
  const gradlePath = path.join(buildContext, "build.gradle");
  const pyprojectPath = path.join(buildContext, "pyproject.toml");

  /* ── Node.js ─────────────────────────────────────────────────── */
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      // Next.js
      if (allDeps["next"]) {
        return {
          language: "node",
          framework: "nextjs",
          buildCommand: "npm run build",
          startCommand: "npm start",
          port: 3000,
          isStaticSite: false,
          buildOutputDir: ".next",
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Nuxt
      if (allDeps["nuxt"] || allDeps["nuxt3"]) {
        return {
          language: "node",
          framework: "nuxt",
          buildCommand: "npm run build",
          startCommand: "npm start",
          port: 3000,
          isStaticSite: false,
          buildOutputDir: ".output",
          packageManager: detectPackageManager(buildContext),
        };
      }

      // React (CRA)
      if (allDeps["react-scripts"]) {
        return {
          language: "node",
          framework: "react",
          buildCommand: "npm run build",
          startCommand: null,
          port: 80,
          isStaticSite: true,
          buildOutputDir: "build",
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Vite
      if (allDeps["vite"]) {
        const isReact = !!allDeps["react"];
        const isVue = !!allDeps["vue"];
        return {
          language: "node",
          framework: isVue ? "vue" : isReact ? "react-vite" : "vite",
          buildCommand: "npm run build",
          startCommand: null,
          port: 80,
          isStaticSite: true,
          buildOutputDir: "dist",
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Angular
      if (allDeps["@angular/core"]) {
        return {
          language: "node",
          framework: "angular",
          buildCommand: "npm run build",
          startCommand: null,
          port: 80,
          isStaticSite: true,
          buildOutputDir: `dist/${pkg.name || "app"}`,
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Express / generic Node.js
      if (allDeps["express"] || allDeps["fastify"] || allDeps["koa"]) {
        const startCmd =
          pkg.scripts?.start || `node ${pkg.main || "index.js"}`;
        return {
          language: "node",
          framework: allDeps["express"]
            ? "express"
            : allDeps["fastify"]
              ? "fastify"
              : "koa",
          buildCommand: pkg.scripts?.build ? "npm run build" : null,
          startCommand: startCmd.startsWith("node") ? startCmd : "npm start",
          port: 3000,
          isStaticSite: false,
          buildOutputDir: null,
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Generic Node.js fallback
      return {
        language: "node",
        framework: "node",
        buildCommand: pkg.scripts?.build ? "npm run build" : null,
        startCommand:
          pkg.scripts?.start
            ? "npm start"
            : `node ${pkg.main || "index.js"}`,
        port: 3000,
        isStaticSite: false,
        buildOutputDir: null,
        packageManager: detectPackageManager(buildContext),
      };
    } catch {
      /* malformed package.json — fall through to AI */
    }
  }

  /* ── Vanilla HTML/JS ─────────────────────────────────────────── */
  if (fs.existsSync(path.join(buildContext, "index.html")) && !fs.existsSync(pkgPath)) {
    return {
      language: "html",
      framework: "vanilla",
      buildCommand: null,
      startCommand: null,
      port: 80,
      isStaticSite: true,
      buildOutputDir: ".",
      packageManager: "none",
    };
  }

  /* ── Python ──────────────────────────────────────────────────── */
  if (
    fs.existsSync(reqPath) ||
    fs.existsSync(pipfilePath) ||
    fs.existsSync(pyprojectPath)
  ) {
    const reqContent = safeRead(reqPath) || "";
    const pipContent = safeRead(pipfilePath) || "";
    const pyprojectContent = safeRead(pyprojectPath) || "";
    const allPyContent = reqContent + pipContent + pyprojectContent;

    // FastAPI
    if (/fastapi/i.test(allPyContent)) {
      const mainFile = findPythonEntrypoint(buildContext, "fastapi");
      return {
        language: "python",
        framework: "fastapi",
        buildCommand: null,
        startCommand: `uvicorn ${mainFile}:app --host 0.0.0.0 --port 8000`,
        port: 8000,
        isStaticSite: false,
        buildOutputDir: null,
        packageManager: fs.existsSync(pipfilePath) ? "pipenv" : "pip",
      };
    }

    // Flask
    if (/flask/i.test(allPyContent)) {
      const mainFile = findPythonEntrypoint(buildContext, "flask");
      return {
        language: "python",
        framework: "flask",
        buildCommand: null,
        startCommand: `gunicorn --bind 0.0.0.0:5000 ${mainFile}:app`,
        port: 5000,
        isStaticSite: false,
        buildOutputDir: null,
        packageManager: fs.existsSync(pipfilePath) ? "pipenv" : "pip",
      };
    }

    // Django
    if (/django/i.test(allPyContent)) {
      return {
        language: "python",
        framework: "django",
        buildCommand: "python manage.py collectstatic --noinput",
        startCommand:
          "gunicorn --bind 0.0.0.0:8000 config.wsgi:application",
        port: 8000,
        isStaticSite: false,
        buildOutputDir: null,
        packageManager: fs.existsSync(pipfilePath) ? "pipenv" : "pip",
      };
    }

    // Generic Python
    return {
      language: "python",
      framework: "python",
      buildCommand: null,
      startCommand: "python main.py",
      port: 8000,
      isStaticSite: false,
      buildOutputDir: null,
      packageManager: fs.existsSync(pipfilePath) ? "pipenv" : "pip",
    };
  }

  /* ── Go ──────────────────────────────────────────────────────── */
  if (fs.existsSync(goModPath)) {
    return {
      language: "go",
      framework: "go",
      buildCommand: "go build -o app .",
      startCommand: "./app",
      port: 8080,
      isStaticSite: false,
      buildOutputDir: null,
      packageManager: "go",
    };
  }

  /* ── Not detected ────────────────────────────────────────────── */
  return null;
}

/**
 * Detect which package manager is used (npm, yarn, pnpm).
 */
function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Find the Python entrypoint module name (for uvicorn/gunicorn).
 * Looks for main.py, app.py, server.py, wsgi.py in project root.
 */
function findPythonEntrypoint(dir, framework) {
  const candidates = ["main", "app", "server", "wsgi", "api"];
  for (const name of candidates) {
    if (fs.existsSync(path.join(dir, `${name}.py`))) {
      return name;
    }
  }
  // Default based on framework
  return framework === "fastapi" ? "main" : "app";
}

/* ================================================================ */
/* DOCKERFILE GENERATION (template-based)                            */
/* ================================================================ */

/**
 * Generate a Dockerfile from built-in templates.
 * @param {Object} detection  – result from heuristicDetect or AI
 * @param {Object} buildTimeEnvs – env vars to inject at build time
 * @returns {string} Dockerfile content
 */
function generateDockerfile(detection, buildTimeEnvs = {}) {
  const {
    language,
    framework,
    buildCommand,
    startCommand,
    port,
    isStaticSite,
    buildOutputDir,
    packageManager,
  } = detection;

  const installCmd =
    packageManager === "yarn"
      ? "yarn install --frozen-lockfile"
      : packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : "npm ci --legacy-peer-deps";

  // Build-time ARG + ENV lines
  const buildArgLines = Object.keys(buildTimeEnvs)
    .map((k) => `ARG ${k}\nENV ${k}=\${${k}}`)
    .join("\n");

  /* ── Node.js Static (React, Vite, Angular) ───────────────────── */
  if (language === "node" && isStaticSite) {
    return `
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json yarn.lock* pnpm-lock.yaml* ./
RUN ${installCmd}
COPY . .
${buildArgLines}
RUN ${buildCommand || "npm run build"}

FROM nginx:alpine
COPY --from=builder /app/${buildOutputDir || "dist"} /usr/share/nginx/html
# SPA fallback: serve index.html for all routes, carefully escaping $uri
RUN printf 'server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files %suri %suri/ /index.html; } }' '$' '$' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`.trim();
  }

  /* ── Vanilla HTML/JS Static ───────────────────────────────────── */
  if (language === "html" && isStaticSite) {
    return `
FROM nginx:alpine
COPY . /usr/share/nginx/html
# SPA fallback: serve index.html for all routes, carefully escaping $uri
RUN printf 'server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files %suri %suri/ /index.html; } }' '$' '$' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`.trim();
  }

  /* ── Node.js SSR (Next.js, Nuxt, Express) ────────────────────── */
  if (language === "node") {
    const buildStep = buildCommand ? `RUN ${buildCommand}` : "";
    // Parse start command to CMD format
    const cmdParts = (startCommand || "npm start")
      .split(" ")
      .map((s) => `"${s}"`)
      .join(", ");

    return `
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json yarn.lock* pnpm-lock.yaml* ./
RUN ${installCmd}
COPY . .
${buildArgLines}
${buildStep}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app ./
EXPOSE ${port || 3000}
CMD [${cmdParts}]
`.trim();
  }

  /* ── Python (FastAPI, Flask, Django) ──────────────────────────── */
  if (language === "python") {
    const installDeps = detection.packageManager === "pipenv"
      ? "RUN pip install pipenv && pipenv install --deploy --system"
      : "COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt";

    const buildStep = buildCommand ? `RUN ${buildCommand}` : "";

    // For FastAPI/Flask we need gunicorn or uvicorn
    let extraInstall = "";
    if (framework === "fastapi") {
      extraInstall = "RUN pip install --no-cache-dir uvicorn[standard]";
    } else if (framework === "flask") {
      extraInstall = "RUN pip install --no-cache-dir gunicorn";
    } else if (framework === "django") {
      extraInstall = "RUN pip install --no-cache-dir gunicorn";
    }

    // Parse start command to CMD format
    const cmdParts = (startCommand || "python main.py")
      .split(" ")
      .map((s) => `"${s}"`)
      .join(", ");

    return `
FROM python:3.12-slim
WORKDIR /app
${installDeps}
${extraInstall}
COPY . .
${buildStep}
EXPOSE ${port || 8000}
CMD [${cmdParts}]
`.trim();
  }

  /* ── Go ──────────────────────────────────────────────────────── */
  if (language === "go") {
    return `
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o app .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/app .
EXPOSE ${port || 8080}
CMD ["./app"]
`.trim();
  }

  // Should not reach here — AI fallback will handle unknown stacks
  return null;
}

/* ================================================================ */
/* AI FALLBACK — OpenAI for unknown/complex stacks                   */
/* ================================================================ */

/**
 * Call OpenAI to analyze repo and produce detection + Dockerfile.
 */
async function aiDetect(buildContext) {
  const fileTree = getFileTree(buildContext).join("\n");

  // Gather key file contents
  const keyFiles = {};
  const candidates = [
    "package.json",
    "requirements.txt",
    "Pipfile",
    "pyproject.toml",
    "go.mod",
    "Gemfile",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "Makefile",
    "docker-compose.yml",
    "Procfile",
  ];

  for (const file of candidates) {
    const content = safeRead(path.join(buildContext, file));
    if (content) keyFiles[file] = content.slice(0, 3000); // truncate
  }

  const prompt = `You are a DevOps expert. Analyze this Git repository and determine the deployment configuration.

## Repository File Structure:
${fileTree}

## Key File Contents:
${Object.entries(keyFiles)
  .map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``)
  .join("\n\n")}

## Respond with ONLY valid JSON, no markdown fences, no explanation:
{
  "language": "node" | "python" | "go" | "ruby" | "java" | "unknown",
  "framework": "nextjs" | "react" | "vue" | "express" | "fastapi" | "flask" | "django" | "unknown",
  "buildCommand": "npm run build" | null,
  "startCommand": "npm start" | "uvicorn main:app --host 0.0.0.0 --port 8000",
  "port": 3000,
  "isStaticSite": false,
  "buildOutputDir": "build" | ".next" | "dist" | null,
  "packageManager": "npm" | "yarn" | "pnpm" | "pip",
  "dockerfile": "...full Dockerfile content if no Dockerfile exists in repo, otherwise null..."
}`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[aiStackDetector] OpenAI call failed:", err.message);
    return null;
  }
}

/* ================================================================ */
/* PUBLIC API                                                        */
/* ================================================================ */

/**
 * Detect stack and generate Dockerfile for a cloned repository.
 *
 * @param {string} buildContext   Absolute path to the cloned repo (or subdirectory).
 * @param {Object} envVars        User-provided environment variables.
 * @param {Object} userOverrides  Optional user-provided overrides { buildCommand, startCommand, port, framework }.
 * @returns {Promise<DetectionResult>}
 *
 * DetectionResult = {
 *   language, framework, buildCommand, startCommand, port,
 *   isStaticSite, buildOutputDir, packageManager,
 *   dockerfile,            // string — the Dockerfile to use
 *   buildTimeEnvs,         // object — vars to pass as --build-arg
 *   runtimeEnvs,           // object — vars for K8s ConfigMap
 *   detectedBy,            // "heuristic" | "ai" | "existing"
 * }
 */
async function detectStack(buildContext, envVars = {}, userOverrides = {}) {
  const hasDockerfile = fs.existsSync(
    path.join(buildContext, "Dockerfile")
  );

  // Classify env vars
  const { buildTime: buildTimeEnvs, runtime: runtimeEnvs } =
    classifyEnvVars(envVars);

  // If user-provided Dockerfile exists, still detect stack for metadata
  if (hasDockerfile) {
    const existingDockerfile = fs.readFileSync(
      path.join(buildContext, "Dockerfile"),
      "utf-8"
    );

    // Still run heuristic for metadata
    let detection = heuristicDetect(buildContext) || {};
    // Apply user overrides
    detection = applyOverrides(detection, userOverrides);

    return {
      ...detection,
      dockerfile: existingDockerfile,
      buildTimeEnvs,
      runtimeEnvs,
      detectedBy: "existing",
    };
  }

  // 1. Try heuristic detection
  let detection = heuristicDetect(buildContext);
  let detectedBy = "heuristic";

  // 2. Fallback to AI if heuristic failed
  if (!detection) {
    console.log(
      "[aiStackDetector] Heuristic inconclusive. Calling OpenAI..."
    );
    const aiResult = await aiDetect(buildContext);

    if (aiResult) {
      detection = aiResult;
      detectedBy = "ai";

      // If AI provided a dockerfile directly, use it
      if (aiResult.dockerfile) {
        detection = applyOverrides(detection, userOverrides);
        return {
          ...detection,
          dockerfile: aiResult.dockerfile,
          buildTimeEnvs,
          runtimeEnvs,
          detectedBy: "ai",
        };
      }
    } else {
      // Complete failure — generic Node.js fallback
      console.warn(
        "[aiStackDetector] AI detection also failed. Using generic Node.js fallback."
      );
      detection = {
        language: "node",
        framework: "unknown",
        buildCommand: null,
        startCommand: "npm start",
        port: 3000,
        isStaticSite: false,
        buildOutputDir: null,
        packageManager: "npm",
      };
      detectedBy = "heuristic";
    }
  }

  // Apply user overrides
  detection = applyOverrides(detection, userOverrides);

  // 3. Generate Dockerfile from template
  let dockerfile = generateDockerfile(detection, buildTimeEnvs);

  // 4. If template generation failed, ask AI to generate
  if (!dockerfile) {
    console.log(
      "[aiStackDetector] Template unavailable for this stack. Asking AI to generate Dockerfile..."
    );
    const aiResult = await aiDetect(buildContext);
    if (aiResult?.dockerfile) {
      dockerfile = aiResult.dockerfile;
      detectedBy = "ai";
    } else {
      throw new Error(
        `Unable to generate Dockerfile for detected stack: ${detection.language}/${detection.framework}`
      );
    }
  }

  return {
    ...detection,
    dockerfile,
    buildTimeEnvs,
    runtimeEnvs,
    detectedBy,
  };
}

/**
 * Apply user overrides to detection result (user-provided values take priority).
 */
function applyOverrides(detection, overrides = {}) {
  const result = { ...detection };
  if (overrides.buildCommand) result.buildCommand = overrides.buildCommand;
  if (overrides.startCommand) result.startCommand = overrides.startCommand;
  if (overrides.port) result.port = overrides.port;
  if (overrides.framework) result.framework = overrides.framework;
  if (overrides.buildDirectory) result.buildOutputDir = overrides.buildDirectory;
  return result;
}

module.exports = {
  detectStack,
  classifyEnvVars,
  heuristicDetect,
  generateDockerfile,

  // Exported for testing
  _aiDetect: aiDetect,
  _getFileTree: getFileTree,
  _findPythonEntrypoint: findPythonEntrypoint,
};
