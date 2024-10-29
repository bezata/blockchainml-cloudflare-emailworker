export interface BaseRepository<T> {
  findById(id: string): Promise<T | null>;
  findMany(
    query: Record<string, any>,
    options: {
      page: number;
      limit: number;
      sort?: Record<string, 1 | -1>;
    }
  ): Promise<T[]>;
  getCount(query?: Record<string, any>): Promise<number>;
  create(data: Omit<T, "_id">): Promise<T>;
  update(id: string, update: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
}
