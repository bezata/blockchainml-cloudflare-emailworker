import { Env } from "hono";

export enum JobStatus {
  PENDING = "PENDING",
  SCHEDULED = "SCHEDULED",
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}
export type TaskPayload =
  | CleanupStoragePayload
  | ProcessEmailPayload
  | GenerateAnalyticsPayload
  | IndexSearchPayload
  | SendEmailPayload;

export interface ProcessEmailPayload {
  emailId: string;
  filters?: string[];
  priority?: boolean;
}

export interface GenerateAnalyticsPayload {
  startDate: Date;
  endDate: Date;
  metrics: string[];
  format?: "csv" | "json";
}

export interface IndexSearchPayload {
  documentId: string;
  content: string;
  language?: string;
  indexName?: string;
  chunkSize?: number;
  embedModel?: string;
}

export interface SendEmailPayload {
  to: string[];
  subject: string;
  body: string;
  attachments?: Array<{
    filename: string;
    content: string;
  }>;
}

export enum JobPriority {
  HIGH = "HIGH",
  NORMAL = "NORMAL",
  LOW = "LOW",
}
export enum TaskType {
  CLEANUP_STORAGE = "CLEANUP_STORAGE",
  PROCESS_EMAIL = "PROCESS_EMAIL",
  GENERATE_ANALYTICS = "GENERATE_ANALYTICS",
  INDEX_SEARCH = "INDEX_SEARCH",
  SEND_EMAIL = "SEND_EMAIL",
}

export interface CleanupStoragePayload {
  path: string;
  olderThan?: Date;
  pattern?: string;
}
export interface Job<T = TaskPayload> {
  id: string;
  type: TaskType;
  data: T;
  env: Env;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  scheduledFor: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: any;
  tags: string[];
  retryStrategy?: {
    maxAttempts: number;
    backoff: "exponential" | "linear";
    initialDelay: number;
  };
  timeout?: number;
  lastError: string | null;
  progress: number;
}

export interface JobResult {
  status: JobStatus;
  result?: any;
  error?: string;
}
