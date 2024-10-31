import { getEnvVar } from "../utils/env";
import { env } from "@/types/env";

export const createConfig = (env: env["Bindings"]) => ({
  app: {
    name: "email-worker",
    version: "1.0.0",
    environment: getEnvVar("ENVIRONMENT", env),
    nodeEnv: getEnvVar("NODE_ENV", env),
    apiVersion: getEnvVar("API_VERSION", env),
  },
  cors: {
    allowedOrigins: getEnvVar("ALLOWED_ORIGINS", env)?.split(",") || ["*"],
  },
  email: {
    domain: getEnvVar("EMAIL_DOMAIN", env),
    defaultFrom: getEnvVar("DEFAULT_FROM_EMAIL", env),
    maxAttachmentSize:
      parseInt(getEnvVar("MAX_ATTACHMENT_SIZE", env)) || 10 * 1024 * 1024,
    allowedMimeTypes: getEnvVar("ALLOWED_MIME_TYPES", env)?.split(",") || [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
    ],
    retentionDays: parseInt(getEnvVar("EMAIL_RETENTION_DAYS", env)) || 30,
  },
  redis: {
    url: env.UPSTASH_REDIS_REST_URL || "",
    token: env.UPSTASH_REDIS_REST_TOKEN || "",
  },
  r2: {
    bucket: getEnvVar("R2_BUCKET", env),
    accessKey: getEnvVar("R2_ACCESS_KEY", env),
    secretKey: getEnvVar("R2_SECRET_KEY", env),
    accountId: getEnvVar("R2_ACCOUNT_ID", env),
  },
  search: {
    batchSize: parseInt(getEnvVar("SEARCH_INDEX_BATCH_SIZE", env)) || 100,
  },
});
