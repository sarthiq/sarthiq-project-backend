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
const { validateDockerfile, validateBuildCommand } = require("./securityValidator");

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
        entry.name === ".venv" ||
        // ── Security: hide secret files from AI analysis ──
        entry.name === ".env" ||
        entry.name === ".env.local" ||
        entry.name === ".env.production" ||
        entry.name === ".env.development" ||
        entry.name.endsWith(".key") ||
        entry.name.endsWith(".pem") ||
        entry.name.endsWith(".p12") ||
        entry.name === ".git-credentials" ||
        entry.name === ".npmrc" ||
        entry.name === ".pypirc" ||
        entry.name === "id_rsa" ||
        entry.name === "id_ed25519" ||
        entry.name === ".docker" ||
        entry.name === ".kube"
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
          port: 8080,
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
          port: 8080,
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
          port: 8080,
          isStaticSite: true,
          buildOutputDir: `dist/${pkg.name || "app"}`,
          packageManager: detectPackageManager(buildContext),
        };
      }

      // Express / generic Node.js
      if (allDeps["express"] || allDeps["fastify"] || allDeps["koa"]) {
        let startCmd =
          pkg.scripts?.start || `node ${pkg.main || "index.js"}`;
        // NEVER use nodemon in production — replace with node
        startCmd = startCmd.replace(/nodemon/g, "node");
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
      {
        let fallbackStart = pkg.scripts?.start
          ? "npm start"
          : `node ${pkg.main || "index.js"}`;
        // NEVER use nodemon in production — replace with node
        fallbackStart = fallbackStart.replace(/nodemon/g, "node");
        return {
          language: "node",
          framework: "node",
          buildCommand: pkg.scripts?.build ? "npm run build" : null,
          startCommand: fallbackStart,
          port: 3000,
          isStaticSite: false,
          buildOutputDir: null,
          packageManager: detectPackageManager(buildContext),
        };
      }
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
      startCommand: "npx serve -s .",
      port: 8080,
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

  /* ── Java (Maven) ───────────────────────────────────────────── */
  if (fs.existsSync(pomPath)) {
    const pomContent = safeRead(pomPath) || "";
    const isSpringBoot = /spring-boot/i.test(pomContent);
    return {
      language: "java",
      framework: isSpringBoot ? "spring-boot" : "maven",
      buildCommand: "mvn clean package -DskipTests",
      startCommand: "java -jar target/*.jar",
      port: isSpringBoot ? 8080 : 8080,
      isStaticSite: false,
      buildOutputDir: "target",
      packageManager: "maven",
    };
  }

  /* ── Java (Gradle) ──────────────────────────────────────────── */
  if (fs.existsSync(gradlePath)) {
    const gradleContent = safeRead(gradlePath) || "";
    const isSpringBoot = /spring-boot/i.test(gradleContent) || /org\.springframework\.boot/i.test(gradleContent);
    const hasWrapper = fs.existsSync(path.join(buildContext, "gradlew"));
    const gradleCmd = hasWrapper ? "./gradlew" : "gradle";
    return {
      language: "java",
      framework: isSpringBoot ? "spring-boot" : "gradle",
      buildCommand: `${gradleCmd} build -x test`,
      startCommand: "java -jar build/libs/*.jar",
      port: 8080,
      isStaticSite: false,
      buildOutputDir: "build/libs",
      packageManager: "gradle",
    };
  }

  /* ── Ruby (Gemfile) ─────────────────────────────────────────── */
  if (fs.existsSync(gemfilePath)) {
    const gemContent = safeRead(gemfilePath) || "";
    const isRails = /rails/i.test(gemContent);
    return {
      language: "ruby",
      framework: isRails ? "rails" : "ruby",
      buildCommand: isRails ? "bundle exec rails assets:precompile" : null,
      startCommand: isRails ? "bundle exec rails server -b 0.0.0.0 -p 3000" : "bundle exec ruby app.rb",
      port: 3000,
      isStaticSite: false,
      buildOutputDir: null,
      packageManager: "bundler",
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

  // Use forgiving install commands — 'npm ci' and '--frozen-lockfile' fail
  // when lock files are out of sync or missing, which is common on user-submitted repos.
  // Strategy: check for lockfile existence, then use strict or permissive install.
  // Use BuildKit cache mounts to persist npm/yarn/pnpm cache across builds.
  const installCmd =
    packageManager === "yarn"
      ? "RUN --mount=type=cache,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn yarn install --frozen-lockfile || yarn install"
      : packageManager === "pnpm"
        ? "RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile || pnpm install"
        : "RUN --mount=type=cache,target=/root/.npm if [ -f package-lock.json ]; then npm ci --legacy-peer-deps; else npm install --legacy-peer-deps; fi";

  // Robust COPY for package files: package.json is required,
  // lockfiles are optional — use separate COPY so missing lockfiles don't fail.
  // Docker's COPY with wildcard only fails if NO files match; package*.json always matches package.json.
  const copyPackageFiles = `COPY package.json package-lock.jso[n] yarn.loc[k] pnpm-lock.yam[l] ./`;

  // Build-time ARG + ENV lines
  const buildArgLines = Object.keys(buildTimeEnvs)
    .map((k) => `ARG ${k}\nENV ${k}=\${${k}}`)
    .join("\n");

  /* ── Node.js Static (React, Vite, Angular) ───────────────────── */
  if (language === "node" && isStaticSite) {
    return `
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
${copyPackageFiles}
${installCmd}
COPY . .
${buildArgLines}
RUN ${buildCommand || "npm run build"}

FROM nginxinc/nginx-unprivileged:alpine
COPY --from=builder /app/${buildOutputDir || "dist"} /usr/share/nginx/html
# SPA fallback: serve index.html for all routes, carefully escaping $uri
USER root
RUN printf 'server { listen 8080; root /usr/share/nginx/html; index index.html; location / { try_files %suri %suri/ /index.html; } }' '$' '$' > /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
`.trim();
  }

  /* ── Vanilla HTML/JS Static ───────────────────────────────────── */
  if (language === "html" && isStaticSite) {
    return `
FROM nginxinc/nginx-unprivileged:alpine
COPY . /usr/share/nginx/html
# SPA fallback: serve index.html for all routes, carefully escaping $uri
USER root
RUN printf 'server { listen 8080; root /usr/share/nginx/html; index index.html; location / { try_files %suri %suri/ /index.html; } }' '$' '$' > /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
`.trim();
  }

  /* ── Next.js (SSR — optimized production image) ──────────────── */
  if (language === "node" && framework === "nextjs") {
    return `
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
${copyPackageFiles}
${installCmd}
COPY . .
${buildArgLines}
ENV NEXT_TELEMETRY_DISABLED=1
RUN ${buildCommand || "npm run build"} && \
    npm prune --production 2>/dev/null; rm -rf .next/cache

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOST=0.0.0.0 HOSTNAME=0.0.0.0
# Copy only production essentials (NOT the entire /app)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config* ./
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser
EXPOSE ${port || 3000}
CMD ["npm", "start"]
`.trim();
  }

  /* ── Nuxt (SSR — optimized production image) ─────────────────── */
  if (language === "node" && framework === "nuxt") {
    return `
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
${copyPackageFiles}
${installCmd}
COPY . .
${buildArgLines}
RUN ${buildCommand || "npm run build"}

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0
COPY --from=builder /app/.output ./.output
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser
EXPOSE ${port || 3000}
CMD ["node", ".output/server/index.mjs"]
`.trim();
  }

  /* ── Node.js SSR (Express, Fastify, Koa, generic) ────────────── */
  if (language === "node") {
    const buildStep = buildCommand ? `RUN ${buildCommand}` : "";
    // NEVER use nodemon in production — replace with node
    let safeStartCmd = (startCommand || "npm start").replace(/nodemon/g, "node");
    // Parse start command to CMD format
    const cmdParts = safeStartCmd
      .split(" ")
      .map((s) => `"${s}"`)
      .join(", ");

    return `
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
${copyPackageFiles}
${installCmd}

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${buildArgLines}
${buildStep}
# Remove dev dependencies for smaller production image
RUN npm prune --production 2>/dev/null; true

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0
# Copy only production essentials
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
${buildCommand ? "COPY --from=builder /app/dist ./dist" : "COPY --from=builder /app ./"}
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser
EXPOSE ${port || 3000}
CMD [${cmdParts}]
`.trim();
  }

  /* ── Python (FastAPI, Flask, Django) — multi-stage build ──────── */
  if (language === "python") {
    const installDeps = detection.packageManager === "pipenv"
      ? "RUN pip install --no-cache-dir pipenv && pipenv install --deploy --system"
      : "COPY requirements.txt ./\nRUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt";

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
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder
WORKDIR /app
${installDeps}
${extraInstall}
COPY . .
${buildStep}

FROM python:3.12-slim
WORKDIR /app
# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /app .
RUN addgroup --gid 1001 appgroup && adduser --uid 1001 --gid 1001 --disabled-password appuser
USER appuser
EXPOSE ${port || 8000}
CMD [${cmdParts}]
`.trim();
  }

  /* ── Go ──────────────────────────────────────────────────────── */
  if (language === "go") {
    return `
# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o app .

FROM scratch
COPY --from=builder /app/app /app
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE ${port || 8080}
USER 1000
ENTRYPOINT ["/app"]
`.trim();
  }

  /* ── Java (Maven) ───────────────────────────────────────────── */
  if (language === "java" && (framework === "maven" || framework === "spring-boot") && packageManager === "maven") {
    return `
FROM maven:3.9-eclipse-temurin-21-alpine AS builder
WORKDIR /app
COPY pom.xml ./
RUN mvn dependency:go-offline -B
COPY . .
RUN mvn clean package -DskipTests -B

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
USER appuser
EXPOSE ${port || 8080}
CMD ["java", "-jar", "app.jar"]
`.trim();
  }

  /* ── Java (Gradle) ──────────────────────────────────────────── */
  if (language === "java" && (framework === "gradle" || framework === "spring-boot") && packageManager === "gradle") {
    return `
FROM gradle:8.5-jdk21-alpine AS builder
WORKDIR /app
COPY build.gradle* settings.gradle* gradlew* ./
COPY gradle/ gradle/ 2>/dev/null || true
RUN gradle dependencies --no-daemon 2>/dev/null || true
COPY . .
RUN gradle build -x test --no-daemon

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
USER appuser
EXPOSE ${port || 8080}
CMD ["java", "-jar", "app.jar"]
`.trim();
  }

  /* ── Ruby ────────────────────────────────────────────────────── */
  if (language === "ruby") {
    const buildStep = buildCommand ? `RUN ${buildCommand}` : "";
    const cmdParts = (startCommand || "bundle exec ruby app.rb")
      .split(" ")
      .map((s) => `"${s}"`)
      .join(", ");

    return `
FROM ruby:3.3-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y build-essential libpq-dev nodejs && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock* ./
RUN bundle install --jobs 4 --retry 3
COPY . .
${buildStep}
RUN addgroup --gid 1001 appgroup && adduser --uid 1001 --gid 1001 --disabled-password appuser
USER appuser
EXPOSE ${port || 3000}
CMD [${cmdParts}]
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

  const prompt = `You are a DevOps expert analyzing a Git repository for deployment configuration.

## SECURITY RULES (MANDATORY — DO NOT VIOLATE):
- NEVER include 'curl | bash', 'wget | sh', or any pipe-to-shell patterns in commands or Dockerfiles
- NEVER use '--privileged' flag in any Docker command
- NEVER mount /var/run/docker.sock
- NEVER include 'nsenter', 'mount /proc', or host namespace access
- NEVER include secrets, API keys, or credentials in the output
- Generated Dockerfiles MUST end with a non-root USER instruction (e.g., USER 1000) unless using nginx
- Only use official base images (node, python, golang, nginx, alpine)

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
    const parsed = JSON.parse(raw);

    // ── Security: Validate AI-returned Dockerfile ──
    if (parsed.dockerfile) {
      const validation = validateDockerfile(parsed.dockerfile);
      if (!validation.safe) {
        console.warn(
          `[aiStackDetector] AI-generated Dockerfile REJECTED: ${validation.violations.join("; ")}`
        );
        parsed.dockerfile = null; // Force template fallback
      }
    }

    // ── Security: Validate AI-returned commands ──
    try {
      if (parsed.buildCommand) validateBuildCommand(parsed.buildCommand);
    } catch {
      console.warn(`[aiStackDetector] AI buildCommand rejected: ${parsed.buildCommand}`);
      parsed.buildCommand = null;
    }

    return parsed;
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
