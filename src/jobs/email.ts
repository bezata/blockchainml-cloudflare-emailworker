import { EmailProcessor } from "@/services/email/processor";
import { Logger } from "@/utils/logger";

interface EmailTaskData {
  email: {
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textContent?: string;
    htmlContent?: string;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  };
  options?: {
    priority?: "high" | "normal" | "low";
    tags?: string[];
  };
}

interface EmailTaskResult {
  success: boolean;
  emailId?: string;
  error?: string;
}

interface Env {
  ATTACHMENT_BUCKET: R2Bucket;
  JWT_SECRET: string;
  MONGODB_URI: string;
}

const logger = Logger.getInstance("production");

export function createEmailTask(env: Env) {
  const emailProcessor = new EmailProcessor(
    {
      ATTACHMENT_BUCKET: env.ATTACHMENT_BUCKET,
      JWT_SECRET: env.JWT_SECRET,
      MONGODB_URI: env.MONGODB_URI,
    },
    logger
  );

  return async function handleEmailTask(
    data: EmailTaskData
  ): Promise<EmailTaskResult> {
    try {
      logger.info("Processing email task", {
        to: data.email.to,
        subject: data.email.subject,
        priority: data.options?.priority,
      });

      // Validate email data
      validateEmailData(data.email);

      // Create Headers object with default fields
      const headers = new Headers({
        "Message-ID": `<${Date.now()}.${Math.random().toString(36).substring(2)}@email-worker>`,
        Date: new Date().toUTCString(),
        From: data.email.from,
        To: data.email.to.join(", "),
        ...(data.email.cc?.length ? { Cc: data.email.cc.join(", ") } : {}),
        ...(data.email.bcc?.length ? { Bcc: data.email.bcc.join(", ") } : {}),
        Subject: data.email.subject,
        "Content-Type": data.email.htmlContent
          ? "text/html; charset=utf-8"
          : "text/plain; charset=utf-8",
      });

      // Process email
      const processedEmail = await emailProcessor.processEmail({
        headers,
        from: data.email.from,
        to: data.email.to,
        cc: data.email.cc || [],
        bcc: data.email.bcc || [],
        subject: data.email.subject,
        raw: {
          ...(data.email.textContent ? { text: data.email.textContent } : {}),
          ...(data.email.htmlContent ? { html: data.email.htmlContent } : {}),
        },
        attachments: data.email.attachments || [],
      });

      logger.info("Email processed successfully", {
        emailId: processedEmail._id.toString(),
        to: processedEmail.to,
      });

      return {
        success: true,
        emailId: processedEmail._id.toString(),
      };
    } catch (error) {
      logger.error("Error processing email:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  };
}

function validateEmailData(email: EmailTaskData["email"]): void {
  if (!email.from) {
    throw new Error("From address is required");
  }

  if (!email.to || email.to.length === 0) {
    throw new Error("At least one recipient is required");
  }

  if (!email.subject) {
    throw new Error("Subject is required");
  }

  if (!email.textContent && !email.htmlContent) {
    throw new Error("Either text or HTML content is required");
  }

  // Validate email addresses
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email.from)) {
    throw new Error("Invalid from address");
  }

  for (const to of email.to) {
    if (!emailRegex.test(to)) {
      throw new Error(`Invalid recipient address: ${to}`);
    }
  }

  if (email.cc) {
    for (const cc of email.cc) {
      if (!emailRegex.test(cc)) {
        throw new Error(`Invalid CC address: ${cc}`);
      }
    }
  }

  if (email.bcc) {
    for (const bcc of email.bcc) {
      if (!emailRegex.test(bcc)) {
        throw new Error(`Invalid BCC address: ${bcc}`);
      }
    }
  }

  // Validate attachments if present
  if (email.attachments) {
    for (const attachment of email.attachments) {
      if (!attachment.filename) {
        throw new Error("Attachment filename is required");
      }
      if (!attachment.content) {
        throw new Error("Attachment content is required");
      }
      if (!attachment.contentType) {
        throw new Error("Attachment content type is required");
      }
    }
  }
}

export type { EmailTaskData, EmailTaskResult, Env };

export default async function handleEmail(
  data: EmailTaskData,
  env: Env
): Promise<EmailTaskResult> {
  try {
    // Validate email data
    validateEmailData(data.email);

    // Prepare email content
    const emailContent: EmailTaskData = {
      email: {
        from: data.email.from,
        to: data.email.to,
        subject: data.email.subject,
        ...(data.email.textContent && { textContent: data.email.textContent }),
        ...(data.email.htmlContent && { htmlContent: data.email.htmlContent }),
        ...(data.email.cc && { cc: data.email.cc }),
        ...(data.email.bcc && { bcc: data.email.bcc }),
        ...(data.email.attachments && { attachments: data.email.attachments }),
      },
    };

    // Create and execute the email task
    const emailTask = createEmailTask(env);
    const result = await emailTask(emailContent);

    return {
      success: true,
      emailId: result.emailId ?? "",
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return {
      success: false,
      error: errorMessage,
    };
  }
}
