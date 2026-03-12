const express = require("express");
const router = express.Router();
const authController = require("../../../Controller/User/Auth/auth");

router.post("/signUp",  authController.userSignUp);
router.post("/login", authController.userLogin);
router.post("/googleLogin", authController.googleLogin);

module.exports = router;
