import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
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
import type { Env } from "@/types/env";

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
const app = new OpenAPIHono<{ Bindings: Env }>();

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
    url: "/api-docs",
    title: "BlockchainML Email Worker API",
    theme: "dark",
  })
);

app.get(
  "/api-docs",
  cache({
    cacheName: "api-docs",
    cacheControl: "public, max-age=86400",
  }),
  (c) => {
    return c.json(openApiSpec);
  }
);

// Health check endpoint
app.openapi(
  {
    tags: ["system"],
    summary: "System health check",
    description: "Returns the current status and health metrics of the API",
    responses: {
      200: {
        description: "System health information",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { type: "string" },
                version: { type: "string" },
                timestamp: { type: "string", format: "date-time" },
                uptime: { type: "number" },
                metrics: {
                  type: "object",
                  properties: {
                    memory: { type: "object" },
                    cpu: { type: "object" },
                    queue: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/health",
  async (c) => {
    const metrics = await getSystemMetrics();
    return c.json({
      status: "healthy",
      version: config.app.version,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      metrics,
    });
  }
);

// API Routes
const api = app.openapi(
  {
    info: {
      title: "BlockchainML Email Worker API",
      version: config.app.version,
    },
    security: [{ bearerAuth: [] }, { apiKey: [] }],
  },
  "/api/v1"
);

// Apply rate limiting to API routes
api.use("*", rateLimitMiddleware);
api.use("*", authMiddleware);

// Mount route handlers
api.mount("/emails", emailRoutes);
api.mount("/threads", threadRoutes);
api.mount("/analytics", analyticsRoutes);
api.mount("/queue", queueRoutes);

// Error handling
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, {
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    requestId: c.req.header("X-Request-ID"),
  });

  const status = err.status || 500;
  const message = status === 500 ? "Internal Server Error" : err.message;

  return c.json(
    {
      status,
      message,
      requestId: c.req.header("X-Request-ID"),
      timestamp: new Date().toISOString(),
    },
    status
  );
});

// Helper function for health metrics
async function getSystemMetrics() {
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
      pending: await getQueueMetrics(),
    },
  };
}

export default app;
