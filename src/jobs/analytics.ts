import { JobScheduler } from "./scheduler";
import { JobWorker } from "./workers";
import { JobPriority } from "./types";
import { AnalyticsProcessor } from "@/services/analytics/processor";

export default async function analytics(data: {
  timeRange: { start: Date; end: Date };
  metrics: string[];
}): Promise<Record<string, any>> {
  const processor = new AnalyticsProcessor();
  const stats = await processor.aggregateStats(data.timeRange);

  // You might want to store or process these stats further
  return stats;
}

// Example usage:
const scheduler = new JobScheduler();

// Schedule immediate job
await scheduler.scheduleJob(
  "cleanup",
  {
    olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
    types: ["attachments", "analytics"],
  },
  {
    priority: JobPriority.LOW,
  }
);

// Schedule future job
await scheduler.scheduleJob(
  "analytics",
  {
    timeRange: {
      start: new Date(),
      end: new Date(),
    },
    metrics: ["emailStats", "userActivity"],
  },
  {
    scheduledFor: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    priority: JobPriority.NORMAL,
  }
);

// Start worker
const worker = new JobWorker();
await worker.start();

// Graceful shutdown
process.on("SIGTERM", async () => {
  await worker.stop();
});
