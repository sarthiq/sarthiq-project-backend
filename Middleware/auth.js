const jwt = require("jsonwebtoken");
const { JWT_SECRET_KEY, DEVELOPER_USERNAME } = require("../importantInfo");

// adminAuthentication
exports.adminAuthentication = async (req, res, next) => {
  try {
    const token = req.headers.authorization;

    if (!token) {
      return res.status(401).json({ error: "No token provided!" });
    }

    // Verify the JWT token and extract the payload
    const payload = jwt.verify(token, JWT_SECRET_KEY);

    if (!payload.adminToken) {
      return res.status(403).json({ error: "Invalid admin token!" });
    }

    // The user identity is checked at sarthiq.com. We trust the signed token.
    // Assign the payload data to req.admin
    req.admin = {
      id: payload.id,
      userName: payload.userName,
      ...payload, // Include any other fields like role or freezeStatus if stored in token
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token!" });
  }
};

// developerAuthentication
exports.developerAuthentication = async (req, res, next) => {
  try {
    const token = req.headers.authorization;

    if (!token) {
      return res.status(401).json({ error: "No token provided!" });
    }

    const payload = jwt.verify(token, JWT_SECRET_KEY);

    if (payload.username !== DEVELOPER_USERNAME) {
      return res.status(403).json({ error: "Invalid developer token!" });
    }

    req.developer = {
      username: payload.username,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token!" });
  }
};

// User Authentication Middleware
exports.userAuthentication = async (req, res, next) => {
  try {
    const token = req.header("Authorization");

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Please Login to view full details!",
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET_KEY);

    // Identify the user based purely on the trusted token payload
    req.user = {
      id: decoded.id,
      ...decoded, // Include roles, subscription status if stored in the token
    };

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: error.message,
    });
  }
};
