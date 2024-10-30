export interface SearchDocument {
  id: string;
  type: SearchDocumentType;
  content: string;
  metadata: Record<string, any>;
  vector?: number[];
  timestamp: Date;
}

export type SearchDocumentType =
  | "email"
  | "thread"
  | "attachment"
  | "document_chunk";

export interface SearchOptions {
  language?: string;
  batchSize?: number;
  skipVector?: boolean;
  indexName?: string;
  from?: number;
  size?: number;
  filters?: Record<string, any>;
  highlight?: boolean;
  fuzzy?: boolean;
}

export interface SearchStats {
  documentsCount: number;
  termsCount: number;
  lastUpdated: Date;
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
