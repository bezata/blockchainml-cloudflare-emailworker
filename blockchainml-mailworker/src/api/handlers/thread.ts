import { Context } from "hono";
import { ThreadRepository } from "@/db/models/repositories/thread";
import { Validator } from "@/utils/validation";
import { Logger } from "@/utils/logger";

export class ThreadHandler {
  private repository: ThreadRepository;
  private logger: Logger;

  constructor() {
    this.repository = new ThreadRepository();
    this.logger = Logger.getInstance("production");
  }

  getThreads = async (c: Context): Promise<Response> => {
    try {
      const { page, limit } = Validator.validatePagination(
        Number(c.req.query("page")),
        Number(c.req.query("limit"))
      );

      const { threads, total } = await this.repository.getThreadsWithEmails(
        {},
        { page, limit }
      );

      return c.json({
        success: true,
        data: threads,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      this.logger.error("Error getting threads:", error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  };

  getThreadById = async (c: Context): Promise<Response> => {
    try {
      const id = c.req.param("id");
      const thread = await this.repository.findById(id);

      if (!thread) {
        return c.json({ success: false, error: "Thread not found" }, 404);
      }

      return c.json({ success: true, data: thread });
    } catch (error) {
      this.logger.error("Error getting thread:", error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  };
}
