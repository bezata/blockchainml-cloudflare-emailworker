import { Context } from "hono";
import { AnalyticsProcessor } from "../../services/analytics/processor";
import { AnalyticsRepository } from "../../db/models/repositories/analytics";
import { Validator } from "../../utils/validation";
import { Logger } from "../../utils/logger";

export class AnalyticsHandler {
  private processor: AnalyticsProcessor;
  private repository: AnalyticsRepository;
  private logger: Logger;

  constructor() {
    this.processor = new AnalyticsProcessor();
    this.repository = new AnalyticsRepository();
    this.logger = Logger.getInstance("production");
  }

  getStats = async (c: Context): Promise<Response> => {
    try {
      const startDateStr = c.req.query("startDate") || new Date().toISOString();
      const endDateStr = c.req.query("endDate") || new Date().toISOString();
      const startDate = new Date(startDateStr);
      const endDate = new Date(endDateStr);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return c.json(
          {
            success: false,
            error: "Invalid date format",
          },
          400
        );
      }

      const stats = await this.processor.aggregateStats({
        start: startDate,
        end: endDate,
      });

      return c.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      this.logger.error("Error getting analytics stats:", error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  };

  getUserActivity = async (c: Context): Promise<Response> => {
    try {
      const userId = c.req.param("userId");
      const { page, limit } = Validator.validatePagination(
        Number(c.req.query("page")),
        Number(c.req.query("limit"))
      );

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const { events, total } = await this.repository.getEventsByUser(
        userId,
        { start: startDate, end: endDate },
        { page, limit }
      );

      return c.json({
        success: true,
        data: events,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      this.logger.error("Error getting user activity:", error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  };
}
