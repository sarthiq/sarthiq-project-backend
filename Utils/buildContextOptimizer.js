/**
 * buildContextOptimizer.js
 * ─────────────────────────────────────────────────────────────────────
 * AI-powered build context optimizer for the SarthiQ deployment platform.
 *
 * Responsibilities:
 *   1. Generate or merge `.dockerignore` files (AI-enhanced)
 *   2. Clean up unnecessary files from build context
 *   3. Calculate dependency-hash fingerprint for cache reuse
 *   4. Estimate context size for logging
 *
 * Strategy:
 *   - DEFAULTS-FIRST: Use language-specific defaults for .dockerignore
 *   - AI ENHANCEMENT: Use GPT-4o-mini to analyze repo and add smart exclusions
 *   - MERGE: If .dockerignore exists, merge with optimized defaults
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");

// Lazy-init OpenAI client
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/* ── Language-specific .dockerignore defaults ──────────────────────── */

const UNIVERSAL_IGNORES = [
  "# === Universal ignores ===",
  ".git",
  ".gitignore",
  ".gitattributes",
  ".github",
  ".vscode",
  ".idea",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.md",
  "!README.md",
  "LICENSE",
  ".env",
  ".env.*",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "*.pem",
  "*.key",
  "*.p12",
  ".docker",
  ".kube",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  ".dockerignore",
  "Dockerfile*",
  ".editorconfig",
  ".prettierrc*",
  ".eslintrc*",
  ".eslintignore",
  ".stylelintrc*",
  "jest.config*",
  "vitest.config*",
  "cypress",
  "cypress.config*",
  "__tests__",
  "tests",
  "test",
  "spec",
  "*.test.*",
  "*.spec.*",
  "coverage",
  ".nyc_output",
  ".circleci",
  ".travis.yml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "Makefile",
  "docs",
  "documentation",
];

const NODE_IGNORES = [
  "# === Node.js specific ===",
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  "dist",
  "build",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "storybook-static",
  ".storybook",
  "*.tsbuildinfo",
  "tsconfig.tsbuildinfo",
  ".swc",
  ".npm",
  ".yarn/cache",
  ".yarn/unplugged",
  ".pnp.*",
];

const PYTHON_IGNORES = [
  "# === Python specific ===",
  "__pycache__",
  "*.pyc",
  "*.pyo",
  "*.pyd",
  ".Python",
  "venv",
  ".venv",
  "env",
  "pip-log.txt",
  "pip-delete-this-directory.txt",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "*.egg-info",
  "dist",
  "build",
  "htmlcov",
  ".eggs",
];

const GO_IGNORES = [
  "# === Go specific ===",
  "vendor",
  "*.exe",
  "*.test",
  "*.out",
];

const JAVA_IGNORES = [
  "# === Java specific ===",
  "target",
  "build",
  ".gradle",
  "*.class",
  "*.jar",
  "*.war",
  "*.ear",
  ".settings",
  ".classpath",
  ".project",
  "bin",
];

const RUBY_IGNORES = [
  "# === Ruby specific ===",
  "vendor/bundle",
  ".bundle",
  "tmp",
  "log",
  "*.gem",
  ".ruby-version",
  ".ruby-gemset",
];

/**
 * Safety negation patterns — placed at the END of .dockerignore.
 * Docker processes .dockerignore top-to-bottom; later '!' patterns override earlier excludes.
 * This guarantees source code files are NEVER accidentally excluded.
 */
const SAFETY_NEGATIONS = [
  "# === SAFETY: Always include source code (overrides any accidental exclusions) ===",
  "!src",
  "!src/**",
  "!public",
  "!public/**",
  "!app",
  "!app/**",
  "!pages",
  "!pages/**",
  "!components",
  "!components/**",
  "!styles",
  "!styles/**",
  "!lib",
  "!lib/**",
  "!server",
  "!server/**",
  "!client",
  "!client/**",
  // Common source directories that should NEVER be excluded
  "!store",
  "!store/**",
  "!hooks",
  "!hooks/**",
  "!utils",
  "!utils/**",
  "!services",
  "!services/**",
  "!types",
  "!types/**",
  "!context",
  "!context/**",
  "!providers",
  "!providers/**",
  "!middleware",
  "!middleware/**",
  "!helpers",
  "!helpers/**",
  "!api",
  "!api/**",
  "!models",
  "!models/**",
  "!config",
  "!config/**",
  "!constants",
  "!constants/**",
  "!assets",
  "!assets/**",
  "!static",
  "!static/**",
  "!package.json",
  "!package-lock.json",
  "!yarn.lock",
  "!pnpm-lock.yaml",
  "!tsconfig.json",
  "!tsconfig*.json",
  "!next.config*",
  "!vite.config*",
  "!postcss.config*",
  "!tailwind.config*",
  "!*.config.js",
  "!*.config.ts",
  "!*.config.mjs",
  "!requirements.txt",
  "!Pipfile",
  "!Pipfile.lock",
  "!pyproject.toml",
  "!go.mod",
  "!go.sum",
  "!Gemfile",
  "!Gemfile.lock",
  "!Dockerfile",
];

/**
 * Get language-specific ignore patterns.
 * @param {string} language - detected language (node, python, go, java, ruby)
 * @returns {string[]}
 */
function getLanguageIgnores(language) {
  switch (language) {
    case "node":
    case "html":
      return NODE_IGNORES;
    case "python":
      return PYTHON_IGNORES;
    case "go":
      return GO_IGNORES;
    case "java":
      return JAVA_IGNORES;
    case "ruby":
      return RUBY_IGNORES;
    default:
      return NODE_IGNORES; // safe default
  }
}

/* ── AI-powered .dockerignore generation ──────────────────────────── */

/**
 * Get a shallow file tree for AI analysis (same as aiStackDetector).
 */
function getFileTree(dir, depth = 0, maxDepth = 2) {
  const result = [];
  if (depth > maxDepth) return result;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (["node_modules", ".git", "__pycache__", "venv", ".venv", ".next", "dist", "build"].includes(entry.name)) {
        result.push(`  ${"  ".repeat(depth)}${entry.name}/ (EXCLUDED)`);
        continue;
      }
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        result.push(`${indent}${entry.name}/`);
        const sub = getFileTree(path.join(dir, entry.name), depth + 1, maxDepth);
        result.push(...sub);
      } else {
        result.push(`${indent}${entry.name}`);
      }
      if (result.length > 150) break;
    }
  } catch { /* ignore */ }
  return result;
}

/**
 * Use AI to generate additional smart exclusions based on repo analysis.
 * Returns extra lines for .dockerignore (beyond language defaults).
 *
 * @param {string} buildContext - path to cloned repo
 * @param {string} language - detected language
 * @returns {Promise<string[]>} additional ignore patterns
 */
async function aiGenerateExclusions(buildContext, language) {
  try {
    const fileTree = getFileTree(buildContext).join("\n");

    const prompt = `You are a Docker build optimization expert. Analyze this repository file tree and suggest additional .dockerignore patterns to minimize the Docker build context.

## Already excluded (do NOT repeat these):
${[...UNIVERSAL_IGNORES, ...getLanguageIgnores(language)].filter(l => !l.startsWith("#")).join("\n")}

## Repository file tree:
${fileTree}

## Language: ${language}

## Rules:
- Only suggest patterns for files/dirs that EXIST in the tree above
- Do NOT exclude source code files needed for the build
- Do NOT exclude dependency manifest files (package.json, requirements.txt, etc.)
- Focus on: IDE configs, CI files, documentation, examples, dev tools, sample data
- Return ONLY the patterns, one per line, no explanation
- If nothing additional to exclude, return "NONE"

Respond with ONLY the patterns (no markdown, no explanation):`;

    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";
    if (raw === "NONE" || !raw) return [];

    // Parse and validate patterns
    const patterns = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.length < 100)
      // Block anything that looks like it would exclude essential files
      .filter((l) => {
        // Block anything that would exclude essential source code or build files
        const BLOCKED_EXACT = [
          "package.json", "requirements.txt", "go.mod", "Gemfile", "pom.xml",
          "build.gradle", "Cargo.toml", "*.js", "*.ts", "*.py", "*.go", "*.java",
          "*.rb", "*.css", "*.scss", "*.sass", "*.less", "*.html", "*.htm",
          "*.json", "*.tsx", "*.jsx", "*.vue", "*.svelte", "*.mjs", "*.cjs",
          "*.yaml", "*.yml", "*.toml", "*.cfg", "*.ini", "*.xml",
          "src", "src/", "app", "app/", "lib", "lib/", "public", "public/",
          "pages", "pages/", "components", "components/", "styles", "styles/",
          "assets", "assets/", "static", "static/", "server", "server/",
          "client", "client/", "frontend", "frontend/", "backend", "backend/",
          // Common source directories that AI sometimes incorrectly excludes
          "store", "store/", "hooks", "hooks/", "utils", "utils/",
          "services", "services/", "types", "types/", "context", "context/",
          "providers", "providers/", "middleware", "middleware/",
          "helpers", "helpers/", "api", "api/", "models", "models/",
          "config", "config/", "constants", "constants/",
        ];
        if (BLOCKED_EXACT.includes(l)) return false;
        // Block wildcard patterns targeting source extensions
        if (/^\*\.\w+$/.test(l) && /\.(js|ts|tsx|jsx|css|scss|html|json|vue|svelte|py|go|java|rb|rs|php|c|cpp|h)$/.test(l)) return false;
        // Block patterns that exclude entire src-like directories
        if (/^(src|app|lib|public|pages|components|styles|assets|static|server|client|store|hooks|utils|services|types|context|providers|middleware|helpers|api|models|config|constants)\b/.test(l)) return false;
        return true;
      });

    return patterns.length > 0 ? ["# === AI-detected exclusions ===", ...patterns] : [];
  } catch (err) {
    console.warn("[buildContextOptimizer] AI exclusion generation failed:", err.message);
    return [];
  }
}

/* ── .dockerignore generation & merge ─────────────────────────────── */

/**
 * Generate or merge .dockerignore for the build context.
 *
 * @param {string} buildContext - path to cloned repo
 * @param {string} language - detected language
 * @param {boolean} useAI - whether to use AI for additional exclusions
 * @returns {Promise<{ content: string, wasGenerated: boolean, wasMerged: boolean }>}
 */
async function generateDockerignore(buildContext, language, useAI = true) {
  const dockerignorePath = path.join(buildContext, ".dockerignore");
  const existingContent = fs.existsSync(dockerignorePath)
    ? fs.readFileSync(dockerignorePath, "utf-8")
    : null;

  // Build the optimized ignore list
  const optimizedLines = [
    "# Auto-generated by SarthiQ Build Optimizer",
    ...UNIVERSAL_IGNORES,
    ...getLanguageIgnores(language),
  ];

  // Get AI-generated exclusions
  let aiExclusions = [];
  if (useAI) {
    aiExclusions = await aiGenerateExclusions(buildContext, language);
  }

  if (existingContent) {
    // MERGE: combine existing + optimized (union, no duplicates)
    const existingLines = existingContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const allPatterns = new Set([
      ...existingLines,
      ...optimizedLines.filter((l) => !l.startsWith("#")),
      ...aiExclusions.filter((l) => !l.startsWith("#")),
    ]);

    const mergedContent = [
      "# SarthiQ Optimized .dockerignore (merged with existing)",
      "# Original user patterns preserved + optimized defaults added",
      "",
      "# --- User patterns ---",
      ...existingLines,
      "",
      "# --- SarthiQ optimized additions ---",
      ...optimizedLines.filter((l) => !existingLines.includes(l) || l.startsWith("#")),
      ...(aiExclusions.length > 0 ? ["", ...aiExclusions] : []),
      "",
      ...SAFETY_NEGATIONS,
    ].join("\n");

    fs.writeFileSync(dockerignorePath, mergedContent);
    return { content: mergedContent, wasGenerated: false, wasMerged: true };
  } else {
    // GENERATE: create new from scratch
    const content = [
      ...optimizedLines,
      ...(aiExclusions.length > 0 ? ["", ...aiExclusions] : []),
      "",
      ...SAFETY_NEGATIONS,
    ].join("\n");

    fs.writeFileSync(dockerignorePath, content);
    return { content, wasGenerated: true, wasMerged: false };
  }
}

/* ── Build context cleanup ────────────────────────────────────────── */

/**
 * Physically remove unnecessary dirs from the cloned repo BEFORE Docker build.
 * This ensures the build context tarball is small even if .dockerignore has issues.
 *
 * @param {string} buildContext - path to cloned repo
 * @returns {{ removed: string[], savedBytes: number }}
 */
function cleanBuildContext(buildContext) {
  const CLEANUP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".swc",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "venv",
    ".venv",
    ".tox",
    "coverage",
    ".nyc_output",
    "storybook-static",
  ];

  const removed = [];
  let savedBytes = 0;

  for (const dirName of CLEANUP_DIRS) {
    const dirPath = path.join(buildContext, dirName);
    if (fs.existsSync(dirPath)) {
      try {
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory()) {
          // Estimate size (fast, not recursive deep count)
          savedBytes += estimateDirSize(dirPath);
          fs.rmSync(dirPath, { recursive: true, force: true });
          removed.push(dirName);
        }
      } catch (err) {
        console.warn(`[buildContextOptimizer] Could not remove ${dirName}: ${err.message}`);
      }
    }
  }

  // Also remove large files that shouldn't be in build context
  const CLEANUP_FILES = [".env", ".env.local", ".env.production", ".env.development"];
  for (const fileName of CLEANUP_FILES) {
    const filePath = path.join(buildContext, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        savedBytes += stat.size;
        fs.unlinkSync(filePath);
        removed.push(fileName);
      } catch { /* ignore */ }
    }
  }

  return { removed, savedBytes };
}

/**
 * Quick estimate of directory size (1 level deep, not fully recursive for speed).
 */
function estimateDirSize(dirPath) {
  try {
    let size = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries.slice(0, 100)) {
      // Sample first 100 entries
      try {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
          size += fs.statSync(entryPath).size;
        } else if (entry.isDirectory()) {
          size += 50_000; // conservative estimate per subdir
        }
      } catch { /* ignore */ }
    }
    // Extrapolate if dir has more than 100 entries
    if (entries.length > 100) {
      size = Math.floor((size / 100) * entries.length);
    }
    return size;
  } catch {
    return 0;
  }
}

/* ── Dependency hash calculation ──────────────────────────────────── */

/**
 * Calculate a deterministic hash of dependency manifests.
 * Used for smart image tagging and cache-hit detection.
 *
 * @param {string} buildContext - path to cloned repo
 * @returns {string} short hash (first 12 chars of SHA-256)
 */
function calculateDependencyHash(buildContext) {
  const DEPENDENCY_FILES = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "package.json",
    "requirements.txt",
    "Pipfile.lock",
    "Pipfile",
    "pyproject.toml",
    "poetry.lock",
    "go.sum",
    "go.mod",
    "Gemfile.lock",
    "Gemfile",
    "Cargo.lock",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradle.lockfile",
  ];

  const hasher = crypto.createHash("sha256");
  let found = false;

  for (const file of DEPENDENCY_FILES) {
    const filePath = path.join(buildContext, file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath);
        hasher.update(`${file}:`);
        hasher.update(content);
        found = true;
      } catch { /* ignore */ }
    }
  }

  if (!found) {
    // No dependency file found — hash the file tree for some cache stability
    hasher.update("no-deps-" + Date.now());
  }

  return hasher.digest("hex").slice(0, 12);
}

/* ── Context size estimation ──────────────────────────────────────── */

/**
 * Estimate the total size of the build context for logging.
 * @param {string} buildContext - path
 * @returns {string} human-readable size
 */
function estimateContextSize(buildContext) {
  try {
    let totalSize = 0;
    const walkDir = (dir, depth = 0) => {
      if (depth > 4) return; // limit depth for speed
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (["node_modules", ".git", "__pycache__", "venv", ".venv"].includes(entry.name)) continue;
        const entryPath = path.join(dir, entry.name);
        try {
          if (entry.isFile()) {
            totalSize += fs.statSync(entryPath).size;
          } else if (entry.isDirectory()) {
            walkDir(entryPath, depth + 1);
          }
        } catch { /* ignore */ }
      }
    };
    walkDir(buildContext);

    if (totalSize < 1024) return `${totalSize} B`;
    if (totalSize < 1024 * 1024) return `${(totalSize / 1024).toFixed(1)} KB`;
    return `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "unknown";
  }
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Full build context optimization pipeline.
 *
 * @param {string} buildContext - path to cloned repo
 * @param {string} language - detected language (node, python, go, etc.)
 * @param {object} options
 * @param {boolean} options.useAI - whether to use AI for .dockerignore (default: true)
 * @param {boolean} options.cleanup - whether to remove unnecessary dirs (default: true)
 *
 * @returns {Promise<OptimizationResult>}
 *
 * OptimizationResult = {
 *   dependencyHash: string,
 *   dockerignoreGenerated: boolean,
 *   dockerignoreMerged: boolean,
 *   contextCleanup: { removed: string[], savedBytes: number },
 *   contextSize: string,
 *   optimizations: string[],  // human-readable list
 * }
 */
async function optimizeBuildContext(buildContext, language, options = {}) {
  const { useAI = true, cleanup = true } = options;
  const optimizations = [];

  // 1. Clean build context (remove node_modules, .git, etc.)
  let cleanupResult = { removed: [], savedBytes: 0 };
  if (cleanup) {
    cleanupResult = cleanBuildContext(buildContext);
    if (cleanupResult.removed.length > 0) {
      const savedMB = (cleanupResult.savedBytes / (1024 * 1024)).toFixed(1);
      optimizations.push(
        `Removed ${cleanupResult.removed.length} unnecessary dirs/files (~${savedMB} MB saved): ${cleanupResult.removed.join(", ")}`
      );
    }
  }

  // 2. Generate/merge .dockerignore
  const dockerignoreResult = await generateDockerignore(buildContext, language, useAI);
  if (dockerignoreResult.wasGenerated) {
    optimizations.push("Generated .dockerignore (AI-enhanced)" + (useAI ? "" : " (defaults only)"));
  } else if (dockerignoreResult.wasMerged) {
    optimizations.push("Merged existing .dockerignore with optimized defaults");
  }

  // 3. Calculate dependency hash
  const dependencyHash = calculateDependencyHash(buildContext);
  optimizations.push(`Dependency hash: ${dependencyHash}`);

  // 4. Estimate final context size
  const contextSize = estimateContextSize(buildContext);
  optimizations.push(`Build context size: ${contextSize}`);

  return {
    dependencyHash,
    dockerignoreGenerated: dockerignoreResult.wasGenerated,
    dockerignoreMerged: dockerignoreResult.wasMerged,
    contextCleanup: cleanupResult,
    contextSize,
    optimizations,
  };
}

module.exports = {
  optimizeBuildContext,
  generateDockerignore,
  cleanBuildContext,
  calculateDependencyHash,
  estimateContextSize,

  // Exported for testing
  _getLanguageIgnores: getLanguageIgnores,
  _aiGenerateExclusions: aiGenerateExclusions,
};
