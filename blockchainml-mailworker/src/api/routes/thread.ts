import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ThreadHandler } from "../handlers/thread";
import { authMiddleware } from "../middlewares/auth";

const threadRoutes = new OpenAPIHono();
const handler = new ThreadHandler();

const getAllThreadsRoute = createRoute({
  method: "get",
  path: "/",
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
  ],
  responses: {
    200: {
      description: "Success",
    },
  },
});

threadRoutes.openapi(getAllThreadsRoute, async (c, next) => {
  await authMiddleware(c, next);
  return handler.getThreads(c);
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
      schema: { type: "string" },
    },
  ],
  responses: {
    200: {
      description: "Success",
    },
  },
});

threadRoutes.openapi(getThreadByIdRoute, async (c, next) => {
  await authMiddleware(c, next);
  return handler.getThreadById(c);
});

export { threadRoutes };
