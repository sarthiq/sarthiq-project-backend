/**
 * projectTypeDetector.js
 * ─────────────────────────────────────────────────────────────────────
 * Classifies a cloned repository as "frontend" (static site) or
 * "backend" (server-side application).
 *
 * Frontend projects skip Docker entirely and are served as static files.
 * Backend projects go through an optimized Docker pipeline.
 *
 * Uses the existing heuristicDetect() from aiStackDetector.js as the
 * primary signal, plus package.json dependency analysis for edge cases.
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");
const { heuristicDetect } = require("./aiStackDetector");

/**
 * Frameworks that produce static output and need NO runtime server.
 * These go through the frontend (no-Docker) pipeline.
 */
const STATIC_FRAMEWORKS = new Set([
  "react",        // Create React App
  "react-vite",   // Vite + React
  "vite",         // Vite standalone
  "vue",          // Vue (Vite-based)
  "angular",      // Angular CLI
  "svelte",       // Svelte/SvelteKit static
  "preact",       // Preact
  "vanilla",      // Plain HTML/JS/CSS
]);

/**
 * Frameworks that require a Node.js runtime (SSR, API, etc.).
 * These always go through the backend (Docker) pipeline.
 */
const BACKEND_FRAMEWORKS = new Set([
  "express",
  "fastify",
  "koa",
  "nextjs",       // SSR — requires Node.js server
  "nuxt",         // SSR — requires Node.js server
  "node",         // Generic Node.js server
]);

/**
 * Frontend dependency names in package.json.
 * If these are the PRIMARY deps (no backend server deps), it's a frontend.
 */
const FRONTEND_DEPENDENCY_MARKERS = [
  "react",
  "react-dom",
  "vue",
  "@angular/core",
  "svelte",
  "preact",
  "@sveltejs/kit",
  "vite",
  "@vitejs/plugin-react",
  "@vitejs/plugin-vue",
  "react-scripts",     // CRA
  "@angular/cli",
  "parcel",
  "webpack",           // Often frontend bundler
];

/**
 * Backend dependency names in package.json that confirm server-side nature.
 * If ANY of these are present AND no frontend framework is detected,
 * the project is classified as backend.
 */
const BACKEND_DEPENDENCY_MARKERS = [
  "express",
  "fastify",
  "koa",
  "@nestjs/core",
  "hapi",
  "@hapi/hapi",
  "restify",
  "socket.io",
  "ws",
  "graphql-yoga",
  "apollo-server",
  "@apollo/server",
  "mongoose",
  "sequelize",
  "typeorm",
  "prisma",
  "@prisma/client",
  "knex",
  "pg",
  "mysql2",
  "redis",
  "ioredis",
  "bullmq",
  "bull",
];

/**
 * Detect whether a project is frontend (static) or backend (server).
 *
 * @param {string} buildContext  Absolute path to the cloned repository.
 * @param {object|null} existingDetection  Optional: pre-computed detection
 *        from aiStackDetector.detectStack(). If provided, heuristic
 *        detection is skipped (saves ~0ms but avoids re-reading files).
 * @returns {{ type: "frontend" | "backend", reason: string, detection: object }}
 */
function detectProjectType(buildContext, existingDetection = null) {
  // Use existing detection or run heuristic
  const detection = existingDetection || heuristicDetect(buildContext);

  // If heuristic failed entirely, default to backend (safer — Docker handles anything)
  if (!detection) {
    return {
      type: "backend",
      reason: "Heuristic detection failed — defaulting to backend (safest path)",
      detection: null,
    };
  }

  // ── Non-Node.js languages are always backend ──
  if (detection.language && detection.language !== "node" && detection.language !== "html") {
    return {
      type: "backend",
      reason: `Non-Node.js language: ${detection.language}/${detection.framework}`,
      detection,
    };
  }

  // ── Vanilla HTML/JS is always frontend ──
  if (detection.language === "html") {
    return {
      type: "frontend",
      reason: "Vanilla HTML/JS static site",
      detection,
    };
  }

  // ── Explicit isStaticSite flag from AI → frontend ──
  if (detection.isStaticSite === true) {
    return {
      type: "frontend",
      reason: `isStaticSite=true (framework: ${detection.framework})`,
      detection,
    };
  }

  // ── Read package.json for dependency analysis ──
  let allDeps = {};
  let productionDeps = {};
  const pkgPath = path.join(buildContext, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      productionDeps = pkg.dependencies || {};
      allDeps = { ...productionDeps, ...(pkg.devDependencies || {}) };
    } catch {
      // Malformed package.json
    }
  }

  const hasFrontendDep = FRONTEND_DEPENDENCY_MARKERS.some((d) => allDeps[d]);
  const hasBackendDep = BACKEND_DEPENDENCY_MARKERS.some((d) => productionDeps[d]);

  // ── Framework-based classification ──
  const framework = (detection.framework || "").toLowerCase();

  // Known backend framework → backend
  if (BACKEND_FRAMEWORKS.has(framework)) {
    return {
      type: "backend",
      reason: `Backend framework: ${framework}`,
      detection,
    };
  }

  // Known static framework → frontend (no need for isStaticSite flag)
  if (STATIC_FRAMEWORKS.has(framework)) {
    return {
      type: "frontend",
      reason: `Static framework: ${framework}`,
      detection,
    };
  }

  // ── Package.json dependency analysis (for cached/stale detection) ──

  // Has frontend deps (react, vue, etc.) and NO backend server deps → frontend
  if (hasFrontendDep && !hasBackendDep) {
    const frontendDep = FRONTEND_DEPENDENCY_MARKERS.find((d) => allDeps[d]);
    return {
      type: "frontend",
      reason: `Frontend dependency: ${frontendDep} (no backend server deps)`,
      detection,
    };
  }

  // Has backend deps → backend
  if (hasBackendDep) {
    const backendDep = BACKEND_DEPENDENCY_MARKERS.find((d) => productionDeps[d]);
    return {
      type: "backend",
      reason: `Backend dependency: ${backendDep}`,
      detection,
    };
  }

  // ── Final fallback: backend (safer) ──
  return {
    type: "backend",
    reason: `Default to backend (framework: ${detection.framework}, isStaticSite: ${detection.isStaticSite})`,
    detection,
  };
}

module.exports = { detectProjectType, STATIC_FRAMEWORKS, BACKEND_FRAMEWORKS };
