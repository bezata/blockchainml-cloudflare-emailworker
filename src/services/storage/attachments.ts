import { Logger } from "../../utils/logger";
import { constants } from "../../config/constants";
import { createHash } from "crypto";
import { AttachmentMetadata, StorageConfig } from "../../types/storage";

// Define environment interface
interface Env {
  ATTACHMENT_BUCKET: R2Bucket;
  logger: Logger;
}

// Define custom R2 types
interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  limit?: number;
  include?: Array<"httpMetadata" | "customMetadata">;
}

interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

// Updated error for missing metadata
class MetadataError extends Error {
  constructor(field: string) {
    super(`Required metadata field missing: ${field}`);
    this.name = "MetadataError";
  }
}

export class AttachmentService {
  private readonly config: StorageConfig = {
    maxSizeBytes: constants.email.maxAttachmentSize,
    allowedMimeTypes: constants.email.allowedMimeTypes,
    bucketName: "email-attachments",
  };

  private readonly logger: Logger;
  private readonly bucket: R2Bucket;

  constructor(env: Env) {
    this.logger = env.logger;
    this.bucket = env.ATTACHMENT_BUCKET;
  }

  async store(attachment: {
    content: string;
    filename: string;
    contentType: string;
  }): Promise<{ id: string; url: string; metadata: AttachmentMetadata }> {
    try {
      // Validate attachment
      this.validateAttachment(attachment);

      // Generate unique ID and key
      const id = crypto.randomUUID();
      const sanitizedFilename = this.sanitizeFilename(attachment.filename);
      const key = `attachments/${id}/${sanitizedFilename}`;

      // Calculate checksum for integrity verification
      const checksum = this.calculateChecksum(attachment.content);

      // Convert base64 content to buffer if needed
      const content = this.isBase64(attachment.content)
        ? Buffer.from(attachment.content, "base64")
        : attachment.content;

      // Prepare metadata
      const metadata: AttachmentMetadata = {
        id,
        filename: sanitizedFilename,
        contentType: attachment.contentType,
        size: Buffer.byteLength(content),
        uploadedAt: new Date(),
        checksum,
      };

      // Upload to R2
      await this.bucket.put(key, content, {
        httpMetadata: {
          contentType: attachment.contentType,
        },
        customMetadata: {
          id: metadata.id,
          filename: metadata.filename,
          contentType: metadata.contentType,
          size: metadata.size.toString(),
          uploadedAt: metadata.uploadedAt.toISOString(),
          checksum: metadata.checksum,
        },
      });

      // Generate signed URL for temporary access
      const url = await this.generateSignedUrl(key);

      this.logger.info("Attachment stored successfully", {
        id,
        filename: sanitizedFilename,
      });

      return {
        id,
        url,
        metadata,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this.logger.error("Error storing attachment:", { error: errorMessage });
      throw new Error(`Failed to store attachment: ${errorMessage}`);
    }
  }

  async retrieve(
    id: string,
    filename: string
  ): Promise<{
    content: ArrayBuffer;
    metadata: AttachmentMetadata;
  }> {
    try {
      const key = `attachments/${id}/${filename}`;

      // Get object and metadata from R2
      const object = await this.bucket.get(key);

      if (!object) {
        throw new Error("Attachment not found");
      }

      // Verify metadata
      const metadata = this.parseMetadata(object.customMetadata || {});

      // Get content
      const content = await object.arrayBuffer();

      // Verify integrity
      const checksum = this.calculateChecksum(content);
      if (checksum !== metadata.checksum) {
        throw new Error("Attachment integrity check failed");
      }

      return {
        content,
        metadata,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this.logger.error("Error retrieving attachment:", {
        error: errorMessage,
      });
      throw new Error(`Failed to retrieve attachment: ${errorMessage}`);
    }
  }

  async delete(id: string, filename: string): Promise<void> {
    try {
      const key = `attachments/${id}/${filename}`;

      // Check if object exists
      const exists = await this.bucket.head(key);
      if (!exists) {
        throw new Error("Attachment not found");
      }

      // Delete from R2
      await this.bucket.delete(key);

      this.logger.info("Attachment deleted successfully", { id, filename });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this.logger.error("Error deleting attachment:", { error: errorMessage });
      throw new Error(`Failed to delete attachment: ${errorMessage}`);
    }
  }

  private validateAttachment(attachment: {
    content: string | Buffer;
    filename: string;
    contentType: string;
  }): void {
    // Check file size
    const size = Buffer.byteLength(
      typeof attachment.content === "string"
        ? Buffer.from(attachment.content)
        : attachment.content
    );
    if (size > this.config.maxSizeBytes) {
      throw new Error(
        `File size exceeds maximum allowed size of ${this.config.maxSizeBytes} bytes`
      );
    }

    // Check MIME type
    if (!this.config.allowedMimeTypes.includes(attachment.contentType)) {
      throw new Error(`File type ${attachment.contentType} is not allowed`);
    }

    // Validate filename
    if (!attachment.filename || attachment.filename.length > 255) {
      throw new Error("Invalid filename");
    }
  }

  private sanitizeFilename(filename: string): string {
    // Remove potentially dangerous characters
    return filename
      .replace(/[^a-zA-Z0-9.-]/g, "_")
      .replace(/\.{2,}/g, ".")
      .toLowerCase();
  }

  private calculateChecksum(content: string | Buffer | ArrayBuffer): string {
    const buffer = Buffer.isBuffer(content)
      ? content
      : content instanceof ArrayBuffer
        ? Buffer.from(content)
        : Buffer.from(content);

    return createHash("sha256").update(buffer).digest("hex");
  }

  private isBase64(str: string): boolean {
    try {
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      return base64Regex.test(str);
    } catch {
      return false;
    }
  }

  private async generateSignedUrl(key: string): Promise<string> {
    // Replace with your R2 bucket's public endpoint
    const publicEndpoint = `https://${this.config.bucketName}.${constants.r2.accountId}.r2.cloudflarestorage.com`;
    return `${publicEndpoint}/${key}`;
  }

  private parseMetadata(
    metadata: Record<string, string | undefined>
  ): AttachmentMetadata {
    // Validate required fields
    const requiredFields = [
      "id",
      "filename",
      "contentType",
      "size",
      "uploadedAt",
      "checksum",
    ];
    for (const field of requiredFields) {
      if (!metadata[field]) {
        throw new MetadataError(field);
      }
    }

    // Now we can safely assert these fields exist
    const id = metadata.id!;
    const filename = metadata.filename!;
    const contentType = metadata.contentType!;
    const sizeStr = metadata.size!;
    const uploadedAtStr = metadata.uploadedAt!;
    const checksum = metadata.checksum!;

    // Parse size with validation
    const size = parseInt(sizeStr, 10);
    if (isNaN(size)) {
      throw new Error(`Invalid size value in metadata: ${sizeStr}`);
    }

    // Parse date with validation
    const uploadedAt = new Date(uploadedAtStr);
    if (isNaN(uploadedAt.getTime())) {
      throw new Error(`Invalid uploadedAt value in metadata: ${uploadedAtStr}`);
    }

    return {
      id,
      filename,
      contentType,
      size,
      uploadedAt,
      checksum,
    };
  }

  async listAttachments(
    prefix?: string,
    limit: number = 100
  ): Promise<AttachmentMetadata[]> {
    try {
      const options: R2ListOptions = {
        prefix: prefix ? `attachments/${prefix}` : "attachments/",
        limit,
        include: ["customMetadata"],
      };

      const listing = (await this.bucket.list(options)) as R2Objects;

      return listing.objects
        .filter((obj) => obj.customMetadata)
        .map((obj) => {
          try {
            return this.parseMetadata(obj.customMetadata || {});
          } catch (error) {
            this.logger.warn("Skipping invalid metadata object:", {
              key: obj.key,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return null;
          }
        })
        .filter(
          (metadata): metadata is AttachmentMetadata => metadata !== null
        );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this.logger.error("Error listing attachments:", { error: errorMessage });
      throw new Error(`Failed to list attachments: ${errorMessage}`);
    }
  }
}
