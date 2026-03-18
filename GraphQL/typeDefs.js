const { gql } = require('graphql-tag'); // We can use apollo-server-express gql if needed, but since we are just returning a template literal for standard GraphQL:

const typeDefs = `#graphql
  type Project {
    id: ID!
    title: String!
    description: String!
    projectRepoUrl: String!
    projectLanguage: String!
    frameWork: String!
    branch: String!
    projectDirectory: String!
    buildCommand: String
    buildDirectory: String
    subdomain: String
    customDomain: String
    envVariables: String
    UserId: Int!
    DockerInfo: DockerInfo
  }

  type DockerInfo {
    id: ID!
    memory: String
    cpu: String
    disk: String
    pidsLimit: Int
    ulimit: String
    logOpt: String
    restartPolicy: String
    image: String
    cmd: String
    workingDir: String
    networkMode: String
    portBindings: String
    internalPort: Int
    containerId: String
    containerUser: String
  }

  type TierConfig {
    id: ID!
    tierName: String!
    defaultMemory: String
    defaultCpu: String
    defaultDisk: String
    defaultPidsLimit: Int
    defaultUlimit: String
    defaultLogOpt: String
    defaultRestartPolicy: String
    maxProjectsPerUser: Int
    maxEnvsPerProject: Int
  }

  input ProjectInput {
    title: String!
    description: String!
    projectRepoUrl: String!
    projectLanguage: String!
    frameWork: String!
    branch: String!
    projectDirectory: String!
    buildCommand: String
    buildDirectory: String
    envVariables: String! 
  }

  input TierConfigInput {
    defaultMemory: String
    defaultCpu: String
    defaultDisk: String
    defaultPidsLimit: Int
    maxProjectsPerUser: Int
    maxEnvsPerProject: Int
  }

  type UserActivity {
    id: ID!
    info: String
    activityType: String!
    activityDescription: String
    ipAddress: String
    userAgent: String
    location: String
    deviceType: String
    UserId: Int!
    createdAt: String
  }

  type AdminActivity {
    id: ID!
    info: String
    activityType: String!
    activityDescription: String
    ipAddress: String
    userAgent: String
    location: String
    deviceType: String
    AdminId: Int!
    createdAt: String
  }

  type Query {
    getProjects: [Project]
    getTierConfigs: [TierConfig]
    getUserActivities: [UserActivity]
    getAdminActivities: [AdminActivity]
    getAllUserActivities: [UserActivity]
  }

  type Mutation {
    userCreateProject(input: ProjectInput!): Project
    adminUpdateTierConfig(tierName: String!, input: TierConfigInput!): TierConfig
  }
`;

module.exports = typeDefs;
