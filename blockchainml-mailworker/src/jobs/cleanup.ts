import { JobScheduler } from "./scheduler";
import { JobPriority } from "./types";
import { JobWorker } from "./workers";

export default async function cleanup(data: {
  olderThan: Date;
  types: string[];
}): Promise<void> {
  // Implement cleanup logic
  const { olderThan, types } = data;

  const scheduler = JobScheduler.getInstance();

  for (const type of types) {
    const job = {
      type: `cleanup_${type}`,
      data: { olderThan },
      priority: JobPriority.LOW,
    };

    await scheduler.enqueue(job);
  }
}
