const User = require("../../../Models/User/users");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const { Op } = require("sequelize");
const {
  JWT_SECRET_KEY,
  UserTokenExpiresIn,
  sequelize,
} = require("../../../importantInfo");
const { createUserActivity } = require("../../../Utils/activityUtils");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client(
  "127179774517-m85vk4lf159fqjjggumrclrm0sk3tmit.apps.googleusercontent.com"
);

exports.userSignUp = async (req, res, next) => {
  let transaction;
  try {
    const { name, email, phone, password, referralCode } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        message: "All fields are required - name, email, phone, password",
      });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters long" });
    }
    if (phone.length !== 10) {
      return res
        .status(400)
        .json({ message: "Phone number must be 10 digits long" });
    }

    const existingUser = await User.findOne({
      where: { [Op.or]: [{ email }, { phone }] },
    });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Validate referral code early (if provided) and resolve referrer id before any writes
    let byReferralUserId = null;
    if (referralCode) {
      const referrer = await User.findOne({ where: { uniqueId: referralCode } });
      if (!referrer) {
        return res.status(400).json({ message: "Invalid referral code" });
      }
      byReferralUserId = referrer.id;
    }

    transaction = await sequelize.transaction();

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create(
      {
        name,
        email,
        phone,
        password: hashedPassword,
      },
      { transaction }
    );

    

    await transaction.commit();

    const token = jwt.sign(
      { name: newUser.name, id: newUser.id },
      JWT_SECRET_KEY,
      {
        expiresIn: UserTokenExpiresIn,
      }
    );

    res.status(201).json({ message: "User created successfully", token, uniqueId: newUser.uniqueId });

  } catch (err) {
    // If any error occurs, rollback the transaction
    if (transaction) {
      await transaction.rollback();
    }
    console.log(err);

    return res
      .status(500)
      .json({ message: "Internal server error. Please try again later." });
  }
};

exports.userLogin = async (req, res, next) => {
  const { emailOrPhone, password } = req.body;

  try {
    if (!emailOrPhone || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Find the user by email or phone
    const user = await User.findOne({
      where: { [Op.or]: [{ email: emailOrPhone }, { phone: emailOrPhone }] },
    });

    if (!user) {
      return res.status(404).json({ error: "User doesn't exist" });
    }

    if (!user.password) {
      return res
        .status(403)
        .json({ error: "Please login with Google or reset password!" });
    }

    // Compare the provided password with the stored password hash
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(403).json({ error: "Invalid Password" });
    }

    const token = jwt.sign({ name: user.name, id: user.id }, JWT_SECRET_KEY, {
      expiresIn: UserTokenExpiresIn,
    });
    req.user = user;

    // Log user activity
    await createUserActivity(
      req,
      "user_login",
      `User logged in successfully`,
      null,
      {
        userId: user.id,
        userEmail: user.email,
        loginMethod: "email_password",
      }
    );

    return res.status(200).json({
      message: "Login Successful",
      token,
      userId: user.id,
      uniqueId: user.uniqueId,
    });
  } catch (err) {
    console.error("Error during login:", err);
    return res
      .status(500)
      .json({ error: "Internal server error. Please try again later." });
  }
};

exports.googleLogin = async (req, res, next) => {
  const { token, referralCode } = req.body;
  let transaction;

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience:
        "127179774517-m85vk4lf159fqjjggumrclrm0sk3tmit.apps.googleusercontent.com",
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    // Check if user already exists
    let user = await User.findOne({
      where: { email },
    });

    let isNewUser = false;

    if (!user) {
      
      // Initialize transaction for creating new user
      transaction = await sequelize.transaction();

      // Create new user
      user = await User.create(
        {
          name,
          email,
          // Password is null for Google users as they authenticate via Google
          password: null,
        },
        { transaction }
      );

     
      await transaction.commit();
      isNewUser = true;

      
    }
    req.user = user;
    // Log user activity for login
    await createUserActivity(
      req,
      "user_login_google",
      `User logged in via Google`,
      null,
      {
        userId: user.id,
        userEmail: user.email,
        googleId: googleId,
        loginMethod: "google",
        isNewUser: isNewUser,
      }
    );

    // Generate JWT token
    const jwtToken = jwt.sign(
      { name: user.name, id: user.id },
      JWT_SECRET_KEY,
      { expiresIn: UserTokenExpiresIn }
    );

    res.status(200).json({
      success: true,
      message: isNewUser
        ? "User created and logged in successfully"
        : "Google Login Successful",
      token: jwtToken,
      userId: user.id,
      uniqueId: user.uniqueId,
    });
  } catch (err) {
    if (transaction) {
      await transaction.rollback();
    }
    console.error("Error in Google login:", err);
    res
      .status(403)
      .json({ error: "Invalid Google token or internal server error" });
  }
};

