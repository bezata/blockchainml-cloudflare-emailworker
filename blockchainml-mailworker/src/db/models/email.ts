import { Collection, IndexDescription, ObjectId } from "mongodb";
import { EmailDocument } from "@/types/email";
import { MongoDB } from "@/config/mongodb";
import { Logger } from "@/utils/logger";

export class EmailModel {
  private static readonly COLLECTION_NAME = "emails";
  private readonly logger: Logger;
  private readonly collection: Collection<EmailDocument>;

  constructor() {
    this.logger = Logger.getInstance("production");
    this.collection = MongoDB.getClient()
      .db()
      .collection<EmailDocument>(EmailModel.COLLECTION_NAME);
  }

  async initialize(): Promise<void> {
    try {
      await this.createIndexes();
      this.logger.info("Email indexes created successfully");
    } catch (error) {
      this.logger.error("Error creating email indexes:", error);
      throw error;
    }
  }

  private async createIndexes(): Promise<void> {
    const indexes: IndexDescription[] = [
      // Unique indexes
      {
        key: { messageId: 1 },
        unique: true,
      },
      // Regular indexes
      {
        key: { threadId: 1 },
      },
      {
        key: { from: 1 },
      },
      {
        key: { receivedAt: -1 },
      },
      {
        key: { status: 1 },
      },
      {
        key: { category: 1 },
      },
      {
        key: { spam: 1 },
      },
      {
        key: { createdAt: -1 },
      },
      // Text indexes
      {
        key: {
          subject: "text",
          textContent: "text",
        },
      },
      // Compound indexes
      {
        key: {
          threadId: 1,
          receivedAt: -1,
        },
      },
      {
        key: {
          status: 1,
          receivedAt: -1,
        },
      },
    ];

    await this.collection.createIndexes(indexes);
  }

  getCollection(): Collection<EmailDocument> {
    return this.collection;
  }

  // Validation schemas
  static readonly validationSchema = {
    bsonType: "object",
    required: ["messageId", "from", "to", "subject", "priority", "status"],
    properties: {
      _id: { bsonType: "objectId" },
      messageId: { bsonType: "string" },
      threadId: { bsonType: "string" },
      from: { bsonType: "string" },
      to: {
        bsonType: "array",
        items: { bsonType: "string" },
        minItems: 1,
      },
      cc: {
        bsonType: "array",
        items: { bsonType: "string" },
      },
      bcc: {
        bsonType: "array",
        items: { bsonType: "string" },
      },
      subject: { bsonType: "string" },
      textContent: { bsonType: "string" },
      htmlContent: { bsonType: "string" },
      attachments: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["id", "filename", "contentType", "size", "url"],
          properties: {
            id: { bsonType: "string" },
            filename: { bsonType: "string" },
            contentType: { bsonType: "string" },
            size: { bsonType: "number" },
            url: { bsonType: "string" },
          },
        },
      },
      priority: {
        enum: ["high", "normal", "low"],
      },
      category: {
        bsonType: "array",
        items: {
          enum: ["business", "personal", "marketing", "social"],
        },
      },
      labels: {
        bsonType: "array",
        items: { bsonType: "string" },
      },
      status: {
        enum: ["unread", "read", "archived", "trash"],
      },
      receivedAt: { bsonType: "date" },
      spam: { bsonType: "bool" },
      spamScore: { bsonType: "double" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" },
    },
  };

  // Factory method for creating email documents
  static createEmailDocument(
    data: Omit<EmailDocument, "_id" | "createdAt" | "updatedAt">
  ): EmailDocument {
    return {
      _id: new ObjectId(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
