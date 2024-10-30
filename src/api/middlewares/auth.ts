import { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { RedisCache } from "@/services/cache/redis";
import { StatusCode } from "hono/utils/http-status";

// Define environment variable bindings
export interface Bindings {
  JWT_SECRET: string;
  REDIS_URL: string;
  REDIS_TOKEN: string;
  NODE_ENV: string;
  API_VERSION: string;
  MONGODB_URI: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY: string;
  R2_SECRET_KEY: string;
  API_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  [key: string]: string;
}

interface JWTPayload {
  sub: string;
  email: string;
  role: string;
  exp: number;
}

export interface UserInfo {
  id: string;
  email: string;
  role: string;
}

// Extend Context type to include our custom properties
export type AuthContext = Context<{
  Bindings: Bindings;
  Variables: {
    user: UserInfo;
  };
}>;

class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const cache = new RedisCache({
  ttl: 3600, // 1 hour
  namespace: "auth",
  strategy: "lru",
});

export async function authMiddleware(c: AuthContext, next: Next) {
  try {
    // Validate JWT_SECRET configuration
    if (!c.env.JWT_SECRET) {
      throw new AuthError(500, "JWT_SECRET is not configured");
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new AuthError(401, "No valid token provided");
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      throw new AuthError(401, "Invalid token format");
    }

    // Check token blacklist/cache
    const cached = await cache.get(`token:${token}`);
    if (cached === "invalid") {
      throw new AuthError(401, "Token is invalidated");
    }

    try {
      // Verify and decode token
      const payload = (await verify(
        token,
        c.env.JWT_SECRET
      )) as unknown as JWTPayload;

      // Validate payload
      if (!payload.sub || !payload.email || !payload.role) {
        throw new AuthError(401, "Invalid token payload");
      }

      // Check expiration
      if (Date.now() >= payload.exp * 1000) {
        await cache.set(`token:${token}`, "invalid");
        throw new AuthError(401, "Token expired");
      }

      // Set user info in context
      c.set("user", {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      });

      return await next();
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      // Invalidate token on verification failure
      await cache.set(`token:${token}`, "invalid");
      throw new AuthError(401, "Invalid token", error);
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json(
        {
          error: error.message,
          details: error.details,
        },
        error.status as StatusCode
      );
    }

    console.error("Auth middleware error:", error);
    return c.json(
      {
        error: "Internal server error",
        code: "AUTH_ERROR",
      },
      500
    );
  }
}

// Role-based authorization middleware
export function authorizeRoles(allowedRoles: string[]) {
  return async function roleMiddleware(c: AuthContext, next: Next) {
    try {
      const user = c.get("user");

      if (!allowedRoles.includes(user.role)) {
        throw new AuthError(403, "Insufficient permissions");
      }

      return await next();
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json(
          {
            error: error.message,
            code: "AUTHORIZATION_ERROR",
          },
          error.status as StatusCode
        );
      }

      return c.json(
        {
          error: "Internal server error",
          code: "AUTH_ERROR",
        },
        500
      );
    }
  };
}

// Helper function to extract and verify token
export async function extractToken(c: AuthContext): Promise<string> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError(401, "No valid token provided");
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    throw new AuthError(401, "Invalid token format");
  }

  return token;
}

// Helper function to verify token and get payload
export async function verifyToken(
  token: string,
  jwtSecret: string
): Promise<JWTPayload> {
  try {
    const payload = (await verify(token, jwtSecret)) as unknown as JWTPayload;

    if (!payload.sub || !payload.email || !payload.role) {
      throw new AuthError(401, "Invalid token payload");
    }

    if (Date.now() >= payload.exp * 1000) {
      throw new AuthError(401, "Token expired");
    }

    return payload;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(401, "Invalid token", error);
  }
}
