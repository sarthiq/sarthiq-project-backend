const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

/**
 * cleanupCron.js
 * ─────────────────────────────────────────────────────────────────────
 * Nightly cleanup tasks to prevent disk growth:
 *   1. Stale sarthiq-* temp directories (build artifacts)
 *   2. Dangling Docker images and build cache
 *   3. Old Docker images (>48 hours)
 *   4. Application log size warnings
 * ─────────────────────────────────────────────────────────────────────
 */

function startCleanupCron() {
  // Schedule the task to run every day at 2:00 AM IST
  cron.schedule("0 2 * * *", () => {
    console.log("[cleanupCron] Running nightly cleanup...");

    /* ── 1. Clean stale temp build directories ──────────────────── */
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

      console.log(`[cleanupCron] Temp cleanup: deleted ${deletedCount} stale directories.`);
    } catch (err) {
      console.error("[cleanupCron] Temp cleanup error:", err.message);
    }

    /* ── 2. Clean dangling Docker images and build cache ─────────── */
    try {
      // Remove dangling images (untagged layers left from builds)
      const pruneResult = execSync(
        "docker image prune -f --filter 'dangling=true' 2>&1",
        { timeout: 120_000, encoding: "utf-8" }
      );
      console.log(`[cleanupCron] Docker image prune: ${pruneResult.trim().split("\n").pop()}`);
    } catch (err) {
      console.error("[cleanupCron] Docker image prune failed:", err.message?.slice(0, 200));
    }

    try {
      // Remove old unused images (>48 hours old, not currently in use)
      const oldImageResult = execSync(
        'docker image prune -af --filter "until=48h" 2>&1',
        { timeout: 120_000, encoding: "utf-8" }
      );
      console.log(`[cleanupCron] Docker old image cleanup: ${oldImageResult.trim().split("\n").pop()}`);
    } catch (err) {
      console.error("[cleanupCron] Docker old image cleanup failed:", err.message?.slice(0, 200));
    }

    try {
      // Remove Docker build cache older than 24h
      const buildCacheResult = execSync(
        'docker builder prune -f --filter "until=24h" 2>&1',
        { timeout: 120_000, encoding: "utf-8" }
      );
      console.log(`[cleanupCron] Docker build cache cleanup: ${buildCacheResult.trim().split("\n").pop()}`);
    } catch (err) {
      console.error("[cleanupCron] Docker build cache cleanup failed:", err.message?.slice(0, 200));
    }

    /* ── 3. Check /var/log size and warn ─────────────────────────── */
    try {
      if (process.platform === "linux") {
        const logSize = execSync("du -sm /var/log 2>/dev/null | awk '{print $1}'", {
          timeout: 30_000,
          encoding: "utf-8",
        }).trim();
        const logSizeMB = parseInt(logSize) || 0;

        if (logSizeMB > 5000) { // > 5 GB
          console.error(
            `[cleanupCron] ⚠ WARNING: /var/log is ${logSizeMB} MB (${(logSizeMB / 1024).toFixed(1)} GB)! ` +
            "Run log rotation or manual cleanup to prevent disk full."
          );

          // Auto-truncate Kubernetes pod logs > 100MB
          try {
            execSync(
              'find /var/log/pods/ -name "*.log" -size +100M -exec truncate -s 0 {} \\; 2>/dev/null',
              { timeout: 60_000 }
            );
            console.log("[cleanupCron] Auto-truncated K8s pod logs > 100MB");
          } catch {
            // Non-fatal — may not have permissions
          }

          // Auto-truncate container logs > 100MB
          try {
            execSync(
              'find /var/log/containers/ -name "*.log" -size +100M -exec truncate -s 0 {} \\; 2>/dev/null',
              { timeout: 60_000 }
            );
            console.log("[cleanupCron] Auto-truncated container logs > 100MB");
          } catch {
            // Non-fatal
          }

          // Vacuum systemd journal to 500MB
          try {
            execSync("journalctl --vacuum-size=500M 2>/dev/null", { timeout: 30_000 });
            console.log("[cleanupCron] Vacuumed systemd journal to 500MB");
          } catch {
            // Non-fatal
          }
        } else {
          console.log(`[cleanupCron] /var/log size: ${logSizeMB} MB — OK`);
        }
      }
    } catch (err) {
      console.error("[cleanupCron] Log size check failed:", err.message?.slice(0, 200));
    }

    /* ── 4. Report disk usage summary ───────────────────────────── */
    try {
      if (process.platform === "linux") {
        const dfOutput = execSync("df -h / | tail -1", {
          timeout: 10_000,
          encoding: "utf-8",
        }).trim();
        console.log(`[cleanupCron] Disk usage: ${dfOutput}`);
      }
    } catch {
      // Non-fatal
    }

    console.log("[cleanupCron] Nightly cleanup finished.");
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // Also run a lighter Docker cleanup every 6 hours
  cron.schedule("0 */6 * * *", () => {
    try {
      execSync("docker image prune -f --filter 'dangling=true' 2>&1", {
        timeout: 60_000,
      });
      console.log("[cleanupCron] 6h Docker dangling image cleanup done.");
    } catch {
      // Non-fatal
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  console.log("[cleanupCron] Scheduled: nightly at 2:00 AM IST + 6-hourly Docker prune.");
}

module.exports = { startCleanupCron };
