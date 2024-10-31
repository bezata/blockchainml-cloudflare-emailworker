import { Context, Next } from "hono";
import { StatusCode } from "hono/utils/http-status";
import { Logger } from "../../utils/logger";

const logger = Logger.getInstance("production");

export async function errorMiddleware(c: Context, next: Next) {
  try {
    return await next();
  } catch (error) {
    logger.error("Unhandled error:", error);

    // Determine error type and status code
    let status = 500;
    let message = "Internal server error";

    if (error instanceof Error && error.name === "ValidationError") {
      status = 400;
      message = error.message;
    } else if (error instanceof Error && error.name === "NotFoundError") {
      status = 404;
      message = error.message;
    } else if (error instanceof Error && error.name === "UnauthorizedError") {
      status = 401;
      message = error.message;
    }

    // Send error response
    return c.json(
      {
        error: {
          message,
          code: status,
          ...(Bun.env.ENVIRONMENT === "development" && {
            stack: error instanceof Error ? error.stack : undefined,
          }),
        },
      },
      status as StatusCode
    );
  }
}
