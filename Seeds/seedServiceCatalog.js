/**
 * seedServiceCatalog.js
 * ─────────────────────────────────────────────────────────────────────
 * Seeds the ServiceCatalog table with all supported infrastructure
 * services. Idempotent — safe to run multiple times (uses findOrCreate).
 *
 * Usage: called from app.js bootstrap or manually:
 *   node Seeds/seedServiceCatalog.js
 * ─────────────────────────────────────────────────────────────────────
 */
const ServiceCatalog = require("../Models/Services/serviceCatalog");

const CATALOG_ENTRIES = [
  /* ── DATABASES ─────────────────────────────────────────────────── */
  {
    name: "postgresql",
    displayName: "PostgreSQL 16",
    category: "database",
    dockerImage: "postgres:16-alpine",
    defaultPort: 5432,
    requiredResources: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
    configSchema: {
      max_connections: { type: "number", default: 100, min: 10, max: 500 },
      shared_buffers: { type: "string", default: "128MB" },
    },
    volumeMounts: [
      { mountPath: "/var/lib/postgresql/data", subPath: "pgdata" },
    ],
    healthCheck: {
      command: ["pg_isready", "-U", "$(POSTGRES_USER)"],
      interval: 10,
      timeout: 5,
    },
    templates: {
      small: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
    },
    envVarMapping: {
      DATABASE_URL: "uri",
      PGHOST: "host",
      PGPORT: "port",
      PGUSER: "username",
      PGPASSWORD: "password",
      PGDATABASE: "database",
    },
    useStatefulSet: true,
    isActive: true,
  },
  {
    name: "mysql",
    displayName: "MySQL 8.0",
    category: "database",
    dockerImage: "mysql:8.0",
    defaultPort: 3306,
    requiredResources: { cpu: "250m", memory: "512Mi", storage: "1Gi" },
    configSchema: {
      max_connections: { type: "number", default: 151, min: 10, max: 1000 },
    },
    volumeMounts: [{ mountPath: "/var/lib/mysql" }],
    healthCheck: {
      command: ["mysqladmin", "ping", "-h", "localhost"],
      interval: 10,
      timeout: 5,
    },
    templates: {
      small: { cpu: "250m", memory: "512Mi", storage: "1Gi" },
    },
    envVarMapping: {
      DATABASE_URL: "uri",
      MYSQL_HOST: "host",
      MYSQL_PORT: "port",
      MYSQL_USER: "username",
      MYSQL_PASSWORD: "password",
      MYSQL_DATABASE: "database",
    },
    useStatefulSet: true,
    isActive: true,
  },
  {
    name: "mongodb",
    displayName: "MongoDB 7",
    category: "database",
    dockerImage: "mongo:7",
    defaultPort: 27017,
    requiredResources: { cpu: "250m", memory: "512Mi", storage: "1Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/data/db" }],
    healthCheck: {
      command: ["mongosh", "--eval", "db.adminCommand('ping')"],
      interval: 10,
      timeout: 5,
    },
    templates: {
      small: { cpu: "250m", memory: "512Mi", storage: "1Gi" },
    },
    envVarMapping: {
      MONGODB_URI: "uri",
      MONGO_HOST: "host",
      MONGO_PORT: "port",
      MONGO_USER: "username",
      MONGO_PASSWORD: "password",
      MONGO_DATABASE: "database",
    },
    useStatefulSet: true,
    isActive: true,
  },

  /* ── CACHE ─────────────────────────────────────────────────────── */
  {
    name: "redis",
    displayName: "Redis 7",
    category: "cache",
    dockerImage: "redis:7-alpine",
    defaultPort: 6379,
    requiredResources: { cpu: "100m", memory: "128Mi", storage: "0" },
    configSchema: {
      maxmemory: { type: "string", default: "128mb" },
      maxmemory_policy: {
        type: "string",
        default: "allkeys-lru",
        enum: ["volatile-lru", "allkeys-lru", "volatile-ttl", "noeviction"],
      },
    },
    volumeMounts: [],
    healthCheck: {
      command: ["redis-cli", "ping"],
      interval: 10,
      timeout: 3,
    },
    templates: {
      small: { cpu: "100m", memory: "128Mi", storage: "0" },
    },
    envVarMapping: {
      REDIS_URL: "uri",
      REDIS_HOST: "host",
      REDIS_PORT: "port",
      REDIS_PASSWORD: "password",
    },
    useStatefulSet: false,
    isActive: true,
  },

  /* ── QUEUE / STREAMING ─────────────────────────────────────────── */
  {
    name: "rabbitmq",
    displayName: "RabbitMQ 3 (Management)",
    category: "queue",
    dockerImage: "rabbitmq:3-management-alpine",
    defaultPort: 5672,
    requiredResources: { cpu: "250m", memory: "256Mi", storage: "512Mi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/var/lib/rabbitmq" }],
    healthCheck: {
      command: ["rabbitmq-diagnostics", "check_running"],
      interval: 15,
      timeout: 10,
    },
    templates: {
      small: { cpu: "250m", memory: "384Mi", storage: "512Mi" },
    },
    envVarMapping: {
      RABBITMQ_URL: "uri",
      RABBITMQ_HOST: "host",
      RABBITMQ_PORT: "port",
      RABBITMQ_USER: "username",
      RABBITMQ_PASSWORD: "password",
    },
    useStatefulSet: true,
    isActive: true,
  },
  {
    name: "kafka",
    displayName: "Apache Kafka 3.6 (KRaft)",
    category: "queue",
    dockerImage: "bitnami/kafka:3.6",
    defaultPort: 9092,
    requiredResources: { cpu: "500m", memory: "512Mi", storage: "2Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/bitnami/kafka" }],
    healthCheck: {
      command: ["kafka-broker-api-versions.sh", "--bootstrap-server", "localhost:9092"],
      interval: 30,
      timeout: 10,
    },
    templates: {
      small: { cpu: "500m", memory: "512Mi", storage: "2Gi" },
    },
    envVarMapping: {
      KAFKA_BROKER: "uri",
      KAFKA_HOST: "host",
      KAFKA_PORT: "port",
    },
    useStatefulSet: true,
    isActive: false, // Structure-only — not deployment-ready in single-node
  },

  /* ── OBJECT STORAGE ────────────────────────────────────────────── */
  {
    name: "minio",
    displayName: "MinIO (S3 Compatible)",
    category: "storage",
    dockerImage: "minio/minio:latest",
    defaultPort: 9000,
    requiredResources: { cpu: "250m", memory: "256Mi", storage: "5Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/data" }],
    healthCheck: {
      httpGet: { path: "/minio/health/ready", port: 9000 },
      interval: 10,
      timeout: 5,
    },
    templates: {
      small: { cpu: "250m", memory: "256Mi", storage: "5Gi" },
    },
    envVarMapping: {
      S3_ENDPOINT: "uri",
      S3_ACCESS_KEY: "accessKey",
      S3_SECRET_KEY: "secretKey",
      S3_BUCKET: "bucket",
      MINIO_ENDPOINT: "uri",
    },
    useStatefulSet: false,
    isActive: true,
  },

  /* ── SEARCH ENGINES ────────────────────────────────────────────── */
  {
    name: "meilisearch",
    displayName: "Meilisearch v1.6",
    category: "search",
    dockerImage: "getmeili/meilisearch:v1.6",
    defaultPort: 7700,
    requiredResources: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/meili_data" }],
    healthCheck: {
      httpGet: { path: "/health", port: 7700 },
      interval: 10,
      timeout: 3,
    },
    templates: {
      small: { cpu: "250m", memory: "256Mi", storage: "1Gi" },
    },
    envVarMapping: {
      MEILISEARCH_URL: "uri",
      MEILISEARCH_HOST: "host",
      MEILISEARCH_PORT: "port",
      MEILISEARCH_MASTER_KEY: "masterKey",
    },
    useStatefulSet: false,
    isActive: true,
  },
  {
    name: "elasticsearch",
    displayName: "Elasticsearch 8.12 (Single Node)",
    category: "search",
    dockerImage: "elasticsearch:8.12.0",
    defaultPort: 9200,
    requiredResources: { cpu: "500m", memory: "512Mi", storage: "2Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/usr/share/elasticsearch/data" }],
    healthCheck: {
      httpGet: { path: "/_cluster/health", port: 9200 },
      interval: 15,
      timeout: 10,
    },
    templates: {
      small: { cpu: "500m", memory: "768Mi", storage: "2Gi" },
    },
    envVarMapping: {
      ELASTICSEARCH_URL: "uri",
      ELASTICSEARCH_HOST: "host",
      ELASTICSEARCH_PORT: "port",
    },
    useStatefulSet: true,
    isActive: true,
  },
  {
    name: "opensearch",
    displayName: "OpenSearch 2.12",
    category: "search",
    dockerImage: "opensearchproject/opensearch:2.12.0",
    defaultPort: 9200,
    requiredResources: { cpu: "500m", memory: "512Mi", storage: "2Gi" },
    configSchema: {},
    volumeMounts: [{ mountPath: "/usr/share/opensearch/data" }],
    healthCheck: {
      httpGet: { path: "/_cluster/health", port: 9200 },
      interval: 15,
      timeout: 10,
    },
    templates: {
      small: { cpu: "500m", memory: "512Mi", storage: "2Gi" },
    },
    envVarMapping: {
      OPENSEARCH_URL: "uri",
      OPENSEARCH_HOST: "host",
      OPENSEARCH_PORT: "port",
      OPENSEARCH_USER: "username",
      OPENSEARCH_PASSWORD: "password",
    },
    useStatefulSet: true,
    isActive: true,
  },
];

/**
 * Seed the ServiceCatalog table. Idempotent via findOrCreate.
 */
async function seedServiceCatalog() {
  let created = 0;
  let updated = 0;

  for (const entry of CATALOG_ENTRIES) {
    const [record, wasCreated] = await ServiceCatalog.findOrCreate({
      where: { name: entry.name },
      defaults: entry,
    });

    if (wasCreated) {
      created++;
    } else {
      // Upsert — update existing records with latest config
      await record.update({
        templates: entry.templates,
        requiredResources: entry.requiredResources,
        isActive: entry.isActive,
        displayName: entry.displayName,
        dockerImage: entry.dockerImage,
      });
      updated++;
    }
  }

  console.log(
    `[seedServiceCatalog] Done: ${created} created, ${updated} updated (${CATALOG_ENTRIES.length} total)`
  );
}

module.exports = { seedServiceCatalog, CATALOG_ENTRIES };

// Allow standalone execution: node Seeds/seedServiceCatalog.js
if (require.main === module) {
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
  const db = require("../database");
  db.sync().then(() => seedServiceCatalog()).then(() => process.exit(0));
}
