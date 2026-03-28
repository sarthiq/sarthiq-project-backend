module.exports = `#graphql
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
    detectedLanguage: String
    detectedFramework: String
    detectedBuildCommand: String
    detectedStartCommand: String
    detectedPort: Int
    isStaticSite: Boolean
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
    status: String
    nodeId: String
    deployedAt: String
    lastActivityAt: String
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

  input UpdateProjectInput {
    title: String
    description: String
    projectRepoUrl: String
    projectLanguage: String
    frameWork: String
    branch: String
    projectDirectory: String
    buildCommand: String
    buildDirectory: String
    envVariables: String
  }

  type Query {
    getProjects(search: String, limit: Int, offset: Int): [Project]
  }

  type Mutation {
    userCreateProject(input: ProjectInput!): Project
    userUpdateProject(projectId: ID!, input: UpdateProjectInput!): Project
    userDeleteProject(projectId: ID!): Boolean
  }
`;
