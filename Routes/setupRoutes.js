const adminRouter = require("./Admin/admin");
const userRouter = require("./User/user");
const githubRouter = require("./User/github");

exports.setupRoutes = (app) => {
  app.use("/admin", adminRouter);
  app.use("/user", userRouter);
  app.use("/api/github", githubRouter);
};
