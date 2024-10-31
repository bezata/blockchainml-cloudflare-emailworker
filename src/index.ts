import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { secureHeaders } from "hono/secure-headers";
import { cache } from "hono/cache";
import { emailRoutes } from "./api/routes/email";
import { threadRoutes } from "./api/routes/thread";
import { analyticsRoutes } from "./api/routes/analytics";
import { queueRoutes } from "./api/routes/queue";
import { authMiddleware } from "@/api/middlewares/auth";
import { errorMiddleware } from "@/api/middlewares/error";
import { QueueManager } from "./services/storage/queue";
import { StatusCode } from "hono/utils/http-status";
import { Context } from "hono";

// Create OpenAPI app instance
const app = new OpenAPIHono<{ Bindings: Env }>();

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

// The base unprotected app for public routes
const publicApp = new OpenAPIHono<{ Bindings: Env }>();
const apiApp = new OpenAPIHono<{ Bindings: Env }>();

// Global Middlewares
app.use("*", logger());
app.use("*", timing());
app.use("*", prettyJSON());
app.use("*", secureHeaders());
app.use("*", errorMiddleware);

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    exposeHeaders: ["X-Total-Count", "X-Request-ID"],
    credentials: true,
    maxAge: 86400,
  })
);

// Initialize queue manager middleware
app.use("*", async (c, next) => {
  try {
    const queueManager = new QueueManager({
      UPSTASH_REDIS_REST_URL: Bun.env.UPSTASH_REDIS_REST_URL!,
      UPSTASH_REDIS_REST_TOKEN: Bun.env.UPSTASH_REDIS_REST_TOKEN!,
      EMAIL_DOMAIN: Bun.env.EMAIL_DOMAIN!,
      DEFAULT_FROM_EMAIL: Bun.env.DEFAULT_FROM_EMAIL!,
      //@ts-expect-error: i am just tired bro
      ATTACHMENT_BUCKET: Bun.env.ATTACHMENT_BUCKET!,
      //@ts-expect-error: i am just tired bro
      KV_STORE: Bun.env.KV_STORE!,
      MONGODB_URI: Bun.env.MONGODB_URI!,
    });
    c.set("queueManager", queueManager);
    await next();
  } catch (error) {
    console.error("Failed to initialize queue manager:", error);
    return c.json({ error: "Service initialization failed" }, 500);
  }
});

// Public routes (no auth required)
publicApp.get("/", (c) =>
  c.json({ status: "ok", message: "BlockchainML Email Worker API" })
);

publicApp.get("/health", async (c) => {
  const metrics = await getSystemMetrics(c);
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    metrics,
  });
});

// Swagger documentation routes
publicApp.get(
  "/docs",
  swaggerUI({
    url: "/api-docs",
  })
);

publicApp.get(
  "/api-docs",
  cache({
    cacheName: "api-docs",
    cacheControl: "public, max-age=86400",
  }),
  (c) => c.json(openApiSpec)
);

// Protected API routes
apiApp.use("*", authMiddleware);
apiApp.route("/emails", emailRoutes);
apiApp.route("/threads", threadRoutes);
apiApp.route("/analytics", analyticsRoutes);
apiApp.route("/queue", queueRoutes);

// Mount sub-applications
app.route("", publicApp);
app.route("/api/v1", apiApp);

// Error handling
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, {
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    requestId: c.req.header("X-Request-ID"),
  });

  if (err instanceof Error) {
    const status = (err as any).status || 500;
    return c.json(
      {
        status,
        message: err.message,
        requestId: c.req.header("X-Request-ID"),
        timestamp: new Date().toISOString(),
      },
      status as StatusCode
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
async function getSystemMetrics(c: Context) {
  const queueManager = c.get("queueManager");
  const pendingJobs = await queueManager.getQueueStats();

  return {
    memory: {
      usage: process.memoryUsage(),
      heapLimit: process.memoryUsage().heapTotal,
    },
    queue: {
      pending: pendingJobs.pending,
    },
  };
}

// Types
type Env = {
  JWT_SECRET: string;
  API_KEY: string;
  ENVIRONMENT: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  EMAIL_DOMAIN: string;
  DEFAULT_FROM_EMAIL: string;
  [key: string]: string | undefined;
};

declare module "hono" {
  interface ContextVariableMap {
    queueManager: QueueManager;
  }
}

export type AppType = typeof app;
export default app;
