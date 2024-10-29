export interface StorageConfig {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  bucketName: string;
}

export interface AttachmentMetadata {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
  checksum: string;
}
