const adminRouter = require("./Admin/admin");
const userRouter = require("./User/user");
const githubRouter = require("./User/github");
const containerRouter = require("./User/containerRoutes");
const serviceRouter = require("./User/services");

exports.setupRoutes = (app) => {
  app.use("/admin", adminRouter);
  app.use("/user", userRouter);
  app.use("/api/github", githubRouter);
  app.use("/api/container", containerRouter);
  app.use("/api/services", serviceRouter);
};
