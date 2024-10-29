import { Redis } from "@upstash/redis";
import { Logger } from "../../utils/logger";
import { SearchIndexer } from "./indexer";
import { env } from "../../config/env";
import { Helpers } from "../../utils/helpers";

interface IndexStats {
  totalTerms: number;
  totalDocuments: number;
  averageTermFrequency: number;
  termDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  storageUsage: {
    terms: number;
    metadata: number;
    total: number;
  };
  health: {
    status: "healthy" | "degraded" | "unhealthy";
    issues: string[];
  };
}

export class SearchOptimizer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly indexer: SearchIndexer;
  private readonly BATCH_SIZE = 1000;
  private readonly OPTIMIZATION_LOCK = "search:optimization:lock";
  private readonly STATS_CACHE_KEY = "search:stats";
  private readonly STATS_CACHE_TTL = 3600; // 1 hour

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.indexer = new SearchIndexer();
  }

  async optimizeIndex(): Promise<void> {
    // Implement distributed lock
    const lockId = Helpers.generateId();
    try {
      const acquired = await this.acquireOptimizationLock(lockId);
      if (!acquired) {
        this.logger.warn("Optimization already in progress, skipping");
        return;
      }

      const startTime = Date.now();
      this.logger.info("Starting index optimization");

      await Promise.all([
        this.cleanupUnusedTerms(),
        this.updateTermFrequencies(),
        this.optimizeMetadata(),
      ]);

      // Update optimization stats
      await this.updateOptimizationStats({
        lastOptimizationTime: startTime,
        duration: Date.now() - startTime,
      });

      this.logger.info("Index optimization completed", {
        duration: Date.now() - startTime,
      });
    } catch (error) {
      this.logger.error("Error optimizing index:", error);
      throw error;
    } finally {
      await this.releaseOptimizationLock(lockId);
    }
  }

  private async acquireOptimizationLock(lockId: string): Promise<boolean> {
    return (
      (await this.redis.set(this.OPTIMIZATION_LOCK, lockId, {
        nx: true,
        ex: 3600, // 1-hour timeout
      })) !== null
    );
  }

  private async releaseOptimizationLock(lockId: string): Promise<void> {
    const currentLock = await this.redis.get(this.OPTIMIZATION_LOCK);
    if (currentLock === lockId) {
      await this.redis.del(this.OPTIMIZATION_LOCK);
    }
  }

  private async cleanupUnusedTerms(): Promise<void> {
    let cursor = 0;
    const deletedKeys: string[] = [];

    try {
      do {
        // Scan instead of keys for better performance
        const [nextCursor, keys] = await this.redis.scan(cursor, {
          match: `${this.indexer["INVERTED_INDEX_PREFIX"]}*`,
          count: this.BATCH_SIZE,
        });

        cursor = parseInt(nextCursor);

        // Process keys in batches
        const batches = Helpers.chunk(keys, 100);
        for (const batch of batches) {
          const pipeline = this.redis.pipeline();

          for (const key of batch) {
            pipeline.zcard(key);
          }

          const counts = await pipeline.exec();

          // Collect keys to delete
          const toDelete = batch.filter((_, i) => counts[i] === 0);
          if (toDelete.length > 0) {
            await this.redis.del(...toDelete);
            deletedKeys.push(...toDelete);
          }

          await Helpers.sleep(100); // Prevent overwhelming Redis
        }
      } while (cursor !== 0);

      this.logger.info("Unused terms cleanup completed", {
        deletedCount: deletedKeys.length,
      });
    } catch (error) {
      this.logger.error("Error cleaning up unused terms:", error);
      throw error;
    }
  }

  private async updateTermFrequencies(): Promise<void> {
    let cursor = 0;
    const processedTerms = new Set<string>();

    try {
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, {
          match: `${this.indexer["INVERTED_INDEX_PREFIX"]}*`,
          count: this.BATCH_SIZE,
        });

        cursor = parseInt(nextCursor);

        // Process in batches
        const batches = Helpers.chunk(keys, 50);
        for (const batch of batches) {
          await Promise.all(
            batch.map(async (key) => {
              if (processedTerms.has(key)) return;

              const pipeline = this.redis.pipeline();
              const entries = await this.redis.zrange(key, 0, -1, {
                withScores: true,
              });

              if (entries.length === 0) return;

              const totalDocs = entries.length;
              const idf = Math.log(totalDocs + 1);

              // Calculate TF-IDF scores
              for (const { member, score } of entries) {
                const tf = score / totalDocs;
                const tfidf = tf * idf;
                pipeline.zadd(key, { score: tfidf, member });
              }

              await pipeline.exec();
              processedTerms.add(key);
            })
          );

          await Helpers.sleep(100);
        }
      } while (cursor !== 0);

      this.logger.info("Term frequencies updated", {
        processedTerms: processedTerms.size,
      });
    } catch (error) {
      this.logger.error("Error updating term frequencies:", error);
      throw error;
    }
  }

  private async optimizeMetadata(): Promise<void> {
    let cursor = 0;
    const optimizedCount = { success: 0, failed: 0 };

    try {
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, {
          match: `${this.indexer["METADATA_PREFIX"]}*`,
          count: this.BATCH_SIZE,
        });

        cursor = parseInt(nextCursor);

        // Process in batches
        const batches = Helpers.chunk(keys, 50);
        for (const batch of batches) {
          const pipeline = this.redis.pipeline();

          for (const key of batch) {
            try {
              const metadata = await this.redis.hgetall(key);
              if (!metadata) continue;

              // Optimize metadata structure
              const optimized = this.optimizeMetadataStructure(metadata);

              // Store optimized metadata
              pipeline.del(key);
              pipeline.set(key, JSON.stringify(optimized));

              optimizedCount.success++;
            } catch (error) {
              optimizedCount.failed++;
              this.logger.error(
                `Error optimizing metadata for key ${key}:`,
                error
              );
            }
          }

          await pipeline.exec();
          await Helpers.sleep(100);
        }
      } while (cursor !== 0);

      this.logger.info("Metadata optimization completed", optimizedCount);
    } catch (error) {
      this.logger.error("Error optimizing metadata:", error);
      throw error;
    }
  }

  private optimizeMetadataStructure(
    metadata: Record<string, any>
  ): Record<string, any> {
    // Remove null or undefined values
    const cleaned = Object.entries(metadata).reduce((acc, [key, value]) => {
      if (value != null) {
        acc[key] = value;
      }
      return acc;
    }, {});

    // Compress long string values if needed
    return Object.entries(cleaned).reduce((acc, [key, value]) => {
      if (typeof value === "string" && value.length > 1000) {
        acc[key] = value.substring(0, 1000) + "...";
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  async analyzeIndexHealth(): Promise<IndexStats> {
    try {
      // Try to get cached stats first
      const cachedStats = await this.redis.get(this.STATS_CACHE_KEY);
      if (cachedStats) {
        return JSON.parse(cachedStats);
      }

      const startTime = Date.now();
      let totalTerms = 0;
      let totalDocuments = 0;
      const frequencies: number[] = [];
      const issues: string[] = [];

      // Analyze term frequencies
      let cursor = 0;
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, {
          match: `${this.indexer["INVERTED_INDEX_PREFIX"]}*`,
          count: this.BATCH_SIZE,
        });

        cursor = parseInt(nextCursor);
        totalTerms += keys.length;

        for (const key of keys) {
          const count = await this.redis.zcard(key);
          frequencies.push(count);
          totalDocuments += count;
        }
      } while (cursor !== 0);

      // Calculate statistics
      const avgFreq = totalDocuments / totalTerms;
      const termDistribution = {
        high: frequencies.filter((f) => f > avgFreq * 2).length,
        medium: frequencies.filter((f) => f >= avgFreq / 2 && f <= avgFreq * 2)
          .length,
        low: frequencies.filter((f) => f < avgFreq / 2).length,
      };

      // Calculate storage usage
      const storageUsage = {
        terms: await this.calculateStorageSize(
          `${this.indexer["INVERTED_INDEX_PREFIX"]}*`
        ),
        metadata: await this.calculateStorageSize(
          `${this.indexer["METADATA_PREFIX"]}*`
        ),
        total: 0,
      };
      storageUsage.total = storageUsage.terms + storageUsage.metadata;

      // Determine health status
      const health = this.determineHealthStatus(
        avgFreq,
        termDistribution,
        storageUsage
      );

      const stats: IndexStats = {
        totalTerms,
        totalDocuments,
        averageTermFrequency: avgFreq,
        termDistribution,
        storageUsage,
        health,
      };

      // Cache stats
      await this.redis.set(this.STATS_CACHE_KEY, JSON.stringify(stats), {
        ex: this.STATS_CACHE_TTL,
      });

      this.logger.info("Index health analysis completed", {
        duration: Date.now() - startTime,
      });

      return stats;
    } catch (error) {
      this.logger.error("Error analyzing index health:", error);
      throw error;
    }
  }

  private async calculateStorageSize(pattern: string): Promise<number> {
    let total = 0;
    let cursor = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        match: pattern,
        count: this.BATCH_SIZE,
      });

      cursor = parseInt(nextCursor);

      for (const key of keys) {
        const memory = await this.redis.memory("usage", key);
        total += memory || 0;
      }
    } while (cursor !== 0);

    return total;
  }

  private determineHealthStatus(
    avgFreq: number,
    distribution: IndexStats["termDistribution"],
    storage: IndexStats["storageUsage"]
  ): IndexStats["health"] {
    const issues: string[] = [];

    if (avgFreq < 1) {
      issues.push("Low average term frequency");
    }
    if (distribution.high > distribution.medium * 2) {
      issues.push("Unbalanced term distribution");
    }
    if (storage.total > 1000000000) {
      // 1GB
      issues.push("High storage usage");
    }

    return {
      status:
        issues.length === 0
          ? "healthy"
          : issues.length < 2
          ? "degraded"
          : "unhealthy",
      issues,
    };
  }

  private async updateOptimizationStats(stats: {
    lastOptimizationTime: number;
    duration: number;
  }): Promise<void> {
    await this.redis.hset("search:optimization:stats", stats);
  }
}
