import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { EmailHandler } from "@/api/handlers/email";
import { authMiddleware } from "@/api/middlewares/auth";

const emailRoutes = new OpenAPIHono();
const handler = new EmailHandler();

// Schema definitions
const EmailSchema = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()),
  subject: z.string(),
  textContent: z.string().optional(),
  htmlContent: z.string().optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
});

// Route definitions with OpenAPI documentation
emailRoutes.openapi(
  {
    method: "get",
    path: "/",
    tags: ["emails"],
    summary: "Get all emails",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "page",
        in: "query",
        schema: { type: "integer", default: 1 },
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", default: 50 },
      },
      {
        name: "status",
        in: "query",
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
                success: { type: "boolean" },
                data: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Email" },
                },
                pagination: {
                  type: "object",
                  properties: {
                    page: { type: "integer" },
                    limit: { type: "integer" },
                    total: { type: "integer" },
                    totalPages: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  handler.getEmails
);
emailRoutes.openapi(
  {
    path: "/:id",
    method: "get",
    tags: ["emails"],
    summary: "Get email by ID",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      200: {
        description: "Email details",
      },
    },
  },
  handler.getEmailById
);

emailRoutes.use("/:id", authMiddleware);

emailRoutes.openapi(
  {
    method: "post",
    path: "/",
    tags: ["emails"],
    summary: "Send new email",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: EmailSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Email sent successfully",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                success: { type: "boolean" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  handler.sendEmail
);

export { emailRoutes };
