/**
 * subdomainParser.js
 * ─────────────────────────────────────────────────────────────────────
 * Middleware for subdomain extraction, validation, and logging.
 *
 * Parses the Host header to extract the subdomain identifier used for
 * dynamic project routing (e.g., user1.sarthiq.in → subdomain = "user1").
 *
 * Supports:
 *   - Production:  <sub>.sarthiq.in
 *   - Development:  <sub>.localhost, or curl -H "Host: <sub>.sarthiq.in" localhost:3737
 *
 * Sets `req.subdomain` to:
 *   - A lowercase, validated string  (e.g. "my-project-42")
 *   - null  when the request targets the root domain or a reserved subdomain
 *
 * Rejects requests with malformed subdomains (non [a-z0-9-]) with 400.
 * ─────────────────────────────────────────────────────────────────────
 */

const BASE_DOMAIN = process.env.BASE_DOMAIN || "sarthiq.in";

/**
 * Reserved subdomains that should never be treated as user projects.
 * Requests to these pass through to the standard API routes.
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
]);

/**
 * Subdomain validation regex.
 * Allows only: a-z, 0-9, and hyphens.
 * Cannot start or end with a hyphen, min 1 char, max 63 chars (RFC 1035).
 */
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Extract subdomain from the Host header.
 * @param {string} host - Raw Host header value (may include port)
 * @returns {string|null} - The subdomain, or null if root/reserved
 */
function extractSubdomain(host) {
  if (!host) return null;

  // Strip port (handles localhost:3737, user1.sarthiq.in:443, etc.)
  const hostname = host.split(":")[0].toLowerCase().trim();

  // Skip bare root domains
  if (hostname === BASE_DOMAIN || hostname === "localhost" || hostname === "127.0.0.1") {
    return null;
  }

  let subdomain = null;

  // Production / curl override: <sub>.<BASE_DOMAIN>
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    subdomain = hostname.slice(0, -(BASE_DOMAIN.length + 1)); // strip ".sarthiq.in"
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
 * – Returns 400 for malformed subdomains
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
  BASE_DOMAIN,
};
