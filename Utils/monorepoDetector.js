/**
 * monorepoDetector.js
 * ─────────────────────────────────────────────────────────────────────
 * Monorepo structure detection and multi-service discovery.
 *
 * Detects common monorepo patterns:
 *   - /frontend + /backend (or /client + /server)
 *   - /apps/* (Next.js / Turborepo convention)
 *   - /services/* (microservice convention)
 *   - /packages/* with workspaces
 *   - turbo.json, lerna.json, nx.json, pnpm-workspace.yaml
 *
 * Returns a list of discovered services with stack detection per service.
 * The user then selects which services to deploy.
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

// Import heuristic detection from aiStackDetector
const { heuristicDetect } = require("./aiStackDetector");

// Lazy-init OpenAI client
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/* ── Known monorepo directory patterns ────────────────────────────── */

/**
 * Well-known paired directory patterns that indicate a monorepo.
 * Each entry: [array of possible names for service A, array for service B]
 */
const PAIRED_PATTERNS = [
  {
    names: ["frontend", "backend"],
    type: "fullstack",
  },
  {
    names: ["client", "server"],
    type: "fullstack",
  },
  {
    names: ["web", "api"],
    type: "fullstack",
  },
  {
    names: ["app", "api"],
    type: "fullstack",
  },
  {
    names: ["ui", "api"],
    type: "fullstack",
  },
];

/**
 * Multi-service directory patterns (glob-like).
 * These dirs contain multiple sub-services.
 */
const MULTI_SERVICE_DIRS = ["apps", "services", "microservices", "packages"];

/**
 * Monorepo tool indicators (files in root).
 */
const MONOREPO_TOOL_FILES = [
  "turbo.json",        // Turborepo
  "lerna.json",        // Lerna
  "nx.json",           // Nx
  "pnpm-workspace.yaml", // pnpm workspaces
  "rush.json",         // Rush
];

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Check if a directory has a deployable app (has dependency manifest or source code).
 */
function isDeployableDir(dirPath) {
  const indicators = [
    "package.json",
    "requirements.txt",
    "Pipfile",
    "pyproject.toml",
    "go.mod",
    "Gemfile",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "index.html",
    "Dockerfile",
  ];

  return indicators.some((f) => fs.existsSync(path.join(dirPath, f)));
}

/**
 * Detect service from a subdirectory.
 *
 * @param {string} baseDir - root of cloned repo
 * @param {string} subDir - relative path to subdirectory
 * @returns {ServiceInfo | null}
 */
function detectService(baseDir, subDir) {
  const fullPath = path.join(baseDir, subDir);

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return null;
  }

  if (!isDeployableDir(fullPath)) {
    return null;
  }

  // Run heuristic detection on this subdirectory
  const detection = heuristicDetect(fullPath);

  if (!detection) {
    // Still return a basic service entry (AI can fill in later)
    return {
      name: path.basename(subDir),
      path: subDir,
      language: "unknown",
      framework: "unknown",
      port: 3000,
      buildCommand: null,
      startCommand: null,
      isStaticSite: false,
      hasDependencies: fs.existsSync(path.join(fullPath, "package.json")) ||
                       fs.existsSync(path.join(fullPath, "requirements.txt")),
      hasDockerfile: fs.existsSync(path.join(fullPath, "Dockerfile")),
    };
  }

  return {
    name: path.basename(subDir),
    path: subDir,
    language: detection.language,
    framework: detection.framework,
    port: detection.port,
    buildCommand: detection.buildCommand,
    startCommand: detection.startCommand,
    isStaticSite: detection.isStaticSite || false,
    hasDependencies: true,
    hasDockerfile: fs.existsSync(path.join(fullPath, "Dockerfile")),
  };
}

/* ── Main detection logic ─────────────────────────────────────────── */

/**
 * Detect monorepo structure in a cloned repository.
 *
 * @param {string} buildContext - path to cloned repo root
 * @returns {Promise<MonorepoDetectionResult>}
 *
 * MonorepoDetectionResult = {
 *   isMonorepo: boolean,
 *   type: "fullstack" | "multi-app" | "workspaces" | "single",
 *   monorepoTool: string | null,           // turbo, lerna, nx, pnpm, etc.
 *   services: ServiceInfo[],               // all detected services
 *   rootIsDeployable: boolean,             // whether root itself is deployable
 *   detectedBy: "filesystem" | "ai",
 * }
 */
async function detectMonorepo(buildContext) {
  const services = [];
  let type = "single";
  let monorepoTool = null;
  let detectedBy = "filesystem";

  // 1. Check for monorepo tool files
  for (const toolFile of MONOREPO_TOOL_FILES) {
    if (fs.existsSync(path.join(buildContext, toolFile))) {
      monorepoTool = toolFile.replace(/\.(json|yaml)$/, "");
      break;
    }
  }

  // 2. Check for workspace config in root package.json
  const rootPkgPath = path.join(buildContext, "package.json");
  if (fs.existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
      if (pkg.workspaces) {
        monorepoTool = monorepoTool || "npm-workspaces";
      }
    } catch { /* malformed package.json */ }
  }

  // 3. Check for paired directory patterns (frontend/backend, client/server)
  for (const pattern of PAIRED_PATTERNS) {
    const foundDirs = pattern.names.filter((name) => {
      const dirPath = path.join(buildContext, name);
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    });

    if (foundDirs.length >= 2) {
      // Found a paired pattern — detect each as a service
      for (const dirName of foundDirs) {
        const service = detectService(buildContext, dirName);
        if (service) {
          services.push(service);
        }
      }
      type = pattern.type;
      break; // Use first matching pattern
    }
  }

  // 4. Check multi-service directories (apps/*, services/*)
  if (services.length === 0) {
    for (const multiDir of MULTI_SERVICE_DIRS) {
      const multiDirPath = path.join(buildContext, multiDir);
      if (fs.existsSync(multiDirPath) && fs.statSync(multiDirPath).isDirectory()) {
        try {
          const subDirs = fs.readdirSync(multiDirPath, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);

          for (const subDir of subDirs) {
            const service = detectService(buildContext, path.join(multiDir, subDir));
            if (service) {
              services.push(service);
            }
          }

          if (services.length > 0) {
            type = "multi-app";
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  // 5. Check if root itself is a deployable single app
  const rootIsDeployable = isDeployableDir(buildContext);

  // 6. If no services found via fs heuristics, try AI fallback
  if (services.length === 0 && rootIsDeployable) {
    // Check if there are subdirs with deployable content (minor monorepo pattern)
    try {
      const rootEntries = fs.readdirSync(buildContext, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") &&
            !["node_modules", "__pycache__", "venv", ".venv", "dist", "build", ".next", "coverage",
              "docs", "test", "tests", "spec", "__tests__", ".git"].includes(entry.name)) {
          if (isDeployableDir(path.join(buildContext, entry.name))) {
            const service = detectService(buildContext, entry.name);
            if (service) {
              services.push(service);
            }
          }
        }
      }
    } catch { /* ignore */ }

    // If we found subdirectory services AND root is also deployable,
    // let the user decide. Otherwise it's a single app.
    if (services.length > 0) {
      type = "fullstack";
    }
  }

  // 7. If still nothing, report as single-app
  if (services.length === 0) {
    if (rootIsDeployable) {
      const rootService = detectService(buildContext, ".");
      if (rootService) {
        rootService.name = "root";
        rootService.path = ".";
        services.push(rootService);
      }
    }
    type = "single";
  }

  const isMonorepo = services.length > 1;

  return {
    isMonorepo,
    type: isMonorepo ? type : "single",
    monorepoTool,
    services,
    rootIsDeployable,
    detectedBy,
  };
}

/**
 * AI-powered monorepo analysis for complex/ambiguous structures.
 * Called when filesystem heuristics fail to identify clear services.
 *
 * @param {string} buildContext - path to cloned repo
 * @returns {Promise<ServiceInfo[]>}
 */
async function aiDetectServices(buildContext) {
  try {
    // Build file tree
    const getFileTree = (dir, depth = 0, maxDepth = 3) => {
      const result = [];
      if (depth > maxDepth) return result;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (["node_modules", ".git", "__pycache__", "venv", ".venv", ".next", "dist", "build"].includes(entry.name)) continue;
          const indent = "  ".repeat(depth);
          if (entry.isDirectory()) {
            result.push(`${indent}${entry.name}/`);
            result.push(...getFileTree(path.join(dir, entry.name), depth + 1, maxDepth));
          } else {
            result.push(`${indent}${entry.name}`);
          }
          if (result.length > 200) break;
        }
      } catch { /* ignore */ }
      return result;
    };

    const fileTree = getFileTree(buildContext).join("\n");

    const prompt = `You are a DevOps expert analyzing a Git repository structure. Identify if this is a monorepo with multiple deployable services.

## Repository file structure:
${fileTree}

## Rules:
- Each service must be independently deployable (has its own dependency file)
- Return ONLY valid JSON, no markdown
- If NOT a monorepo, return { "services": [] }

## Respond with JSON:
{
  "services": [
    {
      "name": "service-name",
      "path": "relative/path",
      "language": "node" | "python" | "go",
      "framework": "express" | "nextjs" | "fastapi" | etc,
      "port": 3000,
      "isStaticSite": false
    }
  ]
}`;

    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1000,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    const parsed = JSON.parse(raw);
    return (parsed.services || []).map((s) => ({
      ...s,
      hasDependencies: true,
      hasDockerfile: fs.existsSync(path.join(buildContext, s.path, "Dockerfile")),
    }));
  } catch (err) {
    console.error("[monorepoDetector] AI detection failed:", err.message);
    return [];
  }
}

module.exports = {
  detectMonorepo,
  aiDetectServices,

  // Exported for testing
  _isDeployableDir: isDeployableDir,
  _detectService: detectService,
  _PAIRED_PATTERNS: PAIRED_PATTERNS,
  _MULTI_SERVICE_DIRS: MULTI_SERVICE_DIRS,
};
