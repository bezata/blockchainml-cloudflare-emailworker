export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    pagination?: PaginationMeta;
    [key: string]: any;
  };
}

export interface SortParams {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

// Base error class for API errors
export class ApiError extends Error {
  constructor(
    public override message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Utility types
export type Required<T> = {
  [P in keyof T]-?: T[P];
};

export type Optional<T> = {
  [P in keyof T]+?: T[P];
};
