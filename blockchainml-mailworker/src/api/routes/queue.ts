import { OpenAPIHono } from "@hono/zod-openapi";
import { Context } from "hono";
import { z } from "zod";
import { QueueManager } from "../../services/storage/queue";
import type { Env } from "@/types/env";
import { QueueTask } from "@/types/queue";
import { TaskPayload } from "@/types/queue";

const queueRoutes = new OpenAPIHono<Env>();
const queueManager = new QueueManager();

// Response schemas
const TaskStatusSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      attempts: z.number(),
      lastAttemptAt: z.string().datetime().optional(),
      error: z.string().optional(),
      completedAt: z.string().datetime().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

const FailedTasksSchema = z.object({
  success: z.boolean(),
  data: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      error: z.string(),
      attempts: z.number(),
      createdAt: z.string().datetime(),
      completedAt: z.string().datetime().optional(),
    })
  ),
});

queueRoutes.openapi(
  {
    method: "get",
    path: "/tasks/:taskId",
    tags: ["queue"],
    summary: "Get task status",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "taskId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      200: {
        description: "Task status retrieved successfully",
        content: {
          "application/json": {
            schema: TaskStatusSchema,
          },
        },
      },
      404: {
        description: "Task not found",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              error: z.string(),
            }),
          },
        },
      },
    },
  },
  async (c: Context) => {
    const taskId = c.req.param("taskId");
    const status = await queueManager.getTaskStatus(taskId);

    if (!status) {
      return c.json({ success: false, error: "Task not found" }, 404);
    }

    return c.json({
      success: true,
      data: status,
    });
  }
);

queueRoutes.openapi(
  {
    method: "get",
    path: "/tasks/failed",
    tags: ["queue"],
    summary: "Get failed tasks",
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
        description: "Failed tasks retrieved successfully",
        content: {
          "application/json": {
            schema: FailedTasksSchema,
          },
        },
      },
    },
  },
  async (c: Context) => {
    const page = Number(c.req.query("page")) || 1;
    const limit = Number(c.req.query("limit")) || 50;
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    const failedTasks = await queueManager.getFailedTasks({
      limit,
      offset: start,
      end: end,
    });

    const tasks = failedTasks.map((task: QueueTask<TaskPayload>) =>
      JSON.parse(task as unknown as string)
    );

    return c.json({
      success: true,
      data: tasks,
    });
  }
);

export { queueRoutes };
