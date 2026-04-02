const express = require("express");
const router = express.Router();

const {
  getAdminNodes,
  getAdminPods,
  getAdminWorkloads,
} = require("../../Controller/Admin/k8sController");

const {
  getAddons,
  installAddon,
  uninstallAddon,
} = require("../../Controller/Admin/k8sAddonController");

// Cluster monitoring
router.get("/nodes", getAdminNodes);
router.get("/pods", getAdminPods);
router.get("/user-projects", getAdminWorkloads);

// Addon management
router.get("/addons", getAddons);
router.post("/addons/install", installAddon);
router.post("/addons/uninstall", uninstallAddon);

module.exports = router;
