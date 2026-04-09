const { deployQueue } = require('./Jobs/queues');

async function checkQueue() {
  await deployQueue.waitUntilReady();
  const waiting = await deployQueue.getWaitingCount();
  const active = await deployQueue.getActiveCount();
  const delayed = await deployQueue.getDelayedCount();
  const failed = await deployQueue.getFailedCount();
  console.log(`deployQueue status: Wait=${waiting}, Active=${active}, Delayed=${delayed}, Failed=${failed}`);
  
  const activeJobs = await deployQueue.getActive();
  for (const job of activeJobs) {
    console.log(`- Active Job ID: ${job.id}`);
  }
  process.exit(0);
}

checkQueue().catch(console.error);
