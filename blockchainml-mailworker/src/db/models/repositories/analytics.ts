import { ObjectId } from "mongodb";
import { MongoDB } from "@/config/mongodb";
import { AnalyticsDocument } from "@/db/models/analytics";
import { Logger } from "@/utils/logger";

export class AnalyticsRepository {
  private readonly logger: Logger;
  private readonly collection = "analytics";

  constructor() {
    this.logger = Logger.getInstance("production");
  }

  private getCollection() {
    const client = MongoDB.getClient();
    return client.db().collection<AnalyticsDocument>(this.collection);
  }

  async createEvent(event: Omit<AnalyticsDocument, "_id">): Promise<void> {
    try {
      await this.getCollection().insertOne({
        _id: new ObjectId(),
        ...event,
      });
    } catch (error) {
      this.logger.error("Error creating analytics event:", error);
      throw error;
    }
  }

  async aggregate(pipeline: any[]): Promise<any[]> {
    try {
      return await this.getCollection().aggregate(pipeline).toArray();
    } catch (error) {
      this.logger.error("Error aggregating analytics:", error);
      throw error;
    }
  }

  async getEventsByUser(
    userId: string,
    timeRange: { start: Date; end: Date },
    options: { page: number; limit: number }
  ): Promise<{ events: AnalyticsDocument[]; total: number }> {
    try {
      const query = {
        userId,
        timestamp: { $gte: timeRange.start, $lte: timeRange.end },
      };

      const [events, total] = await Promise.all([
        this.getCollection()
          .find(query)
          .sort({ timestamp: -1 })
          .skip((options.page - 1) * options.limit)
          .limit(options.limit)
          .toArray(),
        this.getCollection().countDocuments(query),
      ]);

      return { events, total };
    } catch (error) {
      this.logger.error("Error getting user events:", error);
      throw error;
    }
  }
}
