import { Helpers } from "../../utils/helpers";
import { CacheConfig, CacheEntry, CacheStats } from "./types";

export class MemoryCache {
  private readonly cache: Map<string, CacheEntry<any>>;
  private readonly config: Required<CacheConfig>;
  private readonly stats: Map<string, number>;

  constructor(config: CacheConfig) {
    this.cache = new Map();
    this.config = {
      ttl: config.ttl,
      maxSize: config.maxSize || 100000, // 100KB default for memory
      namespace: config.namespace || "memory-cache",
      strategy: config.strategy || "lru",
    };
    this.stats = new Map([
      ["hits", 0],
      ["misses", 0],
      ["size", 0],
    ]);
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.incrementStat("misses");
      return null;
    }

    if (this.isExpired(entry)) {
      this.delete(key);
      this.incrementStat("misses");
      return null;
    }

    this.updateAccessPattern(key, entry);
    this.incrementStat("hits");
    return entry.value;
  }

  set<T>(key: string, value: T, ttl?: number): boolean {
    const size = this.calculateSize(value);

    if (size > this.config.maxSize) {
      return false;
    }

    this.ensureSpace(size);

    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + (ttl || this.config.ttl),
      hitCount: 0,
      lastAccessed: Date.now(),
      size,
    };

    this.cache.set(key, entry);
    this.incrementStat("size", size);
    return true;
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.incrementStat("size", -entry.size);
      return true;
    }
    return false;
  }

  clear(): void {
    this.cache.clear();
    this.stats.set("size", 0);
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return entry.expiresAt <= Date.now();
  }

  private calculateSize(value: any): number {
    return Helpers.getObjectSize(value);
  }

  private ensureSpace(requiredSize: number): void {
    let currentSize = this.stats.get("size") || 0;

    while (
      currentSize + requiredSize > this.config.maxSize &&
      this.cache.size > 0
    ) {
      const keyToRemove = this.getKeyToEvict();
      if (!keyToRemove) break;

      const entry = this.cache.get(keyToRemove);
      if (entry) {
        this.delete(keyToRemove);
        currentSize = this.stats.get("size") || 0;
      }
    }
  }

  private getKeyToEvict(): string | null {
    if (this.cache.size === 0) return null;

    switch (this.config.strategy) {
      case "lru": {
        let oldestAccess = Date.now();
        let oldestKey = null;
        for (const [key, entry] of this.cache.entries()) {
          if (entry.lastAccessed < oldestAccess) {
            oldestAccess = entry.lastAccessed;
            oldestKey = key;
          }
        }
        return oldestKey;
      }
      case "mru": {
        let newestAccess = 0;
        let newestKey = null;
        for (const [key, entry] of this.cache.entries()) {
          if (entry.lastAccessed > newestAccess) {
            newestAccess = entry.lastAccessed;
            newestKey = key;
          }
        }
        return newestKey;
      }
      case "fifo": {
        return this.cache.keys().next().value || null;
      }
      case "lfu": {
        let lowestCount = Infinity;
        let lowestKey = null;
        for (const [key, entry] of this.cache.entries()) {
          if (entry.hitCount < lowestCount) {
            lowestCount = entry.hitCount;
            lowestKey = key;
          }
        }
        return lowestKey;
      }
      default:
        return this.cache.keys().next().value || null;
    }
  }

  private updateAccessPattern(key: string, entry: CacheEntry<any>): void {
    entry.hitCount++;
    entry.lastAccessed = Date.now();
    this.cache.set(key, entry);
  }

  private incrementStat(stat: string, value: number = 1): void {
    this.stats.set(stat, (this.stats.get(stat) || 0) + value);
  }

  getStats(): CacheStats {
    return {
      hits: this.stats.get("hits") || 0,
      misses: this.stats.get("misses") || 0,
      size: this.stats.get("size") || 0,
      itemCount: this.cache.size,
      avgAccessTime: this.stats.get("avgAccessTime") || 0,
    };
  }
}
