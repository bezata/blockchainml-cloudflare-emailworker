import { Redis } from "@upstash/redis";
import { Logger } from "../utils/logger";
import { SearchOptimizer } from "../services/search/optimizer";

export interface TimeRange {
  start: Date;
  end: Date;
}

export enum AlertType {
  HIGH_MEMORY_USAGE = "HIGH_MEMORY_USAGE",
  HIGH_CPU_USAGE = "HIGH_CPU_USAGE",
  SLOW_QUERY = "SLOW_QUERY",
  INDEX_DEGRADATION = "INDEX_DEGRADATION",
  DATA_INCONSISTENCY = "DATA_INCONSISTENCY",
  OPTIMIZATION_FAILURE = "OPTIMIZATION_FAILURE",
  CONNECTION_ISSUES = "CONNECTION_ISSUES",
}

export enum AlertSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum AlertStatus {
  ACTIVE = "ACTIVE",
  RESOLVED = "RESOLVED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
}

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  details: Record<string, any>;
  timestamp: number; // Unix timestamp in milliseconds
  status: AlertStatus;
  acknowledged: boolean;
  acknowledgedBy: string | undefined;
  acknowledgedAt: number | undefined; // Unix timestamp in milliseconds
}

export interface IndexStats {
  totalTerms: number;
  totalDocuments: number;
  averageTermFrequency: number;
  termDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  storageUsage: {
    terms: number;
    metadata: number;
    total: number;
  };
  health: {
    status: "healthy" | "degraded" | "unhealthy";
    issues: string[];
  };
}

export interface StorageStats {
  isHealthy: boolean;
  totalSpace: number;
  usedSpace: number;
  availableSpace: number;
  utilizationPercent: number;
}

export class AlertManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly searchOptimizer: SearchOptimizer;

  constructor(redis: Redis, logger: Logger, searchOptimizer: SearchOptimizer) {
    this.redis = redis;
    this.logger = logger;
    this.searchOptimizer = searchOptimizer;
  }

  async getAlerts(timeRange: TimeRange): Promise<Alert[]> {
    try {
      const alerts: Alert[] = [];
      const pipeline = this.redis.pipeline();

      // Get alerts from Redis sorted set using time range
      const alertKeys = await this.redis.zrange(
        "search:alerts",
        timeRange.start.getTime(),
        timeRange.end.getTime(),
        { byScore: true }
      );

      // Fetch alert details in batch
      for (const key of alertKeys) {
        pipeline.hgetall(`search:alert:${key}`);
      }

      const alertDetails = await pipeline.exec();

      // Process and validate alert data
      alerts.push(
        ...alertDetails
          .filter((result): result is Record<string, string> => result !== null)
          .map((data) => this.parseAlertData(data))
          .filter((alert): alert is Alert => alert !== null)
      );

      // Get system health metrics
      const healthStats = await this.searchOptimizer.analyzeIndexHealth();
      const storageStats = await this.searchOptimizer.getStorageStats();

      // Generate alerts based on current system state
      await this.generateSystemAlerts(healthStats, storageStats);

      // Sort alerts by severity and timestamp
      return this.sortAlerts(alerts);
    } catch (error) {
      this.logger.error("Failed to retrieve alerts", { error, timeRange });
      throw error;
    }
  }

  private parseAlertData(data: Record<string, string>): Alert | null {
    try {
      if (!data.id || !data.type || !data.severity || !data.message) {
        return null;
      }

      return {
        id: data.id,
        type: data.type as AlertType,
        severity: data.severity as AlertSeverity,
        message: data.message,
        details: JSON.parse(data.details || "{}"),
        timestamp: parseInt(data.timestamp || "0"),
        status: (data.status as AlertStatus) || AlertStatus.ACTIVE,
        acknowledged: data.acknowledged === "true",
        acknowledgedBy: data.acknowledgedBy || undefined,
        acknowledgedAt: data.acknowledgedAt
          ? parseInt(data.acknowledgedAt)
          : undefined,
      };
    } catch (error) {
      this.logger.error("Failed to parse alert data", { error, data });
      return null;
    }
  }

  private async generateSystemAlerts(
    healthStats: IndexStats,
    storageStats: StorageStats
  ): Promise<void> {
    const now = Date.now();

    // Check storage usage
    if (!storageStats.isHealthy) {
      await this.createAlert({
        id: `storage_${now}`,
        type: AlertType.HIGH_MEMORY_USAGE,
        severity: AlertSeverity.HIGH,
        message: "High storage usage detected",
        details: {
          utilizationPercent: storageStats.utilizationPercent,
          availableSpace: storageStats.availableSpace,
        },
        timestamp: now,
        status: AlertStatus.ACTIVE,
        acknowledged: false,
        acknowledgedBy: undefined,
        acknowledgedAt: undefined,
      });
    }

    // Check index health
    if (healthStats.health.status !== "healthy") {
      await this.createAlert({
        id: `index_${now}`,
        type: AlertType.INDEX_DEGRADATION,
        severity:
          healthStats.health.status === "unhealthy"
            ? AlertSeverity.CRITICAL
            : AlertSeverity.MEDIUM,
        message: "Index health issues detected",
        details: {
          issues: healthStats.health.issues,
          termDistribution: healthStats.termDistribution,
          averageTermFrequency: healthStats.averageTermFrequency,
        },
        timestamp: now,
        status: AlertStatus.ACTIVE,
        acknowledged: false,
        acknowledgedBy: undefined,
        acknowledgedAt: undefined,
      });
    }

    // Check for data inconsistencies
    if (healthStats.totalTerms === 0 && healthStats.totalDocuments > 0) {
      await this.createAlert({
        id: `consistency_${now}`,
        type: AlertType.DATA_INCONSISTENCY,
        severity: AlertSeverity.HIGH,
        message: "Data inconsistency detected in search index",
        details: {
          totalTerms: healthStats.totalTerms,
          totalDocuments: healthStats.totalDocuments,
        },
        timestamp: now,
        status: AlertStatus.ACTIVE,
        acknowledged: false,
        acknowledgedBy: undefined,
        acknowledgedAt: undefined,
      });
    }
  }

  private sortAlerts(alerts: Alert[]): Alert[] {
    const severityWeight = {
      [AlertSeverity.CRITICAL]: 4,
      [AlertSeverity.HIGH]: 3,
      [AlertSeverity.MEDIUM]: 2,
      [AlertSeverity.LOW]: 1,
    };

    return alerts.sort((a, b) => {
      // Sort by severity
      const severityDiff =
        severityWeight[b.severity] - severityWeight[a.severity];
      if (severityDiff !== 0) return severityDiff;

      // Then sort by timestamp (newest first)
      return b.timestamp - a.timestamp;
    });
  }

  async createAlert(alert: Alert): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      const key = `search:alert:${alert.id}`;

      // Store alert data
      pipeline.hmset(key, {
        ...alert,
        details: JSON.stringify(alert.details),
        acknowledged: alert.acknowledged.toString(),
      });

      // Add to sorted set for time-based queries
      pipeline.zadd("search:alerts", {
        score: alert.timestamp,
        member: alert.id,
      });

      await pipeline.exec();

      this.logger.info("Alert created", {
        alertId: alert.id,
        type: alert.type,
      });
    } catch (error) {
      this.logger.error("Failed to create alert", { error, alert });
      throw error;
    }
  }

  async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    try {
      const key = `search:alert:${alertId}`;
      const exists = await this.redis.exists(key);

      if (!exists) {
        throw new Error(`Alert ${alertId} not found`);
      }

      const now = Date.now();
      await this.redis.hmset(key, {
        acknowledged: "true",
        acknowledgedBy: userId,
        acknowledgedAt: now.toString(),
        status: AlertStatus.ACKNOWLEDGED,
      });

      this.logger.info("Alert acknowledged", {
        alertId,
        userId,
        timestamp: now,
      });
    } catch (error) {
      this.logger.error("Failed to acknowledge alert", {
        error,
        alertId,
        userId,
      });
      throw error;
    }
  }
}
