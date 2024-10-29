export interface CacheConfig {
  ttl: number;
  maxSize?: number;
  namespace?: string;
  strategy?: CacheStrategy;
}

export type CacheStrategy = "lru" | "mru" | "fifo" | "lfu";

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  hitCount: number;
  lastAccessed: number;
  size: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  itemCount: number;
  avgAccessTime: number;
}
