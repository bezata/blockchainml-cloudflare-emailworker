import { Helpers } from "../utils/helpers";
import { MetricAggregation, MetricsCollector } from "./metrics";
import { AlertManager, AlertSeverity } from "./alerts";
import { Alert } from "./alerts";
import { Metric } from "./metrics";
import { MongoDB } from "../config/mongodb";
import { Logger } from "../utils/logger";
import { Redis } from "@upstash/redis";
import { SearchOptimizer } from "@/services/search/optimizer";

interface HealthCheck {
  name: string;
  status: "healthy" | "unhealthy" | "degraded";
  details?: Record<string, unknown>;
  lastChecked: number;
  latency?: number;
}

interface DashboardData {
  metrics: Record<string, MetricAggregation>;
  alerts: Record<AlertSeverity, number>;
  health: Record<string, HealthCheck>;
  timestamp: number;
}

interface TimeRange {
  start: number;
  end: number;
}

export class HealthMonitor {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly HEALTH_KEY = "monitoring:health";
  private checks: Map<string, () => Promise<HealthCheck>> = new Map();

  constructor() {
    if (
      !Bun.env.UPSTASH_REDIS_REST_URL ||
      !Bun.env.UPSTASH_REDIS_REST_TOKEN
    ) {
      throw new Error("Redis configuration is missing");
    }

    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");

    // Register default health checks
    this.registerDefaultChecks();
  }

  registerCheck(name: string, check: () => Promise<HealthCheck>): void {
    this.checks.set(name, check);
  }

  private registerDefaultChecks(): void {
    this.registerCheck("redis", this.checkRedis.bind(this));
    this.registerCheck("mongodb", this.checkMongoDB.bind(this));
    this.registerCheck("queue", this.checkQueue.bind(this));
    this.registerCheck("storage", this.checkStorage.bind(this));
  }

  async runHealthChecks(): Promise<Record<string, HealthCheck>> {
    const results: Record<string, HealthCheck> = {};

    for (const [name, check] of this.checks) {
      try {
        const start = Date.now();
        const result = await check();
        const latency = Date.now() - start;

        results[name] = {
          ...result,
          latency,
          lastChecked: Date.now(),
        };

        await this.redis.hset(this.HEALTH_KEY, {
          [name]: JSON.stringify(results[name]),
        });
      } catch (error) {
        this.logger.error(`Health check failed for ${name}:`, error);
        results[name] = {
          name,
          status: "unhealthy",
          details: {
            error: error instanceof Error ? error.message : "Unknown error",
          },
          lastChecked: Date.now(),
        };
      }
    }

    return results;
  }

  private async checkRedis(): Promise<HealthCheck> {
    const start = Date.now();
    await this.redis.ping();

    return {
      name: "redis",
      status: "healthy",
      details: {
        latency: Date.now() - start,
      },
      lastChecked: Date.now(),
    };
  }

  private async checkMongoDB(): Promise<HealthCheck> {
    try {
      const client = await MongoDB.getClient();
      await client.db().admin().ping();

      return {
        name: "mongodb",
        status: "healthy",
        lastChecked: Date.now(),
      };
    } catch (error) {
      return {
        name: "mongodb",
        status: "unhealthy",
        details: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        lastChecked: Date.now(),
      };
    }
  }

  private async checkQueue(): Promise<HealthCheck> {
    try {
      const queueStats = await this.getQueueStats();
      return {
        name: "queue",
        status: queueStats.isHealthy ? "healthy" : "degraded",
        details: queueStats,
        lastChecked: Date.now(),
      };
    } catch (error) {
      return {
        name: "queue",
        status: "unhealthy",
        details: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        lastChecked: Date.now(),
      };
    }
  }

  private async checkStorage(): Promise<HealthCheck> {
    try {
      const storageStats = await this.getStorageStats();
      return {
        name: "storage",
        status: storageStats.isHealthy ? "healthy" : "degraded",
        details: storageStats,
        lastChecked: Date.now(),
      };
    } catch (error) {
      return {
        name: "storage",
        status: "unhealthy",
        details: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        lastChecked: Date.now(),
      };
    }
  }

  private async getQueueStats(): Promise<{
    isHealthy: boolean;
    [key: string]: any;
  }> {
    // Implement queue statistics collection
    return {
      isHealthy: true,
      pendingJobs: 0,
      processingJobs: 0,
      failedJobs: 0,
    };
  }

  private async getStorageStats(): Promise<{
    isHealthy: boolean;
    [key: string]: any;
  }> {
    try {
      // Get database size using DBSIZE command
      const dbSize = await this.redis.dbsize();

      // Sample a few keys to estimate average memory usage
      const sampleSize = Math.min(100, dbSize);
      let totalSampleSize = 0;
      let sampledKeys = 0;

      if (sampleSize > 0) {
        let cursor = 0;
        do {
          const [nextCursor, keys] = await this.redis.scan(cursor, {
            count: Math.min(10, sampleSize - sampledKeys),
          });

          cursor = parseInt(nextCursor as string);

          for (const key of keys) {
            try {
              // Get key size using STRLEN for strings or serialized size for other types
              const type = await this.redis.type(key);
              let size = 0;

              switch (type) {
                case "string": {
                  const value = (await this.redis.get(key)) as string | null;
                  size = (value?.length || 0) + key.length;
                  break;
                }
                case "hash": {
                  const value = await this.redis.hgetall(key);
                  size = key.length + JSON.stringify(value).length;
                  break;
                }
                case "zset": {
                  const value = await this.redis.zrange(key, 0, -1, {
                    withScores: true,
                  });
                  size = key.length + JSON.stringify(value).length;
                  break;
                }
                case "set": {
                  const value = await this.redis.smembers(key);
                  size = key.length + JSON.stringify(value).length;
                  break;
                }
                case "list": {
                  const value = await this.redis.lrange(key, 0, -1);
                  size = key.length + JSON.stringify(value).length;
                  break;
                }
              }

              totalSampleSize += size;
              sampledKeys++;
            } catch (error) {
              this.logger.warn(`Failed to get size for key: ${key}`, error);
            }
          }
        } while (cursor !== 0 && sampledKeys < sampleSize);
      }

      // Estimate total usage based on sample
      const averageKeySize =
        sampledKeys > 0 ? totalSampleSize / sampledKeys : 0;
      const estimatedTotalSize = dbSize * averageKeySize;

      // Assume healthy if less than 90% of estimated available memory (100MB as example limit)
      const assumedMaxMemory = 100 * 1024 * 1024; // 100MB
      const isHealthy = estimatedTotalSize < assumedMaxMemory * 0.9;

      return {
        isHealthy,
        totalSpace: assumedMaxMemory,
        usedSpace: Math.round(estimatedTotalSize),
        availableSpace: Math.round(assumedMaxMemory - estimatedTotalSize),
        utilizationPercent: Math.round(
          (estimatedTotalSize / assumedMaxMemory) * 100
        ),
        totalKeys: dbSize,
        sampledKeys,
        averageKeySize: Math.round(averageKeySize),
        estimationType: "sampling-based",
      };
    } catch (error) {
      this.logger.error("Failed to get storage stats", { error });
      return {
        isHealthy: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

export class MonitoringDashboard {
  private readonly metricsCollector: MetricsCollector;
  private readonly alertManager: AlertManager;
  private readonly healthMonitor: HealthMonitor;
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly searchOptimizer: SearchOptimizer;

  constructor() {
    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.metricsCollector = new MetricsCollector();
    this.searchOptimizer = new SearchOptimizer();
    this.alertManager = new AlertManager(
      this.redis,
      this.logger,
      this.searchOptimizer
    );
    this.healthMonitor = new HealthMonitor();
  }

  async getDashboardData(timeRange: TimeRange): Promise<DashboardData> {
    try {
      const [metrics, alerts, health] = await Promise.all([
        this.metricsCollector.getMetrics(timeRange),
        this.alertManager.getAlerts({
          start: new Date(timeRange.start),
          end: new Date(timeRange.end),
        }),
        this.healthMonitor.runHealthChecks(),
      ]);

      return {
        metrics: this.aggregateMetrics(metrics),
        alerts: this.summarizeAlerts(alerts),
        health,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new Error(
        `Failed to get dashboard data: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  private aggregateMetrics(
    metrics: Metric[]
  ): Record<string, MetricAggregation> {
    const grouped = Helpers.groupBy(metrics, "name");
    const result: Record<string, MetricAggregation> = {};

    for (const [name, values] of Object.entries(grouped)) {
      const metricValues = values.map((v) => v.value);
      result[name] = {
        min: Math.min(...metricValues),
        max: Math.max(...metricValues),
        avg: metricValues.reduce((sum, v) => sum + v, 0) / metricValues.length,
        sum: metricValues.reduce((sum, v) => sum + v, 0),
        count: values.length,
      };
    }

    return result;
  }

  private summarizeAlerts(alerts: Alert[]): Record<AlertSeverity, number> {
    const summary: Record<AlertSeverity, number> = {
      [AlertSeverity.LOW]: 0,
      [AlertSeverity.MEDIUM]: 0,
      [AlertSeverity.HIGH]: 0,
      [AlertSeverity.CRITICAL]: 0,
    };

    for (const alert of alerts) {
      summary[alert.severity]++;
    }

    return summary;
  }
}
