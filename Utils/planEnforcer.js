/**
 * planEnforcer.js
 * ─────────────────────────────────────────────────────────────────────
 * Enforces user plan limits before creating services or cron jobs.
 * Checks: maxServices, allowedServices, CPU/memory/storage budgets.
 *
 * Usage:
 *   const { allowed, reason } = await checkServiceCreationAllowed(userId, "postgresql", resources);
 *   if (!allowed) return res.status(403).json({ success: false, message: reason });
 * ─────────────────────────────────────────────────────────────────────
 */
const UserPlan = require("../Models/Services/userPlan");
const UserPlanMapping = require("../Models/Services/userPlanMapping");
const ServiceInstance = require("../Models/Services/serviceInstance");
const CronJobInstance = require("../Models/Services/cronJobInstance");

/* ── Resource parsing helpers ──────────────────────────────────────── */

/**
 * Parse K8s CPU string (e.g. "500m", "1") to millicores (integer).
 */
function parseCpuMillicores(cpu) {
  if (!cpu) return 0;
  const str = String(cpu);
  if (str.endsWith("m")) return parseInt(str);
  return Math.round(parseFloat(str) * 1000);
}

/**
 * Parse K8s memory string (e.g. "256Mi", "1Gi") to MiB (integer).
 */
function parseMemoryMi(mem) {
  if (!mem) return 0;
  const str = String(mem);
  if (str.endsWith("Gi")) return parseInt(str) * 1024;
  if (str.endsWith("Mi")) return parseInt(str);
  if (str.endsWith("Ki")) return Math.round(parseInt(str) / 1024);
  return Math.round(parseInt(str) / (1024 * 1024)); // bytes
}

/**
 * Parse K8s storage string (e.g. "1Gi", "512Mi") to GiB (float).
 */
function parseStorageGi(storage) {
  if (!storage) return 0;
  const str = String(storage);
  if (str.endsWith("Gi")) return parseFloat(str);
  if (str.endsWith("Mi")) return parseFloat(str) / 1024;
  if (str.endsWith("Ti")) return parseFloat(str) * 1024;
  return parseFloat(str) / (1024 * 1024 * 1024); // bytes
}

/* ── Plan resolution ───────────────────────────────────────────────── */

/**
 * Resolve the user's plan. Defaults to "free" if no mapping exists.
 * @param {number} userId
 * @returns {object} UserPlan row
 */
async function getUserPlan(userId) {
  const mapping = await UserPlanMapping.findOne({ where: { UserId: userId } });

  if (mapping) {
    const plan = await UserPlan.findByPk(mapping.UserPlanId);
    if (plan) return plan;
  }

  // Default to "free" plan
  const freePlan = await UserPlan.findOne({ where: { name: "free" } });
  if (!freePlan) {
    // Fallback hardcoded limits if seed hasn't run
    return {
      name: "free",
      maxServices: 3,
      maxCpuMillicores: 1000,
      maxMemoryMi: 1024,
      maxStorageGi: 5,
      allowedServices: ["postgresql", "redis", "meilisearch"],
      maxCronJobs: 2,
      logRetentionHours: 24,
    };
  }

  return freePlan;
}

/* ── Resource usage calculation ────────────────────────────────────── */

/**
 * Calculate the user's current total resource usage across all services.
 * @param {number} userId
 * @returns {object} { serviceCount, cpuMillicores, memoryMi, storageGi, cronJobCount }
 */
async function getResourceUsage(userId) {
  const instances = await ServiceInstance.findAll({
    where: { UserId: userId, status: ["provisioning", "running", "stopped"] },
  });

  let cpuMillicores = 0;
  let memoryMi = 0;
  let storageGi = 0;

  for (const inst of instances) {
    const usage = inst.resourceUsage || {};
    cpuMillicores += parseCpuMillicores(usage.cpu);
    memoryMi += parseMemoryMi(usage.memory);
    storageGi += parseStorageGi(usage.storage);
  }

  const cronJobCount = await CronJobInstance.count({
    where: { UserId: userId, status: ["active", "suspended"] },
  });

  return {
    serviceCount: instances.length,
    cpuMillicores,
    memoryMi,
    storageGi,
    cronJobCount,
  };
}

/* ── Enforcement checks ────────────────────────────────────────────── */

/**
 * Check whether a user is allowed to create a new service.
 * @param {number} userId
 * @param {string} serviceType — e.g. "postgresql"
 * @param {object} requestedResources — { cpu: "250m", memory: "256Mi", storage: "1Gi" }
 * @returns {{ allowed: boolean, reason?: string, plan?: object, usage?: object }}
 */
async function checkServiceCreationAllowed(userId, serviceType, requestedResources = {}) {
  const plan = await getUserPlan(userId);
  const usage = await getResourceUsage(userId);

  // 1. Check maxServices
  if (usage.serviceCount >= plan.maxServices) {
    return {
      allowed: false,
      reason: `Plan limit: maximum ${plan.maxServices} services (you have ${usage.serviceCount}). Upgrade your plan to add more.`,
      plan,
      usage,
    };
  }

  // 2. Check allowedServices
  const allowed = plan.allowedServices || [];
  if (!allowed.includes("*") && !allowed.includes(serviceType)) {
    return {
      allowed: false,
      reason: `Service "${serviceType}" is not available on your "${plan.name}" plan. Allowed: ${allowed.join(", ")}.`,
      plan,
      usage,
    };
  }

  // 3. Check CPU budget
  const reqCpu = parseCpuMillicores(requestedResources.cpu || "250m");
  if (usage.cpuMillicores + reqCpu > plan.maxCpuMillicores) {
    return {
      allowed: false,
      reason: `CPU limit exceeded: requesting ${reqCpu}m, but only ${plan.maxCpuMillicores - usage.cpuMillicores}m remaining (limit: ${plan.maxCpuMillicores}m).`,
      plan,
      usage,
    };
  }

  // 4. Check memory budget
  const reqMem = parseMemoryMi(requestedResources.memory || "256Mi");
  if (usage.memoryMi + reqMem > plan.maxMemoryMi) {
    return {
      allowed: false,
      reason: `Memory limit exceeded: requesting ${reqMem}Mi, but only ${plan.maxMemoryMi - usage.memoryMi}Mi remaining (limit: ${plan.maxMemoryMi}Mi).`,
      plan,
      usage,
    };
  }

  // 5. Check storage budget
  const reqStorage = parseStorageGi(requestedResources.storage || "1Gi");
  if (usage.storageGi + reqStorage > plan.maxStorageGi) {
    return {
      allowed: false,
      reason: `Storage limit exceeded: requesting ${reqStorage}Gi, but only ${(plan.maxStorageGi - usage.storageGi).toFixed(1)}Gi remaining (limit: ${plan.maxStorageGi}Gi).`,
      plan,
      usage,
    };
  }

  return { allowed: true, plan, usage };
}

/**
 * Check whether a user is allowed to create a new cron job.
 */
async function checkCronJobCreationAllowed(userId) {
  const plan = await getUserPlan(userId);
  const usage = await getResourceUsage(userId);

  if (usage.cronJobCount >= plan.maxCronJobs) {
    return {
      allowed: false,
      reason: `Plan limit: maximum ${plan.maxCronJobs} cron jobs (you have ${usage.cronJobCount}). Upgrade your plan.`,
      plan,
      usage,
    };
  }

  return { allowed: true, plan, usage };
}

module.exports = {
  getUserPlan,
  getResourceUsage,
  checkServiceCreationAllowed,
  checkCronJobCreationAllowed,
  parseCpuMillicores,
  parseMemoryMi,
  parseStorageGi,
};
