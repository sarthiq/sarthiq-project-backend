const { developerLogin } = require("../../../Controller/Developer/Auth/auth");
const express = require("express");

const router = express.Router();

router.post("/login", developerLogin);

module.exports = router;
