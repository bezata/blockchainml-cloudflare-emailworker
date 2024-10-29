export interface Env {
  MONGODB_URI: string;
  JWT_SECRET: string;
  EMAIL_QUEUE: Queue;
  API_KEY: string;
  ENVIRONMENT: "development" | "production";
}
