const adminRouter = require("./Admin/admin");
const userRouter = require("./User/user");

exports.setupRoutes = (app) => {
  app.use("/admin", adminRouter);
  app.use("/user", userRouter);
};
