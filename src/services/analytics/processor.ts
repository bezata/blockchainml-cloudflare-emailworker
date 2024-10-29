import { Logger } from "@/utils/logger";
import { AnalyticsRepository } from "@/db/models/repositories/analytics";
import { AnalyticsEventType } from "@/db/models/analytics";
import { ObjectId } from "mongodb";

export class AnalyticsProcessor {
  private readonly logger: Logger;
  private readonly repository: AnalyticsRepository;

  constructor() {
    this.logger = Logger.getInstance("production");
    this.repository = new AnalyticsRepository();
  }

  async trackEvent(event: {
    type: AnalyticsEventType;
    userId: string;
    emailId?: string;
    threadId?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      const event_data: any = {
        type: event.type,
        userId: event.userId,
        timestamp: new Date(),
        metadata: event.metadata || {},
      };

      if (event.emailId) event_data.emailId = new ObjectId(event.emailId);
      if (event.threadId) event_data.threadId = new ObjectId(event.threadId);

      await this.repository.createEvent(event_data);
    } catch (error) {
      this.logger.error("Error tracking analytics event:", error);
    }
  }

  async aggregateStats(timeRange: {
    start: Date;
    end: Date;
  }): Promise<Record<string, any>> {
    try {
      const [emailStats, threadStats, userStats] = await Promise.all([
        this.getEmailStats(timeRange),
        this.getThreadStats(timeRange),
        this.getUserStats(timeRange),
      ]);

      return {
        timeRange,
        emailStats,
        threadStats,
        userStats,
        generatedAt: new Date(),
      };
    } catch (error) {
      this.logger.error("Error aggregating analytics:", error);
      throw error;
    }
  }

  private async getEmailStats(timeRange: { start: Date; end: Date }) {
    return this.repository.aggregate([
      {
        $match: {
          timestamp: { $gte: timeRange.start, $lte: timeRange.end },
          type: { $in: ["email_received", "email_sent", "email_read"] },
        },
      },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: "$userId" },
        },
      },
    ]);
  }

  private async getThreadStats(timeRange: { start: Date; end: Date }) {
    return this.repository.aggregate([
      {
        $match: {
          timestamp: { $gte: timeRange.start, $lte: timeRange.end },
          threadId: { $exists: true },
        },
      },
      {
        $group: {
          _id: "$threadId",
          messageCount: { $sum: 1 },
          participants: { $addToSet: "$userId" },
        },
      },
      {
        $group: {
          _id: null,
          totalThreads: { $sum: 1 },
          avgMessagesPerThread: { $avg: "$messageCount" },
          avgParticipantsPerThread: { $avg: { $size: "$participants" } },
        },
      },
    ]);
  }

  private async getUserStats(timeRange: { start: Date; end: Date }) {
    return this.repository.aggregate([
      {
        $match: {
          timestamp: { $gte: timeRange.start, $lte: timeRange.end },
        },
      },
      {
        $group: {
          _id: "$userId",
          activityCount: { $sum: 1 },
          lastActive: { $max: "$timestamp" },
          eventTypes: { $addToSet: "$type" },
        },
      },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          avgActivityPerUser: { $avg: "$activityCount" },
          mostActiveUsers: {
            $push: {
              userId: "$_id",
              activityCount: "$activityCount",
              lastActive: "$lastActive",
            },
          },
        },
      },
      {
        $project: {
          totalUsers: 1,
          avgActivityPerUser: 1,
          mostActiveUsers: { $slice: ["$mostActiveUsers", 10] },
        },
      },
    ]);
  }
}
