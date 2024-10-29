export interface SearchDocument {
  id: string;
  type: "email" | "thread" | "attachment" | "document_chunk";
  content: string;
  metadata: Record<string, any>;
  vector?: number[];
  timestamp: Date;
}

export interface SearchOptions {
  from?: number;
  size?: number;
  sort?: {
    field: string;
    order: "asc" | "desc";
  };
  filters?: Record<string, any>;
  highlight?: boolean;
  fields?: string[];
  fuzzy?: boolean;
}

export interface SearchResult {
  id: string;
  score: number;
  highlights?: Record<string, string[]>;
  document: SearchDocument;
}

export interface UpdateMetadata {
  type: string;
  id: string;
  metadata: Record<string, any>;
}
