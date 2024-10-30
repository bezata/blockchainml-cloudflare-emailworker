import { Redis } from "@upstash/redis";
import { Logger } from "../utils/logger";
import { Helpers } from "../utils/helpers";
import {
  JobStatus,
  JobPriority,
  JobResult,
  TaskType,
  TaskPayload,
} from "./types";

interface JobOptions {
  priority?: JobPriority;
  scheduledFor?: Date | undefined;
  retryStrategy?: {
    maxAttempts: number;
    backoff: "exponential" | "linear";
    initialDelay: number;
  };
  timeout?: number;
  tags?: string[];
}

interface RetryStrategy {
  maxAttempts: number;
  backoff: "exponential" | "linear";
  initialDelay: number;
}

type Env = "development" | "production" | "test";

interface Job<T extends TaskPayload> {
  id: string;
  type: TaskType;
  data: T;
  env: Env;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  retryStrategy: RetryStrategy;
  timeout: number;
  tags: string[];
  createdAt: Date;
  scheduledFor: Date;
  lastError: string | null;
  progress: number;
  startedAt?: Date;
}

export class JobScheduler {
  private static instance: JobScheduler;
  private readonly redis: Redis;
  private readonly logger: Logger;

  // Redis keys
  private readonly KEYS = {
    QUEUE: "jobs:queue",
    SCHEDULED: "jobs:scheduled",
    LOCKS: "jobs:locks",
    RESULTS: "jobs:results",
    DLQ: "jobs:dlq",
    TAGS: "jobs:tags",
    METRICS: "jobs:metrics",
    STATUS: "jobs:status",
  } as const;

  // Default configurations
  private readonly DEFAULTS = {
    LOCK_TIMEOUT: 300, // 5 minutes
    JOB_TIMEOUT: 300000, // 5 minutes
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    BATCH_SIZE: 100,
  } as const;

  constructor() {
    this.redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
  }

  public static getInstance(): JobScheduler {
    if (!JobScheduler.instance) {
      JobScheduler.instance = new JobScheduler();
    }
    return JobScheduler.instance;
  }

  async enqueue<T extends TaskPayload>(
    type: TaskType,
    data: T,
    options: Partial<JobOptions> = {}
  ): Promise<string> {
    try {
      const defaultRetryStrategy: RetryStrategy = {
        maxAttempts: this.DEFAULTS.RETRY_ATTEMPTS,
        backoff: "exponential",
        initialDelay: this.DEFAULTS.RETRY_DELAY,
      };

      return await this.scheduleJob(type, data, {
        priority: options.priority || JobPriority.NORMAL,
        retryStrategy: { ...defaultRetryStrategy, ...options.retryStrategy },
        timeout: options.timeout || this.DEFAULTS.JOB_TIMEOUT,
        tags: options.tags || [],
        scheduledFor: options.scheduledFor,
      });
    } catch (error) {
      this.logger.error("Failed to enqueue job:", {
        type,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  async scheduleJob<T extends TaskPayload>(
    type: TaskType,
    data: T,
    options: JobOptions
  ): Promise<string> {
    try {
      const job: Job<T> = {
        id: Helpers.generateId(),
        type,
        data,
        env: (process.env.NODE_ENV as Env) || "production",
        priority: options.priority || JobPriority.NORMAL,
        status: options.scheduledFor ? JobStatus.SCHEDULED : JobStatus.PENDING,
        attempts: 0,
        maxAttempts:
          options.retryStrategy?.maxAttempts || this.DEFAULTS.RETRY_ATTEMPTS,
        retryStrategy: options.retryStrategy || {
          maxAttempts: this.DEFAULTS.RETRY_ATTEMPTS,
          backoff: "exponential",
          initialDelay: this.DEFAULTS.RETRY_DELAY,
        },
        timeout: options.timeout || this.DEFAULTS.JOB_TIMEOUT,
        tags: options.tags || [],
        createdAt: new Date(),
        scheduledFor: options.scheduledFor || new Date(),
        lastError: null,
        progress: 0,
      };

      await this.saveJob(job, options.scheduledFor);
      await this.updateMetrics("scheduled", job);

      return job.id;
    } catch (error) {
      this.logger.error("Failed to schedule job:", {
        type,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  private async saveJob(
    job: Job<TaskPayload>,
    scheduledFor?: Date
  ): Promise<void> {
    const pipeline = this.redis.pipeline();

    // Save to appropriate queue
    if (scheduledFor) {
      pipeline.zadd(this.KEYS.SCHEDULED, {
        score: scheduledFor.getTime(),
        member: JSON.stringify(job),
      });
    } else {
      pipeline.zadd(this.KEYS.QUEUE, {
        score: this.calculatePriorityScore(job),
        member: JSON.stringify(job),
      });
    }

    // Index by tags
    if (job.tags.length > 0) {
      for (const tag of job.tags) {
        pipeline.sadd(`${this.KEYS.TAGS}:${tag}`, job.id);
      }
    }

    // Save job details
    pipeline.set(`job:${job.id}`, JSON.stringify(job));

    await pipeline.exec();

    this.logger.info("Job saved successfully", {
      jobId: job.id,
      type: job.type,
      tags: job.tags,
    });
  }

  async getJobStatus(jobId: string): Promise<JobResult | null> {
    try {
      const result = await this.redis.get(`${this.KEYS.RESULTS}:${jobId}`);
      return result ? JSON.parse(result as string) : null;
    } catch (error) {
      this.logger.error("Failed to get job status:", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  async updateJobProgress(jobId: string, progress: number): Promise<void> {
    try {
      const job = await this.getJobById(jobId);
      if (job) {
        job.progress = Math.min(Math.max(progress, 0), 100); // Ensure progress is between 0-100
        await this.redis.set(`job:${jobId}`, JSON.stringify(job));
        await this.updateMetrics("progress", job);
      }
    } catch (error) {
      this.logger.error("Failed to update job progress:", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async retryJob(jobId: string): Promise<boolean> {
    try {
      const job = await this.getJobById(jobId);
      if (!job) return false;

      const retryDelay = this.calculateRetryDelay(job);
      if (retryDelay === null) {
        await this.moveToDeadLetterQueue(job);
        return false;
      }

      job.scheduledFor = new Date(Date.now() + retryDelay);
      job.attempts += 1;
      job.status = JobStatus.SCHEDULED;

      await this.saveJob(job, job.scheduledFor);
      await this.updateMetrics("retry", job);

      return true;
    } catch (error) {
      this.logger.error("Failed to retry job:", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  private async updateMetrics(
    event:
      | "scheduled"
      | "started"
      | "completed"
      | "failed"
      | "retry"
      | "progress",
    job: Job<TaskPayload>
  ): Promise<void> {
    try {
      const metrics = {
        event,
        jobId: job.id,
        type: job.type,
        timestamp: Date.now(),
        attempts: job.attempts,
        progress: job.progress,
      };

      await this.redis.zadd(this.KEYS.METRICS, {
        score: Date.now(),
        member: JSON.stringify(metrics),
      });
    } catch (error) {
      this.logger.error("Failed to update metrics:", {
        event,
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private calculateRetryDelay(job: Job<TaskPayload>): number | null {
    if (!job.retryStrategy || job.attempts >= job.retryStrategy.maxAttempts) {
      return null;
    }

    const { backoff, initialDelay } = job.retryStrategy;
    if (backoff === "exponential") {
      return initialDelay * Math.pow(2, job.attempts);
    }
    return initialDelay * (job.attempts + 1);
  }

  private async moveToDeadLetterQueue(job: Job<TaskPayload>): Promise<void> {
    job.status = JobStatus.FAILED;
    await this.redis.zadd(this.KEYS.DLQ, {
      score: Date.now(),
      member: JSON.stringify(job),
    });
    this.logger.error("Job moved to DLQ", {
      jobId: job.id,
      attempts: job.attempts,
    });
  }

  async getJobsByTag(tag: string): Promise<Job<TaskPayload>[]> {
    const jobIds = await this.redis.smembers(`jobs:tag:${tag}`);
    const jobs: Job<TaskPayload>[] = [];

    for (const jobId of jobIds) {
      const job = await this.getJobById(jobId);
      if (job) jobs.push(job);
    }

    return jobs;
  }

  private async getJobById(jobId: string): Promise<Job<TaskPayload> | null> {
    const jobStr = await this.redis.get(`job:${jobId}`);
    return jobStr ? JSON.parse(jobStr as string) : null;
  }

  async getNextJob(): Promise<Job<TaskPayload> | null> {
    try {
      await this.moveScheduledJobs();

      const result = await this.redis.zpopmin(this.KEYS.QUEUE);
      if (!result || !result[0]) return null;

      const [member] = result;
      const job: Job<TaskPayload> = JSON.parse(member as string);
      job.status = JobStatus.RUNNING;
      job.startedAt = new Date();

      await this.setJobLock(job.id);

      this.logger.info("Job started", { jobId: job.id, type: job.type });
      return job;
    } catch (error) {
      this.logger.error("Error getting next job:", error);
      return null;
    }
  }

  private async moveScheduledJobs(): Promise<void> {
    const now = Date.now();
    const dueJobs = await this.redis.zrange(this.KEYS.SCHEDULED, 0, now, {
      byScore: true,
    });

    if (dueJobs.length === 0) return;

    const pipeline = this.redis.pipeline();

    for (const jobStr of dueJobs) {
      const job: Job<TaskPayload> = JSON.parse(jobStr as string);
      job.status = JobStatus.PENDING;

      pipeline.zrem(this.KEYS.SCHEDULED, jobStr);
      pipeline.zadd(this.KEYS.QUEUE, {
        score: this.calculatePriorityScore(job),
        member: JSON.stringify(job),
      });
    }

    await pipeline.exec();
  }

  private calculatePriorityScore(job: Job<TaskPayload>): number {
    const now = Date.now();
    const priorityWeight = {
      [JobPriority.HIGH]: 1000000,
      [JobPriority.NORMAL]: 100000,
      [JobPriority.LOW]: 10000,
    }[job.priority];

    return now - priorityWeight;
  }

  private async setJobLock(jobId: string): Promise<boolean> {
    return (
      (await this.redis.set(`${this.KEYS.LOCKS}:${jobId}`, "1", {
        nx: true,
        ex: 300, // 5 minute lock
      })) !== null
    );
  }
}
