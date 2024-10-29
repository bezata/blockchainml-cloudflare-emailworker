import { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { RedisCache } from "@/services/cache/redis";

interface JWTPayload {
  sub: string;
  email: string;
  role: string;
  exp: number;
}

const cache = new RedisCache({
  ttl: 3600, // 1 hour
  namespace: "auth",
  strategy: "lru",
});

export async function authMiddleware(c: Context, next: Next) {
  try {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized - No token provided" }, 401);
    }

    const token = authHeader.split(" ")[1];

    // Check cache first
    const cached = await cache.get(`token:${token}`);
    if (cached === "invalid") {
      return c.json({ error: "Unauthorized - Invalid token" }, 401);
    }

    try {
      if (!c.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not configured");
      }
      const payload = (await verify(token, c.env.JWT_SECRET!)) as JWTPayload;

      // Check expiration
      if (Date.now() >= payload.exp * 1000) {
        await cache.set(`token:${token}`, "invalid");
        return c.json({ error: "Unauthorized - Token expired" }, 401);
      }

      // Add user info to context
      c.set("user", {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      });

      await next();
      return;
    } catch (error) {
      await cache.set(`token:${token}`, "invalid");
      return c.json({ error: "Unauthorized - Invalid token" }, 401);
    }
  } catch (error) {
    return c.json({ error: "Internal server error" }, 500);
  }
}
