module.exports = `#graphql
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
    getUserActivities: [UserActivity]
    getAdminActivities: [AdminActivity]
    getAllUserActivities: [UserActivity]
  }
`;
