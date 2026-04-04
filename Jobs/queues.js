/**
 * queues.js
 * Central BullMQ queue definitions.
 * All workers import queues from here so they share the same Redis connection.
 */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ
});

connection.on("connect", () => console.log("[Redis] Connected"));
connection.on("error", (err) => console.error("[Redis] Error:", err.message));

/** Queue for building + deploying a project container */
const deployQueue = new Queue("deployQueue", {
  connection,
  defaultJobOptions: {
    attempts: 1,             // Don't retry infra failures — they won't self-heal
    backoff: { type: "exponential", delay: 30000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

/** Queue for waking a sleeping container on-demand */
const wakeQueue = new Queue("wakeQueue", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "fixed", delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  },
});

/** Queue for the periodic sleep-check cron job */
const sleepCheckQueue = new Queue("sleepCheckQueue", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: { count: 10 },
  },
});

module.exports = { deployQueue, wakeQueue, sleepCheckQueue, connection };
