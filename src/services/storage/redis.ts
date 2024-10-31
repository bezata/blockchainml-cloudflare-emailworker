import { Redis } from "@upstash/redis";
import { Logger } from "@/utils/logger";
import { getRedisConfig, RedisConfig } from "@/config/redis.config";

let redisInstance: Redis | null = null;
const logger = Logger.getInstance("redis");

export function getRedisInstance(): Redis {
  if (!redisInstance) {
    try {
      const config = getRedisConfig();
      redisInstance = createRedisInstance(config);
      logger.info("Redis instance successfully initialized");
    } catch (error) {
      logger.error("Failed to initialize Redis:", error);
      throw error;
    }
  }
  return redisInstance;
}

function createRedisInstance(config: RedisConfig): Redis {
  try {
    return new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
      retry: {
        retries: config.maxRetries,
        backoff: (retryCount: number) => {
          const delay = Math.min(
            config.retryBackoff * Math.pow(2, retryCount),
            config.retryBackoff * 10
          );
          return delay;
        },
      },
    });
  } catch (error) {
    logger.error("Failed to create Redis instance:", error);
    throw error;
  }
}

// Add a health check method
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const redis = getRedisInstance();
    await redis.ping();
    return true;
  } catch (error) {
    logger.error("Redis health check failed:", error);
    return false;
  }
}
