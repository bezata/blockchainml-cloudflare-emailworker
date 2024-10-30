import { ObjectId } from "mongodb";

export enum EmailPriority {
  High = "HIGH",
  Normal = "NORMAL",
  Low = "LOW",
}

export type EmailStatus = "unread" | "read" | "archived" | "trash";
export enum EmailCategory {
  Business = "BUSINESS",
  Personal = "PERSONAL",
  Marketing = "MARKETING",
  Social = "SOCIAL",
}
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
  threadId?: string | undefined;
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  tags: string[];
  headers?:
    | {
        "message-id"?: string | undefined;
        references?: string | undefined;
        "in-reply-to"?: string | undefined;
        [key: string]: string | undefined;
      }
    | undefined;
  textContent?: string | undefined;
  htmlContent?: string | undefined;
  attachments?: EmailAttachment[] | undefined;
  priority: (typeof EmailPriority)[keyof typeof EmailPriority];
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

export interface ProcessEmailPayload {
  messageId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textContent?: string;
  htmlContent?: string;
  attachments?: EmailAttachment[];
  headers?: {
    "message-id"?: string;
    references?: string;
    "in-reply-to"?: string;
    [key: string]: string | undefined;
  };
  priority?: (typeof EmailPriority)[keyof typeof EmailPriority];
  receivedAt: Date;
  spam?: boolean;
  spamScore?: number;
}
