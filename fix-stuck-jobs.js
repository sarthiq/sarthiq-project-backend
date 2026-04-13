/**
 * Quick script to fix stuck deployment jobs.
 * Run: node fix-stuck-jobs.js
 */
require("dotenv").config();
const sequelize = require("./database");
const DeploymentJob = require("./Models/Deployment/deploymentJob");
const DockerInfo = require("./Models/Projects/dockerInfo");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

(async () => {
  try {
    // Wait for DB connection
    await sequelize.authenticate();
    console.log("✅ DB connected");

    // 1. Fix stuck deployment jobs in DB
    const [jobCount] = await DeploymentJob.update(
      {
        status: "failed",
        errorMessage: "Cleaned: stale job from manual reset",
        completedAt: new Date(),
      },
      { where: { status: ["queued", "building"] } }
    );
    console.log(`✅ Fixed ${jobCount} stuck deployment job(s) in DB`);

    // 2. Fix stuck DockerInfo records
    const [dockerCount] = await DockerInfo.update(
      { status: "idle" },
      { where: { status: ["queued", "building"] } }
    );
    console.log(`✅ Fixed ${dockerCount} stuck DockerInfo record(s) in DB`);

    // 3. Drain BullMQ queue
    const conn = new IORedis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });
    const q = new Queue("deployQueue", { connection: conn });

    const waiting = await q.getWaiting();
    const active = await q.getActive();
    console.log(`📋 Queue: ${waiting.length} waiting, ${active.length} active`);

    for (const job of [...waiting, ...active]) {
      try {
        await job.remove();
        console.log(`  🗑️  Removed BullMQ job: ${job.id}`);
      } catch (e) {
        console.log(`  ⚠️  Could not remove: ${job.id} (${e.message})`);
      }
    }

    await q.drain();
    console.log("✅ BullMQ queue drained");

    await conn.quit();
    await sequelize.close();
    console.log("\n🎉 All stuck jobs fixed! You can now redeploy.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
