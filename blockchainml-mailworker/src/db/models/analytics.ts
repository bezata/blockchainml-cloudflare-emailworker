import { ObjectId } from "mongodb";

export interface AnalyticsDocument {
  _id: ObjectId;
  type: AnalyticsEventType;
  userId: string;
  emailId?: ObjectId;
  threadId?: ObjectId;
  timestamp: Date;
  metadata: Record<string, any>;
}

export type AnalyticsEventType =
  | "email_received"
  | "email_read"
  | "email_sent"
  | "thread_created"
  | "label_added"
  | "label_removed"
  | "email_archived"
  | "email_deleted"
  | "search_performed"
  | "filter_applied"
  | "attachment_uploaded"
  | "attachment_downloaded";
