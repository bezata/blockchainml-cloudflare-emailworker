import { JobScheduler } from "../jobs/scheduler";
import { SearchIndexer } from "@/services/search/indexer";
import { Logger } from "@/utils/logger";
import { SearchDocument, SearchDocumentType } from "@/services/search/types";
import { MetricsCollector } from "@/monitoring/metrics";

const scheduler = JobScheduler.getInstance();
const searchIndexer = new SearchIndexer();
const logger = Logger.getInstance("production");

interface IndexingOptions {
  language: string;
  indexName: string;
  chunkSize: number;
  embedModel: string;
}

async function splitIntoChunks(
  text: string,
  chunkSize: number
): Promise<string[]> {
  if (!text) return [];

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

async function updateJobProgress(
  jobId: string,
  progress: number
): Promise<void> {
  try {
    await scheduler.updateJobProgress(jobId, progress);
    logger.info(`Updated job progress: ${progress}%`, { jobId });
  } catch (error) {
    logger.error("Failed to update job progress:", error);
  }
}

async function generateEmbedding(
  text: string,
  _embedModel: string
): Promise<number[]> {
  const words = text.toLowerCase().split(/\s+/);
  const wordFreq = new Map<string, number>();

  words.forEach((word) => {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  });

  const embedding = Array.from(wordFreq.values()).slice(0, 1536);
  while (embedding.length < 1536) {
    embedding.push(0);
  }

  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );
  return embedding.map((val) => val / magnitude);
}

async function indexChunk(params: {
  documentId: string;
  chunk: string;
  embedding: number[];
  language: string;
  indexName: string;
  position: number;
}): Promise<void> {
  try {
    const document: SearchDocument = {
      id: `${params.documentId}_chunk_${params.position}`,
      type: "document_chunk",
      content: params.chunk,
      metadata: {
        documentId: params.documentId,
        language: params.language,
        indexName: params.indexName,
        position: params.position,
      },
      vector: params.embedding,
      timestamp: new Date(),
    };

    await searchIndexer.indexDocument(document);
    logger.info(
      `Indexed chunk ${params.position} for document ${params.documentId}`
    );
  } catch (error) {
    logger.error("Failed to index chunk:", error);
    throw error;
  }
}

async function updateDocumentMetadata(
  documentId: string,
  metadata: {
    indexed: boolean;
    chunksCount: number;
    language: string;
    indexName: string;
    embedModel: string;
  }
): Promise<void> {
  try {
    await searchIndexer.updateDocumentMetadata(documentId, metadata);
    logger.info(`Updated metadata for document ${documentId}`, metadata);
  } catch (error) {
    logger.error("Failed to update document metadata:", error);
    throw error;
  }
}

export async function indexing(data: {
  jobId: string;
  documentId: string;
  content: string;
  options?: Partial<IndexingOptions>;
}): Promise<void> {
  const { jobId, documentId, content } = data;

  if (!content) {
    throw new IndexingError("Content is required for indexing");
  }

  const options: IndexingOptions = {
    language: data.options?.language || "en",
    indexName: data.options?.indexName || "default",
    chunkSize: data.options?.chunkSize || 1000,
    embedModel: data.options?.embedModel || "default",
  };

  logger.info("Starting indexing job", { jobId, documentId, options });

  try {
    const chunks = await splitIntoChunks(content, options.chunkSize);

    if (chunks.length === 0) {
      throw new IndexingError("No content chunks generated");
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      const progress = Math.round(((i + 1) / chunks.length) * 100);
      await updateJobProgress(jobId, progress);

      const embedding = await generateEmbedding(chunk, options.embedModel);
      await indexChunk({
        documentId,
        chunk,
        embedding,
        language: options.language,
        indexName: options.indexName,
        position: i,
      });
    }

    await updateDocumentMetadata(documentId, {
      indexed: true,
      chunksCount: chunks.length,
      ...options,
    });

    logger.info("Indexing completed successfully", { jobId, documentId });
  } catch (error) {
    logger.error("Indexing failed:", error);
    throw new IndexingError(`Indexing failed for document ${documentId}`, {
      cause: error,
    });
  }
}

class IndexingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexingError";
  }
}

export async function createIndexingJob(params: {
  documentId: string;
  content: string;
  options?: Partial<IndexingOptions>;
}): Promise<string> {
  try {
    const jobId = `idx_${params.documentId}_${Date.now()}`;

    await indexing({
      jobId,
      ...params,
    });

    return jobId;
  } catch (error) {
    logger.error("Failed to create indexing job:", error);
    throw error;
  }
}

interface IndexSearchData {
  documentId: string;
  content: {
    text: string;
    metadata: Record<string, unknown>;
  };
  options?: {
    language?: string;
    boost?: Record<string, number>;
    batchSize?: number;
    reindexExisting?: boolean;
    indexName?: string;
  };
}

interface IndexSearchResult {
  success: boolean;
  documentId: string;
  status: "completed" | "failed";
  indexedAt?: Date;
  error?: string;
  stats?: {
    processingTime: number;
    tokensGenerated: number;
    vectorsCreated: number;
  };
}

const metricsCollector = new MetricsCollector();

interface ProcessingStats {
  tokensGenerated: number;
  vectorsCreated: number;
}

const indexSearchHandler = async (
  data: IndexSearchData
): Promise<IndexSearchResult> => {
  const startTime = Date.now();
  let tokensGenerated = 0;
  let vectorsCreated = 0;

  try {
    logger.info("Starting document indexing", {
      documentId: data.documentId,
      contentLength: data.content.text.length,
      options: data.options,
    });

    // Validate input
    validateIndexData(data);

    // Prepare search document
    const searchDocument: SearchDocument = {
      id: data.documentId,
      type: getDocumentType(data.content.metadata) as SearchDocumentType,
      content: data.content.text,
      metadata: {
        ...data.content.metadata,
        indexed_at: new Date(),
        language: data.options?.language || "en",
        boost: data.options?.boost || {},
      },
      timestamp: new Date(),
    };

    // Handle reindexing if requested
    if (data.options?.reindexExisting) {
      await searchIndexer.deleteDocument(
        data.documentId,
        data.options?.indexName || "default"
      );
    }

    // Process and index the document
    const processingStats: ProcessingStats = await searchIndexer
      .indexDocument(searchDocument, {
        language: data.options?.language ?? "en",
        batchSize: data.options?.batchSize ?? 100,
        skipVector: !hasVectorRequirement(searchDocument.type),
        indexName: data.options?.indexName ?? "default",
      })
      .then(() => ({
        tokensGenerated: 0,
        vectorsCreated: 0,
      }));

    // Update metrics
    tokensGenerated = processingStats.tokensGenerated;
    vectorsCreated = processingStats.vectorsCreated;

    // Record metrics
    await metricsCollector.recordMetric({
      name: "search_indexing",
      value: Date.now() - startTime,
      tags: {
        document_type: searchDocument.type,
        status: "success",
        language: data.options?.language || "en",
      },
    });

    logger.info("Document indexed successfully", {
      documentId: data.documentId,
      processingTime: Date.now() - startTime,
      stats: processingStats,
    });

    return {
      success: true,
      documentId: data.documentId,
      status: "completed",
      indexedAt: new Date(),
      stats: {
        processingTime: Date.now() - startTime,
        tokensGenerated,
        vectorsCreated,
      },
    };
  } catch (error) {
    logger.error("Error indexing document:", {
      documentId: data.documentId,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    // Record error metrics
    await metricsCollector.recordMetric({
      name: "search_indexing_error",
      value: 1,
      tags: {
        document_type: getDocumentType(data.content.metadata),
        error_type: error instanceof Error ? error.name : "unknown",
      },
    });

    return {
      success: false,
      documentId: data.documentId,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      stats: {
        processingTime: Date.now() - startTime,
        tokensGenerated,
        vectorsCreated,
      },
    };
  }
};

function validateIndexData(data: IndexSearchData): void {
  if (!data.documentId) {
    throw new Error("Document ID is required");
  }

  if (!data.content?.text) {
    throw new Error("Document content text is required");
  }

  if (!data.content?.metadata) {
    throw new Error("Document metadata is required");
  }

  if (data.options?.language && !isValidLanguage(data.options.language)) {
    throw new Error(`Unsupported language: ${data.options.language}`);
  }

  if (data.options?.boost) {
    for (const [field, value] of Object.entries(data.options.boost)) {
      if (typeof value !== "number" || value < 0) {
        throw new Error(`Invalid boost value for field ${field}`);
      }
    }
  }
}

function getDocumentType(metadata: Record<string, unknown>): string {
  return (metadata.type as string) || "unknown";
}

function hasVectorRequirement(documentType: string): boolean {
  const vectorRequiredTypes = ["email", "attachment", "document"];
  return vectorRequiredTypes.includes(documentType);
}

function isValidLanguage(language: string): boolean {
  const supportedLanguages = [
    "en",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "nl",
    "ru",
    "zh",
    "ja",
    "ko",
    "ar",
    "hi",
  ];
  return supportedLanguages.includes(language);
}

export default indexSearchHandler;
