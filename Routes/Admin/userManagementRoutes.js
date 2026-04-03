const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  getUserDetail,
  forceSleepProject,
  forceWakeProject,
} = require("../../Controller/Admin/userManagementController");

// GET /admin/users — list all virtual user records
router.get("/", getAllUsers);

// GET /admin/users/:userId — per-user detail
router.get("/:userId", getUserDetail);

// POST /admin/users/:userId/sleep/:projectId — force sleep
router.post("/:userId/sleep/:projectId", forceSleepProject);

// POST /admin/users/:userId/wake/:projectId — force wake
router.post("/:userId/wake/:projectId", forceWakeProject);

module.exports = router;
