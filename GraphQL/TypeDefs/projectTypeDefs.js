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

  type Query {
    getProjects: [Project]
  }

  type Mutation {
    userCreateProject(input: ProjectInput!): Project
  }
`;
