/**
 * seedUserPlans.js
 * ─────────────────────────────────────────────────────────────────────
 * Seeds the UserPlan table with default plan tiers.
 * Idempotent — safe to run multiple times (uses findOrCreate).
 *
 * Usage: called from app.js bootstrap or manually:
 *   node Seeds/seedUserPlans.js
 * ─────────────────────────────────────────────────────────────────────
 */
const UserPlan = require("../Models/Services/userPlan");

const PLAN_ENTRIES = [
  {
    name: "free",
    maxServices: 3,
    maxCpuMillicores: 2000,   // 2 vCPU total
    maxMemoryMi: 3072,        // 3 GiB total
    maxStorageGi: 15,         // 15 GiB total
    allowedServices: ["*"],   // All services available on free tier
    maxCronJobs: 2,
    logRetentionHours: 24,
  },
  {
    name: "pro",
    maxServices: 10,
    maxCpuMillicores: 4000,   // 4 vCPUs total
    maxMemoryMi: 4096,        // 4 GiB total
    maxStorageGi: 50,         // 50 GiB total
    allowedServices: ["*"],   // All services
    maxCronJobs: 10,
    logRetentionHours: 168,   // 7 days
  },
  {
    name: "enterprise",
    maxServices: 50,
    maxCpuMillicores: 16000,  // 16 vCPUs total
    maxMemoryMi: 16384,       // 16 GiB total
    maxStorageGi: 500,        // 500 GiB total
    allowedServices: ["*"],   // All services
    maxCronJobs: 50,
    logRetentionHours: 720,   // 30 days
  },
];

/**
 * Seed the UserPlan table. Idempotent via findOrCreate.
 */
async function seedUserPlans() {
  let created = 0;
  let skipped = 0;

  for (const entry of PLAN_ENTRIES) {
    const [plan, wasCreated] = await UserPlan.findOrCreate({
      where: { name: entry.name },
      defaults: entry,
    });

    if (wasCreated) {
      created++;
    } else {
      // Update existing plan with latest values
      await plan.update(entry);
      skipped++;
    }
  }

  console.log(
    `[seedUserPlans] Done: ${created} created, ${skipped} updated (${PLAN_ENTRIES.length} total)`
  );
}

module.exports = { seedUserPlans, PLAN_ENTRIES };

// Allow standalone execution: node Seeds/seedUserPlans.js
if (require.main === module) {
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
  const db = require("../database");
  db.sync().then(() => seedUserPlans()).then(() => process.exit(0));
}
