import { Redis } from "@upstash/redis";
import { Logger } from "winston";
import { Helpers } from "@/utils/helpers ";
import { SearchDocument } from "./types";
import { env } from "process";

export class SearchIndexer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly INDEX_PREFIX = "search:index:";
  private readonly INVERTED_INDEX_PREFIX = "search:inverted:";
  private readonly METADATA_PREFIX = "search:metadata:";

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
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

  async updateMetadata(
    documentId: string,
    metadata: {
      indexed: boolean;
      chunksCount: number;
      language: string;
      indexName: string;
      embedModel: string;
    }
  ): Promise<void> {
    try {
      await this.redis.hset(`${this.METADATA_PREFIX}document:${documentId}`, {
        [documentId]: JSON.stringify(metadata),
      });
      this.logger.info(`Updated metadata for document ${documentId}`);
    } catch (error) {
      this.logger.error(
        `Error updating metadata for document ${documentId}:`,
        error
      );
      throw error;
    }
  }
}
