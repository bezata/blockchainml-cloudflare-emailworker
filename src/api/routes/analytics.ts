import { OpenAPIHono } from "@hono/zod-openapi";
import { AnalyticsHandler } from "../handlers/analytics";
import { authMiddleware } from "../middlewares/auth";

const analyticsRoutes = new OpenAPIHono();
const handler = new AnalyticsHandler();

analyticsRoutes.openapi(
  {
    method: "get",
    path: "/stats",
    security: [{ bearerAuth: [] }],
    tags: ["analytics"],
    summary: "Get email analytics",
    parameters: [
      {
        name: "startDate",
        in: "query",
        required: true,
        schema: { type: "string", format: "date-time" },
      },
      {
        name: "endDate",
        in: "query",
        required: true,
        schema: { type: "string", format: "date-time" },
      },
    ],
    responses: {
      200: {
        description: "Success",
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      },
    },
  },
  handler.getStats
);

analyticsRoutes.use("/users/:userId/activity", authMiddleware);
analyticsRoutes.openapi(
  {
    method: "get",
    path: "/users/:userId/activity",
    security: [{ bearerAuth: [] }],
    tags: ["analytics"],
    summary: "Get user activity",
    parameters: [
      {
        name: "userId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
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
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      },
    },
  },
  handler.getUserActivity
);

export { analyticsRoutes };
