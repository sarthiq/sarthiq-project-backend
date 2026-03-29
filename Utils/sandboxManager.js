/**
 * sandboxManager.js
 * ─────────────────────────────────────────────────────────────────────
 * Manages execution modes for the SarthiQ deployment platform.
 *
 * Two modes:
 *   1. SECURE (default) — non-root, hardened K8s pod security context
 *   2. SANDBOX          — root allowed inside isolated environment
 *
 * SECURITY RULE: Root is ONLY allowed inside sandboxed environments
 * that are fully isolated from the host and other tenants.
 *
 * Sandbox implementation uses Kubernetes with:
 *   - RuntimeClass: "gvisor" (or "kata", if available) for kernel isolation
 *   - Strict NetworkPolicy (no internal access, metadata blocked)
 *   - Ephemeral (auto-destroyed after max lifetime)
 *   - No host filesystem, Docker socket, or privileged access
 *   - Separate namespace for sandboxed workloads
 * ─────────────────────────────────────────────────────────────────────
 */

const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || "sarthiq-sandbox";
const SANDBOX_MAX_LIFETIME_SECONDS = parseInt(
  process.env.SANDBOX_MAX_LIFETIME || "3600"
); // 1 hour default
const SANDBOX_RUNTIME_CLASS = process.env.SANDBOX_RUNTIME_CLASS || "gvisor";

/* ================================================================== */
/* EXECUTION MODE CONFIGURATIONS                                       */
/* ================================================================== */

/**
 * Get the Kubernetes security configuration for a given execution mode.
 *
 * @param {"secure" | "sandbox"} mode
 * @returns {object} k8sSecurityConfig
 */
function getSecurityConfig(mode) {
  if (mode === "sandbox") {
    return getSandboxConfig();
  }
  return getSecureConfig();
}

/**
 * SECURE MODE (Default) — Non-root, fully hardened.
 */
function getSecureConfig() {
  return {
    namespace: process.env.K8S_NAMESPACE || "sarthiq-apps",
    runtimeClassName: null, // default container runtime

    // Pod-level security context
    podSecurityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: {
        type: "RuntimeDefault",
      },
    },

    // Container-level security context
    containerSecurityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false, // some apps need writable dirs
      capabilities: {
        drop: ["ALL"],
      },
      seccompProfile: {
        type: "RuntimeDefault",
      },
    },

    // Network policy: allow egress, block metadata + internal
    networkPolicy: getDefaultNetworkPolicy("sarthiq-apps"),

    // Resource limits
    maxCpu: "500m",
    maxMemory: "512Mi",
    maxEphemeralStorage: "1Gi",

    // Lifecycle
    activeDeadlineSeconds: null, // no time limit for normal workloads
    autoDestroy: false,

    // Labels
    labels: {
      "sarthiq.com/execution-mode": "secure",
      "sarthiq.com/root-access": "false",
    },
  };
}

/**
 * SANDBOX MODE — Root allowed, but fully isolated.
 * Uses gVisor/Kata runtime for kernel-level isolation.
 */
function getSandboxConfig() {
  return {
    namespace: SANDBOX_NAMESPACE,
    runtimeClassName: SANDBOX_RUNTIME_CLASS, // gvisor or kata-runtime

    // Pod-level: ROOT IS ALLOWED inside sandbox only
    podSecurityContext: {
      runAsNonRoot: false, // Root OK in sandbox
      // No runAsUser — let Dockerfile decide
      seccompProfile: {
        type: "RuntimeDefault",
      },
    },

    // Container-level: still restricted even with root
    containerSecurityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: {
        drop: ["ALL"],
        // Re-add only what's absolutely needed
        add: [
          "CHOWN",      // needed for apt-get/apk
          "DAC_OVERRIDE", // needed for file operations as root
          "SETUID",     // needed for USER switching
          "SETGID",     // needed for group switching
          "NET_BIND_SERVICE", // needed for ports < 1024
        ],
      },
      // Seccomp still enforced
      seccompProfile: {
        type: "RuntimeDefault",
      },
    },

    // Stricter network policy for sandbox
    networkPolicy: getSandboxNetworkPolicy(),

    // Lower resource limits for sandbox
    maxCpu: "500m",
    maxMemory: "512Mi",
    maxEphemeralStorage: "500Mi",

    // MANDATORY: auto-destroy after max lifetime
    activeDeadlineSeconds: SANDBOX_MAX_LIFETIME_SECONDS,
    autoDestroy: true,

    // Labels for monitoring and policy enforcement
    labels: {
      "sarthiq.com/execution-mode": "sandbox",
      "sarthiq.com/root-access": "true",
      "sarthiq.com/ephemeral": "true",
    },
  };
}

/* ================================================================== */
/* NETWORK POLICIES                                                    */
/* ================================================================== */

/**
 * Default NetworkPolicy for secure mode:
 * - Allow egress to internet (ports 80, 443, 53)
 * - Block metadata endpoint (169.254.169.254)
 * - Block internal cluster access
 */
function getDefaultNetworkPolicy(namespace) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "sarthiq-default-egress",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: { "managed-by": "sarthiq" },
      },
      policyTypes: ["Egress", "Ingress"],

      // Allow ingress from ingress controller only
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" },
              },
            },
          ],
        },
      ],

      // Allow egress to internet, block internal
      egress: [
        // DNS
        {
          to: [],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        // HTTP/HTTPS to external
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: [
                  "10.0.0.0/8",       // internal
                  "172.16.0.0/12",     // internal
                  "192.168.0.0/16",    // internal
                  "169.254.0.0/16",    // metadata
                ],
              },
            },
          ],
          ports: [
            { protocol: "TCP", port: 80 },
            { protocol: "TCP", port: 443 },
          ],
        },
      ],
    },
  };
}

/**
 * Stricter NetworkPolicy for sandbox mode:
 * - All outbound blocked except DNS and HTTPS
 * - No internal network access at all
 */
function getSandboxNetworkPolicy() {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "sarthiq-sandbox-policy",
      namespace: SANDBOX_NAMESPACE,
    },
    spec: {
      podSelector: {
        matchLabels: { "sarthiq.com/execution-mode": "sandbox" },
      },
      policyTypes: ["Egress", "Ingress"],

      // Ingress: only from ingress controller
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" },
              },
            },
          ],
        },
      ],

      // Egress: very restrictive
      egress: [
        // DNS only
        {
          to: [],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        // HTTPS only to external hosts (for package downloads)
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: [
                  "10.0.0.0/8",
                  "172.16.0.0/12",
                  "192.168.0.0/16",
                  "169.254.0.0/16",
                  "100.64.0.0/10",  // CGNAT
                ],
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    },
  };
}

/* ================================================================== */
/* SUSPICIOUS ACTIVITY MONITORING                                      */
/* ================================================================== */

/** Commands to watch for in container logs (terminate if detected) */
const SUSPICIOUS_COMMANDS = [
  /nsenter/i,
  /mount\s+-t\s+proc/i,
  /\/proc\/\d+\/root/i,
  /\/proc\/sysrq/i,
  /docker\s+(run|exec|pull)/i,
  /kubectl\s+(exec|run|apply)/i,
  /\/var\/run\/docker\.sock/i,
  /curl\s+169\.254\.169\.254/i,
  /wget\s+169\.254\.169\.254/i,
  /nc\s+-l/i,              // netcat listener
  /nmap\b/i,               // port scanning
  /ssh-keygen/i,           // key generation
  /reverse.*shell/i,
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
];

/**
 * Check container log output for suspicious activity.
 *
 * @param {string} logContent
 * @returns {{ suspicious: boolean, matches: string[] }}
 */
function detectSuspiciousActivity(logContent) {
  if (!logContent || typeof logContent !== "string") {
    return { suspicious: false, matches: [] };
  }

  const matches = [];
  for (const pattern of SUSPICIOUS_COMMANDS) {
    if (pattern.test(logContent)) {
      matches.push(pattern.source);
    }
  }

  return {
    suspicious: matches.length > 0,
    matches,
  };
}

/* ================================================================== */
/* EXECUTION MODE DECISION                                             */
/* ================================================================== */

/**
 * Decide the execution mode and get the full configuration.
 *
 * @param {object} rootDetection — result from rootDetector.detectRootRequirements()
 * @param {object} options
 * @param {boolean} options.userConsentsToSandbox — user explicitly chose sandbox mode
 * @param {boolean} options.forceSecure — admin override: force secure mode
 * @returns {object} { mode, config, warning }
 */
function resolveExecutionMode(rootDetection, options = {}) {
  const { userConsentsToSandbox = false, forceSecure = false } = options;

  // Admin override
  if (forceSecure) {
    return {
      mode: "secure",
      config: getSecureConfig(),
      warning: rootDetection.requiresRoot
        ? "⚠ Project requires root but running in secure mode (admin override). Some features may not work."
        : null,
    };
  }

  // Project doesn't need root → always secure
  if (!rootDetection.requiresRoot) {
    // Even if auto-fixable issues exist, secure mode will work
    return {
      mode: "secure",
      config: getSecureConfig(),
      warning: null,
    };
  }

  // Project requires root
  if (userConsentsToSandbox) {
    return {
      mode: "sandbox",
      config: getSandboxConfig(),
      warning:
        "🔒 Running in sandbox mode with root access. Environment is isolated and ephemeral.",
    };
  }

  // Root needed but user hasn't consented — return info for frontend
  return {
    mode: "requires_consent",
    config: null,
    warning:
      "⚠ Your project requires elevated permissions. Please choose: (1) Fix for non-root mode, or (2) Run in sandboxed root mode.",
    rootDetection,
  };
}

/* ================================================================== */
/* EXPORTS                                                             */
/* ================================================================== */

module.exports = {
  getSecurityConfig,
  getSecureConfig,
  getSandboxConfig,
  getDefaultNetworkPolicy,
  getSandboxNetworkPolicy,
  detectSuspiciousActivity,
  resolveExecutionMode,

  // Constants
  SANDBOX_NAMESPACE,
  SANDBOX_MAX_LIFETIME_SECONDS,
  SANDBOX_RUNTIME_CLASS,
  SUSPICIOUS_COMMANDS,
};
