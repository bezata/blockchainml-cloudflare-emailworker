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
  correlationId: string;
  timestamp: number;
}

export interface QueueTask<T extends BaseTaskPayload = TaskPayload> {
  id: string;
  type: TaskType;
  payload: T;
  priority: TaskPriority;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  scheduledFor: Date;
  metadata: Record<string, unknown>;
  lastAttemptAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  content: string;
  headers: Record<string, string>;
  raw: {
    text: string;
    html?: string;
  };
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
  type: string;
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

export interface SendEmailPayload extends BaseTaskPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  subject: string;
  content: {
    text: string;
    html?: string;
  };
  attachments?: {
    id: string;
    filename: string;
    content: string;
    contentType: string;
    size: number;
  }[];
  metadata?: Record<string, unknown>;
}

export interface CleanupStoragePayload extends BaseTaskPayload {
  olderThan: Date;
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

export type TaskPayload =
  | EmailTaskPayload
  | AttachmentTaskPayload
  | AnalyticsTaskPayload
  | UpdateThreadPayload
  | NotificationPayload
  | SendEmailPayload
  | CleanupStoragePayload
  | IndexSearchPayload;

export interface SendEmailPayload extends BaseTaskPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  subject: string;
  content: {
    text: string;
    html?: string;
  };
  attachments?: {
    id: string;
    filename: string;
    content: string;
    contentType: string;
    size: number;
  }[];
  metadata?: Record<string, unknown>;
}

// Add missing payload types
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

export interface UpdateThreadPayload extends BaseTaskPayload {
  threadId: string;
  updates: {
    status?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
  };
  reindex?: boolean;
}

// Update KV list types
export interface KVNamespaceListOptions {
  prefix?: string;
  cursor?: string | null;
  limit?: number;
}

export interface KVNamespaceListResult<K> {
  keys: KVNamespaceListKey<K>[];
  list_complete: boolean;
  cursor?: string;
}
