export enum JobStatus {
  PENDING = "PENDING",
  SCHEDULED = "SCHEDULED",
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

export enum JobPriority {
  HIGH = "HIGH",
  NORMAL = "NORMAL",
  LOW = "LOW",
}

export interface Job {
  id: string;
  type: string;
  data: Record<string, any>;
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
