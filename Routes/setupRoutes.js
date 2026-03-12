const adminRouter = require("./Admin/admin");
const developerRouter = require("./Developer/developer");
const userRouter = require("./User/user");

exports.setupRoutes = (app) => {
  app.use("/admin", adminRouter);
  app.use("/developer", developerRouter);
  app.use("/user", userRouter);
};
