const express = require("express");
const k8sRoutes = require("./k8sRoutes");
const userRoutes = require("./userManagementRoutes");
const { adminAuthentication } = require("../../Middleware/auth");

const router = express.Router();

router.use("/k8s", k8sRoutes);
router.use("/users", adminAuthentication, userRoutes);

module.exports = router;
