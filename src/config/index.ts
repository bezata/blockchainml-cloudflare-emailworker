export const config = {
  app: {
    name: "email-worker",
    version: "1.0.0",
  },
  cors: {
    allowedOrigins: ["https://yourdomain.com", "http://localhost:3000"],
  },
  mongodb: {
    dbName: "emailService",
    collections: {
      emails: "emails",
      threads: "threads",
      analytics: "analytics",
    },
  },
  email: {
    maxAttachmentSize: 10 * 1024 * 1024, // 10MB
    allowedAttachmentTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    spamScoreThreshold: 0.5,
  },
  api: {
    rateLimit: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
    },
    pagination: {
      defaultLimit: 50,
      maxLimit: 100,
    },
  },
  cache: {
    ttl: 60 * 60, // 1 hour
    prefix: "email-worker:",
  },
};
