const { generateServiceHost } = require("./serviceHostResolver");

const SERVICE_ENDPOINTS = {
  mysql: { protocol: "tcp", primary: { name: "mysql", port: 3306, targetPort: 3306 } },
  postgresql: { protocol: "tcp", primary: { name: "postgres", port: 5432, targetPort: 5432 } },
  mongodb: { protocol: "tcp", primary: { name: "mongo", port: 27017, targetPort: 27017 } },
  redis: { protocol: "tcp", primary: { name: "redis", port: 6379, targetPort: 6379 } },
  rabbitmq: {
    protocol: "tcp",
    primary: { name: "amqp", port: 5672, targetPort: 5672 },
    secondary: [{ name: "management", port: 15672, targetPort: 15672, scheme: "http" }],
  },
  kafka: { protocol: "tcp", primary: { name: "kafka", port: 9092, targetPort: 9092 } },
  minio: {
    protocol: "http",
    primary: { name: "api", port: 9000, targetPort: 9000 },
    secondary: [{ name: "console", port: 9001, targetPort: 9001, scheme: "http" }],
  },
  meilisearch: { protocol: "http", primary: { name: "http", port: 7700, targetPort: 7700 } },
  elasticsearch: { protocol: "http", primary: { name: "http", port: 9200, targetPort: 9200 } },
  opensearch: { protocol: "http", primary: { name: "http", port: 9200, targetPort: 9200 } },
};

function getServiceEndpoints(serviceType, fallbackPort = null) {
  const cfg = SERVICE_ENDPOINTS[serviceType];
  if (!cfg) {
    const p = fallbackPort || 0;
    return {
      protocol: "tcp",
      primary: { name: "default", port: p, targetPort: p },
      secondary: [],
    };
  }
  return {
    protocol: cfg.protocol,
    primary: cfg.primary,
    secondary: cfg.secondary || [],
  };
}

function uriFor(serviceType, credentials, host, port) {
  const enc = (v) => encodeURIComponent(v || "");
  switch (serviceType) {
    case "postgresql":
      return `postgres://${enc(credentials.username)}:${enc(credentials.password)}@${host}:${port}/${credentials.database}`;
    case "mysql":
      return `mysql://${enc(credentials.username)}:${enc(credentials.password)}@${host}:${port}/${credentials.database}`;
    case "mongodb":
      return `mongodb://${enc(credentials.username)}:${enc(credentials.password)}@${host}:${port}/${credentials.database}?authSource=${credentials.authSource || "admin"}`;
    case "redis":
      return `redis://:${enc(credentials.password)}@${host}:${port}`;
    case "rabbitmq":
      return `amqp://${enc(credentials.username)}:${enc(credentials.password)}@${host}:${port}${credentials.vhost || "/"}`;
    case "minio":
    case "meilisearch":
      return `http://${host}:${port}`;
    case "elasticsearch":
    case "opensearch":
      return `http://${enc(credentials.username)}:${enc(credentials.password)}@${host}:${port}`;
    default:
      return `${host}:${port}`;
  }
}

function generateServiceConnection({ serviceInstance, serviceType, credentials, defaultPort, environment, externalPorts = {} }) {
  const hostDetails = generateServiceHost(
    {
      ...serviceInstance,
      serviceType,
      port: defaultPort,
    },
    environment,
  );

  const endpoints = getServiceEndpoints(serviceType, defaultPort);
  const primaryExternalPort = externalPorts[endpoints.primary.name] || null;

  const internalUri = uriFor(serviceType, credentials, hostDetails.internal_host, defaultPort);

  const result = {
    host: hostDetails.internal_host,
    port: defaultPort,
    uri: internalUri,
    ...credentials,

    internal_host: hostDetails.internal_host,
    external_host: hostDetails.external_host,
    fallback_host: hostDetails.fallback_host,
    protocol: endpoints.protocol,
    connection_uri: internalUri,
    secondary_endpoints: [],
  };

  if (primaryExternalPort && hostDetails.external_host) {
    result.externalHost = hostDetails.external_host;
    result.externalPort = primaryExternalPort;
    result.externalUri = uriFor(serviceType, credentials, hostDetails.external_host, primaryExternalPort);
  }

  if (primaryExternalPort && hostDetails.fallback_host) {
    result.fallbackHost = hostDetails.fallback_host;
    result.fallbackPort = primaryExternalPort;
    result.fallbackUri = uriFor(serviceType, credentials, hostDetails.fallback_host, primaryExternalPort);
  }

  for (const sp of endpoints.secondary) {
    const np = externalPorts[sp.name];
    if (!np || !hostDetails.external_host) continue;
    result.secondary_endpoints.push({
      name: sp.name,
      protocol: sp.scheme || "tcp",
      host: hostDetails.external_host,
      port: np,
      uri: `${sp.scheme || "http"}://${hostDetails.external_host}:${np}`,
    });
    result[`${sp.name}Port`] = np;
    result[`${sp.name}Uri`] = `${sp.scheme || "http"}://${hostDetails.external_host}:${np}`;
  }

  return { hostDetails, endpoints, result };
}

module.exports = {
  getServiceEndpoints,
  generateServiceConnection,
};
