import { Redis } from "@upstash/redis";
import { Logger } from "@/utils/logger";
import { Helpers } from "@/utils/helpers";
import { SearchDocument, SearchOptions, SearchStats } from "./types";

export class SearchIndexer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly DEFAULT_BATCH_SIZE = 100;

  // Redis key prefixes
  private readonly KEYS = {
    INDEX: "search:index:",
    INVERTED: "search:inverted:",
    METADATA: "search:metadata:",
    STATS: "search:stats",
    LOCK: "search:lock:",
  } as const;

  constructor() {
    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");

    // Validate Redis connection
    this.validateConnection();
  }

  private async validateConnection(): Promise<void> {
    try {
      await this.redis.ping();
    } catch (error) {
      this.logger.error("Failed to connect to Redis:", error);
      throw new SearchIndexerError("Redis connection failed");
    }
  }

  async indexDocument(
    document: SearchDocument,
    options: SearchOptions = {}
  ): Promise<void> {
    const lockId = await this.acquireLock(document.id);
    try {
      await this.validateDocument(document);

      const pipeline = this.redis.pipeline();

      // Store the document with timestamp
      const documentToStore = {
        ...document,
        timestamp: new Date(),
      };

      pipeline.hset(`${this.KEYS.INDEX}${document.type}`, {
        [document.id]: JSON.stringify(documentToStore),
      });

      // Process and index content
      const tokens = await this.tokenizeContent(
        document.content,
        options.language
      );
      const termFrequencies = this.calculateTermFrequencies(tokens);

      // Update inverted index with scored terms
      for (const [term, frequency] of Object.entries(termFrequencies)) {
        pipeline.zadd(`${this.KEYS.INVERTED}${term}`, {
          score: this.calculateScore(frequency, document),
          member: `${document.type}:${document.id}`,
        });
      }

      // Store metadata for filtering
      pipeline.hset(`${this.KEYS.METADATA}${document.type}`, {
        [document.id]: JSON.stringify({
          ...document.metadata,
          lastIndexed: new Date(),
        }),
      });

      // Update stats
      await this.updateStats(document.type);

      // Execute pipeline
      await pipeline.exec();

      this.logger.info("Document indexed successfully", {
        id: document.id,
        type: document.type,
        tokensCount: tokens.length,
      });
    } catch (error) {
      this.logger.error("Failed to index document:", error);
      throw new SearchIndexerError(`Failed to index document ${document.id}`, {
        cause: error,
      });
    } finally {
      await this.releaseLock(document.id, lockId);
    }
  }

  async bulkIndex(
    documents: SearchDocument[],
    options: SearchOptions = {}
  ): Promise<void> {
    const batchSize = options.batchSize || this.DEFAULT_BATCH_SIZE;
    const batches = Helpers.chunk(documents, batchSize);

    this.logger.info("Starting bulk indexing", {
      documentsCount: documents.length,
      batchesCount: batches.length,
    });

    let successCount = 0;
    let failureCount = 0;

    for (const [index, batch] of batches.entries()) {
      try {
        const pipeline = this.redis.pipeline();

        // Process batch concurrently
        await Promise.all(
          batch.map(async (document) => {
            try {
              await this.processDocumentForBatch(document, pipeline, options);
              successCount++;
            } catch (error) {
              failureCount++;
              this.logger.error("Failed to process document in batch:", {
                documentId: document.id,
                error,
              });
            }
          })
        );

        await pipeline.exec();

        // Update progress
        this.logger.info("Batch processed", {
          batchNumber: index + 1,
          totalBatches: batches.length,
          successCount,
          failureCount,
        });

        // Prevent overwhelming Redis
        await Helpers.sleep(100);
      } catch (error) {
        this.logger.error("Batch processing failed:", error);
        throw new SearchIndexerError("Bulk indexing failed", { cause: error });
      }
    }

    // Update final stats
    await this.updateStats();

    this.logger.info("Bulk indexing completed", {
      totalDocuments: documents.length,
      successCount,
      failureCount,
    });
  }

  async deleteDocument(type: string, id: string): Promise<void> {
    const lockId = await this.acquireLock(id);
    try {
      const document = await this.getDocument(type, id);
      if (!document) {
        this.logger.warn("Document not found for deletion", { type, id });
        return;
      }

      const pipeline = this.redis.pipeline();

      // Remove document
      pipeline.hdel(`${this.KEYS.INDEX}${type}`, id);
      pipeline.hdel(`${this.KEYS.METADATA}${type}`, id);

      // Clean up inverted index
      const tokens = await this.tokenizeContent(document.content);
      const uniqueTokens = new Set(tokens);

      for (const token of uniqueTokens) {
        pipeline.zrem(`${this.KEYS.INVERTED}${token}`, `${type}:${id}`);
      }

      await pipeline.exec();
      await this.updateStats(type);

      this.logger.info("Document deleted successfully", { type, id });
    } catch (error) {
      this.logger.error("Failed to delete document:", error);
      throw new SearchIndexerError(`Failed to delete document ${id}`, {
        cause: error,
      });
    } finally {
      await this.releaseLock(id, lockId);
    }
  }

  async updateDocumentMetadata(
    documentId: string,
    metadata: Record<string, any>
  ): Promise<void> {
    const lockId = await this.acquireLock(documentId);
    try {
      // Get document type from existing metadata
      const types = ["email", "thread", "attachment", "document_chunk"];
      let documentType: string | null = null;

      for (const type of types) {
        const exists = await this.redis.hexists(
          `${this.KEYS.METADATA}${type}`,
          documentId
        );
        if (exists) {
          documentType = type;
          break;
        }
      }

      if (!documentType) {
        throw new SearchIndexerError(`Document ${documentId} not found`);
      }

      // Update metadata
      await this.redis.hset(`${this.KEYS.METADATA}${documentType}`, {
        [documentId]: JSON.stringify({
          ...metadata,
          lastUpdated: new Date(),
        }),
      });

      this.logger.info("Document metadata updated", {
        documentId,
        documentType,
      });
    } catch (error) {
      this.logger.error("Failed to update document metadata:", error);
      throw new SearchIndexerError(
        `Failed to update metadata for document ${documentId}`,
        { cause: error }
      );
    } finally {
      await this.releaseLock(documentId, lockId);
    }
  }

  async getStats(): Promise<SearchStats> {
    try {
      const stats = await this.redis.get<SearchStats>(this.KEYS.STATS);
      return (
        stats || {
          documentsCount: 0,
          termsCount: 0,
          lastUpdated: new Date(),
        }
      );
    } catch (error) {
      this.logger.error("Failed to get stats:", error);
      throw new SearchIndexerError("Failed to get search stats", {
        cause: error,
      });
    }
  }

  private async processDocumentForBatch(
    document: SearchDocument,
    pipeline: any,
    options: SearchOptions
  ): Promise<void> {
    await this.validateDocument(document);

    // Store document
    pipeline.hset(`${this.KEYS.INDEX}${document.type}`, {
      [document.id]: JSON.stringify({
        ...document,
        timestamp: new Date(),
      }),
    });

    // Process content
    const tokens = await this.tokenizeContent(
      document.content,
      options.language
    );
    const termFrequencies = this.calculateTermFrequencies(tokens);

    // Update inverted index
    for (const [term, frequency] of Object.entries(termFrequencies)) {
      pipeline.zadd(`${this.KEYS.INVERTED}${term}`, {
        score: this.calculateScore(frequency, document),
        member: `${document.type}:${document.id}`,
      });
    }

    // Store metadata
    pipeline.hset(`${this.KEYS.METADATA}${document.type}`, {
      [document.id]: JSON.stringify({
        ...document.metadata,
        lastIndexed: new Date(),
      }),
    });
  }

  private async validateDocument(document: SearchDocument): Promise<void> {
    if (!document.id || !document.type || !document.content) {
      throw new SearchIndexerError("Invalid document format");
    }
  }

  private async tokenizeContent(
    content: string,
    language: string = "en"
  ): Promise<string[]> {
    const normalized = content.toLowerCase();
    const cleaned = normalized.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ");
    const tokens = cleaned.split(" ").filter((token) => token.length > 2);

    // Get language-specific stopwords
    const stopwords = await this.getStopwords(language);
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

  private calculateScore(frequency: number, document: SearchDocument): number {
    // TF-IDF like scoring
    const baseScore = Math.log(1 + frequency);
    const lengthNormalization = 1 / Math.sqrt(document.content.length);
    return baseScore * lengthNormalization;
  }

  private async getStopwords(language: string): Promise<Set<string>> {
    const stopwordsByLanguage: Record<string, string[]> = {
      en: [
        "the",
        "is",
        "at",
        "which",
        "on",
        "and",
        "or",
        "but",
        "in",
        "with",
        "to",
        "of",
        "for",
        "a",
        "an",
      ],
      es: [
        "el",
        "la",
        "los",
        "las",
        "un",
        "una",
        "y",
        "o",
        "pero",
        "en",
        "con",
        "de",
        "por",
        "para",
      ],
      fr: [
        "le",
        "la",
        "les",
        "un",
        "une",
        "et",
        "ou",
        "mais",
        "dans",
        "avec",
        "de",
        "pour",
        "par",
      ],
      de: [
        "der",
        "die",
        "das",
        "ein",
        "eine",
        "und",
        "oder",
        "aber",
        "in",
        "mit",
        "von",
        "für",
      ],
    };

    const defaultStopwords = stopwordsByLanguage["en"];
    const languageStopwords = stopwordsByLanguage[language] || defaultStopwords;

    return new Set(languageStopwords);
  }

  private async acquireLock(resourceId: string): Promise<string> {
    const lockId = Helpers.generateId();
    const acquired = await this.redis.set(
      `${this.KEYS.LOCK}${resourceId}`,
      lockId,
      {
        nx: true,
        ex: 30, // 30 seconds timeout
      }
    );

    if (!acquired) {
      throw new SearchIndexerError("Failed to acquire lock");
    }

    return lockId;
  }

  private async releaseLock(resourceId: string, lockId: string): Promise<void> {
    const currentLock = await this.redis.get(`${this.KEYS.LOCK}${resourceId}`);
    if (currentLock === lockId) {
      await this.redis.del(`${this.KEYS.LOCK}${resourceId}`);
    }
  }

  private async updateStats(type?: string): Promise<void> {
    try {
      const stats = await this.getStats();
      const termKeys = await this.redis.keys(`${this.KEYS.INVERTED}*`);

      const updatedStats: SearchStats = {
        documentsCount: type
          ? await this.redis.hlen(`${this.KEYS.INDEX}${type}`)
          : stats.documentsCount + 1,
        termsCount: termKeys.length,
        lastUpdated: new Date(),
      };

      await this.redis.set(this.KEYS.STATS, JSON.stringify(updatedStats));
    } catch (error) {
      this.logger.error("Failed to update stats:", error);
    }
  }

  private async getDocument(
    type: string,
    id: string
  ): Promise<SearchDocument | null> {
    try {
      const doc = await this.redis.hget(`${this.KEYS.INDEX}${type}`, id);
      return doc ? JSON.parse(doc as string) : null;
    } catch (error) {
      this.logger.error("Failed to get document:", error);
      throw new SearchIndexerError(`Failed to get document ${id}`, {
        cause: error,
      });
    }
  }
}

class SearchIndexerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchIndexerError";
  }
}
