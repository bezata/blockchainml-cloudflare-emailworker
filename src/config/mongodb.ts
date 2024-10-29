import { MongoClient, ServerApiVersion, MongoClientOptions } from "mongodb";
import { constants } from "@/config/constants";

export class MongoDB {
  private static instance: MongoClient | null;
  private static isConnected: boolean = false;

  private constructor() {}

  public static async connect(uri: string): Promise<MongoClient> {
    if (!MongoDB.instance) {
      MongoDB.instance = new MongoClient(uri, {
        maxPoolSize: constants.mongodb.maxPoolSize,
        minPoolSize: 5,
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      } as MongoClientOptions);

      try {
        await MongoDB.instance.connect();
        MongoDB.isConnected = true;
        console.log("MongoDB connection established");
      } catch (error) {
        console.error("MongoDB connection error:", error);
        throw error;
      }
    }

    return MongoDB.instance;
  }

  public static async disconnect(): Promise<void> {
    if (MongoDB.instance && MongoDB.isConnected) {
      await MongoDB.instance.close();
      MongoDB.isConnected = false;
      MongoDB.instance = null;
      console.log("MongoDB connection closed");
    }
  }

  public static getClient(): MongoClient {
    if (!MongoDB.instance || !MongoDB.isConnected) {
      throw new Error("MongoDB is not connected. Call connect() first.");
    }
    return MongoDB.instance;
  }
}
