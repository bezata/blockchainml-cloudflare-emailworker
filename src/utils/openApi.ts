export const openApiSpec = {
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
      Thread: {
        type: "object",
        properties: {
          _id: { type: "string" },
          subject: { type: "string" },
          participants: {
            type: "array",
            items: { type: "string", format: "email" },
          },
          emailIds: { type: "array", items: { type: "string" } },
          lastMessageAt: { type: "string", format: "date-time" },
          messageCount: { type: "integer" },
          status: { type: "string", enum: ["active", "archived", "trash"] },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["subject", "participants", "status"],
      },
      AnalyticsResponse: {
        type: "object",
        properties: {
          timeRange: {
            type: "object",
            properties: {
              start: { type: "string", format: "date-time" },
              end: { type: "string", format: "date-time" },
            },
          },
          emailStats: {
            type: "object",
            properties: {
              total: { type: "integer" },
              read: { type: "integer" },
              unread: { type: "integer" },
              archived: { type: "integer" },
            },
          },
          threadStats: {
            type: "object",
            properties: {
              total: { type: "integer" },
              active: { type: "integer" },
              avgMessagesPerThread: { type: "number" },
            },
          },
        },
      },
      Error: {
        type: "object",
        properties: {
          status: { type: "integer" },
          message: { type: "string" },
          details: { type: "object" },
          requestId: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["status", "message"],
      },
      PaginationResponse: {
        type: "object",
        properties: {
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
    },
    parameters: {
      PageParam: {
        in: "query",
        name: "page",
        schema: { type: "integer", minimum: 1, default: 1 },
        description: "Page number",
      },
      LimitParam: {
        in: "query",
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        description: "Items per page",
      },
    },
    responses: {
      UnauthorizedError: {
        description: "Unauthorized",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      NotFoundError: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        summary: "System health check",
        security: [],
        responses: {
          200: {
            description: "System health status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      enum: ["healthy", "degraded", "unhealthy"],
                    },
                    version: { type: "string" },
                    uptime: { type: "number" },
                    metrics: {
                      type: "object",
                      properties: {
                        memory: { type: "object" },
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
    },
    "/api/v1/emails": {
      get: {
        tags: ["emails"],
        summary: "List emails",
        parameters: [
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
          {
            in: "query",
            name: "status",
            schema: {
              type: "string",
              enum: ["unread", "read", "archived", "trash"],
            },
          },
        ],
        responses: {
          200: {
            description: "List of emails",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Email" },
                    },
                    pagination: {
                      $ref: "#/components/schemas/PaginationResponse",
                    },
                  },
                },
              },
            },
          },
          401: { $ref: "#/components/responses/UnauthorizedError" },
        },
      },
      post: {
        tags: ["emails"],
        summary: "Send email",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Email" },
            },
          },
        },
        responses: {
          201: {
            description: "Email sent",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Email" },
              },
            },
          },
          401: { $ref: "#/components/responses/UnauthorizedError" },
        },
      },
    },
    "/api/v1/threads/{threadId}": {
      get: {
        tags: ["threads"],
        summary: "Get thread by ID",
        parameters: [
          {
            in: "path",
            name: "threadId",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Thread details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thread" },
              },
            },
          },
          404: { $ref: "#/components/responses/NotFoundError" },
        },
      },
    },
    "/api/v1/analytics": {
      get: {
        tags: ["analytics"],
        summary: "Get email analytics",
        parameters: [
          {
            in: "query",
            name: "startDate",
            required: true,
            schema: { type: "string", format: "date-time" },
          },
          {
            in: "query",
            name: "endDate",
            required: true,
            schema: { type: "string", format: "date-time" },
          },
        ],
        responses: {
          200: {
            description: "Analytics data",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalyticsResponse" },
              },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }, { apiKey: [] }],
};
