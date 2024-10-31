import { Redis } from "@upstash/redis";
import {
  QueueTask,
  TaskType,
  TaskStatus,
  TaskPriority,
  TaskPayload,
  EmailTaskPayload,
  SendEmailPayload,
  NotificationPayload,
  AttachmentTaskPayload,
  AnalyticsTaskPayload,
  CleanupStoragePayload,
  IndexSearchPayload,
  UpdateThreadPayload,
} from "../../types/queue";
import { Logger } from "@/utils/logger";
import { Helpers } from "@/utils/helpers";

type TaskProcessor<T extends TaskPayload> = (
  task: QueueTask<T>
) => Promise<void>;

export interface WorkerEnv {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  EMAIL_DOMAIN: string;
  DEFAULT_FROM_EMAIL: string;
  MAILCHANNELS_API_KEY?: string;
  ATTACHMENT_BUCKET: R2Bucket;
  KV_STORE: KVNamespace;
}
interface EmailWorkerMessage {
  personalizations: Array<{
    to: Array<{ email: string; name?: string }>;
    cc?: Array<{ email: string; name?: string }>;
    bcc?: Array<{ email: string; name?: string }>;
    dkim_domain?: string;
    dkim_selector?: string;
    dkim_private_key?: string;
  }>;
  from: {
    email: string;
    name?: string;
  };
  subject: string;
  content: Array<{
    type: "text/plain" | "text/html";
    value: string;
  }>;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition?: "attachment" | "inline";
  }>;
  headers?: Record<string, string>;
}

export class QueueManager {
  private readonly logger: Logger;
  private readonly redis: Redis;
  private readonly env: WorkerEnv;
  private readonly MAILCHANNELS_ENDPOINT =
    "https://api.mailchannels.net/tx/v1/send";

  private readonly QUEUE_KEY = "email:queue";
  private readonly PROCESSING_KEY = "email:processing";
  private readonly FAILED_KEY = "email:failed";

  constructor(env: WorkerEnv) {
    this.logger = Logger.getInstance("production");
    this.env = env;
    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  async enqueueTask<T extends TaskPayload>(
    type: TaskType,
    payload: Omit<T, keyof TaskPayload>,
    options: {
      priority?: TaskPriority;
      scheduledFor?: Date;
      maxAttempts?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<string> {
    return this.safeExecute(async () => {
      const task: QueueTask<T> = {
        id: Helpers.generateId(),
        type,
        payload: {
          ...payload,
          correlationId: Helpers.generateId(),
          timestamp: Date.now(),
        } as T & TaskPayload,
        priority: options.priority || TaskPriority.NORMAL,
        status: TaskStatus.PENDING,
        attempts: 0,
        maxAttempts: options.maxAttempts || 3,
        createdAt: new Date(),
        scheduledFor: options.scheduledFor || new Date(),
        metadata: options.metadata || {},
      };

      await this.redis.zadd(this.QUEUE_KEY, {
        score: this.calculatePriorityScore(task),
        member: JSON.stringify(task),
      });

      await this.updateTaskStatus(task);
      this.logger.info("Task enqueued", { taskId: task.id, type: task.type });

      return task.id;
    }, "Failed to enqueue task");
  }

  async processNextTask(): Promise<void> {
    const task = await this.getNextTask();
    if (task) {
      await this.processTask(task);
    }
  }

  private async getNextTask(): Promise<QueueTask | null> {
    const now = Date.now();
    const tasks = await this.redis.zrange(this.QUEUE_KEY, "-inf", now, {
      byScore: true,
      offset: 0,
      count: 1,
    });

    if (!tasks.length) return null;

    const task = JSON.parse(tasks[0] as string) as QueueTask;

    // Move to processing
    await this.redis.zrem(this.QUEUE_KEY, tasks[0]);
    await this.redis.zadd(this.PROCESSING_KEY, {
      score: now,
      member: JSON.stringify({ ...task, status: TaskStatus.PROCESSING }),
    });

    return task;
  }

  private async processTask(task: QueueTask): Promise<void> {
    try {
      task.attempts++;
      task.lastAttemptAt = new Date();

      const processor = this.getTaskProcessor(task.type);
      await processor(task);

      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();
      await this.handleTaskCompletion(task);
    } catch (error) {
      await this.handleTaskError(task, error);
    } finally {
      await this.updateTaskStatus(task);
    }
  }

  private getTaskProcessor(type: TaskType): TaskProcessor<TaskPayload> {
    const processors: Record<TaskType, TaskProcessor<any>> = {
      [TaskType.PROCESS_EMAIL]: this.processEmailTask.bind(this),
      [TaskType.SEND_EMAIL]: this.sendEmailTask.bind(this),
      [TaskType.PROCESS_ATTACHMENTS]: this.processAttachmentsTask.bind(this),
      [TaskType.GENERATE_ANALYTICS]: this.generateAnalyticsTask.bind(this),
      [TaskType.CLEANUP_STORAGE]: this.cleanupStorageTask.bind(this),
      [TaskType.INDEX_SEARCH]: this.indexSearchTask.bind(this),
      [TaskType.UPDATE_THREAD]: this.updateThreadTask.bind(this),
      [TaskType.SEND_NOTIFICATION]: this.sendNotificationTask.bind(this),
    };

    const processor = processors[type];
    if (!processor) {
      throw new Error(`No processor found for task type: ${type}`);
    }

    return processor;
  }

  private async processAttachmentsTask(
    task: QueueTask<AttachmentTaskPayload>
  ): Promise<void> {
    this.logger.info("Processing attachments task", {
      taskId: task.id,
      attachmentCount: task.payload.attachments.length,
    });

    for (const attachment of task.payload.attachments) {
      try {
        const key = `attachments/${attachment.id}/${attachment.filename}`;
        await this.env.ATTACHMENT_BUCKET.put(
          key,
          Buffer.from(attachment.content, "base64"),
          {
            customMetadata: {
              contentType: attachment.contentType,
              size: attachment.size.toString(),
              uploadedAt: new Date().toISOString(),
            },
          }
        );

        // Store attachment metadata in KV for quick lookups
        await this.env.KV_STORE.put(
          `attachment:${attachment.id}`,
          JSON.stringify({
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            bucketKey: key,
            uploadedAt: new Date().toISOString(),
          }),
          { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
        );
      } catch (error) {
        this.logger.error("Failed to store attachment:", {
          attachmentId: attachment.id,
          error,
        });
        throw error;
      }
    }
  }

  private async generateAnalyticsTask(
    task: QueueTask<AnalyticsTaskPayload>
  ): Promise<void> {
    this.logger.info("Processing analytics task", {
      taskId: task.id,
      timeRange: task.payload.timeRange,
    });

    const analyticsData = await this.env.KV_STORE.list({
      prefix: `analytics:${task.payload.timeRange.start.toISOString().slice(0, 10)}`,
    });

    await this.env.KV_STORE.put(
      `analytics:${task.id}`,
      JSON.stringify({
        timeRange: task.payload.timeRange,
        results: analyticsData,
        generatedAt: new Date(),
      })
    );
  }

  private async cleanupStorageTask(
    task: QueueTask<CleanupStoragePayload>
  ): Promise<void> {
    this.logger.info("Processing cleanup task", {
      taskId: task.id,
      olderThan: task.payload.olderThan,
    });

    const stats = {
      scanned: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
    };

    let listCursor: string | undefined;
    do {
      const objects = (await this.env.ATTACHMENT_BUCKET.list({
        ...(listCursor && { cursor: listCursor }),
      })) as R2Objects;

      listCursor = objects.truncated ? objects.cursor : undefined;

      for (const object of objects.objects) {
        stats.scanned++;

        const uploadedAt = new Date(object.customMetadata?.uploadedAt || 0);
        if (uploadedAt < task.payload.olderThan) {
          if (!task.payload.dryRun) {
            try {
              await this.env.ATTACHMENT_BUCKET.delete(object.key);
              // Also cleanup KV metadata
              const attachmentId = object.key.split("/")[1];
              await this.env.KV_STORE.delete(`attachment:${attachmentId}`);
              stats.deleted++;
            } catch (error) {
              stats.failed++;
              this.logger.error("Failed to delete object:", {
                key: object.key,
                error,
              });
            }
          }
        } else {
          stats.skipped++;
        }
      }
    } while (listCursor);

    await this.env.KV_STORE.put(
      `cleanup:${task.id}`,
      JSON.stringify({
        stats,
        completedAt: new Date(),
      })
    );
  }

  private async indexSearchTask(
    task: QueueTask<IndexSearchPayload>
  ): Promise<void> {
    this.logger.info("Processing search indexing task", {
      taskId: task.id,
      documentId: task.payload.documentId,
    });

    const processedContent = this.processTextForIndexing(
      task.payload.content.text,
      task.payload.options?.language || "en"
    );

    await this.env.KV_STORE.put(
      `search:${task.payload.documentId}`,
      JSON.stringify({
        content: processedContent,
        metadata: task.payload.content.metadata,
        language: task.payload.options?.language || "en",
        boost: task.payload.options?.boost || 1.0,
        indexedAt: new Date(),
      })
    );
  }

  private async updateThreadTask(
    task: QueueTask<UpdateThreadPayload>
  ): Promise<void> {
    this.logger.info("Processing thread update task", {
      taskId: task.id,
      threadId: task.payload.threadId,
    });

    const threadKey = `thread:${task.payload.threadId}`;
    const existingThread = await this.env.KV_STORE.get(threadKey, "json");

    if (!existingThread) {
      throw new Error(`Thread ${task.payload.threadId} not found`);
    }

    const updatedThread = {
      ...existingThread,
      ...task.payload.updates,
      updatedAt: new Date(),
    };

    await this.env.KV_STORE.put(threadKey, JSON.stringify(updatedThread));

    if (task.payload.reindex) {
      await this.enqueueTask(TaskType.INDEX_SEARCH, {
        documentId: task.payload.threadId,
        content: {
          text: this.generateThreadSearchContent(updatedThread),
          metadata: { type: "thread", ...updatedThread },
        },
      });
    }
  }

  private async sendEmailTask(
    task: QueueTask<SendEmailPayload>
  ): Promise<void> {
    this.logger.info("Processing send email task", {
      taskId: task.id,
      to: task.payload.to,
      subject: task.payload.subject,
    });

    const emailMessage = await this.createMailChannelsMessage(task.payload);

    const response = await fetch(this.MAILCHANNELS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.env.MAILCHANNELS_API_KEY && {
          Authorization: `Bearer ${this.env.MAILCHANNELS_API_KEY}`,
        }),
      },
      body: JSON.stringify(emailMessage),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send email: ${error}`);
    }

    await this.env.KV_STORE.put(
      `email:${task.id}`,
      JSON.stringify({
        messageId: task.id,
        status: "sent",
        timestamp: new Date().toISOString(),
        recipients: task.payload.to,
        subject: task.payload.subject,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );
  }

  private async createMailChannelsMessage(
    payload: SendEmailPayload
  ): Promise<EmailWorkerMessage> {
    const attachments = await this.processAttachments(payload.attachments);

    if (!payload.content.text) {
      throw new Error("Email text content is required");
    }

    return {
      personalizations: [
        {
          to: payload.to.map((email) => ({ email })),
          ...(payload.cc?.length && {
            cc: payload.cc.map((email) => ({ email })),
          }),
          ...(payload.bcc?.length && {
            bcc: payload.bcc.map((email) => ({ email })),
          }),
          dkim_domain: this.env.EMAIL_DOMAIN,
        },
      ],
      from: {
        email: payload.from || this.env.DEFAULT_FROM_EMAIL,
      },
      subject: payload.subject,
      content: [
        {
          type: "text/plain",
          value: payload.content.text,
        },
        {
          type: "text/html",
          value:
            payload.content.html || this.convertToHtml(payload.content.text),
        },
      ],
      ...(attachments && attachments.length > 0 && { attachments }),
      headers: {
        "Message-ID": `<${payload.correlationId}@${this.env.EMAIL_DOMAIN}>`,
        "X-Entity-Ref-ID": payload.correlationId,
      },
    };
  }

  private processTextForIndexing(text: string, language: string): string {
    // Language-specific text processing could be added here
    switch (language) {
      case "en":
        return text
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      // Add cases for other languages as needed
      default:
        return text
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
    }
  }

  private async processAttachments(
    attachments?: SendEmailPayload["attachments"]
  ): Promise<EmailWorkerMessage["attachments"]> {
    if (!attachments?.length) return [];

    return Promise.all(
      attachments.map(async (attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        type: attachment.contentType,
        disposition: "attachment",
      }))
    );
  }

  private generateThreadSearchContent(thread: any): string {
    return [thread.subject, thread.snippet, thread.participants?.join(" ")]
      .filter(Boolean)
      .join(" ");
  }

  private async processEmailTask(
    task: QueueTask<EmailTaskPayload>
  ): Promise<void> {
    const emailMessage = await this.createMailChannelsMessage({
      to: task.payload.email.to,
      subject: task.payload.email.subject,
      content: {
        text: task.payload.email.content,
        html: this.convertToHtml(task.payload.email.content),
      },
      correlationId: task.payload.correlationId,
      from: task.payload.email.from,
      timestamp: new Date().getTime(),
    });

    const response = await fetch(this.MAILCHANNELS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.env.MAILCHANNELS_API_KEY && {
          Authorization: `Bearer ${this.env.MAILCHANNELS_API_KEY}`,
        }),
      },
      body: JSON.stringify(emailMessage),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send email: ${error}`);
    }

    // Store email metadata
    await this.env.KV_STORE.put(
      `email:${task.payload.email.id}`,
      JSON.stringify({
        messageId: task.payload.email.id,
        status: "sent",
        timestamp: new Date().toISOString(),
        recipients: task.payload.email.to,
        subject: task.payload.email.subject,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );
  }

  private convertToHtml(text: string): string {
    const paragraphs = text
      .split("\n\n")
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => {
        // Convert URLs to links
        const linkedText = paragraph.replace(
          /(https?:\/\/[^\s]+)/g,
          '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
        );
        return `<p>${this.escapeHtml(linkedText)}</p>`;
      });

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333;">
          ${paragraphs.join("\n")}
        </body>
      </html>
    `;
  }

  private escapeHtml(text: string): string {
    const htmlEscapes = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#x27;",
      "/": "&#x2F;",
    } as const;
    return text.replace(
      /[&<>"'/]/g,
      (char) => htmlEscapes[char as keyof typeof htmlEscapes]
    );
  }

  private async handleTaskError(
    task: QueueTask,
    error: unknown
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    task.error = errorMessage;

    if (task.attempts < task.maxAttempts) {
      task.status = TaskStatus.SCHEDULED;
      await this.retryTask(task);
    } else {
      task.status = TaskStatus.FAILED;
      await this.handleFailedTask(task);
    }

    // Store error details in KV for debugging
    await this.env.KV_STORE.put(
      `error:${task.id}:${task.attempts}`,
      JSON.stringify({
        error: errorMessage,
        timestamp: new Date().toISOString(),
        taskDetails: task,
      }),
      { expirationTtl: 60 * 60 * 24 * 7 } // 7 days retention for errors
    );
  }

  private async handleTaskCompletion(task: QueueTask): Promise<void> {
    await this.redis.zrem(this.PROCESSING_KEY, JSON.stringify(task));

    // Store completion details in KV
    await this.env.KV_STORE.put(
      `completion:${task.id}`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        duration: task.completedAt
          ? task.completedAt.getTime() - task.createdAt.getTime()
          : 0,
        attempts: task.attempts,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );

    if (task.metadata?.dependentTasks) {
      for (const dependentTask of task.metadata.dependentTasks as any[]) {
        await this.enqueueTask(
          dependentTask.type,
          dependentTask.payload,
          dependentTask.options
        );
      }
    }
  }

  private async retryTask(task: QueueTask): Promise<void> {
    const backoffMinutes = Math.pow(2, task.attempts - 1);
    const nextAttempt = new Date();
    nextAttempt.setMinutes(nextAttempt.getMinutes() + backoffMinutes);

    const updatedTask: QueueTask = {
      ...task,
      status: TaskStatus.SCHEDULED,
      scheduledFor: nextAttempt,
    };

    await this.redis.zadd(this.QUEUE_KEY, {
      score: this.calculatePriorityScore(updatedTask),
      member: JSON.stringify(updatedTask),
    });

    this.logger.info("Task scheduled for retry", {
      taskId: task.id,
      attempt: task.attempts,
      nextAttempt,
    });
  }

  private calculatePriorityScore(task: QueueTask): number {
    const now = Date.now();
    const scheduledTime = task.scheduledFor.getTime();
    const priorityWeight = {
      [TaskPriority.HIGH]: 1000000,
      [TaskPriority.NORMAL]: 100000,
      [TaskPriority.LOW]: 10000,
    }[task.priority];

    return scheduledTime - now + priorityWeight;
  }

  private async safeExecute<T>(
    operation: () => Promise<T>,
    errorMessage: string,
    retryOptions: { maxAttempts?: number; baseDelay?: number } = {}
  ): Promise<T> {
    return Helpers.retry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          this.logger.error(`${errorMessage}:`, error);
          throw error;
        }
      },
      retryOptions.maxAttempts || 3,
      retryOptions.baseDelay || 1000
    );
  }

  private async updateTaskStatus(task: QueueTask): Promise<void> {
    await this.env.KV_STORE.put(
      `task:${task.id}`,
      JSON.stringify({
        status: task.status,
        attempts: task.attempts,
        lastAttempt: task.lastAttemptAt?.toISOString(),
        error: task.error,
        completedAt: task.completedAt?.toISOString(),
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );
  }

  // Public API methods
  async getTaskStatus(taskId: string): Promise<QueueTask | null> {
    const status = await this.env.KV_STORE.get(`task:${taskId}`);
    return status ? JSON.parse(status) : null;
  }

  async getTaskHistory(taskId: string): Promise<any> {
    const [task, completion, errors] = await Promise.all([
      this.env.KV_STORE.get(`task:${taskId}`),
      this.env.KV_STORE.get(`completion:${taskId}`),
      this.listTaskErrors(taskId),
    ]);

    return {
      task: task ? JSON.parse(task) : null,
      completion: completion ? JSON.parse(completion) : null,
      errors,
    };
  }

  private async listTaskErrors(taskId: string): Promise<any[]> {
    const errors: any[] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.env.KV_STORE.list({
        prefix: `error:${taskId}:`,
        cursor: cursor || null,
      })) as KVNamespaceListResult<string, any>;

      for (const key of result.keys) {
        const error = await this.env.KV_STORE.get(key.name);
        if (error) {
          errors.push(JSON.parse(error));
        }
      }

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return errors;
  }

  async getFailedTasks(
    options: { limit?: number; offset?: number } = {}
  ): Promise<QueueTask[]> {
    const { limit = 50, offset = 0 } = options;

    const tasks = await this.redis.zrange(
      this.FAILED_KEY,
      offset,
      offset + limit - 1,
      {
        rev: true,
      }
    );

    return tasks
      .map((task) => {
        try {
          return JSON.parse(task as string) as QueueTask;
        } catch (error) {
          this.logger.error("Failed to parse task:", { task, error });
          return null;
        }
      })
      .filter((task): task is QueueTask => task !== null);
  }

  async getFailedTaskStats(): Promise<{
    total: number;
    byType: Record<TaskType, number>;
  }> {
    const tasks = await this.getFailedTasks({ limit: 1000 }); // Get last 1000 failed tasks

    const stats = {
      total: tasks.length,
      byType: tasks.reduce(
        (acc, task) => {
          acc[task.type] = (acc[task.type] || 0) + 1;
          return acc;
        },
        {} as Record<TaskType, number>
      ),
    };

    return stats;
  }

  private async handleFailedTask(task: QueueTask): Promise<void> {
    await this.redis.zrem(this.PROCESSING_KEY, JSON.stringify(task));
    await this.redis.zadd(this.FAILED_KEY, {
      score: Date.now(),
      member: JSON.stringify(task),
    });

    // Store failure details in KV
    await this.env.KV_STORE.put(
      `failure:${task.id}`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        attempts: task.attempts,
        error: task.error,
        taskDetails: task,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );

    this.logger.error("Task failed permanently", {
      taskId: task.id,
      type: task.type,
      error: task.error,
    });
  }

  private async sendNotificationTask(
    task: QueueTask<NotificationPayload>
  ): Promise<void> {
    this.logger.info("Processing notification task", {
      taskId: task.id,
      type: task.payload.notification.type,
      userId: task.payload.userId,
    });
  }

  async getQueueStats() {
    return {
      pending: 0, // Or implement actual queue size tracking logic
    };
  }
}
