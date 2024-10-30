import { EmailDocument } from "@/types/email";
import { ThreadDocument } from "@/db/models/thread";
import { ThreadRepository } from "@/db/models/repositories/thread";
import { Logger } from "@/utils/logger";

export class ThreadService {
  private readonly logger: Logger;
  private readonly threadRepository: ThreadRepository;

  constructor() {
    this.logger = Logger.getInstance("production");
    this.threadRepository = new ThreadRepository();
  }

  async processThread(email: EmailDocument): Promise<string> {
    try {
      const threadId = await this.detectThread(email);
      await this.updateThread(threadId, email);
      return threadId;
    } catch (error) {
      this.logger.error("Error processing thread:", error);
      throw error;
    }
  }

  async detectThread(email: EmailDocument): Promise<string> {
    try {
      const cleanSubject = this.cleanSubject(email.subject);
      const references = this.extractReferences(email);

      // Try to find existing thread by references
      if (references.length > 0) {
        const existingThread =
          await this.threadRepository.findByReferences(references);
        if (existingThread) {
          return existingThread._id.toString();
        }
      }

      // Try to find by subject
      const similarThread =
        await this.threadRepository.findBySubject(cleanSubject);
      if (similarThread && this.areParticipantsRelated(similarThread, email)) {
        return similarThread._id.toString();
      }

      // Create new thread
      const thread = await this.threadRepository.create({
        subject: cleanSubject,
        participants: this.extractParticipants(email),
        emailIds: [email._id],
        lastMessageAt: email.receivedAt,
        messageCount: 1,
        status: "active",
        labels: [],
        metadata: {
          originalSubject: email.subject,
          isForwarded: this.isForwarded(email.subject),
          hasAttachments: (email.attachments?.length || 0) > 0,
        },
      });

      return thread._id.toString();
    } catch (error) {
      this.logger.error("Error detecting thread:", error);
      throw error;
    }
  }

  private cleanSubject(subject: string): string {
    return subject
      .replace(/^(?:Re|Fwd|Fw|Forward):\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractReferences(email: EmailDocument): string[] {
    const references: string[] = [];

    // Extract Message-ID references
    const messageIdHeader = email.headers?.["message-id"];
    const referencesHeader = email.headers?.["references"];
    const inReplyToHeader = email.headers?.["in-reply-to"];

    if (messageIdHeader) references.push(messageIdHeader);
    if (referencesHeader) references.push(...referencesHeader.split(/\s+/));
    if (inReplyToHeader) references.push(inReplyToHeader);

    return [...new Set(references)];
  }

  private extractParticipants(email: EmailDocument): string[] {
    const participants = new Set<string>();

    participants.add(email.from);
    email.to.forEach((to) => participants.add(to));
    email.cc?.forEach((cc) => participants.add(cc));

    return Array.from(participants);
  }

  private areParticipantsRelated(
    thread: ThreadDocument,
    email: EmailDocument
  ): boolean {
    const emailParticipants = this.extractParticipants(email);
    return thread.participants.some((p) => emailParticipants.includes(p));
  }

  private isForwarded(subject: string): boolean {
    return /^(?:Fwd|Fw|Forward):/i.test(subject);
  }

  async updateThread(threadId: string, email: EmailDocument): Promise<void> {
    try {
      const update = {
        $addToSet: {
          participants: { $each: this.extractParticipants(email) },
          emailIds: email._id,
        },
        $set: { lastMessageAt: email.receivedAt },
        $inc: { messageCount: 1 },
      };

      await this.threadRepository.update(threadId, update);
    } catch (error) {
      this.logger.error("Error updating thread:", error);
      throw error;
    }
  }
}
