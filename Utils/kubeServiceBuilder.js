/**
 * kubeServiceBuilder.js
 * ─────────────────────────────────────────────────────────────────────
 * Factory that generates Kubernetes resource specs for infrastructure
 * services. Returns plain JS objects matching the K8s API spec.
 *
 * Design:
 *   - Each builder returns { statefulSet?, deployment?, service, pvc?, secret, configMap? }
 *   - Resource names: svc-{serviceType}-{instanceId}
 *   - Labels: managed-by=sarthiq, sarthiq.com/service-type, sarthiq.com/projectId
 *   - All containers have resource limits/requests
 *   - StatefulSets use volumeClaimTemplates
 *   - Health checks use service-specific probes
 * ─────────────────────────────────────────────────────────────────────
 */

/* ── Standard labels applied to all resources ──────────────────────── */
function standardLabels(instanceId, serviceType, projectId) {
  return {
    "managed-by": "sarthiq",
    "sarthiq.com/component": "service",
    "sarthiq.com/service-type": serviceType,
    "sarthiq.com/projectId": String(projectId),
    "sarthiq.com/instanceId": String(instanceId),
    app: resourceName(serviceType, instanceId),
  };
}

function resourceName(serviceType, instanceId) {
  return `svc-${serviceType}-${instanceId}`;
}

/* ── Shared builders ───────────────────────────────────────────────── */

function buildPVC(name, namespace, storageSize, storageClass = null) {
  const pvc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: storageSize } },
    },
  };
  if (storageClass) {
    pvc.spec.storageClassName = storageClass;
  }
  return pvc;
}

function buildClusterIPService(name, namespace, port, targetPort, labels) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace,
      labels,
    },
    spec: {
      selector: { app: name },
      ports: [{ protocol: "TCP", port, targetPort }],
      type: "ClusterIP",
    },
  };
}

/**
 * Build a NodePort Service for external access to a service.
 * K8s auto-assigns a port in the 30000-32767 range.
 */
function buildNodePortService(name, namespace, port, targetPort, labels) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: `${name}-external`,
      namespace,
      labels: { ...labels, "sarthiq.com/access": "external" },
    },
    spec: {
      selector: { app: name },
      ports: [{ protocol: "TCP", port, targetPort, name: "external" }],
      type: "NodePort",
    },
  };
}

function buildSecret(name, namespace, stringData, labels = {}) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace, labels },
    type: "Opaque",
    stringData, // K8s will base64-encode these automatically
  };
}

function buildConfigMap(name, namespace, data, labels = {}) {
  // Ensure all values are strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = String(v);
  }
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace, labels },
    data: stringData,
  };
}

/**
 * Shared container spec builder with resource limits and probes.
 */
function buildContainer({
  name,
  image,
  port,
  envFrom = [],
  env = [],
  command,
  args,
  volumeMounts = [],
  resources,
  readinessProbe,
  livenessProbe,
}) {
  const container = {
    name,
    image,
    imagePullPolicy: "IfNotPresent",
    ports: [{ containerPort: port }],
    resources: {
      limits: {
        cpu: resources?.cpu || "500m",
        memory: resources?.memory || "512Mi",
      },
      requests: {
        cpu: resources?.cpuRequest || "100m",
        memory: resources?.memoryRequest || "128Mi",
      },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
    },
  };

  if (envFrom.length > 0) container.envFrom = envFrom;
  if (env.length > 0) container.env = env;
  if (command) container.command = command;
  if (args) container.args = args;
  if (volumeMounts.length > 0) container.volumeMounts = volumeMounts;
  if (readinessProbe) container.readinessProbe = readinessProbe;
  if (livenessProbe) container.livenessProbe = livenessProbe;

  return container;
}

/* ── PostgreSQL ────────────────────────────────────────────────────── */
function buildPostgresResources({ instanceId, namespace, credentials, resources, projectId, config }) {
  const name = resourceName("postgresql", instanceId);
  const labels = standardLabels(instanceId, "postgresql", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    POSTGRES_USER: credentials.username,
    POSTGRES_PASSWORD: credentials.password,
    POSTGRES_DB: credentials.database,
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "postgresql",
              image: "postgres:16-alpine",
              port: 5432,
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              env: config?.max_connections
                ? [{ name: "POSTGRES_INITDB_ARGS", value: `--locale=C.UTF-8` }]
                : [],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/postgresql/data", subPath: "pgdata" },
              ],
              resources,
              readinessProbe: {
                exec: { command: ["pg_isready", "-U", credentials.username] },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                exec: { command: ["pg_isready", "-U", credentials.username] },
                initialDelaySeconds: 15,
                periodSeconds: 20,
                timeoutSeconds: 5,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "1Gi" } },
          },
        },
      ],
    },
  };

  const service = buildClusterIPService(name, namespace, 5432, 5432, labels);

  return { statefulSet, service, secret };
}

/* ── MySQL ──────────────────────────────────────────────────────────── */
function buildMySQLResources({ instanceId, namespace, credentials, resources, projectId, config }) {
  const name = resourceName("mysql", instanceId);
  const labels = standardLabels(instanceId, "mysql", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    MYSQL_ROOT_PASSWORD: credentials.password,
    MYSQL_DATABASE: credentials.database,
    MYSQL_USER: credentials.username,
    MYSQL_PASSWORD: credentials.password,
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "mysql",
              image: "mysql:8.0",
              port: 3306,
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              // Force mysql_native_password — caching_sha2_password requires TLS
              // for non-localhost connections (which breaks NodePort access)
              args: ["--default-authentication-plugin=mysql_native_password"],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/mysql" },
              ],
              resources,
              readinessProbe: {
                exec: { command: ["mysqladmin", "ping", "-h", "localhost", "-uroot", `-p${credentials.password}`] },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                exec: { command: ["mysqladmin", "ping", "-h", "localhost", "-uroot", `-p${credentials.password}`] },
                initialDelaySeconds: 30,
                periodSeconds: 20,
                timeoutSeconds: 5,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "1Gi" } },
          },
        },
      ],
    },
  };

  const service = buildClusterIPService(name, namespace, 3306, 3306, labels);

  return { statefulSet, service, secret };
}

/* ── MongoDB ────────────────────────────────────────────────────────── */
function buildMongoDBResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("mongodb", instanceId);
  const labels = standardLabels(instanceId, "mongodb", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    MONGO_INITDB_ROOT_USERNAME: credentials.username,
    MONGO_INITDB_ROOT_PASSWORD: credentials.password,
    MONGO_INITDB_DATABASE: credentials.database,
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "mongodb",
              image: "mongo:7",
              port: 27017,
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              volumeMounts: [
                { name: "data", mountPath: "/data/db" },
              ],
              resources,
              readinessProbe: {
                exec: { command: ["mongosh", "--eval", "db.adminCommand('ping')"] },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                exec: { command: ["mongosh", "--eval", "db.adminCommand('ping')"] },
                initialDelaySeconds: 30,
                periodSeconds: 20,
                timeoutSeconds: 5,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "1Gi" } },
          },
        },
      ],
    },
  };

  const service = buildClusterIPService(name, namespace, 27017, 27017, labels);

  return { statefulSet, service, secret };
}

/* ── Redis ──────────────────────────────────────────────────────────── */
function buildRedisResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("redis", instanceId);
  const labels = standardLabels(instanceId, "redis", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    REDIS_PASSWORD: credentials.password,
  }, labels);

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "redis",
              image: "redis:7-alpine",
              port: 6379,
              command: ["redis-server"],
              args: ["--requirepass", credentials.password, "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"],
              resources,
              readinessProbe: {
                exec: { command: ["redis-cli", "-a", credentials.password, "ping"] },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
              },
              livenessProbe: {
                exec: { command: ["redis-cli", "-a", credentials.password, "ping"] },
                initialDelaySeconds: 15,
                periodSeconds: 20,
                timeoutSeconds: 3,
              },
            }),
          ],
        },
      },
    },
  };

  const service = buildClusterIPService(name, namespace, 6379, 6379, labels);

  return { deployment, service, secret };
}

/* ── RabbitMQ ──────────────────────────────────────────────────────── */
function buildRabbitMQResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("rabbitmq", instanceId);
  const labels = standardLabels(instanceId, "rabbitmq", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    RABBITMQ_DEFAULT_USER: credentials.username,
    RABBITMQ_DEFAULT_PASS: credentials.password,
    RABBITMQ_DEFAULT_VHOST: credentials.vhost,
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "rabbitmq",
              image: "rabbitmq:3-management-alpine",
              port: 5672,
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/rabbitmq" },
              ],
              resources,
              readinessProbe: {
                exec: { command: ["rabbitmq-diagnostics", "check_running"] },
                initialDelaySeconds: 20,
                periodSeconds: 15,
                timeoutSeconds: 10,
              },
              livenessProbe: {
                exec: { command: ["rabbitmq-diagnostics", "check_running"] },
                initialDelaySeconds: 40,
                periodSeconds: 30,
                timeoutSeconds: 10,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "512Mi" } },
          },
        },
      ],
    },
  };

  // Main AMQP port + management UI port
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { app: name },
      ports: [
        { name: "amqp", protocol: "TCP", port: 5672, targetPort: 5672 },
        { name: "management", protocol: "TCP", port: 15672, targetPort: 15672 },
      ],
      type: "ClusterIP",
    },
  };

  return { statefulSet, service, secret };
}

/* ── Kafka (structure-only) ────────────────────────────────────────── */
function buildKafkaResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("kafka", instanceId);
  const labels = standardLabels(instanceId, "kafka", projectId);

  const configMap = buildConfigMap(`${name}-config`, namespace, {
    KAFKA_CFG_NODE_ID: "0",
    KAFKA_CFG_PROCESS_ROLES: "controller,broker",
    KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
    KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP:
      "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
    KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "0@localhost:9093",
    KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
    ALLOW_PLAINTEXT_LISTENER: "yes",
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "kafka",
              image: "bitnami/kafka:3.6",
              port: 9092,
              envFrom: [{ configMapRef: { name: `${name}-config` } }],
              volumeMounts: [
                { name: "data", mountPath: "/bitnami/kafka" },
              ],
              resources,
              readinessProbe: {
                tcpSocket: { port: 9092 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                tcpSocket: { port: 9092 },
                initialDelaySeconds: 60,
                periodSeconds: 30,
                timeoutSeconds: 5,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "2Gi" } },
          },
        },
      ],
    },
  };

  const service = buildClusterIPService(name, namespace, 9092, 9092, labels);

  return { statefulSet, service, configMap };
}

/* ── MinIO ──────────────────────────────────────────────────────────── */
function buildMinIOResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("minio", instanceId);
  const labels = standardLabels(instanceId, "minio", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    MINIO_ROOT_USER: credentials.accessKey,
    MINIO_ROOT_PASSWORD: credentials.secretKey,
  }, labels);

  const pvc = buildPVC(`${name}-data`, namespace, resources?.storage || "5Gi");
  pvc.metadata.labels = labels;

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "minio",
              image: "minio/minio:latest",
              port: 9000,
              command: ["minio"],
              args: ["server", "/data", "--console-address", ":9001"],
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              volumeMounts: [
                { name: "data", mountPath: "/data" },
              ],
              resources,
              readinessProbe: {
                httpGet: { path: "/minio/health/ready", port: 9000 },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                httpGet: { path: "/minio/health/live", port: 9000 },
                initialDelaySeconds: 20,
                periodSeconds: 20,
                timeoutSeconds: 5,
              },
            }),
          ],
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: `${name}-data` } },
          ],
        },
      },
    },
  };

  // Main API port + console port
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { app: name },
      ports: [
        { name: "api", protocol: "TCP", port: 9000, targetPort: 9000 },
        { name: "console", protocol: "TCP", port: 9001, targetPort: 9001 },
      ],
      type: "ClusterIP",
    },
  };

  return { deployment, service, secret, pvc };
}

/* ── Meilisearch ───────────────────────────────────────────────────── */
function buildMeilisearchResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("meilisearch", instanceId);
  const labels = standardLabels(instanceId, "meilisearch", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    MEILI_MASTER_KEY: credentials.masterKey,
    MEILI_ENV: "production",
  }, labels);

  const pvc = buildPVC(`${name}-data`, namespace, resources?.storage || "1Gi");
  pvc.metadata.labels = labels;

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            buildContainer({
              name: "meilisearch",
              image: "getmeili/meilisearch:v1.6",
              port: 7700,
              envFrom: [{ secretRef: { name: `${name}-secret` } }],
              volumeMounts: [
                { name: "data", mountPath: "/meili_data" },
              ],
              resources,
              readinessProbe: {
                httpGet: { path: "/health", port: 7700 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
              },
              livenessProbe: {
                httpGet: { path: "/health", port: 7700 },
                initialDelaySeconds: 15,
                periodSeconds: 20,
                timeoutSeconds: 5,
              },
            }),
          ],
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: `${name}-data` } },
          ],
        },
      },
    },
  };

  const service = buildClusterIPService(name, namespace, 7700, 7700, labels);

  return { deployment, service, secret, pvc };
}

/* ── Elasticsearch ─────────────────────────────────────────────────── */
function buildElasticsearchResources({ instanceId, namespace, credentials, resources, projectId }) {
  const name = resourceName("elasticsearch", instanceId);
  const labels = standardLabels(instanceId, "elasticsearch", projectId);

  const secret = buildSecret(`${name}-secret`, namespace, {
    ELASTIC_PASSWORD: credentials.password,
    "xpack.security.enabled": "true",
    "discovery.type": "single-node",
    "ES_JAVA_OPTS": `-Xms${Math.floor(parseInt(resources?.memory || "512") / 2)}m -Xmx${Math.floor(parseInt(resources?.memory || "512") / 2)}m`,
  }, labels);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace, labels },
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          // Elasticsearch requires vm.max_map_count = 262144
          initContainers: [
            {
              name: "sysctl",
              image: "busybox:1.36",
              command: ["sh", "-c", "sysctl -w vm.max_map_count=262144 || true"],
              securityContext: { privileged: true },
            },
          ],
          containers: [
            buildContainer({
              name: "elasticsearch",
              image: "elasticsearch:8.12.0",
              port: 9200,
              env: [
                { name: "ELASTIC_PASSWORD", valueFrom: { secretKeyRef: { name: `${name}-secret`, key: "ELASTIC_PASSWORD" } } },
                { name: "xpack.security.enabled", value: "true" },
                { name: "discovery.type", value: "single-node" },
                { name: "ES_JAVA_OPTS", valueFrom: { secretKeyRef: { name: `${name}-secret`, key: "ES_JAVA_OPTS" } } },
              ],
              volumeMounts: [
                { name: "data", mountPath: "/usr/share/elasticsearch/data" },
              ],
              resources,
              readinessProbe: {
                httpGet: { path: "/_cluster/health", port: 9200 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
                timeoutSeconds: 10,
              },
              livenessProbe: {
                httpGet: { path: "/_cluster/health", port: 9200 },
                initialDelaySeconds: 60,
                periodSeconds: 30,
                timeoutSeconds: 10,
              },
            }),
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: resources?.storage || "2Gi" } },
          },
        },
      ],
    },
  };

  const service = buildClusterIPService(name, namespace, 9200, 9200, labels);

  return { statefulSet, service, secret };
}

/* ── CronJob ───────────────────────────────────────────────────────── */
function buildCronJobResources({
  instanceId,
  namespace,
  projectId,
  name: jobName,
  schedule,
  command,
  image,
  resourceLimits,
  successfulJobsHistoryLimit = 3,
  failedJobsHistoryLimit = 1,
  envVars = {},
}) {
  const name = `cron-${jobName}-${instanceId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 52);
  const labels = standardLabels(instanceId, "cronjob", projectId);

  const cronJob = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: { name, namespace, labels },
    spec: {
      schedule,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit,
      failedJobsHistoryLimit,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          activeDeadlineSeconds: 3600, // 1 hour max
          template: {
            metadata: { labels },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "job",
                  image,
                  command,
                  resources: {
                    limits: {
                      cpu: resourceLimits?.cpu || "100m",
                      memory: resourceLimits?.memory || "128Mi",
                    },
                    requests: {
                      cpu: "50m",
                      memory: "64Mi",
                    },
                  },
                  env: Object.entries(envVars).map(([k, v]) => ({
                    name: k,
                    value: String(v),
                  })),
                },
              ],
            },
          },
        },
      },
    },
  };

  return { cronJob, kubeResourceName: name };
}

/* ── Main dispatcher ───────────────────────────────────────────────── */

/**
 * Build all Kubernetes resources for a given service type.
 * @param {object} catalogEntry — Row from ServiceCatalog table
 * @param {object} instanceConfig — { instanceId, namespace, credentials, resources, projectId, config }
 * @returns {object} { statefulSet?, deployment?, service, pvc?, secret?, configMap?, cronJob? }
 */
function buildServiceResources(catalogEntry, instanceConfig) {
  const serviceType = catalogEntry.name;

  switch (serviceType) {
    case "postgresql":
      return buildPostgresResources(instanceConfig);
    case "mysql":
      return buildMySQLResources(instanceConfig);
    case "mongodb":
      return buildMongoDBResources(instanceConfig);
    case "redis":
      return buildRedisResources(instanceConfig);
    case "rabbitmq":
      return buildRabbitMQResources(instanceConfig);
    case "kafka":
      return buildKafkaResources(instanceConfig);
    case "minio":
      return buildMinIOResources(instanceConfig);
    case "meilisearch":
      return buildMeilisearchResources(instanceConfig);
    case "elasticsearch":
      return buildElasticsearchResources(instanceConfig);
    default:
      throw new Error(`Unsupported service type: ${serviceType}`);
  }
}

module.exports = {
  buildServiceResources,
  buildCronJobResources,
  buildPVC,
  buildClusterIPService,
  buildNodePortService,
  buildSecret,
  buildConfigMap,
  resourceName,
  standardLabels,
  // Individual builders (for testing)
  buildPostgresResources,
  buildMySQLResources,
  buildMongoDBResources,
  buildRedisResources,
  buildRabbitMQResources,
  buildKafkaResources,
  buildMinIOResources,
  buildMeilisearchResources,
  buildElasticsearchResources,
};
