export enum TaskPriority {
  HIGH = "high",
  NORMAL = "normal",
  LOW = "low",
}

export enum TaskStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  SCHEDULED = "scheduled",
  CANCELED = "canceled",
}

export enum TaskType {
  PROCESS_EMAIL = "process_email",
  SEND_EMAIL = "send_email",
  PROCESS_ATTACHMENTS = "process_attachments",
  GENERATE_ANALYTICS = "generate_analytics",
  CLEANUP_STORAGE = "cleanup_storage",
  INDEX_SEARCH = "index_search",
  UPDATE_THREAD = "update_thread",
  SEND_NOTIFICATION = "send_notification",
}

export interface BaseTaskPayload {
  correlationId?: string;
  timestamp: number;
}

export interface EmailTaskPayload extends BaseTaskPayload {
  email: {
    id: string;
    from: string;
    to: string[];
    subject: string;
    content: string;
  };
}

export interface AttachmentTaskPayload extends BaseTaskPayload {
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
    content: string;
  }>;
}

export interface AnalyticsTaskPayload extends BaseTaskPayload {
  timeRange: {
    start: Date;
    end: Date;
  };
  filters?: Record<string, unknown>;
}

export interface UpdateThreadPayload extends BaseTaskPayload {
  threadId: string;
  updates: {
    status?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
  };
  reindex?: boolean;
}

export interface NotificationPayload extends BaseTaskPayload {
  userId: string;
  notification: {
    type: "email" | "push" | "sms" | "in_app";
    title: string;
    message: string;
    priority?: "high" | "normal" | "low";
    data?: Record<string, unknown>;
    channels?: string[];
  };
}

export type TaskPayload =
  | EmailTaskPayload
  | AttachmentTaskPayload
  | AnalyticsTaskPayload
  | UpdateThreadPayload
  | NotificationPayload;

export interface QueueTask<T extends TaskPayload = TaskPayload> {
  id: string;
  type: TaskType;
  payload: T;
  priority: TaskPriority;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  error?: string;
  createdAt: Date;
  scheduledFor: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SendEmailPayload extends BaseTaskPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  content: {
    text?: string;
    html?: string;
  };
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
  metadata?: {
    templateId?: string;
    campaignId?: string;
    customHeaders?: Record<string, string>;
  };
}

export interface CleanupStoragePayload extends BaseTaskPayload {
  olderThan: Date;
  types?: Array<"attachments" | "analytics" | "logs">;
  excludePatterns?: string[];
  dryRun?: boolean;
}

export interface IndexSearchPayload extends BaseTaskPayload {
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
