export const constants = {
  app: {
    name: "email-worker",
    version: "1.0.0",
    apiVersion: "v1",
  },
  mongodb: {
    collections: {
      emails: "emails",
      threads: "threads",
      filters: "filters",
      analytics: "analytics",
    },
    maxPoolSize: 10,
  },
  email: {
    maxAttachmentSize: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: [
      "text/plain",
      "text/html",
      "application/pdf",
      "image/jpeg",
      "image/png",
    ],
    spamThreshold: 0.5,
  },
  pagination: {
    defaultLimit: 50,
    maxLimit: 100,
  },
  cache: {
    ttl: 3600, // 1 hour
  },
  security: {
    jwtExpiresIn: "24h",
    bcryptRounds: 10,
  },
};
