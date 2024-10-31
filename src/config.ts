import { env } from "bun";

export const config = {
  app: {
    version: "1.0.0",
  },
  email: {
    domain: Bun.env.EMAIL_DOMAIN || "",
    defaultFrom: Bun.env.DEFAULT_FROM_EMAIL || "",
    maxAttachmentSize: 10 * 1024 * 1024,
    allowedAttachmentTypes: [".pdf", ".doc", ".docx"],
    spamScoreThreshold: 5,
  },
  redis: {
    url: Bun.env.UPSTASH_REDIS_REST_URL || "",
    token: Bun.env.UPSTASH_REDIS_REST_TOKEN || "",
  },
  cors: {
    allowedOrigins: Bun.env.ALLOWED_ORIGINS?.split(",") || ["*"],
  },
};

export function createConfig(c: any) {
  return {
    app: {
      name: "email-worker",
      version: "1.0.0",
      environment: Bun.env.ENVIRONMENT || "development",
      nodeEnv: Bun.env.NODE_ENV || "development",
      apiVersion: Bun.env.API_VERSION || "v1",
    },
    cors: {
      allowedOrigins: Bun.env.ALLOWED_ORIGINS?.split(",") || ["*"],
    },
    email: {
      domain: Bun.env.EMAIL_DOMAIN || "",
      defaultFrom: Bun.env.DEFAULT_FROM_EMAIL || "",
      maxAttachmentSize:
        parseInt(Bun.env.MAX_ATTACHMENT_SIZE || "") || 10 * 1024 * 1024,
      allowedMimeTypes: Bun.env.ALLOWED_MIME_TYPES?.split(",") || [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "application/msword",
      ],
      retentionDays: parseInt(Bun.env.EMAIL_RETENTION_DAYS || "") || 30,
    },
    redis: {
      url: Bun.env.UPSTASH_REDIS_REST_URL || "",
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN || "",
    },
    r2: {
      bucket: Bun.env.R2_BUCKET || "",
      accessKey: Bun.env.R2_ACCESS_KEY || "",
      secretKey: Bun.env.R2_SECRET_KEY || "",
      accountId: Bun.env.R2_ACCOUNT_ID || "",
    },
    search: {
      batchSize: parseInt(Bun.env.SEARCH_INDEX_BATCH_SIZE || "") || 100,
    },
  };
}
