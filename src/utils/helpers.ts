// src/utils/helpers.ts
import { customAlphabet } from "nanoid";
import { format } from "date-fns";

export class Helpers {
  /**
   * Sleep for a specified duration
   * @param ms Time to sleep in milliseconds
   * @returns Promise that resolves after the specified duration
   */
  static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sleep with exponential backoff
   * @param attempt Current attempt number
   * @param baseMs Base time in milliseconds
   * @param maxMs Maximum time in milliseconds
   */
  static async sleepWithBackoff(
    attempt: number,
    baseMs: number = 1000,
    maxMs: number = 30000
  ): Promise<void> {
    const delay = Math.min(Math.pow(2, attempt) * baseMs, maxMs);
    await this.sleep(delay);
  }

  /**
   * Generate a unique ID with custom alphabet
   * @param length Length of the ID
   * @param alphabet Custom alphabet to use
   */
  static generateId(
    length: number = 21,
    alphabet: string = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  ): string {
    const nanoid = customAlphabet(alphabet, length);
    return nanoid();
  }

  /**
   * Format a date using a specified format
   * @param date Date to format
   * @param formatStr Format string
   */
  static formatDate(
    date: Date | number,
    formatStr: string = "yyyy-MM-dd HH:mm:ss"
  ): string {
    return format(date, formatStr);
  }

  /**
   * Retry a function with exponential backoff
   * @param fn Function to retry
   * @param maxAttempts Maximum number of attempts
   * @param baseDelay Base delay in milliseconds
   */
  static async retry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts - 1) {
          await this.sleepWithBackoff(attempt, baseDelay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Chunk an array into smaller arrays
   * @param array Array to chunk
   * @param size Size of each chunk
   */
  static chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Deep clone an object
   * @param obj Object to clone
   */
  static deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime()) as any;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepClone(item)) as any;
    }

    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, this.deepClone(value)])
    ) as T;
  }

  /**
   * Safely parse JSON with error handling
   * @param json JSON string to parse
   * @param defaultValue Default value if parsing fails
   */
  static safeJSONParse<T>(json: string, defaultValue: T): T {
    try {
      return JSON.parse(json);
    } catch {
      return defaultValue;
    }
  }

  /**
   * Format bytes to human readable string
   * @param bytes Number of bytes
   * @param decimals Number of decimal places
   */
  static formatBytes(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  /**
   * Truncate a string to a specified length
   * @param str String to truncate
   * @param length Maximum length
   * @param suffix Suffix to add when truncated
   */
  static truncate(str: string, length: number, suffix: string = "..."): string {
    if (str.length <= length) return str;
    return str.substring(0, length - suffix.length) + suffix;
  }

  /**
   * Debounce a function
   * @param fn Function to debounce
   * @param ms Debounce delay in milliseconds
   */
  static debounce<T extends (...args: any[]) => any>(
    fn: T,
    ms: number
  ): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout>;

    return function (this: any, ...args: Parameters<T>) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /**
   * Throttle a function
   * @param fn Function to throttle
   * @param ms Throttle interval in milliseconds
   */
  static throttle<T extends (...args: any[]) => any>(
    fn: T,
    ms: number
  ): (...args: Parameters<T>) => void {
    let lastCall = 0;

    return function (this: any, ...args: Parameters<T>) {
      const now = Date.now();

      if (now - lastCall >= ms) {
        fn.apply(this, args);
        lastCall = now;
      }
    };
  }

  /**
   * Check if a value is empty (null, undefined, empty string, empty array, empty object)
   * @param value Value to check
   */
  static isEmpty(value: any): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }

  /**
   * Generate a random string
   * @param length Length of the string
   * @param type Type of characters to include
   */
  static randomString(
    length: number = 16,
    type: "alphanumeric" | "numeric" | "alphabetic" = "alphanumeric"
  ): string {
    const chars = {
      alphanumeric:
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      numeric: "0123456789",
      alphabetic: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    };

    const charset = chars[type];
    let result = "";

    for (let i = 0; i < length; i++) {
      result += charset[Math.floor(Math.random() * charset.length)];
    }

    return result;
  }

  /**
   * Memoize a function
   * @param fn Function to memoize
   */
  static memoize<T extends (...args: any[]) => any>(
    fn: T
  ): (...args: Parameters<T>) => ReturnType<T> {
    const cache = new Map();

    return (...args: Parameters<T>): ReturnType<T> => {
      const key = JSON.stringify(args);

      if (cache.has(key)) {
        return cache.get(key);
      }

      const result = fn(...args);
      cache.set(key, result);
      return result;
    };
  }

  /**
   * Group an array of objects by a key
   * @param array Array to group
   * @param key Key to group by
   */
  static groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
    return array.reduce((groups, item) => {
      const group = item[key]?.toString() ?? "";
      groups[group] = groups[group] ?? [];
      groups[group].push(item);
      return groups;
    }, {} as Record<string, T[]>);
  }

  /**
   * Pick specified properties from an object
   * @param obj Source object
   * @param keys Keys to pick
   */
  static pick<T extends object, K extends keyof T>(
    obj: T,
    keys: K[]
  ): Pick<T, K> {
    return keys.reduce((result, key) => {
      if (obj.hasOwnProperty(key)) {
        result[key] = obj[key];
      }
      return result;
    }, {} as Pick<T, K>);
  }

  /**
   * Omit specified properties from an object
   * @param obj Source object
   * @param keys Keys to omit
   */
  static omit<T extends object, K extends keyof T>(
    obj: T,
    keys: K[]
  ): Omit<T, K> {
    const result = { ...obj };
    keys.forEach((key) => delete result[key]);
    return result;
  }
}
