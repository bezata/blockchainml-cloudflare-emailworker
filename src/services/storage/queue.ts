import { Redis } from "@upstash/redis";
import {
  QueueTask,
  TaskType,
  TaskStatus,
  TaskPriority,
  TaskPayload,
  AnalyticsTaskPayload,
  AttachmentTaskPayload,
  EmailTaskPayload,
} from "../../types/queue";
import { Logger } from "../../utils/logger";
import { EmailProcessor } from "../email/processor";
import { AnalyticsProcessor } from "../analytics/processor";
import { AttachmentService } from "./attachments";
import { Helpers } from "../../utils/helpers";
import { env } from "hono/adapter";

interface CleanupStoragePayload extends TaskPayload {
  olderThan: Date;
  types?: string[];
  excludePatterns?: string[];
  dryRun?: boolean;
}

interface IndexSearchPayload extends TaskPayload {
  documentId: string;
  content: {
    text: string;
    metadata: Record<string, unknown>;
  };
  options?: {
    language?: string;
    boost?: Record<string, number>;
  };
}

interface UpdateThreadPayload extends TaskPayload {
  threadId: string;
  updates: Record<string, unknown>;
  reindex?: boolean;
}

interface NotificationPayload extends TaskPayload {
  userId: string;
  notification: {
    type: "email" | "push" | "sms" | "in_app";
    priority?: "low" | "normal" | "high";
  };
}

export class QueueManager {
  private readonly logger: Logger;
  private readonly emailProcessor: EmailProcessor;
  private readonly analyticsProcessor: AnalyticsProcessor;
  private readonly attachmentService: AttachmentService;
  private readonly redis: Redis;

  private readonly QUEUE_KEY = "email:queue";
  private readonly PROCESSING_KEY = "email:processing";
  private readonly FAILED_KEY = "email:failed";
  private readonly STATUS_KEY = "email:status";

  constructor() {
    this.logger = Logger.getInstance("production");
    this.emailProcessor = new EmailProcessor();
    this.analyticsProcessor = new AnalyticsProcessor();
    this.attachmentService = new AttachmentService();
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  private async safeExecute<T>(
    operation: () => Promise<T>,
    errorMessage: string,
    retryOptions: {
      maxAttempts?: number;
      baseDelay?: number;
    } = {}
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

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = 5000,
    operationName: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        Helpers.sleep(timeoutMs).then(() => {
          reject(
            new Error(
              `Operation ${operationName} timed out after ${timeoutMs}ms`
            )
          );
        });
      }),
    ]);
  }

  private formatTaskForLogging(task: QueueTask): Record<string, unknown> {
    return Helpers.pick(task, [
      "id",
      "type",
      "priority",
      "status",
      "attempts",
      "createdAt",
      "scheduledFor",
    ]);
  }

  async enqueueTask<T extends TaskPayload>(
    type: TaskType,
    payload: T,
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
        },
        priority: options.priority || TaskPriority.NORMAL,
        status: TaskStatus.PENDING,
        attempts: 0,
        maxAttempts: options.maxAttempts || 3,
        createdAt: new Date(),
        scheduledFor: options.scheduledFor || new Date(),
        metadata: options.metadata,
      };

      const priorityScore = this.calculatePriorityScore(task);

      await this.withTimeout(
        this.redis.zadd(this.QUEUE_KEY, {
          score: priorityScore,
          member: Helpers.safeJSONParse(JSON.stringify(task), {}),
        }),
        3000,
        "enqueue task"
      );

      await this.updateTaskStatus(task);
      this.logger.info("Task enqueued", this.formatTaskForLogging(task));

      return task.id;
    }, "Failed to enqueue task");
  }

  async processNextTask(): Promise<void> {
    try {
      // Get highest priority task that's due for processing
      const now = Date.now();
      const result = await this.redis.zrange(this.QUEUE_KEY, "-inf", now, {
        byScore: true,
        offset: 0,
        count: 1,
        withScores: true,
      });

      if (!result.length) {
        return;
      }

      const task = JSON.parse(result[0].member) as QueueTask;

      // Move task to processing set
      await this.redis.zrem(this.QUEUE_KEY, result[0].member);
      await this.redis.zadd(this.PROCESSING_KEY, {
        score: now,
        member: JSON.stringify({
          ...task,
          status: TaskStatus.PROCESSING,
          lastAttemptAt: new Date(),
        }),
      });

      await this.processTask(task);
    } catch (error) {
      this.logger.error("Error processing next task:", error);
      throw error;
    }
  }

  async processTask(task: QueueTask): Promise<void> {
    try {
      this.logger.info("Processing task", {
        taskId: task.id,
        type: task.type,
        attempt: task.attempts + 1,
      });

      task.status = TaskStatus.PROCESSING;
      task.attempts += 1;
      task.lastAttemptAt = new Date();

      await this.executeTask(task);

      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();
      await this.finalizeTask(task);
    } catch (error: any) {
      this.logger.error("Error processing task: " + error, {
        taskId: task.id,
        type: task.type,
        attempt: task.attempts,
      });

      task.status = TaskStatus.FAILED;
      task.error = error.message;

      if (task.attempts < task.maxAttempts) {
        await this.retryTask(task);
      } else {
        await this.handleFailedTask(task);
      }
    }
  }

  private async executeTask(task: QueueTask): Promise<void> {
    const processors: Record<TaskType, (task: QueueTask) => Promise<void>> = {
      [TaskType.PROCESS_EMAIL]: this.processEmailTask.bind(this),
      [TaskType.SEND_EMAIL]: this.sendEmailTask.bind(this),
      [TaskType.PROCESS_ATTACHMENTS]: this.processAttachmentsTask.bind(this),
      [TaskType.GENERATE_ANALYTICS]: this.generateAnalyticsTask.bind(this),
      [TaskType.CLEANUP_STORAGE]: this.cleanupStorageTask.bind(this),
      [TaskType.INDEX_SEARCH]: this.indexSearchTask.bind(this),
      [TaskType.UPDATE_THREAD]: this.updateThreadTask.bind(this),
      [TaskType.SEND_NOTIFICATION]: this.sendNotificationTask.bind(this),
    };

    const processor = processors[task.type];
    if (!processor) {
      throw new Error(`No processor found for task type: ${task.type}`);
    }

    await processor(task);
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

  private async finalizeTask(task: QueueTask): Promise<void> {
    // Remove from processing set
    await this.redis.zrem(this.PROCESSING_KEY, JSON.stringify(task));

    // Update status
    await this.updateTaskStatus(task);

    // Trigger any completion handlers
    await this.handleTaskCompletion(task);
  }

  private async handleTaskCompletion(task: QueueTask): Promise<void> {
    // Trigger any dependent tasks
    if (task.metadata?.dependentTasks) {
      for (const dependentTask of task.metadata.dependentTasks as any[]) {
        await this.enqueueTask(
          dependentTask.type,
          dependentTask.payload,
          dependentTask.options
        );
      }
    }

    // Emit metrics
    await this.emitTaskMetrics(task);
  }

  private async emitTaskMetrics(task: QueueTask): Promise<void> {
    const metrics = {
      taskType: task.type,
      duration: task.completedAt.getTime() - task.createdAt.getTime(),
      attempts: task.attempts,
      status: task.status,
      timestamp: Date.now(),
    };

    await env.METRICS_QUEUE.send(metrics);
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

    const priorityScore = this.calculatePriorityScore(updatedTask);

    await this.redis.zadd(this.QUEUE_KEY, {
      score: priorityScore,
      member: JSON.stringify(updatedTask),
    });

    await this.updateTaskStatus(updatedTask);

    this.logger.info("Task scheduled for retry", {
      taskId: task.id,
      attempt: task.attempts,
      nextAttempt,
    });
  }

  private async handleFailedTask(task: QueueTask): Promise<void> {
    this.logger.error("Task failed permanently", {
      taskId: task.id,
      type: task.type,
      attempts: task.attempts,
      error: task.error,
    });

    // Move to failed set
    await this.redis.zadd(this.FAILED_KEY, {
      score: Date.now(),
      member: JSON.stringify(task),
    });

    // Update status
    await this.updateTaskStatus(task);

    // Send alert if critical
    if (task.priority === TaskPriority.HIGH) {
      await this.sendFailureAlert(task);
    }
  }

  private async updateTaskStatus(task: QueueTask): Promise<void> {
    const status = {
      id: task.id,
      type: task.type,
      status: task.status,
      attempts: task.attempts,
      lastAttemptAt: task.lastAttemptAt,
      error: task.error,
      completedAt: task.completedAt,
    };

    await this.redis.hset(this.STATUS_KEY, {
      [task.id]: JSON.stringify(status),
    });
  }

  // Implement processor methods...
  private async processEmailTask(
    task: QueueTask<EmailTaskPayload>
  ): Promise<void> {
    await this.emailProcessor.processEmail(task.payload.email);
  }

  private async processAttachmentsTask(
    task: QueueTask<AttachmentTaskPayload>
  ): Promise<void> {
    for (const attachment of task.payload.attachments) {
      await this.attachmentService.store(attachment);
    }
  }

  private async generateAnalyticsTask(
    task: QueueTask<AnalyticsTaskPayload>
  ): Promise<void> {
    await this.analyticsProcessor.aggregateStats(task.payload.timeRange);
  }
  private async sendEmailTask(
    task: QueueTask<SendEmailPayload>
  ): Promise<void> {
    this.logger.info("Processing send email task", {
      taskId: task.id,
      to: task.payload.to,
      subject: task.payload.subject,
    });

    try {
      // Validate email params
      this.validateEmailParams(task.payload);

      // Prepare email content
      const emailContent = await this.prepareEmailContent(task.payload);

      // Handle attachments if present
      if (task.payload.attachments?.length) {
        emailContent.attachments = await this.processEmailAttachments(
          task.payload.attachments
        );
      }

      // Send via email service (e.g., SendGrid, AWS SES)
      const response = await env.EMAIL_SERVICE.send({
        to: task.payload.to,
        cc: task.payload.cc,
        bcc: task.payload.bcc,
        subject: task.payload.subject,
        ...emailContent,
        headers: {
          "X-Transaction-ID": task.payload.correlationId,
          ...task.payload.metadata?.customHeaders,
        },
      });

      // Track email metrics
      await this.trackEmailMetrics({
        taskId: task.id,
        messageId: response.messageId,
        recipients:
          task.payload.to.length +
          (task.payload.cc?.length || 0) +
          (task.payload.bcc?.length || 0),
        size: this.calculateEmailSize(emailContent),
      });
    } catch (error) {
      this.logger.error("Error sending email:", error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  private async cleanupStorageTask(
    task: QueueTask<CleanupStoragePayload>
  ): Promise<void> {
    this.logger.info("Processing storage cleanup task", {
      taskId: task.id,
      olderThan: task.payload.olderThan,
    });

    try {
      const stats = {
        scanned: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
      };

      // Process attachments cleanup
      if (!task.payload.types || task.payload.types.includes("attachments")) {
        const attachmentStats = await this.cleanupAttachments(
          task.payload.olderThan,
          task.payload.excludePatterns,
          task.payload.dryRun
        );
        Object.entries(attachmentStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Process analytics data cleanup
      if (!task.payload.types || task.payload.types.includes("analytics")) {
        const analyticsStats = await this.cleanupAnalytics(
          task.payload.olderThan,
          task.payload.dryRun
        );
        Object.entries(analyticsStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Process logs cleanup
      if (!task.payload.types || task.payload.types.includes("logs")) {
        const logsStats = await this.cleanupLogs(
          task.payload.olderThan,
          task.payload.dryRun
        );
        Object.entries(logsStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Store cleanup results
      await this.storeCleanupResults(task.id, stats);

      this.logger.info("Storage cleanup completed", { taskId: task.id, stats });
    } catch (error) {
      this.logger.error("Error cleaning up storage:", error);
      throw new Error(`Failed to cleanup storage: ${error.message}`);
    }
  }

  private async indexSearchTask(
    task: QueueTask<IndexSearchPayload>
  ): Promise<void> {
    this.logger.info("Processing search indexing task", {
      taskId: task.id,
      documentId: task.payload.documentId,
    });

    try {
      // Prepare document for indexing
      const document = {
        id: task.payload.documentId,
        text: task.payload.content.text,
        metadata: task.payload.content.metadata,
        language: task.payload.options?.language || "en",
        boost: task.payload.options?.boost || {},
        indexed_at: new Date().toISOString(),
      };

      // Process text for better search
      const processedText = await this.processTextForSearch(
        document.text,
        document.language
      );

      // Index the document
      await env.SEARCH_INDEX.index(document.id, {
        ...document,
        processed_text: processedText,
      });

      // Update search metadata
      await this.updateSearchMetadata(document.id, {
        lastIndexed: new Date(),
        status: "indexed",
      });
    } catch (error) {
      this.logger.error("Error indexing document:", error);
      throw new Error(`Failed to index document: ${error.message}`);
    }
  }

  private async updateThreadTask(
    task: QueueTask<UpdateThreadPayload>
  ): Promise<void> {
    this.logger.info("Processing thread update task", {
      taskId: task.id,
      threadId: task.payload.threadId,
    });

    try {
      const { threadId, updates, reindex } = task.payload;

      // Update thread in database
      const updatedThread = await env.THREAD_DB.updateThread(threadId, updates);

      // Update thread cache
      await this.updateThreadCache(threadId, updatedThread);

      // Reindex thread if required
      if (reindex) {
        await this.enqueueTask(TaskType.INDEX_SEARCH, {
          documentId: `thread:${threadId}`,
          content: {
            text: this.generateThreadSearchContent(updatedThread),
            metadata: {
              type: "thread",
              threadId,
              ...updates.metadata,
            },
          },
        });
      }

      // Update related analytics
      await this.updateThreadAnalytics(threadId, updates);
    } catch (error) {
      this.logger.error("Error updating thread:", error);
      throw new Error(`Failed to update thread: ${error.message}`);
    }
  }

  private async sendNotificationTask(
    task: QueueTask<NotificationPayload>
  ): Promise<void> {
    this.logger.info("Processing notification task", {
      taskId: task.id,
      userId: task.payload.userId,
      type: task.payload.notification.type,
    });

    try {
      const { userId, notification } = task.payload;

      // Get user preferences
      const userPreferences = await this.getUserNotificationPreferences(userId);

      // Check if user accepts this type of notification
      if (!this.shouldSendNotification(notification, userPreferences)) {
        this.logger.info("Notification skipped based on user preferences", {
          taskId: task.id,
          userId,
        });
        return;
      }

      // Prepare notification content
      const content = await this.prepareNotificationContent(
        notification,
        userPreferences
      );

      // Send notification based on type
      switch (notification.type) {
        case "email":
          await this.sendEmailNotification(userId, content);
          break;
        case "push":
          await this.sendPushNotification(userId, content);
          break;
        case "sms":
          await this.sendSMSNotification(userId, content);
          break;
        case "in_app":
          await this.sendInAppNotification(userId, content);
          break;
        default:
          throw new Error(
            `Unsupported notification type: ${notification.type}`
          );
      }

      // Track notification delivery
      await this.trackNotificationDelivery({
        taskId: task.id,
        userId,
        type: notification.type,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error("Error sending notification:", error);
      throw new Error(`Failed to send notification: ${error.message}`);
    }
  }

  // Helper methods for processors
  private validateEmailParams(payload: SendEmailPayload): void {
    if (!payload.to?.length) {
      throw new Error("No recipients specified");
    }
    if (!payload.subject?.trim()) {
      throw new Error("Subject is required");
    }
    if (!payload.content.text && !payload.content.html) {
      throw new Error("Email content is required");
    }
  }

  private async processEmailAttachments(
    attachments: SendEmailPayload["attachments"]
  ): Promise<any[]> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.contentType,
      }))
    );
  }

  private async cleanupAttachments(
    olderThan: Date,
    excludePatterns?: string[],
    dryRun?: boolean
  ): Promise<Record<string, number>> {
    const stats = { scanned: 0, deleted: 0, failed: 0, skipped: 0 };
    const cursor = await env.ATTACHMENT_BUCKET.list();
    const batchSize = 100;
    const objects = [];

    for await (const object of cursor) {
      objects.push(object);
    }

    // Process in batches
    const batches = Helpers.chunk(objects, batchSize);
    for (const batch of batches) {
      await Promise.all(
        batch.map(async (object) => {
          stats.scanned++;

          if (
            excludePatterns?.some((pattern) =>
              object.key.match(new RegExp(pattern))
            )
          ) {
            stats.skipped++;
            return;
          }

          if (object.uploaded < olderThan) {
            if (!dryRun) {
              try {
                await this.withTimeout(
                  env.ATTACHMENT_BUCKET.delete(object.key),
                  5000,
                  `delete attachment ${object.key}`
                );
                stats.deleted++;
              } catch (error) {
                stats.failed++;
                this.logger.error("Failed to delete attachment:", error);
              }
            }
          }
        })
      );

      await Helpers.sleep(100); // Add delay between batches
    }

    return stats;
  }

  private async processTextForSearch(
    text: string,
    language: string
  ): Promise<string> {
    // Remove special characters
    let processed = text.replace(/[^\w\s]/g, " ");

    // Convert to lowercase
    processed = processed.toLowerCase();

    // Remove extra whitespace
    processed = processed.replace(/\s+/g, " ").trim();

    // Add language-specific processing if needed
    if (language !== "en") {
      processed = await this.processTextForLanguage(processed, language);
    }

    return processed;
  }

  private shouldSendNotification(
    notification: NotificationPayload["notification"],
    preferences: any
  ): boolean {
    // Check if notification type is enabled
    if (!preferences.enabledTypes.includes(notification.type)) {
      return false;
    }

    // Check notification time preferences
    const currentHour = new Date().getHours();
    if (
      currentHour < preferences.quietHoursStart ||
      currentHour > preferences.quietHoursEnd
    ) {
      return false;
    }

    // Check priority preferences
    if (notification.priority === "low" && !preferences.lowPriorityEnabled) {
      return false;
    }

    return true;
  }

  async getTaskStatus(taskId: string): Promise<QueueTask | null> {
    const status = await this.redis.hget(this.STATUS_KEY, taskId);
    return status ? JSON.parse(status as unknown as string) : null;
  }

  async getFailedTasks(
    options: {
      limit?: number;
      offset?: number;
      end?: number;
    } = {}
  ): Promise<QueueTask[]> {
    const { limit = 50, offset = 0 } = options;
    const end = options.end ?? offset + limit - 1;

    const result = await this.safeExecute(
      async () => {
        return this.redis.zrange(this.FAILED_KEY, offset, end, {
          rev: true, // Get newest first
        });
      },
      "Failed to fetch failed tasks",
      { maxAttempts: 3, baseDelay: 1000 }
    );

    return result
      .map((task) => {
        try {
          return JSON.parse(task);
        } catch (error) {
          this.logger.error("Failed to parse task:", { task, error });
          return null;
        }
      })
      .filter((task): task is QueueTask => task !== null);
  }
}
import { Redis } from "@upstash/redis";
import {
  QueueTask,
  TaskType,
  TaskStatus,
  TaskPriority,
  TaskPayload,
  AnalyticsTaskPayload,
  AttachmentTaskPayload,
  EmailTaskPayload,
} from "../../types/queue";
import { Logger } from "../../utils/logger";
import { EmailProcessor } from "../email/processor";
import { AnalyticsProcessor } from "../analytics/processor";
import { AttachmentService } from "./attachments";
import { Helpers } from "../../utils/helpers";
import { env } from "hono/adapter";

interface CleanupStoragePayload extends TaskPayload {
  olderThan: Date;
  types?: string[];
  excludePatterns?: string[];
  dryRun?: boolean;
}

interface IndexSearchPayload extends TaskPayload {
  documentId: string;
  content: {
    text: string;
    metadata: Record<string, unknown>;
  };
  options?: {
    language?: string;
    boost?: Record<string, number>;
  };
}

interface UpdateThreadPayload extends TaskPayload {
  threadId: string;
  updates: Record<string, unknown>;
  reindex?: boolean;
}

interface NotificationPayload extends TaskPayload {
  userId: string;
  notification: {
    type: "email" | "push" | "sms" | "in_app";
    priority?: "low" | "normal" | "high";
  };
}

export class QueueManager {
  private readonly logger: Logger;
  private readonly emailProcessor: EmailProcessor;
  private readonly analyticsProcessor: AnalyticsProcessor;
  private readonly attachmentService: AttachmentService;
  private readonly redis: Redis;

  private readonly QUEUE_KEY = "email:queue";
  private readonly PROCESSING_KEY = "email:processing";
  private readonly FAILED_KEY = "email:failed";
  private readonly STATUS_KEY = "email:status";

  constructor() {
    this.logger = Logger.getInstance("production");
    this.emailProcessor = new EmailProcessor();
    this.analyticsProcessor = new AnalyticsProcessor();
    this.attachmentService = new AttachmentService();
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  private async safeExecute<T>(
    operation: () => Promise<T>,
    errorMessage: string,
    retryOptions: {
      maxAttempts?: number;
      baseDelay?: number;
    } = {}
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

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = 5000,
    operationName: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        Helpers.sleep(timeoutMs).then(() => {
          reject(
            new Error(
              `Operation ${operationName} timed out after ${timeoutMs}ms`
            )
          );
        });
      }),
    ]);
  }

  private formatTaskForLogging(task: QueueTask): Record<string, unknown> {
    return Helpers.pick(task, [
      "id",
      "type",
      "priority",
      "status",
      "attempts",
      "createdAt",
      "scheduledFor",
    ]);
  }

  async enqueueTask<T extends TaskPayload>(
    type: TaskType,
    payload: T,
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
        },
        priority: options.priority || TaskPriority.NORMAL,
        status: TaskStatus.PENDING,
        attempts: 0,
        maxAttempts: options.maxAttempts || 3,
        createdAt: new Date(),
        scheduledFor: options.scheduledFor || new Date(),
        metadata: options.metadata,
      };

      const priorityScore = this.calculatePriorityScore(task);

      await this.withTimeout(
        this.redis.zadd(this.QUEUE_KEY, {
          score: priorityScore,
          member: Helpers.safeJSONParse(JSON.stringify(task), {}),
        }),
        3000,
        "enqueue task"
      );

      await this.updateTaskStatus(task);
      this.logger.info("Task enqueued", this.formatTaskForLogging(task));

      return task.id;
    }, "Failed to enqueue task");
  }

  async processNextTask(): Promise<void> {
    try {
      // Get highest priority task that's due for processing
      const now = Date.now();
      const result = await this.redis.zrange(this.QUEUE_KEY, "-inf", now, {
        byScore: true,
        offset: 0,
        count: 1,
        withScores: true,
      });

      if (!result.length) {
        return;
      }

      const task = JSON.parse(result[0].member) as QueueTask;

      // Move task to processing set
      await this.redis.zrem(this.QUEUE_KEY, result[0].member);
      await this.redis.zadd(this.PROCESSING_KEY, {
        score: now,
        member: JSON.stringify({
          ...task,
          status: TaskStatus.PROCESSING,
          lastAttemptAt: new Date(),
        }),
      });

      await this.processTask(task);
    } catch (error) {
      this.logger.error("Error processing next task:", error);
      throw error;
    }
  }

  async processTask(task: QueueTask): Promise<void> {
    try {
      this.logger.info("Processing task", {
        taskId: task.id,
        type: task.type,
        attempt: task.attempts + 1,
      });

      task.status = TaskStatus.PROCESSING;
      task.attempts += 1;
      task.lastAttemptAt = new Date();

      await this.executeTask(task);

      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();
      await this.finalizeTask(task);
    } catch (error: any) {
      this.logger.error("Error processing task: " + error, {
        taskId: task.id,
        type: task.type,
        attempt: task.attempts,
      });

      task.status = TaskStatus.FAILED;
      task.error = error.message;

      if (task.attempts < task.maxAttempts) {
        await this.retryTask(task);
      } else {
        await this.handleFailedTask(task);
      }
    }
  }

  private async executeTask(task: QueueTask): Promise<void> {
    const processors: Record<TaskType, (task: QueueTask) => Promise<void>> = {
      [TaskType.PROCESS_EMAIL]: this.processEmailTask.bind(this),
      [TaskType.SEND_EMAIL]: this.sendEmailTask.bind(this),
      [TaskType.PROCESS_ATTACHMENTS]: this.processAttachmentsTask.bind(this),
      [TaskType.GENERATE_ANALYTICS]: this.generateAnalyticsTask.bind(this),
      [TaskType.CLEANUP_STORAGE]: this.cleanupStorageTask.bind(this),
      [TaskType.INDEX_SEARCH]: this.indexSearchTask.bind(this),
      [TaskType.UPDATE_THREAD]: this.updateThreadTask.bind(this),
      [TaskType.SEND_NOTIFICATION]: this.sendNotificationTask.bind(this),
    };

    const processor = processors[task.type];
    if (!processor) {
      throw new Error(`No processor found for task type: ${task.type}`);
    }

    await processor(task);
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

  private async finalizeTask(task: QueueTask): Promise<void> {
    // Remove from processing set
    await this.redis.zrem(this.PROCESSING_KEY, JSON.stringify(task));

    // Update status
    await this.updateTaskStatus(task);

    // Trigger any completion handlers
    await this.handleTaskCompletion(task);
  }

  private async handleTaskCompletion(task: QueueTask): Promise<void> {
    // Trigger any dependent tasks
    if (task.metadata?.dependentTasks) {
      for (const dependentTask of task.metadata.dependentTasks as any[]) {
        await this.enqueueTask(
          dependentTask.type,
          dependentTask.payload,
          dependentTask.options
        );
      }
    }

    // Emit metrics
    await this.emitTaskMetrics(task);
  }

  private async emitTaskMetrics(task: QueueTask): Promise<void> {
    const metrics = {
      taskType: task.type,
      duration: task.completedAt.getTime() - task.createdAt.getTime(),
      attempts: task.attempts,
      status: task.status,
      timestamp: Date.now(),
    };

    await env.METRICS_QUEUE.send(metrics);
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

    const priorityScore = this.calculatePriorityScore(updatedTask);

    await this.redis.zadd(this.QUEUE_KEY, {
      score: priorityScore,
      member: JSON.stringify(updatedTask),
    });

    await this.updateTaskStatus(updatedTask);

    this.logger.info("Task scheduled for retry", {
      taskId: task.id,
      attempt: task.attempts,
      nextAttempt,
    });
  }

  private async handleFailedTask(task: QueueTask): Promise<void> {
    this.logger.error("Task failed permanently", {
      taskId: task.id,
      type: task.type,
      attempts: task.attempts,
      error: task.error,
    });

    // Move to failed set
    await this.redis.zadd(this.FAILED_KEY, {
      score: Date.now(),
      member: JSON.stringify(task),
    });

    // Update status
    await this.updateTaskStatus(task);

    // Send alert if critical
    if (task.priority === TaskPriority.HIGH) {
      await this.sendFailureAlert(task);
    }
  }

  private async updateTaskStatus(task: QueueTask): Promise<void> {
    const status = {
      id: task.id,
      type: task.type,
      status: task.status,
      attempts: task.attempts,
      lastAttemptAt: task.lastAttemptAt,
      error: task.error,
      completedAt: task.completedAt,
    };

    await this.redis.hset(this.STATUS_KEY, {
      [task.id]: JSON.stringify(status),
    });
  }

  // Implement processor methods...
  private async processEmailTask(
    task: QueueTask<EmailTaskPayload>
  ): Promise<void> {
    await this.emailProcessor.processEmail(task.payload.email);
  }

  private async processAttachmentsTask(
    task: QueueTask<AttachmentTaskPayload>
  ): Promise<void> {
    for (const attachment of task.payload.attachments) {
      await this.attachmentService.store(attachment);
    }
  }

  private async generateAnalyticsTask(
    task: QueueTask<AnalyticsTaskPayload>
  ): Promise<void> {
    await this.analyticsProcessor.aggregateStats(task.payload.timeRange);
  }
  private async sendEmailTask(
    task: QueueTask<SendEmailPayload>
  ): Promise<void> {
    this.logger.info("Processing send email task", {
      taskId: task.id,
      to: task.payload.to,
      subject: task.payload.subject,
    });

    try {
      // Validate email params
      this.validateEmailParams(task.payload);

      // Prepare email content
      const emailContent = await this.prepareEmailContent(task.payload);

      // Handle attachments if present
      if (task.payload.attachments?.length) {
        emailContent.attachments = await this.processEmailAttachments(
          task.payload.attachments
        );
      }

      // Send via email service (e.g., SendGrid, AWS SES)
      const response = await env.EMAIL_SERVICE.send({
        to: task.payload.to,
        cc: task.payload.cc,
        bcc: task.payload.bcc,
        subject: task.payload.subject,
        ...emailContent,
        headers: {
          "X-Transaction-ID": task.payload.correlationId,
          ...task.payload.metadata?.customHeaders,
        },
      });

      // Track email metrics
      await this.trackEmailMetrics({
        taskId: task.id,
        messageId: response.messageId,
        recipients:
          task.payload.to.length +
          (task.payload.cc?.length || 0) +
          (task.payload.bcc?.length || 0),
        size: this.calculateEmailSize(emailContent),
      });
    } catch (error) {
      this.logger.error("Error sending email:", error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  private async cleanupStorageTask(
    task: QueueTask<CleanupStoragePayload>
  ): Promise<void> {
    this.logger.info("Processing storage cleanup task", {
      taskId: task.id,
      olderThan: task.payload.olderThan,
    });

    try {
      const stats = {
        scanned: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
      };

      // Process attachments cleanup
      if (!task.payload.types || task.payload.types.includes("attachments")) {
        const attachmentStats = await this.cleanupAttachments(
          task.payload.olderThan,
          task.payload.excludePatterns,
          task.payload.dryRun
        );
        Object.entries(attachmentStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Process analytics data cleanup
      if (!task.payload.types || task.payload.types.includes("analytics")) {
        const analyticsStats = await this.cleanupAnalytics(
          task.payload.olderThan,
          task.payload.dryRun
        );
        Object.entries(analyticsStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Process logs cleanup
      if (!task.payload.types || task.payload.types.includes("logs")) {
        const logsStats = await this.cleanupLogs(
          task.payload.olderThan,
          task.payload.dryRun
        );
        Object.entries(logsStats).forEach(([key, value]) => {
          stats[key] += value;
        });
      }

      // Store cleanup results
      await this.storeCleanupResults(task.id, stats);

      this.logger.info("Storage cleanup completed", { taskId: task.id, stats });
    } catch (error) {
      this.logger.error("Error cleaning up storage:", error);
      throw new Error(`Failed to cleanup storage: ${error.message}`);
    }
  }

  private async indexSearchTask(
    task: QueueTask<IndexSearchPayload>
  ): Promise<void> {
    this.logger.info("Processing search indexing task", {
      taskId: task.id,
      documentId: task.payload.documentId,
    });

    try {
      // Prepare document for indexing
      const document = {
        id: task.payload.documentId,
        text: task.payload.content.text,
        metadata: task.payload.content.metadata,
        language: task.payload.options?.language || "en",
        boost: task.payload.options?.boost || {},
        indexed_at: new Date().toISOString(),
      };

      // Process text for better search
      const processedText = await this.processTextForSearch(
        document.text,
        document.language
      );

      // Index the document
      await env.SEARCH_INDEX.index(document.id, {
        ...document,
        processed_text: processedText,
      });

      // Update search metadata
      await this.updateSearchMetadata(document.id, {
        lastIndexed: new Date(),
        status: "indexed",
      });
    } catch (error) {
      this.logger.error("Error indexing document:", error);
      throw new Error(`Failed to index document: ${error.message}`);
    }
  }

  private async updateThreadTask(
    task: QueueTask<UpdateThreadPayload>
  ): Promise<void> {
    this.logger.info("Processing thread update task", {
      taskId: task.id,
      threadId: task.payload.threadId,
    });

    try {
      const { threadId, updates, reindex } = task.payload;

      // Update thread in database
      const updatedThread = await env.THREAD_DB.updateThread(threadId, updates);

      // Update thread cache
      await this.updateThreadCache(threadId, updatedThread);

      // Reindex thread if required
      if (reindex) {
        await this.enqueueTask(TaskType.INDEX_SEARCH, {
          documentId: `thread:${threadId}`,
          content: {
            text: this.generateThreadSearchContent(updatedThread),
            metadata: {
              type: "thread",
              threadId,
              ...updates.metadata,
            },
          },
        });
      }

      // Update related analytics
      await this.updateThreadAnalytics(threadId, updates);
    } catch (error) {
      this.logger.error("Error updating thread:", error);
      throw new Error(`Failed to update thread: ${error.message}`);
    }
  }

  private async sendNotificationTask(
    task: QueueTask<NotificationPayload>
  ): Promise<void> {
    this.logger.info("Processing notification task", {
      taskId: task.id,
      userId: task.payload.userId,
      type: task.payload.notification.type,
    });

    try {
      const { userId, notification } = task.payload;

      // Get user preferences
      const userPreferences = await this.getUserNotificationPreferences(userId);

      // Check if user accepts this type of notification
      if (!this.shouldSendNotification(notification, userPreferences)) {
        this.logger.info("Notification skipped based on user preferences", {
          taskId: task.id,
          userId,
        });
        return;
      }

      // Prepare notification content
      const content = await this.prepareNotificationContent(
        notification,
        userPreferences
      );

      // Send notification based on type
      switch (notification.type) {
        case "email":
          await this.sendEmailNotification(userId, content);
          break;
        case "push":
          await this.sendPushNotification(userId, content);
          break;
        case "sms":
          await this.sendSMSNotification(userId, content);
          break;
        case "in_app":
          await this.sendInAppNotification(userId, content);
          break;
        default:
          throw new Error(
            `Unsupported notification type: ${notification.type}`
          );
      }

      // Track notification delivery
      await this.trackNotificationDelivery({
        taskId: task.id,
        userId,
        type: notification.type,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error("Error sending notification:", error);
      throw new Error(`Failed to send notification: ${error.message}`);
    }
  }

  // Helper methods for processors
  private validateEmailParams(payload: SendEmailPayload): void {
    if (!payload.to?.length) {
      throw new Error("No recipients specified");
    }
    if (!payload.subject?.trim()) {
      throw new Error("Subject is required");
    }
    if (!payload.content.text && !payload.content.html) {
      throw new Error("Email content is required");
    }
  }

  private async processEmailAttachments(
    attachments: SendEmailPayload["attachments"]
  ): Promise<any[]> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.contentType,
      }))
    );
  }

  private async cleanupAttachments(
    olderThan: Date,
    excludePatterns?: string[],
    dryRun?: boolean
  ): Promise<Record<string, number>> {
    const stats = { scanned: 0, deleted: 0, failed: 0, skipped: 0 };
    const cursor = await env.ATTACHMENT_BUCKET.list();
    const batchSize = 100;
    const objects = [];

    for await (const object of cursor) {
      objects.push(object);
    }

    // Process in batches
    const batches = Helpers.chunk(objects, batchSize);
    for (const batch of batches) {
      await Promise.all(
        batch.map(async (object) => {
          stats.scanned++;

          if (
            excludePatterns?.some((pattern) =>
              object.key.match(new RegExp(pattern))
            )
          ) {
            stats.skipped++;
            return;
          }

          if (object.uploaded < olderThan) {
            if (!dryRun) {
              try {
                await this.withTimeout(
                  env.ATTACHMENT_BUCKET.delete(object.key),
                  5000,
                  `delete attachment ${object.key}`
                );
                stats.deleted++;
              } catch (error) {
                stats.failed++;
                this.logger.error("Failed to delete attachment:", error);
              }
            }
          }
        })
      );

      await Helpers.sleep(100); // Add delay between batches
    }

    return stats;
  }

  private async processTextForSearch(
    text: string,
    language: string
  ): Promise<string> {
    // Remove special characters
    let processed = text.replace(/[^\w\s]/g, " ");

    // Convert to lowercase
    processed = processed.toLowerCase();

    // Remove extra whitespace
    processed = processed.replace(/\s+/g, " ").trim();

    // Add language-specific processing if needed
    if (language !== "en") {
      processed = await this.processTextForLanguage(processed, language);
    }

    return processed;
  }

  private shouldSendNotification(
    notification: NotificationPayload["notification"],
    preferences: any
  ): boolean {
    // Check if notification type is enabled
    if (!preferences.enabledTypes.includes(notification.type)) {
      return false;
    }

    // Check notification time preferences
    const currentHour = new Date().getHours();
    if (
      currentHour < preferences.quietHoursStart ||
      currentHour > preferences.quietHoursEnd
    ) {
      return false;
    }

    // Check priority preferences
    if (notification.priority === "low" && !preferences.lowPriorityEnabled) {
      return false;
    }

    return true;
  }

  async getTaskStatus(taskId: string): Promise<QueueTask | null> {
    const status = await this.redis.hget(this.STATUS_KEY, taskId);
    return status ? JSON.parse(status) : null;
  }

  async getFailedTasks(
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<QueueTask[]> {
    const { limit = 50, offset = 0 } = options;
    const end = offset + limit - 1;

    const result = await this.redis.zrange(this.FAILED_KEY, offset, end, {
      rev: true, // Get newest first
    });

    return result.map((task) => JSON.parse(task));
  }
}
