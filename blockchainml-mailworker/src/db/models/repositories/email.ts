import { ObjectId } from "mongodb";
import { MongoDB } from "@/config/mongodb";
import { EmailDocument } from "@/types/email";
import { Logger } from "@/utils/logger";

export class EmailRepository {
  private readonly logger: Logger;
  private readonly collection = "emails";

  constructor() {
    this.logger = Logger.getInstance("production");
  }

  private getCollection() {
    const client = MongoDB.getClient();
    return client.db().collection<EmailDocument>(this.collection);
  }

  async findById(id: string): Promise<EmailDocument | null> {
    try {
      return await this.getCollection().findOne({ _id: new ObjectId(id) });
    } catch (error) {
      this.logger.error("Error finding email by id:", error);
      throw error;
    }
  }

  async findMany(
    query: any,
    options: {
      page: number;
      limit: number;
      sort?: any;
    }
  ): Promise<EmailDocument[]> {
    try {
      const skip = (options.page - 1) * options.limit;
      return await this.getCollection()
        .find(query)
        .sort(options.sort || { receivedAt: -1 })
        .skip(skip)
        .limit(options.limit)
        .toArray();
    } catch (error) {
      this.logger.error("Error finding emails:", error);
      throw error;
    }
  }

  async create(email: Omit<EmailDocument, "_id">): Promise<EmailDocument> {
    try {
      const result = await this.getCollection().insertOne({
        _id: new ObjectId(),
        ...email,
      });
      return (await this.findById(
        result.insertedId.toString()
      )) as EmailDocument;
    } catch (error) {
      this.logger.error("Error creating email:", error);
      throw error;
    }
  }

  async update(
    id: string,
    update: Partial<EmailDocument>
  ): Promise<EmailDocument | null> {
    try {
      await this.getCollection().updateOne(
        { _id: new ObjectId(id) },
        { $set: update }
      );
      return this.findById(id);
    } catch (error) {
      this.logger.error("Error updating email:", error);
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.getCollection().deleteOne({
        _id: new ObjectId(id),
      });
      return result.deletedCount > 0;
    } catch (error) {
      this.logger.error("Error deleting email:", error);
      throw error;
    }
  }

  async search(
    query: string,
    options: {
      page: number;
      limit: number;
      filters?: Partial<EmailDocument>;
    }
  ): Promise<{ results: EmailDocument[]; total: number }> {
    try {
      const searchQuery = {
        $text: { $search: query },
        ...options.filters,
      };

      const [results, total] = await Promise.all([
        this.findMany(searchQuery, options),
        this.getCollection().countDocuments(searchQuery),
      ]);

      return { results, total };
    } catch (error) {
      this.logger.error("Error searching emails:", error);
      throw error;
    }
  }

  async markAsRead(ids: string[]): Promise<void> {
    try {
      await this.getCollection().updateMany(
        { _id: { $in: ids.map((id) => new ObjectId(id)) } },
        { $set: { status: "read" } }
      );
    } catch (error) {
      this.logger.error("Error marking emails as read:", error);
      throw error;
    }
  }

  async updateLabels(
    id: string,
    labels: string[],
    operation: "add" | "remove"
  ): Promise<void> {
    try {
      const update =
        operation === "add"
          ? { $addToSet: { labels: { $each: labels } } }
          : { $pull: { labels: { $in: labels } } };

      await this.getCollection().updateOne({ _id: new ObjectId(id) }, update);
    } catch (error) {
      this.logger.error("Error updating email labels:", error);
      throw error;
    }
  }

  async getCount(query: any = {}): Promise<number> {
    try {
      return await this.getCollection().countDocuments(query);
    } catch (error) {
      this.logger.error("Error getting email count:", error);
      throw error;
    }
  }
}
