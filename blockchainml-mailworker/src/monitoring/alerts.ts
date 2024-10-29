import { Redis } from "@upstash/redis";
import { Logger } from "../utils/logger";
import { MetricsCollector } from "./metrics";
import { Helpers } from "../utils/helpers";
import { QueueManager } from "@/queue/manager";
import { TaskType } from "@/api/routes";
import { env } from "@/config/env";

export enum AlertSeverity {
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
}

export interface AlertRule {
  id: string;
  name: string;
  metricName: string;
  condition: {
    operator: ">" | "<" | ">=" | "<=" | "==" | "!=";
    threshold: number;
  };
  duration: number; // Time window in milliseconds
  severity: AlertSeverity;
  channels: string[];
  enabled: boolean;
}

export interface Alert {
  id: string;
  ruleId: string;
  message: string;
  severity: AlertSeverity;
  metricValue: number;
  timestamp: number;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

export class AlertManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly queueManager: QueueManager;
  private readonly RULES_KEY = "monitoring:alert:rules";
  private readonly ALERTS_KEY = "monitoring:alerts";
  private readonly metricsCollector: MetricsCollector;

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.queueManager = new QueueManager();
    this.metricsCollector = new MetricsCollector();
  }

  async createRule(rule: Omit<AlertRule, "id">): Promise<string> {
    const id = Helpers.generateId();
    const fullRule: AlertRule = {
      ...rule,
      id,
      enabled: true,
    };

    await this.redis.hset(this.RULES_KEY, {
      [id]: JSON.stringify(fullRule),
    });

    return id;
  }

  async evaluateRules(): Promise<void> {
    const rules = await this.getEnabledRules();
    const now = Date.now();

    for (const rule of rules) {
      const metrics = await this.metricsCollector.getMetrics(
        {
          start: now - rule.duration,
          end: now,
        },
        { name: rule.metricName }
      );

      if (metrics.length === 0) continue;

      const latestValue = metrics[metrics.length - 1].value;
      if (this.evaluateCondition(latestValue, rule.condition)) {
        await this.createAlert({
          ruleId: rule.id,
          message: `Alert: ${rule.name} - Threshold ${rule.condition.operator} ${rule.condition.threshold} violated. Current value: ${latestValue}`,
          severity: rule.severity,
          metricValue: latestValue,
        });
      }
    }
  }

  private async getEnabledRules(): Promise<AlertRule[]> {
    const rules = await this.redis.hgetall(this.RULES_KEY);
    return Object.values(rules)
      .map((r) => JSON.parse(r))
      .filter((r) => r.enabled);
  }

  private evaluateCondition(
    value: number,
    condition: AlertRule["condition"]
  ): boolean {
    switch (condition.operator) {
      case ">":
        return value > condition.threshold;
      case "<":
        return value < condition.threshold;
      case ">=":
        return value >= condition.threshold;
      case "<=":
        return value <= condition.threshold;
      case "==":
        return value === condition.threshold;
      case "!=":
        return value !== condition.threshold;
      default:
        return false;
    }
  }

  private async createAlert(
    alert: Omit<Alert, "id" | "timestamp" | "acknowledged">
  ): Promise<void> {
    const fullAlert: Alert = {
      ...alert,
      id: Helpers.generateId(),
      timestamp: Date.now(),
      acknowledged: false,
    };

    await this.redis.zadd(this.ALERTS_KEY, {
      score: fullAlert.timestamp,
      member: JSON.stringify(fullAlert),
    });

    await this.notifyAlertChannels(fullAlert);
  }

  private async notifyAlertChannels(alert: Alert): Promise<void> {
    const rule = JSON.parse(
      await this.redis.hget(this.RULES_KEY, alert.ruleId)
    ) as AlertRule;

    for (const channel of rule.channels) {
      try {
        await this.sendAlertNotification(channel, alert);
      } catch (error) {
        this.logger.error(`Failed to send alert to channel ${channel}:`, error);
      }
    }
  }

  private async sendAlertNotification(
    channel: string,
    alert: Alert
  ): Promise<void> {
    // Implement different notification channels (email, Slack, etc.)
    switch (channel) {
      case "email":
        await this.queueManager.enqueueTask(TaskType.SEND_EMAIL, {
          to: alert.acknowledgedBy || "admin@example.com",
          subject: `Alert: ${alert.severity.toUpperCase()} - ${alert.message}`,
          body: `
            Alert Details:
            Severity: ${alert.severity}
            Message: ${alert.message}
            Metric Value: ${alert.metricValue}
            Time: ${new Date(alert.timestamp).toLocaleString()}
          `,
        });
        break;
      case "slack":
        // Implement Slack webhook integration
        const webhookUrl = process.env.SLACK_WEBHOOK_URL;
        if (!webhookUrl) {
          this.logger.error("Slack webhook URL not configured");
          return;
        }

        await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: `🚨 *${alert.severity.toUpperCase()}* Alert\n${
              alert.message
            }\nMetric Value: ${alert.metricValue}`,
          }),
        });
        break;
      default:
        this.logger.warn(`Unknown alert channel: ${channel}`);
    }
  }
}
