/**
 * GitHub Webhook route
 * ─────────────────────────────────────────────────────────────────────
 * Mounted BEFORE bodyParser.json() in app.js so we can access the raw
 * request body for HMAC signature verification.
 * ─────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();

const { handleWebhook } = require("../../Controller/User/githubController");

// Webhook — uses raw body for signature verification
// The raw body is attached by the custom middleware in app.js
router.post("/", handleWebhook);

module.exports = router;
