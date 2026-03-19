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

  input CreateTierConfigInput {
    tierName: String!
    defaultMemory: String
    defaultCpu: String
    defaultDisk: String
    defaultPidsLimit: Int
    maxProjectsPerUser: Int
    maxEnvsPerProject: Int
  }

  type Query {
    getTierConfigs(search: String, limit: Int, offset: Int): [TierConfig]
  }

  type Mutation {
    adminCreateTierConfig(input: CreateTierConfigInput!): TierConfig
    adminUpdateTierConfig(tierName: String!, input: TierConfigInput!): TierConfig
  }
`;
