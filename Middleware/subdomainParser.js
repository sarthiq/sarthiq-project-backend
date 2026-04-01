/**
 * subdomainParser.js
 * ─────────────────────────────────────────────────────────────────────
 * Middleware for subdomain extraction, validation, and logging.
 *
 * IMPORTANT DOMAIN SEPARATION:
 *   - *.sarthiq.com  → Platform itself (devproject, project, devprojectapi, etc.)
 *                       These are NEVER treated as student projects.
 *   - *.sarthiq.in   → Student deployed projects ONLY
 *                       These ARE routed through the subdomain proxy.
 *   - *.localhost     → Local development (treated like sarthiq.in)
 *
 * Sets `req.subdomain` to:
 *   - A lowercase, validated string  (e.g. "my-project-42")
 *   - null  when the request targets the platform or root domain
 *
 * Rejects requests with malformed subdomains (non [a-z0-9-]) with 400.
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * PROJECT_DOMAIN: The domain where student projects are deployed.
 * Only subdomains of THIS domain are treated as project routes.
 * e.g., user1.sarthiq.in → routes to user1's deployed container
 */
const PROJECT_DOMAIN = process.env.PROJECT_DOMAIN || "sarthiq.in";

/**
 * PLATFORM_DOMAIN: The domain where the SarthiQ platform lives.
 * Subdomains here (devproject, project, devprojectapi, etc.) are
 * NEVER treated as student projects — they pass through to API routes.
 */
const PLATFORM_DOMAIN = "sarthiq.com";

/**
 * Reserved subdomains that should never be treated as user projects
 * even on sarthiq.in. Requests to these pass through to standard API routes.
 */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "mail",
  "smtp",
  "ftp",
  "ns1",
  "ns2",
  "staging",
  "dev",
  "test",
  "dashboard",
  "app",
  "project",
  "devproject",
  "devprojectapi",
  "projectapi",
]);

/**
 * Subdomain validation regex.
 * Allows only: a-z, 0-9, and hyphens.
 * Cannot start or end with a hyphen, min 1 char, max 63 chars (RFC 1035).
 */
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Extract subdomain from the Host header.
 * ONLY parses subdomains from PROJECT_DOMAIN (sarthiq.in) and localhost.
 * Requests to PLATFORM_DOMAIN (sarthiq.com) always return null.
 *
 * @param {string} host - Raw Host header value (may include port)
 * @returns {string|null} - The subdomain, or null if root/platform/reserved
 */
function extractSubdomain(host) {
  if (!host) return null;

  // Strip port (handles localhost:3737, user1.sarthiq.in:443, etc.)
  const hostname = host.split(":")[0].toLowerCase().trim();

  // ── PLATFORM DOMAIN: Always pass through, NEVER treat as student project ──
  if (hostname === PLATFORM_DOMAIN || hostname.endsWith(`.${PLATFORM_DOMAIN}`)) {
    return null;
  }

  // Skip bare root domains
  if (hostname === PROJECT_DOMAIN || hostname === "localhost" || hostname === "127.0.0.1") {
    return null;
  }

  let subdomain = null;

  // Student project domain: <sub>.sarthiq.in
  if (hostname.endsWith(`.${PROJECT_DOMAIN}`)) {
    subdomain = hostname.slice(0, -(PROJECT_DOMAIN.length + 1));
  }
  // Localhost development: <sub>.localhost
  else if (hostname.endsWith(".localhost")) {
    subdomain = hostname.slice(0, -".localhost".length);
  }

  if (!subdomain) return null;

  // Reject reserved subdomains
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    return null;
  }

  return subdomain;
}

/**
 * Express middleware: parses subdomain from Host header.
 *
 * – Sets `req.subdomain` (string | null)
 * – Returns 400 for malformed subdomains on PROJECT_DOMAIN
 * – Logs subdomain + URL for observability
 */
function subdomainParser(req, res, next) {
  const host = req.headers.host || "";
  const subdomain = extractSubdomain(host);

  if (subdomain !== null) {
    // Validation: only allow [a-z0-9-], RFC-compliant
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
      console.warn(
        `[subdomain] ⚠ Rejected invalid subdomain: "${subdomain}" from host "${host}"`,
      );
      return res.status(400).json({
        success: false,
        message: "Invalid subdomain format. Only lowercase letters, numbers, and hyphens are allowed.",
      });
    }

    req.subdomain = subdomain;

    // Structured log for observability
    console.log(
      `[subdomain] 🌐 ${subdomain} → ${req.method} ${req.originalUrl} (host: ${host})`,
    );
  } else {
    req.subdomain = null;
  }

  next();
}

module.exports = {
  subdomainParser,
  extractSubdomain,
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_REGEX,
  PROJECT_DOMAIN,
  PLATFORM_DOMAIN,
};
