import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { secureHeaders } from "hono/secure-headers";
import { cache } from "hono/cache";
import { config } from "./config";
import { emailRoutes } from "./api/routes/email";
import { threadRoutes } from "./api/routes/thread";
import { analyticsRoutes } from "./api/routes/analytics";
import { queueRoutes } from "./api/routes/queue";
import { authMiddleware } from "@/api/middlewares/auth";
import { rateLimitMiddleware } from "@/api/middlewares/rateLimit";
import { errorMiddleware } from "@/api/middlewares/error";
import { QueueManager, WorkerEnv } from "./services/storage/queue";
import { StatusCode } from "hono/utils/http-status";

// OpenAPI Specification
const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "BlockchainML Email Worker API",
    version: "1.0.0",
    description:
      "Enterprise email processing system with blockchain integration",
    contact: {
      name: "BlockchainML Support",
      email: "support@blockchainml.com",
      url: "https://blockchainml.com/support",
    },
  },
  servers: [
    {
      url: "https://api.blockchainml.com",
      description: "Production server",
    },
    {
      url: "https://staging-api.blockchainml.com",
      description: "Staging server",
    },
    {
      url: "http://localhost:8787",
      description: "Development server",
    },
  ],
  tags: [
    {
      name: "emails",
      description: "Email management and processing operations",
    },
    {
      name: "threads",
      description: "Email thread and conversation management",
    },
    {
      name: "analytics",
      description: "Email analytics and insights",
    },
    {
      name: "queue",
      description: "Background job and task management",
    },
    {
      name: "system",
      description: "System health and maintenance",
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      },
    },
    schemas: {
      Email: {
        type: "object",
        properties: {
          _id: { type: "string" },
          messageId: { type: "string" },
          threadId: { type: "string" },
          from: { type: "string", format: "email" },
          to: {
            type: "array",
            items: { type: "string", format: "email" },
          },
          cc: {
            type: "array",
            items: { type: "string", format: "email" },
          },
          bcc: {
            type: "array",
            items: { type: "string", format: "email" },
          },
          subject: { type: "string" },
          textContent: { type: "string" },
          htmlContent: { type: "string" },
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                filename: { type: "string" },
                contentType: { type: "string" },
                size: { type: "number" },
                url: { type: "string" },
              },
            },
          },
          priority: {
            type: "string",
            enum: ["high", "normal", "low"],
          },
          status: {
            type: "string",
            enum: ["unread", "read", "archived", "trash"],
          },
          labels: {
            type: "array",
            items: { type: "string" },
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
          receivedAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["from", "to", "subject"],
      },
    },
  },
  security: [{ bearerAuth: [] }, { apiKey: [] }],
};

// Create OpenAPI app instance
const app = new OpenAPIHono<AppBindings>();
const queueManager = new QueueManager({
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL!,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN!,
  EMAIL_DOMAIN: process.env.EMAIL_DOMAIN!,
  DEFAULT_FROM_EMAIL: process.env.DEFAULT_FROM_EMAIL!,
} as WorkerEnv);

// Global Middlewares
app.use("*", logger());
app.use("*", timing());
app.use("*", prettyJSON());
app.use("*", secureHeaders());
app.use("*", errorMiddleware);

// CORS configuration
app.use(
  "*",
  cors({
    origin: config.cors.allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Authorization", "Content-Type", "X-API-Key"],
    exposeHeaders: ["X-Request-ID", "X-Response-Time"],
    maxAge: 86400,
    credentials: true,
  })
);

// Documentation routes
app.get(
  "/docs",
  swaggerUI({
    urls: [
      {
        url: "/api-docs",
        name: "Current Environment",
      },
      {
        url: "https://api.blockchainml.com/api-docs",
        name: "Production",
      },
      {
        url: "https://staging-api.blockchainml.com/api-docs",
        name: "Staging",
      },
    ],
  })
);

app.get(
  "/api-docs",
  cache({
    cacheName: "api-docs",
    cacheControl: "public, max-age=86400",
  }),
  (c) => c.json(openApiSpec)
);

// Health check route schema
const healthCheckSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  version: z.string(),
  timestamp: z.string().datetime(),
  uptime: z.number(),
  metrics: z.object({
    memory: z.object({
      usage: z.record(z.number()),
      heapLimit: z.number(),
    }),
    cpu: z.object({
      usage: z.record(z.number()),
      loadAvg: z.number(),
    }),
    queue: z.object({
      pending: z.number(),
    }),
  }),
});

// Health check endpoint
const healthCheckRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "System health check",
  description: "Returns the current status and health metrics of the API",
  responses: {
    200: {
      description: "System health information",
      content: {
        "application/json": {
          schema: healthCheckSchema,
        },
      },
    },
  },
});

app.openapi(healthCheckRoute, async (c) => {
  const metrics = await getSystemMetrics();
  return c.json({
    status: "healthy" as const,
    version: config.app.version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    metrics,
  });
});

// API Routes with OpenAPI config
const apiRoute = createRoute({
  method: "get",
  path: "/api/v1",
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  responses: {
    200: {
      description: "API root endpoint",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
  },
});

const api = app.openapi(apiRoute, (c) => {
  return c.json({ message: "API root endpoint" });
});

// Apply rate limiting to API routes
api.use("*", rateLimitMiddleware);
api.use("*", authMiddleware);

// Mount route handlers with proper typing
api.route("/emails", emailRoutes);
api.route("/threads", threadRoutes);
api.route("/analytics", analyticsRoutes);
api.route("/queue", queueRoutes);

// Custom error class
class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "APIError";
  }
}

// Error handling
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, {
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    requestId: c.req.header("X-Request-ID"),
  });

  if (err instanceof APIError) {
    return c.json(
      {
        status: err.status,
        message: err.message,
        details: err.details,
        requestId: c.req.header("X-Request-ID"),
        timestamp: new Date().toISOString(),
      },
      err.status as StatusCode
    );
  }

  return c.json(
    {
      status: 500,
      message: "Internal Server Error",
      requestId: c.req.header("X-Request-ID"),
      timestamp: new Date().toISOString(),
    },
    500
  );
});

// Helper function for health metrics
async function getSystemMetrics() {
  const pendingJobs = await queueManager.getQueueStats();

  return {
    memory: {
      usage: process.memoryUsage(),
      heapLimit: process.memoryUsage().heapTotal,
    },
    cpu: {
      usage: process.cpuUsage(),
      loadAvg: 0, // Workers don't have access to this
    },
    queue: {
      pending: pendingJobs.pending,
    },
  };
}

export type AppType = typeof app;
export default app;

// Add this type definition
type AppBindings = {
  Bindings: {
    MONGODB_URI: string;
    JWT_SECRET: string;
    EMAIL_QUEUE: string;
    API_KEY: string;
    ENVIRONMENT: string;
  };
};
