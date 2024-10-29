import { Job, JobStatus } from "@/jobs/types";
import { JobScheduler } from "@/jobs/scheduler";
import { Logger } from "@/utils/logger";

export class JobWorker {
  private readonly scheduler: JobScheduler;
  private readonly logger: Logger;
  private isRunning: boolean = false;
  private currentJob: Job | null = null;

  constructor() {
    this.scheduler = new JobScheduler();
    this.logger = Logger.getInstance("production");
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      try {
        this.currentJob = await this.scheduler.getNextJob();

        if (!this.currentJob) {
          await Helpers.sleep(1000); // Wait before checking again
          continue;
        }

        await this.processJob(this.currentJob);
      } catch (error) {
        this.logger.error("Worker error:", error);
        await Helpers.sleep(5000); // Wait longer after error
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.currentJob) {
      await this.handleFailedJob(this.currentJob, new Error("Worker stopped"));
    }
  }

  private async processJob(job: Job): Promise<void> {
    try {
      const handler = await this.getJobHandler(job.type);
      const result = await handler(job.data);

      await this.handleCompletedJob(job, result);
    } catch (error) {
      await this.handleFailedJob(job, error);
    }
  }

  private async getJobHandler(type: string): Promise<Function> {
    // Import job handlers dynamically
    const handlers = {
      cleanup: (await import("./tasks/cleanup")).default,
      indexing: (await import("./tasks/indexing")).default,
      analytics: (await import("./tasks/analytics")).default,
    };

    const handler = handlers[type];
    if (!handler) {
      throw new Error(`No handler found for job type: ${type}`);
    }

    return handler;
  }

  private async handleCompletedJob(job: Job, result: any): Promise<void> {
    job.status = JobStatus.COMPLETED;
    job.completedAt = new Date();
    job.result = result;

    await this.updateJobStatus(job);
    this.logger.info("Job completed", { jobId: job.id, type: job.type });
  }

  private async handleFailedJob(job: Job, error: Error): Promise<void> {
    job.status = JobStatus.FAILED;
    job.error = error.message;
    job.attempts += 1;

    if (job.attempts < job.maxAttempts) {
      // Reschedule with backoff
      const backoffMinutes = Math.pow(2, job.attempts);
      const nextAttempt = new Date();
      nextAttempt.setMinutes(nextAttempt.getMinutes() + backoffMinutes);

      await this.scheduler.scheduleJob(job.type, job.data, {
        priority: job.priority,
        scheduledFor: nextAttempt,
        maxAttempts: job.maxAttempts,
      });

      this.logger.warn("Job failed, rescheduling", {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        nextAttempt,
      });
    } else {
      await this.updateJobStatus(job);
      this.logger.error("Job failed permanently", {
        jobId: job.id,
        type: job.type,
        error: job.error,
      });
    }
  }

  private async updateJobStatus(job: Job): Promise<void> {
    await this.redis.hset(`jobs:status:${job.id}`, job);
  }
}
