import { ObjectId } from "mongodb";

export interface ThreadDocument {
  _id: ObjectId;
  subject: string;
  participants: string[];
  emailIds: ObjectId[];
  lastMessageAt: Date;
  messageCount: number;
  status: "active" | "archived" | "trash";
  labels: string[];
  metadata: {
    originalSubject: string;
    isForwarded: boolean;
    hasAttachments: boolean;
  };
}
