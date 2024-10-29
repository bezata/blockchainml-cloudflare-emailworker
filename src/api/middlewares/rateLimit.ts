import { Context, Next } from "hono";

const WINDOW_SIZE = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100;

interface RateLimitInfo {
  count: number;
  timestamp: number;
}

export async function rateLimitMiddleware(c: Context, next: Next) {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const key = `ratelimit:${ip}`;

  const info = (await c.env.KV.get(key)) as RateLimitInfo | null;
  const now = Date.now();

  if (info) {
    if (now - info.timestamp < WINDOW_SIZE) {
      if (info.count >= MAX_REQUESTS) {
        return c.json(
          {
            error: "Too many requests",
            retryAfter: WINDOW_SIZE - (now - info.timestamp),
          },
          429
        );
      }
      await c.env.KV.put(key, {
        count: info.count + 1,
        timestamp: info.timestamp,
      });
    } else {
      await c.env.KV.put(key, { count: 1, timestamp: now });
    }
  } else {
    await c.env.KV.put(key, { count: 1, timestamp: now });
  }

  return next();
}
