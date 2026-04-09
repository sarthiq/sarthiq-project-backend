// resetNodes.js
// Run this file manually on the server to clear out ghost CPU/Memory reservations.
// Usage: node resetNodes.js

require('dotenv').config();
const path = require('path');
const db = require('./database');
const KubeNode = require('./Models/Deployment/kubeNode');

async function resetNodeLimits() {
  try {
    await db.authenticate();
    console.log("✅ DB Authenticated");

    const nodes = await KubeNode.findAll();
    let resetCount = 0;
    
    for (const node of nodes) {
      console.log(`Resetting Node: ${node.nodeName}...`);
      await node.update({ usedCpuMillicores: 0, usedMemoryMi: 0 });
      console.log(`   → Node ${node.nodeName} reset to 0 capacity.`);
      resetCount++;
    }

    console.log(`\n🎉 Success! All ${resetCount} nodes reset.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to reset nodes:", error.message);
    process.exit(1);
  }
}

resetNodeLimits();
