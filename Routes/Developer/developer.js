const express = require("express");

const authRouter = require("./Auth/auth");
const adminRouter = require("./Admin/admin");
const { developerAuthentication } = require("../../Middleware/auth");

const router = express.Router();

router.use("/auth", authRouter);
router.use("/admin", developerAuthentication, adminRouter);

module.exports = router;
