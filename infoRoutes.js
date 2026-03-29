const express = require("express");

const router = express.Router();

// ── HARDENED: Only expose safe, non-sensitive server info ──
router.use("/getServerInfo", (req, res, next) => {
  return res.status(200).json({
    nodeEnv: process.env.NODE_ENV === "production" ? "production" : "development",
    // REMOVED: socketPort (was leaking internal infrastructure details)
  });
});

module.exports = router;
