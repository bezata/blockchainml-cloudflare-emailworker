import { Helpers } from "../utils/helpers";
import { MetricAggregation, MetricsCollector } from "./metrics";
import { AlertManager, AlertSeverity } from "./alerts";
import { Alert } from "./alerts";
import { Metric } from "./metrics";
import { MongoDB } from "../config/mongodb";
import { Logger } from "../utils/logger";
import { Redis } from "@upstash/redis";
import { env } from "hono/adapter";

export interface HealthCheck {
  name: string;
  status: "healthy" | "unhealthy" | "degraded";
  details?: Record<string, unknown>;
  lastChecked: number;
  latency?: number;
}

export class HealthMonitor {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly HEALTH_KEY = "monitoring:health";

  private checks: Map<string, () => Promise<HealthCheck>> = new Map();

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
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
          details: { error: (error as Error).message },
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
        details: { error: (error as Error).message },
        lastChecked: Date.now(),
      };
    }
  }

  private async checkQueue(): Promise<HealthCheck> {
    // Implement queue health check
    return {
      name: "queue",
      status: "healthy",
      lastChecked: Date.now(),
    };
  }

  private async checkStorage(): Promise<HealthCheck> {
    // Implement storage health check
    return {
      name: "storage",
      status: "healthy",
      lastChecked: Date.now(),
    };
  }
}

// src/monitoring/dashboard.ts
export class MonitoringDashboard {
  private readonly metricsCollector: MetricsCollector;
  private readonly alertManager: AlertManager;
  private readonly healthMonitor: HealthMonitor;

  constructor() {
    this.metricsCollector = new MetricsCollector();
    this.alertManager = new AlertManager();
    this.healthMonitor = new HealthMonitor();
  }

  async getDashboardData(timeRange: {
    start: number;
    end: number;
  }): Promise<any> {
    const [metrics, alerts, health] = await Promise.all([
      this.metricsCollector.getMetrics(timeRange),
      this.getAlerts(timeRange),
      this.healthMonitor.runHealthChecks(),
    ]);

    return {
      metrics: this.aggregateMetrics(metrics),
      alerts: this.summarizeAlerts(alerts),
      health,
      timestamp: Date.now(),
    };
  }

  private aggregateMetrics(
    metrics: Metric[]
  ): Record<string, MetricAggregation> {
    return Helpers.groupBy(metrics, "name").reduce((acc, [name, values]) => {
      acc[name] = {
        min: Math.min(...values.map((v) => v.value)),
        max: Math.max(...values.map((v) => v.value)),
        avg: values.reduce((sum, v) => sum + v.value, 0) / values.length,
        sum: values.reduce((sum, v) => sum + v.value, 0),
        count: values.length,
      };
      return acc;
    }, {});
  }

  private summarizeAlerts(alerts: Alert[]): Record<AlertSeverity, number> {
    return alerts.reduce((acc, alert) => {
      acc[alert.severity] = (acc[alert.severity] || 0) + 1;
      return acc;
    }, {} as Record<AlertSeverity, number>);
  }
}
