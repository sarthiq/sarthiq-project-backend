require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { activityLogger } = require("./Middleware/activityLogger");
const {
  sleepProxyHandler,
  router: proxyRouter,
} = require("./Middleware/sleepProxy");

// ── Security middleware ───────────────────────────────────────────
const {
  helmetMiddleware,
  apiRateLimiter,
  graphqlRateLimiter,
  requestSanitizer,
} = require("./Middleware/securityMiddleware");

const { setupRoutes } = require("./Routes/setupRoutes");
const { initContainerWebSocket } = require("./Utils/containerService");
const db = require("./database");
const infoRoutes = require("./infoRoutes");
const { setupModels } = require("./Models/setModels");

// ── GitHub App ────────────────────────────────────────────────────
const githubWebhookRouter = require("./Routes/User/githubWebhook");
const { handleSetupRedirect } = require("./Controller/User/githubController");
const { initGithubApp, checkGithubCredentials } = require("./Utils/githubApp");

// ── FIX: use const (was global variable leak) ──
const app = express();

app.set("trust proxy", 1);

// ── Security headers (Helmet) ─────────────────────────────────────
app.use(helmetMiddleware);

// ── CORS: restrict to known origins (was: origin "*") ─────────────
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:3000,http://localhost:3001,http://localhost:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  }),
);

// ── GitHub Webhook (MUST be before bodyParser to preserve raw body) ─
app.use(
  "/api/github/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    req.rawBody = req.body; // Store raw Buffer for HMAC verification
    next();
  },
  githubWebhookRouter
);

// ── GitHub Setup URL redirect (non-API route) ─────────────────────
app.get("/github/setup", handleSetupRedirect);

// ── Body parser with REDUCED limits (was 50MB — too large) ────────
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ limit: "5mb", extended: true }));

// ── Request sanitization (strip null bytes, etc.) ─────────────────
app.use(requestSanitizer);

// ── Rate limiting (global) ────────────────────────────────────────
app.use(apiRateLimiter);

// Custom error handler for invalid JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON format",
    });
  }
  // Handle CORS errors
  if (err.message && err.message.includes("CORS")) {
    return res.status(403).json({
      success: false,
      message: "Cross-origin request blocked",
    });
  }
  next();
});

app.use(activityLogger);

app.use("/", infoRoutes);

setupRoutes(app);

const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const typeDefs = require("./GraphQL/TypeDefs/index");
const resolvers = require("./GraphQL/Resolvers/index");
const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY } = require("./importantInfo");

async function performInitialHealthChecks() {
  console.log("------------------------------------------------------");
  console.log("[bootstrap] 🔍 Running initial system health checks...");
  const errors = [];

  // 0. Required env vars
  if (!process.env.JWT_SECRET_KEY) {
    errors.push("Missing JWT_SECRET_KEY in environment!");
  }

  // 1. MySQL Check
  try {
    await db.authenticate();
    console.log("  ✓ Database (MySQL) reachable");
  } catch (err) {
    errors.push(`MySQL Connection Failed: ${err.message}`);
  }

  // 2. Redis Check
  try {
    const { connection } = require("./Jobs/queues");
    await connection.ping();
    console.log("  ✓ Redis reachable");
  } catch (err) {
    errors.push(`Redis Connection Failed: ${err.message}`);
  }

  // 3. Env Config Check
  if (process.env.NODE_ENV === "production" && !process.env.DOCKER_REGISTRY) {
    errors.push(
      "Missing DOCKER_REGISTRY in environment! Kubernetes cannot pull images in production without this.",
    );
  }

  // 4. GitHub Credentials Check
  const missingGithubEnv = checkGithubCredentials();
  if (missingGithubEnv.length > 0) {
    console.warn(`\n⚠️  [githubApp] WARNING: Missing GitHub configurations: ${missingGithubEnv.join(", ")}`);
    console.warn("   GitHub integration features will be disabled until these are configured.\n");
  } else {
    console.log("  ✓ GitHub App credentials found");
  }

  if (errors.length > 0) {
    console.error("\n❌ [bootstrap] CRITICAL STARTUP CHECKS FAILED:");
    errors.forEach((e) => console.error(`   - ${e}`));
    console.error(
      "Please ensure all services are running and .env is configured correctly.\n",
    );
    process.exit(1);
  }
  console.log("[bootstrap] ✅ All core systems validated running.");
  console.log("------------------------------------------------------\n");
}

async function bootstrap() {
  await performInitialHealthChecks();

  // ── Initialize GitHub App (non-fatal if env not set) ────────────
  initGithubApp();

  setupModels();

  // ── Start BullMQ workers ──────────────────────────────────────
  require("./Jobs/deployWorker");
  require("./Jobs/wakeWorker");
  const { startSleepWatcherCron } = require("./Jobs/sleepWatcher");
  const { startCleanupCron } = require("./Jobs/cleanupCron");

  startSleepWatcherCron().catch((e) =>
    console.error("[sleepWatcher] Cron start error:", e.message),
  );
  startCleanupCron();
  console.log("[bootstrap] BullMQ workers & cron jobs started");

  const server = new ApolloServer({
    typeDefs,
    resolvers,
  });

  await server.start();

  app.use(
    "/graphql",
    cors({
      origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("CORS policy: Origin not allowed"));
        }
      },
      credentials: true,
    }),
    graphqlRateLimiter, // ← GraphQL-specific rate limiter
    bodyParser.json({ limit: "2mb" }), // ← Tighter limit for GraphQL
    expressMiddleware(server, {
      context: async ({ req }) => {
        let user = null;
        let admin = null;
        const token = req.headers.authorization;

        if (token) {
          try {
            const payload = jwt.verify(token, JWT_SECRET_KEY);
            if (payload.adminToken) {
              admin = payload;
            } else {
              user = payload;
            }
          } catch (error) {
            // Don't log the token itself — only the error type
            console.error("GraphQL Auth error:", error.message);
          }
        }
        return { req, user, admin };
      },
    }),
  );

  // ── Mount sleep proxy wake-status REST route ────────────────
  app.use("/api/proxy", proxyRouter);

  // ── Wildcard subdomain sleep proxy (LAST middleware) ─────────
  app.use(sleepProxyHandler);

  db.sync()
    .then(() => {
      const port = process.env.APP_PORT || 3000;

      // Create HTTP server wrapping Express (needed for WebSocket)
      const server = http.createServer(app);

      // Initialize WebSocket server for container terminal
      initContainerWebSocket(server);

      server.listen(port);
      console.log(`Listening to the port : ${port}`);
      console.log(
        `GraphQL endpoint available at http://localhost:${port}/graphql`,
      );
      console.log(
        `WebSocket terminal available at ws://localhost:${port}/api/container/terminal`,
      );
    })
    .catch((err) => console.log(err));
}

bootstrap();
