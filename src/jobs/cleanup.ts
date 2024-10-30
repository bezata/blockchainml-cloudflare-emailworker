import { Logger } from "../utils/logger";
import { Redis } from "@upstash/redis";
import { MongoDB } from "../config/mongodb";
import { env } from "process";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

interface CleanupStats {
  path: string;
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
  errors: string[];
}

interface CleanupResult {
  success: boolean;
  stats: CleanupStats[];
  duration: number;
}

interface CleanupOptions {
  path: string;
  olderThan?: Date;
  pattern?: string;
  dryRun?: boolean;
  maxBatchSize?: number;
}

export default async function cleanup(
  options: CleanupOptions
): Promise<CleanupResult> {
  const logger = Logger.getInstance("production");
  const startTime = Date.now();
  const stats: CleanupStats[] = [];

  try {
    logger.info("Starting cleanup operation", {
      path: options.path,
      olderThan: options.olderThan?.toISOString(),
      pattern: options.pattern,
      dryRun: options.dryRun,
    });

    // Validate input
    validateInput(options);

    // Process cleanup based on path type
    const pathStats = await processCleanup(options);
    stats.push(pathStats);

    const duration = Date.now() - startTime;
    const success = pathStats.failed === 0;

    logger.info("Cleanup operation completed", {
      duration,
      success,
      stats,
    });

    return {
      success,
      stats,
      duration,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    logger.error("Cleanup operation failed", { error: errorMessage });
    throw error;
  }
}

function validateInput(options: CleanupOptions): void {
  if (!options.path) {
    throw new Error("Path is required");
  }

  if (options.olderThan && isNaN(options.olderThan.getTime())) {
    throw new Error("Invalid olderThan date");
  }
}

async function processCleanup(options: CleanupOptions): Promise<CleanupStats> {
  const stats: CleanupStats = {
    path: options.path,
    scanned: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    if (options.path.startsWith("storage://")) {
      await cleanupStorage(stats, options);
    } else if (options.path.startsWith("db://")) {
      await cleanupDatabase(stats, options);
    } else if (options.path.startsWith("cache://")) {
      await cleanupCache(stats, options);
    } else {
      throw new Error(`Unsupported path: ${options.path}`);
    }

    return stats;
  } catch (error) {
    if (error instanceof Error) {
      stats.errors.push(error.message);
      stats.failed++;
    } else {
      stats.errors.push("Unknown error occurred");
      stats.failed++;
    }
    return stats;
  }
}

async function cleanupStorage(
  stats: CleanupStats,
  options: CleanupOptions
): Promise<void> {
  const path = options.path.replace("storage://", "");
  const bucketName = env.ATTACHMENT_BUCKET;

  if (!bucketName) {
    throw new Error("ATTACHMENT_BUCKET is not configured");
  }

  const s3 = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: "your-access-key-id",
      secretAccessKey: "your-secret-access-key",
    },
  });

  const objects = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: path,
      Delimiter: "/",
    })
  );

  for (const object of objects.Contents ?? []) {
    stats.scanned++;

    try {
      const shouldDelete = await shouldCleanupObject(object, options);

      if (shouldDelete) {
        if (!options.dryRun) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: object.Key,
            })
          );
          stats.deleted++;
        }
      } else {
        stats.skipped++;
      }
    } catch (error) {
      if (error instanceof Error) {
        stats.errors.push(`Failed to process ${object.Key}: ${error.message}`);
      }
      stats.failed++;
    }
  }
}

async function cleanupDatabase(
  stats: CleanupStats,
  options: CleanupOptions
): Promise<void> {
  const path = options.path.replace("db://", "");
  const [collection] = path.split("/");

  const mongodb = MongoDB.getClient();
  const db = mongodb.db();

  const query: Record<string, any> = {};
  if (options.olderThan) {
    query.createdAt = { $lt: options.olderThan };
  }
  if (options.pattern) {
    query.$or = [
      { name: { $regex: options.pattern } },
      { path: { $regex: options.pattern } },
    ];
  }

  const cursor = db.collection(collection as string).find(query);

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    stats.scanned++;

    try {
      if (!options.dryRun) {
        await db.collection(collection as string).deleteOne({ _id: doc._id });
        stats.deleted++;
      }
    } catch (error) {
      if (error instanceof Error) {
        stats.errors.push(
          `Failed to delete document ${doc._id}: ${error.message}`
        );
      }
      stats.failed++;
    }
  }
}

async function cleanupCache(
  stats: CleanupStats,
  options: CleanupOptions
): Promise<void> {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const path = options.path.replace("cache://", "");
  let cursor = 0;
  const pattern = path + (options.pattern || "*");

  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: pattern,
      count: 100,
    });

    cursor = parseInt(nextCursor.toString());

    for (const key of keys) {
      stats.scanned++;

      try {
        const ttl = await redis.ttl(key);
        if (
          ttl === -1 ||
          (options.olderThan &&
            (await isKeyOlderThan(redis, key, options.olderThan)))
        ) {
          if (!options.dryRun) {
            await redis.del(key);
            stats.deleted++;
          }
        } else {
          stats.skipped++;
        }
      } catch (error) {
        if (error instanceof Error) {
          stats.errors.push(`Failed to process key ${key}: ${error.message}`);
        }
        stats.failed++;
      }
    }
  } while (cursor !== 0);
}

async function shouldCleanupObject(
  object: { Key?: string; LastModified?: Date },
  options: CleanupOptions
): Promise<boolean> {
  if (!object.LastModified) return false;

  if (options.olderThan && object.LastModified < options.olderThan) {
    if (options.pattern) {
      return new RegExp(options.pattern).test(object.Key || "");
    }
    return true;
  }

  return false;
}

async function isKeyOlderThan(
  redis: Redis,
  key: string,
  date: Date
): Promise<boolean> {
  const metadata = await redis.hget(key, "timestamp");
  if (!metadata) return true;

  try {
    const timestamp = new Date(metadata as string);
    return timestamp < date;
  } catch {
    return true;
  }
}
