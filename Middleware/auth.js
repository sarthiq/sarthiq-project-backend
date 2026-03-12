const jwt = require("jsonwebtoken");
const Admin = require("../Models/User/admins");
const { JWT_SECRET_KEY, DEVELOPER_USERNAME } = require("../importantInfo");
const User = require("../Models/User/users");

//adminAuthentication
exports.adminAuthentication = async (req, res, next) => {
  try {
    const token = req.headers.authorization;

    // Verify the JWT token and extract the payload
    const payload = jwt.verify(token, JWT_SECRET_KEY);

    if (!payload.adminToken) {
      return res.status(403).json({ error: "Invalid admin token!=" });
    }

    // Find the admin by primary key (id)
    const admin = await Admin.findOne({
      where: { id: payload.id, userName: payload.userName },
    });

    // Check if the admin exists
    if (!admin) {
      return res.status(404).json({ error: "Admin not found!" });
    }

    // Check freeze status for admin types 'SA' and 'A'
    if (admin.isDeactivated) {
      return res
        .status(403)
        .json({ error: "Access denied. Admin account is Deactivated!" });
    }

    // Check freeze status for admin types 'SA' and 'A'
    if (admin.freezeStatus) {
      return res
        .status(403)
        .json({ error: "Access denied. Admin account is frozen!" });
    }

    // Assign the admin object to the request object
    req.admin = admin;

    // Proceed to the next middleware
    next();
  } catch (err) {
    return res.status(503).json({ error: "Invalid Signature!" });
  }
};

//developerAuthentication
exports.developerAuthentication = async (req, res, next) => {
  try {
    const token = req.headers.authorization;

    // Verify the JWT token and extract the payload
    const payload = jwt.verify(token, JWT_SECRET_KEY);

    // Check if the username matches the developer username
    if (payload.username !== DEVELOPER_USERNAME) {
      return res.status(403).json({ error: "Invalid developer token!" });
    }

    // Add developer info to request object
    req.developer = {
      username: payload.username,
    };

    // Proceed to the next middleware
    next();
  } catch (err) {
    return res.status(503).json({ error: "Invalid Signature!" });
  }
};

// User Authentication Middleware
exports.userAuthentication = async (req, res, next) => {
  //onsole.log(req.headers);
  let transaction;
  try {
    // Get token from header
    const token = req.header("Authorization");

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Please Login to view full details!",
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET_KEY);

    // Find user
    const user = await User.findByPk(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found. Please login again.",
      });
    }

    // Check if user is blocked
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked. Please contact support.",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact support.",
      });
    }


    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    if (transaction) {
      await transaction.rollback();
    }
    res.status(503).json({
      success: false,
      message: "Invalid token",
      error: error.message,
    });
  }
};
