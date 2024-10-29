import { JobScheduler } from "../jobs/scheduler";
import { SearchIndexer } from "@/services/search/indexer";
import { Logger } from "@/utils/logger";
import { JobPriority } from "./types";
import { SearchDocument } from "@/services/search/types";

type DocumentType = "email" | "thread" | "attachment" | "document_chunk";

const scheduler = JobScheduler.getInstance();
const searchIndexer = new SearchIndexer();
const logger = Logger.getInstance("production");

async function splitIntoChunks(
  text: string,
  chunkSize: number
): Promise<string[]> {
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
  await scheduler.updateJobProgress(jobId, progress);
}

async function generateEmbedding(
  text: string,
  model: string
): Promise<number[]> {
  // Simple TF (Term Frequency) based embedding
  const words = text.toLowerCase().split(/\s+/);
  const wordFreq = new Map<string, number>();

  // Count word frequencies
  words.forEach((word) => {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  });

  // Convert to vector (using word frequencies as values)
  // Limiting to first 1536 words to match typical embedding dimensions
  const embedding = Array.from(wordFreq.values()).slice(0, 1536);

  // Pad with zeros if needed to maintain consistent dimension
  while (embedding.length < 1536) {
    embedding.push(0);
  }

  // Normalize the vector
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
  await searchIndexer.updateMetadata(documentId, metadata);
}

export default async function indexing(data: {
  jobId: string;
  documentId: string;
  content: string;
  options?: {
    language?: string;
    indexName?: string;
    chunkSize?: number;
    embedModel?: string;
  };
}): Promise<void> {
  const { jobId, documentId, content, options = {} } = data;

  const {
    language = "en",
    indexName = "default",
    chunkSize = 1000,
    embedModel = "default",
  } = options;

  // Split content into chunks for processing
  const chunks = await splitIntoChunks(content, chunkSize);

  // Process each chunk with progress tracking
  for (let i = 0; i < chunks.length; i++) {
    try {
      // Update progress with jobId
      const progress = Math.round(((i + 1) / chunks.length) * 100);
      await updateJobProgress(jobId, progress);

      // Process chunk
      const embedding = await generateEmbedding(chunks[i], embedModel);
      await indexChunk({
        documentId,
        chunk: chunks[i],
        embedding,
        language,
        indexName,
        position: i,
      });
    } catch (error) {
      console.error(
        `Failed to process chunk ${i} of document ${documentId}:`,
        error
      );
      throw new IndexingError(`Indexing failed at chunk ${i}`, {
        cause: error,
      });
    }
  }

  // Update metadata
  await updateDocumentMetadata(documentId, {
    indexed: true,
    chunksCount: chunks.length,
    language,
    indexName,
    embedModel,
  });
}

class IndexingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexingError";
  }
}

// Add a helper function to create indexing jobs
export async function createIndexingJob(data: {
  documentId: string;
  content: string;
  options?: {
    language?: string;
    indexName?: string;
    chunkSize?: number;
    embedModel?: string;
  };
}): Promise<string> {
  const { documentId, content, options = {} } = data;

  const {
    language = "en",
    indexName = "default",
    chunkSize = 1000,
    embedModel = "default",
  } = options;

  // Generate a unique jobId
  const jobId = `${documentId}_${Date.now()}`;

  // Create a new indexing job
  await indexing({
    jobId,
    documentId,
    content,
    options,
  });

  return jobId;
}
