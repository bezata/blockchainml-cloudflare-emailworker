import { Redis } from "@upstash/redis";
import { Logger } from "../utils/logger";
import { env } from "hono/adapter";

export interface Metric {
  name: string;
  value: number;
  tags: Record<string, string>;
  timestamp: number;
}

export interface MetricAggregation {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
}

export class MetricsCollector {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly METRICS_KEY = "monitoring:metrics";
  private readonly AGGREGATIONS_KEY = "monitoring:aggregations";

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
  }

  async recordMetric(metric: Omit<Metric, "timestamp">): Promise<void> {
    const fullMetric: Metric = {
      ...metric,
      timestamp: Date.now(),
    };

    try {
      await this.redis.zadd(this.METRICS_KEY, {
        score: fullMetric.timestamp,
        member: JSON.stringify(fullMetric),
      });
      await this.updateAggregations(fullMetric);
      this.logger.info("Metric recorded successfully", { metric: fullMetric });
    } catch (error) {
      this.logger.error("Failed to record metric", {
        metric: fullMetric,
        error,
      });
      throw error;
    }
  }

  private async updateAggregations(metric: Metric): Promise<void> {
    try {
      const key = `${this.AGGREGATIONS_KEY}:${metric.name}`;
      const aggregation = ((await this.redis.hgetall(
        key
      )) as unknown as MetricAggregation) || {
        min: metric.value,
        max: metric.value,
        avg: metric.value,
        sum: metric.value,
        count: 1,
      };

      await this.redis.hset(key, {
        min: Math.min(aggregation.min, metric.value),
        max: Math.max(aggregation.max, metric.value),
        sum: aggregation.sum + metric.value,
        count: aggregation.count + 1,
        avg: (aggregation.sum + metric.value) / (aggregation.count + 1),
      });
      this.logger.debug("Updated metric aggregations", {
        metricName: metric.name,
      });
    } catch (error) {
      this.logger.error("Failed to update aggregations", {
        metricName: metric.name,
        error,
      });
      throw error;
    }
  }

  async getMetrics(
    timeRange: { start: number; end: number },
    filter?: { name?: string; tags?: Record<string, string> }
  ): Promise<Metric[]> {
    try {
      const metrics = await this.redis.zrange<string[]>(
        this.METRICS_KEY,
        timeRange.start,
        timeRange.end
      );
      this.logger.info("Retrieved metrics", {
        timeRange,
        filter,
        count: metrics.length,
      });

      return metrics
        .map((m) => JSON.parse(m))
        .filter((m) => {
          if (filter?.name && m.name !== filter.name) return false;
          if (filter?.tags) {
            return Object.entries(filter.tags).every(
              ([key, value]) => m.tags[key] === value
            );
          }
          return true;
        });
    } catch (error) {
      this.logger.error("Failed to retrieve metrics", {
        timeRange,
        filter,
        error,
      });
      throw error;
    }
  }
}
