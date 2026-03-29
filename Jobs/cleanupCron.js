const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const os = require("os");

function startCleanupCron() {
  // Schedule the task to run every day at 2:00 AM IST
  cron.schedule("0 2 * * *", () => {
    console.log("[cleanupCron] Running nightly cleanup of stale temporary build directories...");
    try {
      const tmpDir = os.tmpdir();
      const files = fs.readdirSync(tmpDir);
      
      const now = Date.now();
      const THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

      let deletedCount = 0;

      for (const file of files) {
        // Our project creates temp dirs starting with "sarthiq-" in os.tmpdir()
        if (file.startsWith("sarthiq-")) {
          const fullPath = path.join(tmpDir, file);
          try {
            const stats = fs.statSync(fullPath);
            // If it's a directory and older than the threshold, delete it
            if (stats.isDirectory() && (now - stats.mtimeMs > THRESHOLD_MS)) {
              fs.rmSync(fullPath, { recursive: true, force: true });
              console.log(`[cleanupCron] Deleted stale directory: ${fullPath}`);
              deletedCount++;
            }
          } catch (err) {
            console.error(`[cleanupCron] Failed to process ${fullPath}: ${err.message}`);
          }
        }
      }

      console.log(`[cleanupCron] Nightly cleanup finished. Deleted ${deletedCount} stale directories.`);
    } catch (err) {
      console.error("[cleanupCron] Top-level error during cleanup:", err.message);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
  
  console.log("[cleanupCron] Scheduled for 2:00 AM IST daily.");
}

module.exports = { startCleanupCron };
