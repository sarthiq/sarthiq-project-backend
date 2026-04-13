/**
 * securityMiddleware.js
 * ─────────────────────────────────────────────────────────────────────
 * Express middleware for application-layer security:
 *   1. Helmet — HTTP security headers
 *   2. Rate limiting — per-IP request throttling
 *   3. Request sanitization
 * ─────────────────────────────────────────────────────────────────────
 */
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

/* ================================================================== */
/* 1. HELMET — Security headers                                        */
/* ================================================================== */

/**
 * Pre-configured Helmet middleware.
 * Disables X-Powered-By, sets CSP, HSTS, etc.
 */
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // sleep proxy pages need inline JS
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // may break some APIs
  crossOriginResourcePolicy: { policy: "cross-origin" }, // for API access
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
});

/* ================================================================== */
/* 2. RATE LIMITING                                                    */
/* ================================================================== */

/**
 * General API rate limiter — 100 requests per minute per IP.
 */
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
  keyGenerator: (req) => {
    return req.clientInfo?.primaryIpAddress || req.ip || "unknown";
  },
});

/**
 * GraphQL rate limiter — more restrictive: 60 requests per minute.
 */
const graphqlRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "GraphQL rate limit exceeded. Please slow down.",
  },
  keyGenerator: (req) => {
    return req.clientInfo?.primaryIpAddress || req.ip || "unknown";
  },
});

/**
 * Auth-specific rate limiter — 10 attempts per 15 minutes.
 */
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many authentication attempts. Please try again in 15 minutes.",
  },
  keyGenerator: (req) => {
    return req.clientInfo?.primaryIpAddress || req.ip || "unknown";
  },
});

/**
 * Deploy trigger rate limiter — 5 deploys per 5 minutes per user.
 */
const deployRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Deploy rate limit exceeded. Please wait before deploying again.",
  },
  keyGenerator: (req) => {
    return req.clientInfo?.primaryIpAddress || req.ip || "unknown";
  },
});

/**
 * Project proxy rate limiter — applied ONLY to user-deployed project
 * subdomains (e.g., simple-website-31.sarthiq.in).
 *
 * This is SEPARATE from the platform API rate limiter so that traffic
 * to deployed projects does NOT block access to project.sarthiq.com.
 *
 * Default is 300 req/min per IP (free tier). Override per tier via:
 *   - PROXY_RATE_LIMIT_WINDOW_MS  (default: 60000)
 *   - PROXY_RATE_LIMIT_MAX        (default: 300)
 */
const projectProxyRateLimiter = rateLimit({
  windowMs: parseInt(process.env.PROXY_RATE_LIMIT_WINDOW_MS || "60000"), // 1 minute
  max: parseInt(process.env.PROXY_RATE_LIMIT_MAX || "300"),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Rate limit exceeded for this application. Please try again later.",
  },
  keyGenerator: (req) => {
    // Key by IP + subdomain so limits are per-project per-client
    const ip = req.clientInfo?.primaryIpAddress || req.ip || "unknown";
    const subdomain = req.subdomain || "global";
    return `proxy:${subdomain}:${ip}`;
  },
  skip: (req) => {
    // Only apply to subdomain proxy traffic
    return !req.subdomain;
  },
});

/* ================================================================== */
/* 3. REQUEST SANITIZATION                                             */
/* ================================================================== */

/**
 * Middleware to strip null bytes and other dangerous characters
 * from request bodies and query strings.
 */
function requestSanitizer(req, res, next) {
  // Strip null bytes from all string values in body
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeObject(req.body);
  }

  // Strip null bytes from query params
  if (req.query && typeof req.query === "object") {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === "string") {
        req.query[key] = req.query[key].replace(/\0/g, "");
      }
    }
  }

  next();
}

/**
 * Recursively sanitize an object's string values.
 */
function sanitizeObject(obj) {
  if (typeof obj === "string") {
    return obj.replace(/\0/g, "");
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key.replace(/\0/g, "")] = sanitizeObject(value);
    }
    return result;
  }
  return obj;
}

/* ================================================================== */
/* EXPORTS                                                             */
/* ================================================================== */

module.exports = {
  helmetMiddleware,
  apiRateLimiter,
  graphqlRateLimiter,
  authRateLimiter,
  deployRateLimiter,
  projectProxyRateLimiter,
  requestSanitizer,
};
