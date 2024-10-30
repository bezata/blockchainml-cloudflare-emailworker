import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { ThreadHandler } from "../handlers/thread";
import {
  authMiddleware,
  type Bindings,
  type UserInfo,
} from "../middlewares/auth";

// Define response schemas
const ThreadResponseSchema = z.object({
  id: z.string(),
  subject: z.string(),
  lastMessageAt: z.string().datetime(),
  messageCount: z.number(),
  participants: z.array(z.string()),
  labels: z.array(z.string()).optional(),
  updatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

const ThreadListResponseSchema = z.object({
  threads: z.array(ThreadResponseSchema),
  pagination: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    pages: z.number(),
  }),
});

// Create router instance with proper typing
const threadRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: {
    user: UserInfo;
  };
}>();

const handler = new ThreadHandler();

const getAllThreadsRoute = createRoute({
  method: "get",
  path: "/",
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: "page",
      in: "query",
      schema: { type: "integer", default: 1, minimum: 1 },
      required: false,
    },
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", default: 50, minimum: 1, maximum: 100 },
      required: false,
    },
    {
      name: "sort",
      in: "query",
      schema: {
        type: "string",
        enum: ["newest", "oldest", "updated"],
        default: "newest",
      },
      required: false,
    },
  ],
  responses: {
    200: {
      description: "Successfully retrieved threads",
      content: {
        "application/json": {
          schema: ThreadListResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

threadRoutes.use("*", authMiddleware);
// @ts-ignore
threadRoutes.openapi(getAllThreadsRoute, async (c) => {
  const response = await handler.getThreads(c);
  return c.json(response);
});

const getThreadByIdRoute = createRoute({
  method: "get",
  path: "/:id",
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", minLength: 1 },
      description: "Thread ID",
    },
  ],
  responses: {
    200: {
      description: "Successfully retrieved thread",
      content: {
        "application/json": {
          schema: ThreadResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    404: {
      description: "Thread not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

//@ts-ignore
threadRoutes.openapi(getThreadByIdRoute, async (c) => {
  return handler.getThreadById(c);
});

export { threadRoutes };
