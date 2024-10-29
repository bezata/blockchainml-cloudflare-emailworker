import { Redis } from "@upstash/redis";
import { Logger } from "../../utils/logger";
import { Helpers } from "../../utils/helpers";
import { SearchDocument } from "./types";
import { env } from "process";

export class SearchIndexer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly INDEX_PREFIX = "search:index:";
  private readonly INVERTED_INDEX_PREFIX = "search:inverted:";
  private readonly METADATA_PREFIX = "search:metadata:";

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
  }

  async indexDocument(document: SearchDocument): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();

      // Store the document
      pipeline.hset(`${this.INDEX_PREFIX}${document.type}`, {
        [document.id]: JSON.stringify(document),
      });

      // Process and index content
      const tokens = await this.tokenizeContent(document.content);
      const termFrequencies = this.calculateTermFrequencies(tokens);

      // Update inverted index
      for (const [term, frequency] of Object.entries(termFrequencies)) {
        pipeline.zadd(`${this.INVERTED_INDEX_PREFIX}${term}`, {
          score: frequency,
          member: `${document.type}:${document.id}`,
        });
      }

      // Store metadata for filtering
      pipeline.hset(`${this.METADATA_PREFIX}${document.type}`, {
        [document.id]: JSON.stringify(document.metadata),
      });

      await pipeline.exec();

      this.logger.info(
        `Indexed document ${document.id} of type ${document.type}`
      );
    } catch (error) {
      this.logger.error("Error indexing document:", error);
      throw error;
    }
  }

  async bulkIndex(documents: SearchDocument[]): Promise<void> {
    const batches = Helpers.chunk(documents, 100);

    for (const batch of batches) {
      const pipeline = this.redis.pipeline();

      for (const document of batch) {
        // Store document
        pipeline.hset(`${this.INDEX_PREFIX}${document.type}`, {
          [document.id]: JSON.stringify(document),
        });

        // Process content in parallel
        const tokens = await this.tokenizeContent(document.content);
        const termFrequencies = this.calculateTermFrequencies(tokens);

        // Update inverted index
        for (const [term, frequency] of Object.entries(termFrequencies)) {
          pipeline.zadd(`${this.INVERTED_INDEX_PREFIX}${term}`, {
            score: frequency,
            member: `${document.type}:${document.id}`,
          });
        }

        // Store metadata
        pipeline.hset(`${this.METADATA_PREFIX}${document.type}`, {
          [document.id]: JSON.stringify(document.metadata),
        });
      }

      await pipeline.exec();
      await Helpers.sleep(100); // Prevent overwhelming Redis
    }
  }

  private async tokenizeContent(content: string): Promise<string[]> {
    // Normalize content
    const normalized = content.toLowerCase();

    // Remove special characters and extra spaces
    const cleaned = normalized.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ");

    // Split into tokens
    const tokens = cleaned.split(" ").filter((token) => token.length > 2);

    // Remove stopwords
    const stopwords = new Set(["the", "is", "at", "which", "on"]);
    return tokens.filter((token) => !stopwords.has(token));
  }

  private calculateTermFrequencies(tokens: string[]): Record<string, number> {
    return tokens.reduce(
      (acc, token) => {
        acc[token] = (acc[token] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async deleteDocument(type: string, id: string): Promise<void> {
    try {
      // Get document first to clean up inverted index
      const document = await this.getDocument(type, id);
      if (!document) return;

      const pipeline = this.redis.pipeline();

      // Remove from main index
      pipeline.hdel(`${this.INDEX_PREFIX}${type}`, id);

      // Remove from metadata
      pipeline.hdel(`${this.METADATA_PREFIX}${type}`, id);

      // Clean up inverted index
      const tokens = await this.tokenizeContent(document.content);
      const uniqueTokens = new Set(tokens);

      for (const token of uniqueTokens) {
        pipeline.zrem(`${this.INVERTED_INDEX_PREFIX}${token}`, `${type}:${id}`);
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error("Error deleting document:", error);
      throw error;
    }
  }

  private async getDocument(
    type: string,
    id: string
  ): Promise<SearchDocument | null> {
    const doc = await this.redis.hget(`${this.INDEX_PREFIX}${type}`, id);
    return doc ? JSON.parse(doc as string) : null;
  }
}
