const {
  createAdmin,
  getAllAdmins,
  getAdminById,
  updateAdmin,
  deleteAdmin,
  restoreAdmin,
  toggleFreezeStatus,
} = require("../../../Controller/Developer/Admin/admin");

const express = require("express");
const router = express.Router();

// ==================== ADMIN CRUD ROUTES ====================
// Create Admin
router.post("/create", createAdmin);

// Get All Admins
router.post("/getAll", getAllAdmins);

// Get Admin by ID
router.post("/getById", getAdminById);

// Update Admin
router.post("/update", updateAdmin);

// Delete Admin (Soft Delete)
router.post("/delete", deleteAdmin);

// Restore Admin
router.post("/restore", restoreAdmin);

// Toggle Freeze Status
router.post("/toggleFreeze", toggleFreezeStatus);


module.exports = router;
