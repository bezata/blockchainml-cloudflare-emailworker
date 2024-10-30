import { JobScheduler } from "./scheduler";
import { JobPriority, TaskType } from "./types";
import { AnalyticsProcessor } from "@/services/analytics/processor";
import { Logger } from "@/utils/logger";
import {
  AnalyticsTaskPayload,
  AnalyticsStats,
} from "@/types/analytics";

interface AnalyticsResult {
  success: boolean;
  stats: AnalyticsStats;
  processingTime?: number;
  error?: string;
}

export default async function analyticsHandler(
  data: AnalyticsTaskPayload
): Promise<AnalyticsResult> {
  const startTime = Date.now();
  const processor = new AnalyticsProcessor();
  const logger = Logger.getInstance("production");

  try {
    logger.info("Starting analytics processing", data);

    const stats = await processor.aggregateStats(data.timeRange);

    logger.info("Analytics processing completed", {
      processingTime: Date.now() - startTime,
    });

    return {
      success: true,
      stats,
      processingTime: Date.now() - startTime,
    };
  } catch (error) {
    logger.error("Analytics processing failed:", error);
    return {
      success: false,
      stats: {},
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

// Example usage and job scheduling
export async function scheduleAnalytics(): Promise<void> {
  const scheduler = new JobScheduler();

  // Schedule daily analytics
  await scheduler.enqueue<AnalyticsTaskPayload>(
    TaskType.GENERATE_ANALYTICS,
    {
      timeRange: {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000),
        end: new Date(),
      },
      metrics: ["emailStats", "userActivity", "systemStats"],
      options: {
        aggregation: "hour",
      },
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(),
    },
    {
      priority: JobPriority.LOW,
      tags: ["analytics", "daily"],
    }
  );
}
