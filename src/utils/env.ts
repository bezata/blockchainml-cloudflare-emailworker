import { env } from "@/types/env";
import { Logger } from "./logger";

const logger = Logger.getInstance("development");

export function checkEnvVar(key: keyof env["Bindings"], env: any): boolean {
  const value = env[key];
  if (!value) {
    console.log(`❌ Missing: ${key}`);
    return false;
  }
  console.log(
    `✅ Found: ${key} = ${typeof value === "string" ? value.slice(0, 4) : "[Object]"}...`
  );
  return true;
}

export function getEnvVar(key: keyof env["Bindings"], env: any): string {
  const value = env[key];

  if (!value) {
    const error = `Missing required environment variable: ${key}`;
    logger.error(error);
    throw new Error(error);
  }

  return value;
}

export function validateEnvVars(env: any) {
  console.log("\n🔍 Checking environment variables:");
  console.log("Available env keys:", Object.keys(env));

  const requiredVars = [
    "MONGODB_URI",
    "JWT_SECRET",
    "API_KEY",
    "ENVIRONMENT",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "R2_BUCKET",
    "R2_ACCESS_KEY",
    "R2_SECRET_KEY",
    "EMAIL_DOMAIN",
    "DEFAULT_FROM_EMAIL",
  ] as const;

  const missingVars = requiredVars.filter((key) => {
    return !checkEnvVar(key, env);
  });

  console.log("\n📊 Summary:");
  console.log(`Total required: ${requiredVars.length}`);
  console.log(`Missing: ${missingVars.length}`);
  console.log(`Found: ${requiredVars.length - missingVars.length}`);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`
    );
  }
}
