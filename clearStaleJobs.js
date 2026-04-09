require('dotenv').config();
const db = require('./database');
const DeploymentJob = require('./Models/Deployment/deploymentJob');
const DockerInfo = require('./Models/Projects/dockerInfo');
const { Op } = require('sequelize');

async function fixGhostJobs() {
  await db.authenticate();
  console.log("DB Authenticated");

  const staleJobs = await DeploymentJob.update(
    {
      status: "failed",
      errorMessage: "Manually marked as failed (Ghost job from previous crash)",
      completedAt: new Date(),
    },
    {
      where: {
        status: { [Op.in]: ["queued", "building"] }
      }
    }
  );

  await DockerInfo.update(
    { status: "sleeping" },
    {
      where: {
        status: { [Op.in]: ["queued", "building"] }
      }
    }
  );

  console.log(`Fixed ${staleJobs[0]} ghost jobs.`);
  process.exit(0);
}

fixGhostJobs().catch(console.error);
