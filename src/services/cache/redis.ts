import { Redis } from "@upstash/redis";
import { Logger } from "../../utils/logger";
import { CacheConfig, CacheEntry, CacheStats } from "./types";
import { env } from "process";

export class RedisCache {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly config: Required<CacheConfig>;
  private readonly stats: Map<string, number>;

  constructor(config: CacheConfig) {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.config = {
      ttl: config.ttl,
      maxSize: config.maxSize || 1000000, // 1MB default
      namespace: config.namespace || "cache",
      strategy: config.strategy || "lru",
    };
    this.stats = new Map([
      ["hits", 0],
      ["misses", 0],
      ["size", 0],
    ]);
  }

  async get<T>(key: string): Promise<T | null> {
    const start = Date.now();
    try {
      const fullKey = this.getFullKey(key);
      const entry = await this.redis.get<CacheEntry<T>>(fullKey);

      if (!entry) {
        this.incrementStat("misses");
        return null;
      }

      if (this.isExpired(entry)) {
        await this.delete(key);
        this.incrementStat("misses");
        return null;
      }

      // Update access patterns
      await this.updateAccessPattern(fullKey, entry);
      this.incrementStat("hits");

      return entry.value;
    } catch (error) {
      this.logger.error("Redis cache get error:", error);
      return null;
    } finally {
      this.updateAccessTime(Date.now() - start);
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    const start = Date.now();
    try {
      const fullKey = this.getFullKey(key);
      const size = this.calculateSize(value);

      // Check size constraints
      if (size > this.config.maxSize) {
        this.logger.warn("Cache entry too large", { key, size });
        return false;
      }

      // Ensure space available
      await this.ensureSpace(size);

      const entry: CacheEntry<T> = {
        value,
        expiresAt: Date.now() + (ttl || this.config.ttl),
        hitCount: 0,
        lastAccessed: Date.now(),
        size,
      };

      await this.redis.set(fullKey, entry, {
        ex: Math.ceil((ttl || this.config.ttl) / 1000),
      });

      this.incrementStat("size", size);
      return true;
    } catch (error) {
      this.logger.error("Redis cache set error:", error);
      return false;
    } finally {
      this.updateAccessTime(Date.now() - start);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const fullKey = this.getFullKey(key);
      const entry = await this.redis.get<CacheEntry<any>>(fullKey);

      if (entry) {
        await this.redis.del(fullKey);
        this.incrementStat("size", -entry.size);
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error("Redis cache delete error:", error);
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      let cursor = 0;
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, {
          match: `${this.config.namespace}:*`,
          count: 100,
        });

        cursor = parseInt(nextCursor);

        if (keys.length) {
          await this.redis.del(...keys);
        }
      } while (cursor !== 0);

      this.stats.set("size", 0);
    } catch (error) {
      this.logger.error("Redis cache clear error:", error);
    }
  }

  private getFullKey(key: string): string {
    return `${this.config.namespace}:${key}`;
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return entry.expiresAt <= Date.now();
  }

  private calculateSize(value: any): number {
    return Buffer.byteLength(JSON.stringify(value));
  }

  private async ensureSpace(requiredSize: number): Promise<void> {
    const currentSize = this.stats.get("size") || 0;

    if (currentSize + requiredSize <= this.config.maxSize) {
      return;
    }

    // Evict entries based on strategy
    await this.evictEntries(requiredSize);
  }

  private async evictEntries(requiredSize: number): Promise<void> {
    let cursor = 0;
    const entries: Array<{ key: string; entry: CacheEntry<any> }> = [];

    // Collect entries
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        match: `${this.config.namespace}:*`,
        count: 100,
      });

      cursor = parseInt(nextCursor);

      for (const key of keys) {
        const entry = await this.redis.get<CacheEntry<any>>(key);
        if (entry) {
          entries.push({ key, entry });
        }
      }
    } while (cursor !== 0);

    // Sort entries based on strategy
    entries.sort((a, b) => {
      switch (this.config.strategy) {
        case "lru":
          return a.entry.lastAccessed - b.entry.lastAccessed;
        case "mru":
          return b.entry.lastAccessed - a.entry.lastAccessed;
        case "lfu":
          return a.entry.hitCount - b.entry.hitCount;
        case "fifo":
          return a.entry.expiresAt - b.entry.expiresAt;
        default:
          return 0;
      }
    });

    // Evict entries until we have enough space
    let evictedSize = 0;
    for (const { key, entry } of entries) {
      await this.redis.del(key);
      evictedSize += entry.size;
      this.incrementStat("size", -entry.size);

      if (evictedSize >= requiredSize) {
        break;
      }
    }
  }

  private async updateAccessPattern(
    key: string,
    entry: CacheEntry<any>
  ): Promise<void> {
    entry.hitCount++;
    entry.lastAccessed = Date.now();

    await this.redis.set(key, entry, {
      ex: Math.ceil((entry.expiresAt - Date.now()) / 1000),
    });
  }

  private incrementStat(stat: string, value: number = 1): void {
    this.stats.set(stat, (this.stats.get(stat) || 0) + value);
  }

  private updateAccessTime(duration: number): void {
    const current = this.stats.get("avgAccessTime") || 0;
    const count =
      (this.stats.get("hits") || 0) + (this.stats.get("misses") || 0);
    this.stats.set("avgAccessTime", (current * (count - 1) + duration) / count);
  }

  async getStats(): Promise<CacheStats> {
    const itemCount = await this.getItemCount();

    return {
      hits: this.stats.get("hits") || 0,
      misses: this.stats.get("misses") || 0,
      size: this.stats.get("size") || 0,
      itemCount,
      avgAccessTime: this.stats.get("avgAccessTime") || 0,
    };
  }

  private async getItemCount(): Promise<number> {
    let count = 0;
    let cursor = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        match: `${this.config.namespace}:*`,
        count: 100,
      });

      cursor = parseInt(nextCursor);
      count += keys.length;
    } while (cursor !== 0);

    return count;
  }
}
