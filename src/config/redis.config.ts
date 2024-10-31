export interface RedisConfig {
  url: string;
  token: string;
  maxRetries: number;
  retryBackoff: number;
}

export const getRedisConfig = (): RedisConfig => {
  const url = Bun.env.UPSTASH_REDIS_REST_URL;
  const token = Bun.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Redis configuration missing. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables."
    );
  }

  return {
    url,
    token,
    maxRetries: 3,
    retryBackoff: 100,
  };
};
