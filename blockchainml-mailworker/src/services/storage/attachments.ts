import { Logger } from "../../utils/logger";
import { Validator } from "../../utils/validation";
import { constants } from "../../config/constants";
import { createHash } from "crypto";
import { AttachmentMetadata } from "../../types/storage";

export class AttachmentService {
  private readonly config: StorageConfig = {
    maxSizeBytes: constants.email.maxAttachmentSize,
    allowedMimeTypes: constants.email.allowedMimeTypes,
    bucketName: "email-attachments",
  };

  private readonly logger: Logger;

  constructor() {
    this.logger = Logger.getInstance("production");
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
      await env.ATTACHMENT_BUCKET.put(key, content, {
        httpMetadata: {
          contentType: attachment.contentType,
        },
        customMetadata: {
          ...metadata,
          uploadedAt: metadata.uploadedAt.toISOString(),
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
      this.logger.error("Error storing attachment:", error);
      throw new Error(`Failed to store attachment: ${error.message}`);
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
      const object = await env.ATTACHMENT_BUCKET.get(key);

      if (!object) {
        throw new Error("Attachment not found");
      }

      // Verify metadata
      const metadata = this.parseMetadata(object.customMetadata);

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
      this.logger.error("Error retrieving attachment:", error);
      throw new Error(`Failed to retrieve attachment: ${error.message}`);
    }
  }

  async delete(id: string, filename: string): Promise<void> {
    try {
      const key = `attachments/${id}/${filename}`;

      // Check if object exists
      const exists = await env.ATTACHMENT_BUCKET.head(key);
      if (!exists) {
        throw new Error("Attachment not found");
      }

      // Delete from R2
      await env.ATTACHMENT_BUCKET.delete(key);

      this.logger.info("Attachment deleted successfully", { id, filename });
    } catch (error) {
      this.logger.error("Error deleting attachment:", error);
      throw new Error(`Failed to delete attachment: ${error.message}`);
    }
  }

  async listAttachments(
    prefix?: string,
    limit: number = 100
  ): Promise<AttachmentMetadata[]> {
    try {
      const options: R2ListOptions = {
        prefix: prefix ? `attachments/${prefix}` : "attachments/",
        limit,
      };

      const listing = await env.ATTACHMENT_BUCKET.list(options);

      return listing.objects.map((obj) =>
        this.parseMetadata(obj.customMetadata)
      );
    } catch (error) {
      this.logger.error("Error listing attachments:", error);
      throw new Error(`Failed to list attachments: ${error.message}`);
    }
  }

  private validateAttachment(attachment: {
    content: string | Buffer;
    filename: string;
    contentType: string;
  }): void {
    // Check file size
    const size = Buffer.byteLength(attachment.content);
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
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

    return createHash("sha256").update(buffer).digest("hex");
  }

  private isBase64(str: string): boolean {
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    return base64Regex.test(str);
  }

  private async generateSignedUrl(
    key: string,
    expirationMinutes: number = 60
  ): Promise<string> {
    const url = await env.ATTACHMENT_BUCKET.createSignedUrl(key, {
      expiresIn: expirationMinutes * 60, // Convert to seconds
    });

    return url;
  }

  private parseMetadata(metadata: any): AttachmentMetadata {
    return {
      id: metadata.id,
      filename: metadata.filename,
      contentType: metadata.contentType,
      size: parseInt(metadata.size),
      uploadedAt: new Date(metadata.uploadedAt),
      checksum: metadata.checksum,
    };
  }
}
