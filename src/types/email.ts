import { ObjectId } from "mongodb";

export type EmailPriority = "high" | "normal" | "low";
export type EmailStatus = "unread" | "read" | "archived" | "trash";
export type EmailCategory = "business" | "personal" | "marketing" | "social";
export type EmailSendingStatus = "pending" | "sending" | "sent" | "failed";

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export interface EmailDocument {
  _id: ObjectId;
  messageId: string;
  threadId?: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  headers?: {
    "message-id"?: string;
    references?: string;
    "in-reply-to"?: string;
    [key: string]: string | undefined;
  };
  textContent?: string;
  htmlContent?: string;
  attachments?: EmailAttachment[];
  priority: EmailPriority;
  category: EmailCategory[];
  labels: string[];
  status: EmailStatus;
  receivedAt: Date;
  spam: boolean;
  spamScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BaseRepository<T> {
  findById(id: string): Promise<T | null>;
  findMany(
    query: Record<string, any>,
    options: {
      page: number;
      limit: number;
      sort?: Record<string, 1 | -1>;
    }
  ): Promise<T[]>;
  getCount(query?: Record<string, any>): Promise<number>;
  create(data: Omit<T, "_id">): Promise<T>;
  update(id: string, update: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
}
