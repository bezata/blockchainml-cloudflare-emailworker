import { ObjectId } from "mongodb";
import { MongoDB } from "@/config/mongodb";
import { ThreadDocument } from "@/db/models/thread";
import { Logger } from "@/utils/logger";

export class ThreadRepository {
  private readonly logger: Logger;
  private readonly collection = "threads";

  constructor() {
    this.logger = Logger.getInstance("production");
  }

  private getCollection() {
    const client = MongoDB.getClient();
    return client.db().collection<ThreadDocument>(this.collection);
  }

  async create(thread: Omit<ThreadDocument, "_id">): Promise<ThreadDocument> {
    try {
      const result = await this.getCollection().insertOne({
        _id: new ObjectId(),
        ...thread,
      });
      return (await this.findById(result.insertedId.toString()))!;
    } catch (error) {
      this.logger.error("Error creating thread:", error);
      throw error;
    }
  }

  async findById(id: string): Promise<ThreadDocument | null> {
    try {
      return await this.getCollection().findOne({ _id: new ObjectId(id) });
    } catch (error) {
      this.logger.error("Error finding thread:", error);
      throw error;
    }
  }

  async findByReferences(references: string[]): Promise<ThreadDocument | null> {
    try {
      return await this.getCollection().findOne({
        "metadata.references": { $in: references },
      });
    } catch (error) {
      this.logger.error("Error finding thread by references:", error);
      throw error;
    }
  }

  async findBySubject(subject: string): Promise<ThreadDocument | null> {
    try {
      return await this.getCollection().findOne({
        subject: subject,
      });
    } catch (error) {
      this.logger.error("Error finding thread by subject:", error);
      throw error;
    }
  }

  async update(id: string, update: any): Promise<void> {
    try {
      await this.getCollection().updateOne({ _id: new ObjectId(id) }, update);
    } catch (error) {
      this.logger.error("Error updating thread:", error);
      throw error;
    }
  }

  async getThreadsWithEmails(
    query: any = {},
    options: {
      page: number;
      limit: number;
      sort?: any;
    }
  ): Promise<{
    threads: ThreadDocument[];
    total: number;
  }> {
    try {
      const skip = (options.page - 1) * options.limit;

      const [threads, total] = await Promise.all([
        this.getCollection()
          .find(query)
          .sort(options.sort || { lastMessageAt: -1 })
          .skip(skip)
          .limit(options.limit)
          .toArray(),
        this.getCollection().countDocuments(query),
      ]);

      return { threads, total };
    } catch (error) {
      this.logger.error("Error getting threads with emails:", error);
      throw error;
    }
  }
}
