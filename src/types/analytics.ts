export interface TimeRange {
  start: Date;
  end: Date;
}

export interface AnalyticsTaskPayload {
  timeRange: TimeRange;
  metrics: MetricType[];
  filters?: AnalyticsFilters;
  options?: AnalyticsOptions;
  startDate: Date;
  endDate: Date;
}

export type MetricType =
  | "emailStats"
  | "userActivity"
  | "threadStats"
  | "attachmentStats"
  | "searchStats"
  | "systemStats";

export interface AnalyticsFilters {
  users?: string[];
  categories?: string[];
  labels?: string[];
  status?: string[];
}

export interface AnalyticsOptions {
  aggregation?: "hour" | "day" | "week" | "month";
  includeMetadata?: boolean;
  format?: "json" | "csv";
}

export interface MetricResult {
  total: number;
  data: any[];
  summary?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface AnalyticsStats {
  emailStats?: MetricResult;
  userActivity?: MetricResult;
  threadStats?: MetricResult;
  attachmentStats?: MetricResult;
  searchStats?: MetricResult;
  systemStats?: MetricResult;
}
