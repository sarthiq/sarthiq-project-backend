module.exports = `#graphql
  # ── Deploy Job ──────────────────────────────────────────────────
  type DeploymentJob {
    id: ID!
    bullmqJobId: String
    status: String       # queued | building | running | sleeping | failed | done
    logs: String
    errorMessage: String
    retryCount: Int
    aiDiagnosis: String        # JSON array of AI diagnosis results
    generatedDockerfile: String
    commitSha: String
    commitMessage: String
    startedAt: String
    completedAt: String
    ProjectId: Int
    UserId: Int
    createdAt: String
    # Build optimization metrics
    buildDurationMs: Int
    imageSizeMB: Float
    cacheHit: Boolean
    dependencyHash: String
    dockerignoreGenerated: Boolean
    servicesDetected: String    # JSON array of detected monorepo services
    optimizationsApplied: String # JSON array of applied optimizations
    buildContextSizeMB: Float
  }

  # ── Admin Stats ──────────────────────────────────────────────────
  type LanguageStat {
    language: String
    count: Int
  }

  type FrameworkStat {
    framework: String
    count: Int
  }

  type NodeStat {
    nodeName: String
    totalCpuMillicores: Int
    usedCpuMillicores: Int
    totalMemoryMi: Int
    usedMemoryMi: Int
    isActive: Boolean
  }

  type AdminStats {
    totalUsers: Int
    totalProjects: Int
    runningContainers: Int
    sleepingContainers: Int
    buildingContainers: Int
    failedContainers: Int
    totalDeployments: Int
    successfulDeployments: Int
    failedDeployments: Int
    projectsByLanguage: [LanguageStat]
    projectsByFramework: [FrameworkStat]
    nodeUtilization: [NodeStat]
  }

  # ── Queries ──────────────────────────────────────────────────────
  type Query {
    getDeployStatus(jobId: ID!): DeploymentJob
    getProjectDeployJobs(projectId: ID!, limit: Int, offset: Int): [DeploymentJob]
    getAdminStats: AdminStats
    getKubeNodes: [NodeStat]
  }

  # ── Mutations ────────────────────────────────────────────────────
  type Mutation {
    triggerDeploy(projectId: ID!): DeploymentJob
    cancelDeploy(projectId: ID!): Boolean
    wakeProject(projectId: ID!): DeploymentJob
    stopProject(projectId: ID!): Boolean
    deleteProjectDeploy(projectId: ID!): Boolean
    registerKubeNode(nodeName: String!, totalCpuMillicores: Int, totalMemoryMi: Int): NodeStat
  }
`;
