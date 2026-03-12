const Admin = require("../../../Models/User/admins");
const { createAdminActivity } = require("../../../Utils/activityUtils");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const {
  AdminTokenExpiresIn,
  JWT_SECRET_KEY,
  NODE_ENV,
} = require("../../../importantInfo");

exports.adminLogin = async (req, res, next) => {
  const { userName, password } = req.body;

  try {
    if (!userName || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }
    // Check if the admin exists
    const admin = await Admin.findOne({ where: { userName } });

    if (!admin) {
      return res.status(404).json({ error: "Admin doesn't exist" }); // 404 Not Found
    }
    req.admin = admin;
    // Compare the provided password with the stored hashed password
    bcrypt.compare(password, admin.password, async (err, isMatch) => {
      if (err) {
        console.error("Error comparing passwords:", err);
        return res
          .status(500)
          .json({ error: "Internal server error. Please try again later." });
      }

      if (isMatch) {
        // Generate a JWT token
        const token = jwt.sign(
          { id: admin.id, adminToken: true ,userName:admin.userName},
          JWT_SECRET_KEY,
          {
            expiresIn: AdminTokenExpiresIn, // Optional: specify token expiration time
          }
        );
        await createAdminActivity(req, "auth", "Login Successfull");
        return res
          .status(200)
          .json({ status: "Login Successful", token, adminId: admin.id }); // 200 OK
      } else {
        await createAdminActivity(
          req,
          "auth",
          "Login Password verification failed!"
        );
        return res.status(402).json({ error: "Invalid Password" }); // 401 Unauthorized
      }
    });
  } catch (err) {
    console.error("Error during admin login:", err);

    return res
      .status(500)
      .json({ error: "Internal server error. Please try again later." });
  }
};

