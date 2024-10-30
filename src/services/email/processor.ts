import { ObjectId } from "mongodb";
import { EmailDocument, EmailAttachment, EmailPriority } from "@/types/email";
import { EmailClassifier } from "@/services/email/classifier";
import { ThreadService } from "@/services/email/thread";
import { AttachmentService } from "@/services/storage/attachments";
import { Logger } from "@/utils/logger";

interface Env {
  ATTACHMENT_BUCKET: R2Bucket;
  JWT_SECRET: string;
  MONGODB_URI: string;
}

interface EmailMessage {
  headers: Headers;
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  raw: {
    text?: string;
    html?: string;
  };
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
  tags?: string[];
  priority?: "high" | "normal" | "low";
}

interface EmailData {
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textContent: string | undefined;
  htmlContent: string | undefined;
  receivedAt: Date;
}

export class EmailProcessor {
  private readonly classifier: EmailClassifier;
  private readonly threadService: ThreadService;
  private readonly attachmentService: AttachmentService;
  private readonly logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.logger = logger;
    this.classifier = new EmailClassifier();
    this.threadService = new ThreadService();
    this.attachmentService = new AttachmentService({
      ATTACHMENT_BUCKET: env.ATTACHMENT_BUCKET,
      logger: this.logger,
    });
  }

  async processEmail(message: EmailMessage): Promise<EmailDocument> {
    try {
      // Extract basic email data
      const emailData = await this.extractEmailData(message);

      // Process attachments
      const attachments = await this.processAttachments(
        message.attachments || []
      );

      // Create a base email document for classification
      const baseEmailDoc: EmailDocument = {
        _id: new ObjectId(),
        messageId: emailData.messageId,
        from: emailData.from,
        to: emailData.to,
        cc: emailData.cc,
        bcc: emailData.bcc,
        subject: emailData.subject,
        textContent: emailData.textContent ?? "",
        htmlContent: emailData.htmlContent ?? "",
        attachments: [],
        category: [],
        labels: [],
        status: "unread",
        spam: false,
        spamScore: 0,
        receivedAt: emailData.receivedAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        priority: EmailPriority.Normal,
        tags: [],
      };

      // Classify email
      const classification = this.classifier.classify(baseEmailDoc);

      // Detect thread
      const threadId = await this.threadService.detectThread(baseEmailDoc);

      // Construct final email document
      const emailDocument: EmailDocument = {
        ...baseEmailDoc,
        attachments,
        priority: classification.priority,
        category: classification.categories,
        threadId,
        spam: classification.spamScore > 0.5,
        spamScore: classification.spamScore,
      };

      this.logger.info("Email processed successfully", {
        messageId: emailDocument.messageId,
        threadId: emailDocument.threadId,
      });

      return emailDocument;
    } catch (error) {
      this.logger.error("Error processing email:", {
        error: error instanceof Error ? error.message : "Unknown error",
        messageId: message.headers.get("Message-ID"),
      });
      throw error;
    }
  }

  private async extractEmailData(message: EmailMessage): Promise<EmailData> {
    const messageId =
      message.headers.get("Message-ID") || this.generateMessageId();

    // Normalize arrays with explicit undefined handling
    const toArray = Array.isArray(message.to) ? message.to : [message.to];
    const ccArray = message.cc
      ? Array.isArray(message.cc)
        ? message.cc
        : [message.cc]
      : [];
    const bccArray = message.bcc
      ? Array.isArray(message.bcc)
        ? message.bcc
        : [message.bcc]
      : [];

    return {
      messageId,
      from: message.from,
      to: toArray,
      cc: ccArray,
      bcc: bccArray,
      subject: message.subject,
      textContent: message.raw.text,
      htmlContent: message.raw.html,
      receivedAt: new Date(),
    };
  }

  private async processAttachments(
    attachments: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>
  ): Promise<EmailAttachment[]> {
    try {
      return await Promise.all(
        attachments.map(async (att) => {
          const { id, url, metadata } = await this.attachmentService.store({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
          });

          const attachment: EmailAttachment = {
            id,
            filename: metadata.filename,
            contentType: metadata.contentType,
            size: metadata.size,
            url,
          };

          return attachment;
        })
      );
    } catch (error) {
      this.logger.error("Error processing attachments:", error);
      throw error;
    }
  }

  private generateMessageId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2);
    return `${timestamp}.${random}@email-worker`;
  }
}
