const Admin = require("../../../Models/User/admins");
const bcrypt = require("bcrypt");
const validator = require("validator");
const { Op } = require("sequelize");

// Create Admin
exports.createAdmin = async (req, res) => {
  try {
    const { password, userName, name, email, adminType, phone } = req.body;
    
    if (!password || !userName || !name || !adminType || !phone) {
      return res.status(400).json({
        success: false,
        message: "All fields are required."
      });
    }

    if (phone && phone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Phone number must be 10 digits long."
      });
    }

    if (email && !validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address."
      });
    }

    // Validate admin type
    const validAdminTypes = ['SSA', 'SA', 'A'];
    if (!validAdminTypes.includes(adminType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid admin type. Allowed types: SSA, SA, A"
      });
    }

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({
      where: {
        [Op.or]: [
          { userName: userName },
          { phone: phone },
          { email: email }
        ]
      }
    });

    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: "Admin already exists. Please try with different email, phone number, or username."
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new admin
    const newAdmin = await Admin.create({
      userName,
      adminType,
      password: hashedPassword,
      phone,
      email: email || null,
      name,
      isDeactivated: false,
      freezeStatus: false
    });

    // Return admin without sensitive data
    const adminResponse = {
      id: newAdmin.id,
      userName: newAdmin.userName,
      adminType: newAdmin.adminType,
      phone: newAdmin.phone,
      email: newAdmin.email,
      name: newAdmin.name,
      isDeactivated: newAdmin.isDeactivated,
      freezeStatus: newAdmin.freezeStatus,
      createdAt: newAdmin.createdAt,
      updatedAt: newAdmin.updatedAt
    };

    return res.status(201).json({
      success: true,
      message: "Admin created successfully.",
      data: adminResponse
    });
  } catch (error) {
    console.error("Error creating admin:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Get All Admins
exports.getAllAdmins = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, adminType, isDeactivated, freezeStatus } = req.body;
    const offset = (page - 1) * limit;

    // Build where clause
    const whereClause = {};
    
    if (search) {
      whereClause[Op.or] = [
        { userName: { [Op.like]: `%${search}%` } },
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } }
      ];
    }

    if (adminType) {
      whereClause.adminType = adminType;
    }

    if (isDeactivated !== undefined) {
      whereClause.isDeactivated = isDeactivated;
    }

    if (freezeStatus !== undefined) {
      whereClause.freezeStatus = freezeStatus;
    }

    const { count, rows: admins } = await Admin.findAndCountAll({
      where: whereClause,
      attributes: { exclude: ['password'] },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']]
    });

    res.status(200).json({
      success: true,
      message: "Admins retrieved successfully",
      data: {
        admins,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error("Error fetching admins:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Get Admin by ID
exports.getAdminById = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required"
      });
    }

    const admin = await Admin.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Admin retrieved successfully",
      data: admin
    });
  } catch (error) {
    console.error("Error fetching admin:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Update Admin
exports.updateAdmin = async (req, res) => {
  try {
    const { id, userName, adminType, password, phone, email, name, isDeactivated, freezeStatus } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required"
      });
    }

    const admin = await Admin.findByPk(id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found"
      });
    }

    // Validate admin type if provided
    if (adminType) {
      const validAdminTypes = ['SSA', 'SA', 'A'];
      if (!validAdminTypes.includes(adminType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid admin type. Allowed types: SSA, SA, A"
        });
      }
    }

    // Check for duplicate username, phone, or email if being changed
    if (userName || phone || email) {
      const existingAdmin = await Admin.findOne({
        where: {
          [Op.or]: [
            userName ? { userName: userName } : null,
            phone ? { phone: phone } : null,
            email ? { email: email } : null
          ].filter(Boolean),
          id: { [Op.ne]: id }
        }
      });

      if (existingAdmin) {
        return res.status(409).json({
          success: false,
          message: "Admin with this username, phone, or email already exists"
        });
      }
    }

    // Prepare update data
    const updateData = {
      userName: userName || admin.userName,
      adminType: adminType || admin.adminType,
      phone: phone || admin.phone,
      email: email !== undefined ? email : admin.email,
      name: name !== undefined ? name : admin.name,
      isDeactivated: isDeactivated !== undefined ? isDeactivated : admin.isDeactivated,
      freezeStatus: freezeStatus !== undefined ? freezeStatus : admin.freezeStatus
    };

    // Hash password if provided
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    // Update admin
    await admin.update(updateData);

    // Return updated admin without sensitive data
    const updatedAdmin = await Admin.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    res.status(200).json({
      success: true,
      message: "Admin updated successfully",
      data: updatedAdmin
    });
  } catch (error) {
    console.error("Error updating admin:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Delete Admin (Soft Delete)
exports.deleteAdmin = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required"
      });
    }

    const admin = await Admin.findByPk(id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found"
      });
    }

    // Soft delete by setting isDeactivated to true
    await admin.update({ isDeactivated: true });

    res.status(200).json({
      success: true,
      message: "Admin deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting admin:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Restore Admin
exports.restoreAdmin = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required"
      });
    }

    const admin = await Admin.findByPk(id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found"
      });
    }

    // Restore admin by setting isDeactivated to false
    await admin.update({ isDeactivated: false });

    const restoredAdmin = await Admin.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    res.status(200).json({
      success: true,
      message: "Admin restored successfully",
      data: restoredAdmin
    });
  } catch (error) {
    console.error("Error restoring admin:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Toggle Freeze Status
exports.toggleFreezeStatus = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required"
      });
    }

    const admin = await Admin.findByPk(id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found"
      });
    }

    // Toggle freeze status
    await admin.update({ freezeStatus: !admin.freezeStatus });

    const updatedAdmin = await Admin.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    res.status(200).json({
      success: true,
      message: `Admin ${admin.freezeStatus ? 'unfrozen' : 'frozen'} successfully`,
      data: updatedAdmin
    });
  } catch (error) {
    console.error("Error toggling freeze status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};


