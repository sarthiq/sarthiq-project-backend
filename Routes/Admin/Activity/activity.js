
const express = require("express");
const { getAdminActivity } = require("../../../Controller/Admin/Activity/activity");

const router = express.Router();

router.post("/getAdminActivity", getAdminActivity);

module.exports = router;
