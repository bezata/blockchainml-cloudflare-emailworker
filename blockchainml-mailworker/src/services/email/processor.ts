import { EmailDocument, EmailAttachment } from "@/types/email";
import { EmailClassifier } from "@/services/email/classifier";
import { ThreadService } from "@/services/email/thread";
import { AttachmentService } from "@/services/storage/attachments";
import { Logger } from "@/utils/logger";

export class EmailProcessor {
  private classifier: EmailClassifier;
  private threadService: ThreadService;
  private attachmentService: AttachmentService;
  private logger: Logger;

  constructor() {
    this.classifier = new EmailClassifier();
    this.threadService = new ThreadService();
    this.attachmentService = new AttachmentService();
    this.logger = Logger.getInstance("production");
  }

  async processEmail(message: ForwardableEmailMessage): Promise<EmailDocument> {
    try {
      // Extract basic email data
      const emailData = {
        messageId:
          message.headers.get("Message-ID") || this.generateMessageId(),
        from: message.from,
        to: Array.isArray(message.to) ? message.to : [message.to],
        cc: message.cc
          ? Array.isArray(message.cc)
            ? message.cc
            : [message.cc]
          : [],
        bcc: message.bcc
          ? Array.isArray(message.bcc)
            ? message.bcc
            : [message.bcc]
          : [],
        subject: message.subject,
        textContent: message.raw.text,
        htmlContent: message.raw.html,
        receivedAt: new Date(),
      };

      // Process attachments
      const attachments = await this.processAttachments(
        message.attachments || []
      );

      // Classify email
      const classification = this.classifier.classify(emailData);

      // Detect thread
      const threadId = await this.threadService.detectThread(emailData.subject);

      // Construct final email document
      const emailDocument: EmailDocument = {
        _id: new ObjectId(),
        ...emailData,
        attachments,
        priority: classification.priority,
        category: classification.categories,
        labels: [],
        status: "unread",
        threadId,
        spam: classification.spamScore > 0.5,
        spamScore: classification.spamScore,
      };

      return emailDocument;
    } catch (error) {
      this.logger.error("Error processing email:", error);
      throw error;
    }
  }

  private async processAttachments(
    attachments: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>
  ): Promise<EmailAttachment[]> {
    const attachmentService = new AttachmentService();

    return Promise.all(
      attachments.map(async (att) => {
        const { id, url, metadata } = await attachmentService.store({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        });

        return {
          id,
          filename: metadata.filename,
          contentType: metadata.contentType,
          size: metadata.size,
          url,
        };
      })
    );
  }

  private generateMessageId(): string {
    return `${Date.now()}.${Math.random()
      .toString(36)
      .substring(2)}@email-worker`;
  }
}
