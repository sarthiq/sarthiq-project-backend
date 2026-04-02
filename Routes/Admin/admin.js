const express = require("express");
const k8sRoutes = require("./k8sRoutes");

const router = express.Router();

router.use("/k8s", k8sRoutes);

module.exports = router;
