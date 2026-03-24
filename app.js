require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { activityLogger } = require("./Middleware/activityLogger");
const { sleepProxyHandler, router: proxyRouter } = require("./Middleware/sleepProxy");

const { setupRoutes } = require("./Routes/setupRoutes");
const db = require("./database");
const infoRoutes = require("./infoRoutes");
const { setupModels } = require("./Models/setModels");

app = express();

app.set("trust proxy", 1); // 1 means trust the first proxy, usually Nginx or another load balancer

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Custom error handler for invalid JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON format",
      error: err.message,
    });
  }
  next();
});

app.use(activityLogger);

app.use("/", infoRoutes);

setupRoutes(app);

const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const typeDefs = require("./GraphQL/TypeDefs/index"); // Updated to point to modular TypeDefs
const resolvers = require("./GraphQL/Resolvers/index"); // Updated to point to modular Resolvers
const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY } = require("./importantInfo");

async function bootstrap() {
  setupModels();

  // ── Start BullMQ workers ──────────────────────────────────────
  require("./Jobs/deployWorker");   // deploy pipeline
  require("./Jobs/wakeWorker");     // on-demand cold-start wake
  const { startSleepWatcherCron } = require("./Jobs/sleepWatcher");
  startSleepWatcherCron().catch((e) =>
    console.error("[sleepWatcher] Cron start error:", e.message)
  );
  console.log("[bootstrap] BullMQ workers started");

  const server = new ApolloServer({
    typeDefs,
    resolvers,
  });

  await server.start();

  app.use(
    "/graphql",
    cors({ origin: "*" }),
    bodyParser.json({ limit: "50mb" }),
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
            console.error("GraphQL Auth error: Invalid token", error.message);
          }
        }
        return { req, user, admin };
      },
    })
  );

  // ── Mount sleep proxy wake-status REST route ────────────────
  app.use("/api/proxy", proxyRouter);

  // ── Wildcard subdomain sleep proxy (LAST middleware) ─────────
  app.use(sleepProxyHandler);

  db.sync()
    .then(() => {
      const port = process.env.APP_PORT || 3000;
      app.listen(port);
      console.log(`Listening to the port : ${port}`);
      console.log(`GraphQL endpoint available at http://localhost:${port}/graphql`);
    })
    .catch((err) => console.log(err));
}

bootstrap();
