module.exports = `#graphql
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

  input TierConfigInput {
    defaultMemory: String
    defaultCpu: String
    defaultDisk: String
    defaultPidsLimit: Int
    maxProjectsPerUser: Int
    maxEnvsPerProject: Int
  }

  type Query {
    getTierConfigs: [TierConfig]
  }

  type Mutation {
    adminUpdateTierConfig(tierName: String!, input: TierConfigInput!): TierConfig
  }
`;
