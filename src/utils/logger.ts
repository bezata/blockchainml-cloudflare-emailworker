type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
}

export class Logger {
  private static instance: Logger;
  private env: string;

  private constructor(env: string) {
    this.env = env;
  }

  public static getInstance(env: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(env);
    }
    return Logger.instance;
  }

  private formatLog(level: LogLevel, message: string, data?: any): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };
  }

  private log(entry: LogEntry): void {
    const logString = JSON.stringify(entry);
    console.log(logString);
  }

  public debug(message: string, data?: any): void {
    if (this.env === "development") {
      this.log(this.formatLog("debug", message, data));
    }
  }

  public info(message: string, data?: any): void {
    this.log(this.formatLog("info", message, data));
  }

  public warn(message: string, data?: any): void {
    this.log(this.formatLog("warn", message, data));
  }

  public error(message: string, error?: Error | any): void {
    this.log(
      this.formatLog("error", message, {
        error: error?.message || error,
        stack: error?.stack,
      })
    );
  }
}
