/**
 * Centralized service host resolver.
 * Generates deterministic internal/external hosts for managed services.
 */

function canonicalServiceName(serviceType, projectId) {
  return `${serviceType}-${projectId}`;
}

function canonicalNamespace(projectId) {
  return `project-${projectId}`;
}

function resolveEnvironment(environment = process.env.APP_ENV || process.env.NODE_ENV) {
  if (environment === "production") return "production";
  return "local";
}

function generateServiceHost(serviceInstance, environment = null) {
  const env = resolveEnvironment(environment);
  const serviceType = serviceInstance.serviceType || serviceInstance.ServiceCatalog?.name;
  const projectId = serviceInstance.ProjectId;
  const port = serviceInstance.port || serviceInstance.ServiceCatalog?.defaultPort || null;

  if (!serviceType || !projectId) {
    throw new Error("generateServiceHost requires serviceType and ProjectId");
  }

  const serviceName = canonicalServiceName(serviceType, projectId);
  const namespace = canonicalNamespace(projectId);

  const internal_host = `${serviceName}.${namespace}.svc.cluster.local`;

  let external_host = null;
  if (serviceInstance.externalAccessEnabled === true) {
    const baseDomain = env === "production"
      ? (process.env.SERVICE_EXTERNAL_BASE_DOMAIN || process.env.PROJECT_DOMAIN || "sarthiq.in")
      : (process.env.SERVICE_LOCAL_BASE_DOMAIN || "localhost");
    external_host = `${serviceName}.${baseDomain}`;
  }

  return {
    internal_host,
    external_host,
    port,
    service_name: serviceName,
    namespace,
  };
}

module.exports = {
  generateServiceHost,
  canonicalServiceName,
  canonicalNamespace,
  resolveEnvironment,
};
