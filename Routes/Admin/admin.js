const express = require("express");

const authRouter = require("./Auth/auth");
const { adminAuthentication } = require("../../Middleware/auth");
const activityRouter = require("./Activity/activity");

const router = express.Router();

router.use("/auth", authRouter);
router.use("/activity", adminAuthentication, activityRouter);

module.exports = router;
