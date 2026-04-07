/**
 * credentialManager.js
 * ─────────────────────────────────────────────────────────────────────
 * AES-256-GCM encryption for service credentials.
 * Generates per-service credentials (DB passwords, API keys, etc.).
 * Builds connection URIs for each service type.
 *
 * SECURITY:
 *   - Never log plaintext credentials
 *   - Uses crypto.randomBytes for all secret generation
 *   - AES-256-GCM provides both confidentiality and authenticity
 * ─────────────────────────────────────────────────────────────────────
 */
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128-bit IV
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Get the 32-byte encryption key from env.
 * Falls back to a deterministic dev key (NOT for production).
 */
function getEncryptionKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (keyHex) {
    const buf = Buffer.from(keyHex, "hex");
    if (buf.length !== 32) {
      throw new Error(
        "ENCRYPTION_KEY must be a 64-char hex string (32 bytes). " +
          `Got ${buf.length} bytes.`
      );
    }
    return buf;
  }

  // Dev fallback — deterministic but obviously insecure
  if (process.env.NODE_ENV !== "production") {
    return crypto
      .createHash("sha256")
      .update("sarthiq-dev-encryption-key-DO-NOT-USE-IN-PROD")
      .digest();
  }

  throw new Error(
    "ENCRYPTION_KEY env var is required in production. " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} Base64-encoded JSON: { iv, authTag, ciphertext }
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag();

  const payload = JSON.stringify({
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted,
  });

  return Buffer.from(payload).toString("base64");
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * @param {string} encryptedBase64 — Output from encrypt()
 * @returns {string} Plaintext
 */
function decrypt(encryptedBase64) {
  const key = getEncryptionKey();
  const payload = JSON.parse(
    Buffer.from(encryptedBase64, "base64").toString("utf8")
  );

  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = payload.ciphertext;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Generate a secure random string of given length (hex).
 */
function randomSecret(byteLength = 16) {
  return crypto.randomBytes(byteLength).toString("hex");
}

/**
 * Generate a random alphanumeric string (for usernames, db names).
 */
function randomAlphanumeric(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Generate credentials for a given service type.
 * @param {string} serviceType — e.g. "postgresql", "redis", "minio"
 * @returns {object} Credentials specific to the service
 */
function generateCredentials(serviceType) {
  const password = randomSecret(16); // 32-char hex password
  const username = `sarthiq_${randomAlphanumeric(8)}`;
  const dbName = `sarthiq_${randomAlphanumeric(8)}`;

  switch (serviceType) {
    case "postgresql":
    case "mysql":
      return { username, password, database: dbName };

    case "mongodb":
      return {
        username,
        password,
        database: dbName,
        authSource: "admin",
      };

    case "redis":
      return { password };

    case "rabbitmq":
      return {
        username,
        password,
        vhost: `/sarthiq-${randomAlphanumeric(6)}`,
      };

    case "kafka":
      return {
        clientId: `sarthiq-${randomAlphanumeric(8)}`,
        // Kafka doesn't use traditional auth in single-node mode
      };

    case "minio":
      return {
        accessKey: `sarthiq-${randomAlphanumeric(12)}`,
        secretKey: randomSecret(20), // 40-char hex
        bucket: `sarthiq-${randomAlphanumeric(8)}`,
      };

    case "meilisearch":
      return {
        masterKey: randomSecret(16),
      };

    case "elasticsearch":
      return {
        username: "elastic",
        password: randomSecret(16),
      };

    case "opensearch":
      return {
        username: "admin",
        password: randomSecret(16),
      };

    default:
      return { password };
  }
}

/**
 * Build a connection URI for a given service type.
 * @param {string} serviceType
 * @param {object} credentials — Output from generateCredentials()
 * @param {string} host — K8s service DNS name
 * @param {number} port
 * @returns {string} Connection URI
 */
function buildConnectionUri(serviceType, credentials, host, port) {
  const encode = (s) => encodeURIComponent(s);

  switch (serviceType) {
    case "postgresql":
      return `postgresql://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}/${credentials.database}`;

    case "mysql":
      return `mysql://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}/${credentials.database}`;

    case "mongodb":
      return `mongodb://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}/${credentials.database}?authSource=${credentials.authSource}`;

    case "redis":
      return `redis://:${encode(credentials.password)}@${host}:${port}`;

    case "rabbitmq":
      return `amqp://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}${credentials.vhost}`;

    case "kafka":
      return `kafka://${host}:${port}`;

    case "minio":
      return `http://${host}:${port}`;

    case "meilisearch":
      return `http://${host}:${port}`;

    case "elasticsearch":
      return `http://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}`;

    case "opensearch":
      return `http://${encode(credentials.username)}:${encode(credentials.password)}@${host}:${port}`;

    default:
      return `${host}:${port}`;
  }
}

/**
 * Build the full connection details object for a service.
 * This gets encrypted and stored in ServiceInstance.connectionDetails.
 */
function buildConnectionDetails(serviceType, credentials, host, port, externalHost, externalPort) {
  const uri = buildConnectionUri(serviceType, credentials, host, port);

  const details = {
    host,
    port,
    uri,
    ...credentials,
  };

  // Add external connection info if available (NodePort access)
  if (externalHost && externalPort) {
    details.externalHost = externalHost;
    details.externalPort = externalPort;
    details.externalUri = buildConnectionUri(serviceType, credentials, externalHost, externalPort);
  }

  return details;
}

/**
 * Determine which env vars to auto-inject for a given service type.
 * Returns a map of { ENV_VAR_NAME: 'field_from_connectionDetails' }.
 */
function getAutoInjectMapping(serviceType) {
  switch (serviceType) {
    case "postgresql":
      return {
        DATABASE_URL: "uri",
        PGHOST: "host",
        PGPORT: "port",
        PGUSER: "username",
        PGPASSWORD: "password",
        PGDATABASE: "database",
      };

    case "mysql":
      return {
        DATABASE_URL: "uri",
        MYSQL_HOST: "host",
        MYSQL_PORT: "port",
        MYSQL_USER: "username",
        MYSQL_PASSWORD: "password",
        MYSQL_DATABASE: "database",
      };

    case "mongodb":
      return {
        MONGODB_URI: "uri",
        MONGO_HOST: "host",
        MONGO_PORT: "port",
        MONGO_USER: "username",
        MONGO_PASSWORD: "password",
        MONGO_DATABASE: "database",
      };

    case "redis":
      return {
        REDIS_URL: "uri",
        REDIS_HOST: "host",
        REDIS_PORT: "port",
        REDIS_PASSWORD: "password",
      };

    case "rabbitmq":
      return {
        RABBITMQ_URL: "uri",
        RABBITMQ_HOST: "host",
        RABBITMQ_PORT: "port",
        RABBITMQ_USER: "username",
        RABBITMQ_PASSWORD: "password",
      };

    case "kafka":
      return {
        KAFKA_BROKER: "uri",
        KAFKA_HOST: "host",
        KAFKA_PORT: "port",
      };

    case "minio":
      return {
        S3_ENDPOINT: "uri",
        S3_ACCESS_KEY: "accessKey",
        S3_SECRET_KEY: "secretKey",
        S3_BUCKET: "bucket",
        MINIO_ENDPOINT: "uri",
      };

    case "meilisearch":
      return {
        MEILISEARCH_URL: "uri",
        MEILISEARCH_HOST: "host",
        MEILISEARCH_PORT: "port",
        MEILISEARCH_MASTER_KEY: "masterKey",
      };

    case "elasticsearch":
      return {
        ELASTICSEARCH_URL: "uri",
        ELASTICSEARCH_HOST: "host",
        ELASTICSEARCH_PORT: "port",
      };

    case "opensearch":
      return {
        OPENSEARCH_URL: "uri",
        OPENSEARCH_HOST: "host",
        OPENSEARCH_PORT: "port",
        OPENSEARCH_USER: "username",
        OPENSEARCH_PASSWORD: "password",
      };

    default:
      return {};
  }
}

module.exports = {
  encrypt,
  decrypt,
  generateCredentials,
  buildConnectionUri,
  buildConnectionDetails,
  getAutoInjectMapping,
  randomSecret,
  randomAlphanumeric,
};
