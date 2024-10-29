import { Redis } from "@upstash/redis";
import { Logger } from "../utils/logger";
import { Helpers } from "../utils/helpers";
import { Job, JobStatus, JobPriority, JobResult } from "./types";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      UPSTASH_REDIS_REST_URL: string;
      UPSTASH_REDIS_REST_TOKEN: string;
    }
  }
}

export class JobScheduler {
  private static instance: JobScheduler;
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly JOBS_KEY = "jobs:queue";
  private readonly SCHEDULED_JOBS_KEY = "jobs:scheduled";
  private readonly JOB_LOCKS_KEY = "jobs:locks";
  private readonly JOB_RESULTS_KEY = "jobs:results";
  private readonly DEAD_LETTER_QUEUE = "jobs:dlq";

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

  async enqueue(job: {
    type: string;
    data: Record<string, any>;
    priority: JobPriority;
    retryStrategy?: {
      maxAttempts?: number;
      backoff?: "exponential" | "linear";
      initialDelay?: number;
    };
    timeout?: number;
    tags?: string[];
  }): Promise<string> {
    const defaultRetryStrategy = {
      maxAttempts: 3,
      backoff: "exponential" as const,
      initialDelay: 1000, // 1 second
    };

    return this.scheduleJob(job.type, job.data, {
      priority: job.priority,
      retryStrategy: { ...defaultRetryStrategy, ...job.retryStrategy },
      timeout: job.timeout || 300000, // 5 minutes default
      tags: job.tags || [],
    });
  }

  async scheduleJob(
    type: string,
    data: Record<string, any>,
    options: {
      priority?: JobPriority;
      scheduledFor?: Date;
      retryStrategy?: {
        maxAttempts: number;
        backoff: "exponential" | "linear";
        initialDelay: number;
      };
      timeout?: number;
      tags?: string[];
    } = {}
  ): Promise<string> {
    try {
      const job: Job = {
        id: Helpers.generateId(),
        type,
        data,
        priority: options.priority || JobPriority.NORMAL,
        status: options.scheduledFor ? JobStatus.SCHEDULED : JobStatus.PENDING,
        attempts: 0,
        maxAttempts: options.retryStrategy?.maxAttempts || 3,
        retryStrategy: options.retryStrategy || {
          maxAttempts: 3,
          backoff: "exponential",
          initialDelay: 1000,
        },
        timeout: options.timeout || 300000,
        tags: options.tags || [],
        createdAt: new Date(),
        scheduledFor: options.scheduledFor || new Date(),
        lastError: null,
        progress: 0,
      };

      const pipeline = this.redis.pipeline();

      if (options.scheduledFor) {
        pipeline.zadd(this.SCHEDULED_JOBS_KEY, {
          score: options.scheduledFor.getTime(),
          member: JSON.stringify(job),
        });
      } else {
        pipeline.zadd(this.JOBS_KEY, {
          score: this.calculatePriorityScore(job),
          member: JSON.stringify(job),
        });
      }

      // Index job by tags for easier querying
      if ((job as Job & { tags: string[] }).tags.length > 0) {
        for (const tag of job.tags) {
          pipeline.sadd(`jobs:tag:${tag}`, job.id);
        }
      }

      await pipeline.exec();
      this.logger.info("Job scheduled", {
        jobId: job.id,
        type,
        tags: job.tags,
      });

      return job.id;
    } catch (error) {
      this.logger.error("Error scheduling job:", error);
      throw error;
    }
  }

  async getJobStatus(jobId: string): Promise<JobResult | null> {
    return this.redis.get(`${this.JOB_RESULTS_KEY}:${jobId}`);
  }

  async updateJobProgress(jobId: string, progress: number): Promise<void> {
    const job = await this.getJobById(jobId);
    if (job) {
      job.progress = progress;
      await this.redis.set(`job:${jobId}`, JSON.stringify(job));
    }
  }

  async retryJob(jobId: string): Promise<boolean> {
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

    await this.redis.zadd(this.SCHEDULED_JOBS_KEY, {
      score: job.scheduledFor.getTime(),
      member: JSON.stringify(job),
    });

    return true;
  }

  private calculateRetryDelay(job: Job): number | null {
    if (!job.retryStrategy || job.attempts >= job.retryStrategy.maxAttempts) {
      return null;
    }

    const { backoff, initialDelay } = job.retryStrategy;
    if (backoff === "exponential") {
      return initialDelay * Math.pow(2, job.attempts);
    }
    return initialDelay * (job.attempts + 1);
  }

  private async moveToDeadLetterQueue(job: Job): Promise<void> {
    job.status = JobStatus.FAILED;
    await this.redis.zadd(this.DEAD_LETTER_QUEUE, {
      score: Date.now(),
      member: JSON.stringify(job),
    });
    this.logger.error("Job moved to DLQ", {
      jobId: job.id,
      attempts: job.attempts,
    });
  }

  async getJobsByTag(tag: string): Promise<Job[]> {
    const jobIds = await this.redis.smembers(`jobs:tag:${tag}`);
    const jobs: Job[] = [];

    for (const jobId of jobIds) {
      const job = await this.getJobById(jobId);
      if (job) jobs.push(job);
    }

    return jobs;
  }

  private async getJobById(jobId: string): Promise<Job | null> {
    const jobStr = await this.redis.get(`job:${jobId}`);
    return jobStr ? JSON.parse(jobStr as string) : null;
  }

  async getNextJob(): Promise<Job | null> {
    try {
      await this.moveScheduledJobs();

      const result = await this.redis.zpopmin(this.JOBS_KEY);
      if (!result || !result[0]) return null;

      const [member] = result;
      const job: Job = JSON.parse(member as string);
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
    const dueJobs = await this.redis.zrange(this.SCHEDULED_JOBS_KEY, 0, now, {
      byScore: true,
    });

    if (dueJobs.length === 0) return;

    const pipeline = this.redis.pipeline();

    for (const jobStr of dueJobs) {
      const job: Job = JSON.parse(jobStr as string);
      job.status = JobStatus.PENDING;

      pipeline.zrem(this.SCHEDULED_JOBS_KEY, jobStr);
      pipeline.zadd(this.JOBS_KEY, {
        score: this.calculatePriorityScore(job),
        member: JSON.stringify(job),
      });
    }

    await pipeline.exec();
  }

  private calculatePriorityScore(job: Job): number {
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
      (await this.redis.set(`${this.JOB_LOCKS_KEY}:${jobId}`, "1", {
        nx: true,
        ex: 300, // 5 minute lock
      })) !== null
    );
  }
}
