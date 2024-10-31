import { Job, JobStatus, TaskType } from "./types";
import { JobScheduler } from "./scheduler";
import { Logger } from "../utils/logger";
import { Helpers } from "@/utils/helpers";
import { Redis } from "@upstash/redis";
import type { TaskPayload } from "./types";

type JobHandler = (data: any, env: any) => Promise<any>;

interface JobHandlerModule {
  default: JobHandler;
}

export class JobWorker {
  private readonly scheduler: JobScheduler;
  private readonly logger: Logger;
  private readonly redis: Redis;
  private isRunning: boolean = false;
  private currentJob: Job<TaskPayload> | null = null;

  constructor() {
    this.scheduler = JobScheduler.getInstance();
    this.logger = Logger.getInstance("production");
    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL!,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      try {
        // @ts-ignore
        this.currentJob = await this.scheduler.getNextJob();

        if (!this.currentJob) {
          await Helpers.sleep(1000); // Wait before checking again
          continue;
        }

        await this.processJob(this.currentJob);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        this.logger.error("Worker error:", { error: errorMessage });
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

  private async processJob(job: Job<TaskPayload>): Promise<void> {
    try {
      const handler = await this.getJobHandler(job.type);
      const result = await handler(job.data, job.env);

      await this.handleCompletedJob(job, result);
    } catch (error) {
      if (error instanceof Error) {
        await this.handleFailedJob(job, error);
      } else {
        await this.handleFailedJob(job, new Error("Unknown error occurred"));
      }
    }
  }

  private async getJobHandler(type: string): Promise<JobHandler> {
    // Import job handlers dynamically based on TaskType
    try {
      let handlerModule: JobHandlerModule;

      switch (type) {
        case TaskType.CLEANUP_STORAGE:
          handlerModule = await import("@/jobs/cleanup");
          break;
        case TaskType.PROCESS_EMAIL:
          handlerModule = await import("@/jobs/email");
          break;
        case TaskType.GENERATE_ANALYTICS:
          handlerModule = await import("@/jobs/analytics");
          break;
        case TaskType.INDEX_SEARCH:
          handlerModule = await import("@/jobs/indexing");
          break;
        default:
          throw new Error(`Unsupported job type: ${type}`);
      }

      if (!handlerModule.default) {
        throw new Error(`Handler not found for job type: ${type}`);
      }

      return handlerModule.default;
    } catch (error) {
      this.logger.error(`Error loading handler for job type ${type}:`, error);
      throw new Error(`Failed to load handler for job type: ${type}`);
    }
  }

  private async handleCompletedJob(
    job: Job<TaskPayload>,
    result: any
  ): Promise<void> {
    try {
      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date();
      job.result = result;

      await this.updateJobStatus(job);

      this.logger.info("Job completed", {
        jobId: job.id,
        type: job.type,
        duration: job.completedAt.getTime() - job.createdAt.getTime(),
      });

      // Emit metrics
      await this.emitJobMetrics(job);
    } catch (error) {
      this.logger.error("Error handling completed job:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async handleFailedJob(
    job: Job<TaskPayload>,
    error: Error
  ): Promise<void> {
    try {
      job.status = JobStatus.FAILED;
      job.error = error.message;
      job.attempts += 1;

      const shouldRetry = job.attempts < (job.retryStrategy?.maxAttempts ?? 3);

      if (shouldRetry) {
        await this.retryJob(job);
      } else {
        await this.updateJobStatus(job);
        await this.moveToDeadLetterQueue(job);

        this.logger.error("Job failed permanently", {
          jobId: job.id,
          type: job.type,
          error: job.error,
          attempts: job.attempts,
        });
      }
    } catch (error) {
      this.logger.error("Error handling failed job:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async retryJob(job: Job<TaskPayload>): Promise<void> {
    const initialDelay = job.retryStrategy?.initialDelay ?? 1000;
    const backoff = job.retryStrategy?.backoff ?? "exponential";

    const backoffDelay =
      backoff === "exponential"
        ? Math.pow(2, job.attempts) * initialDelay
        : job.attempts * initialDelay;

    const nextAttempt = new Date(Date.now() + backoffDelay);

    await this.scheduler.scheduleJob(job.type, job.data, {
      priority: job.priority,
      scheduledFor: nextAttempt,
      retryStrategy: job.retryStrategy ?? {
        maxAttempts: 3,
        backoff: "exponential",
        initialDelay: 1000,
      },
      tags: job.tags,
    });

    this.logger.warn("Job rescheduled", {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      nextAttempt: nextAttempt.toISOString(),
      backoffDelay,
    });
  }

  private async moveToDeadLetterQueue(job: Job): Promise<void> {
    try {
      await this.redis.zadd("jobs:dlq", {
        score: Date.now(),
        member: JSON.stringify(job),
      });
    } catch (error) {
      this.logger.error("Error moving job to DLQ:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async updateJobStatus(job: Job): Promise<void> {
    try {
      await this.redis.hset(`jobs:status:${job.id}`, {
        status: job.status,
        attempts: job.attempts,
        error: job.error || null,
        completedAt: job.completedAt?.toISOString() || null,
        result: job.result ? JSON.stringify(job.result) : null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error("Error updating job status:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async emitJobMetrics(job: Job): Promise<void> {
    try {
      const metrics = {
        jobType: job.type,
        duration: job.completedAt
          ? job.completedAt.getTime() - job.createdAt.getTime()
          : 0,
        attempts: job.attempts,
        status: job.status,
        timestamp: Date.now(),
      };

      await this.redis.zadd("jobs:metrics", {
        score: Date.now(),
        member: JSON.stringify(metrics),
      });
    } catch (error) {
      this.logger.error("Error emitting job metrics:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
