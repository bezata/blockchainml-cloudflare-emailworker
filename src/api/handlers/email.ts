import { Context } from "hono";
import { EmailRepository } from "@/db/models/repositories/email";

import { Validator } from "@/utils/validation";
import type {
  ApiResponse,
  PaginationParams,
  PaginationMeta,
} from "@/types/common";
import type { EmailDocument } from "@/types/email";
import { Logger } from "@/utils/logger";
import { EmailPriority } from "@/types/email";

export class EmailHandler {
  private repository: EmailRepository;
  private baseRepository: EmailRepository;
  private logger: Logger;

  constructor() {
    this.repository = new EmailRepository();
    this.baseRepository = new EmailRepository();
    this.logger = Logger.getInstance("production");
  }

  getEmails = async (c: Context): Promise<Response> => {
    try {
      // Validate and parse pagination parameters
      const paginationParams = this.getPaginationParams(c);

      // Get query parameters
      const status = c.req.query("status");
      const query = this.buildQuery({ status: status || undefined });

      // Fetch emails and total count
      const { emails, total } = await this.fetchEmailsWithCount(
        query,
        paginationParams
      );

      // Build pagination metadata
      const paginationMeta = this.buildPaginationMeta({
        ...paginationParams,
        total,
      });

      const response: ApiResponse<EmailDocument[]> = {
        success: true,
        data: emails,
        meta: {
          pagination: paginationMeta,
        },
      };

      return c.json(response);
    } catch (error) {
      return this.handleError(c, error);
    }
  };

  getEmailById = async (c: Context): Promise<Response> => {
    try {
      const id = c.req.param("id");

      if (!id) {
        return c.json(
          {
            success: false,
            error: "Email ID is required",
          },
          400
        );
      }

      const email = await this.repository.findById(id);

      if (!email) {
        return c.json(
          {
            success: false,
            error: "Email not found",
          },
          404
        );
      }

      const response: ApiResponse<EmailDocument> = {
        success: true,
        data: email,
      };

      return c.json(response);
    } catch (error) {
      return this.handleError(c, error);
    }
  };

  sendEmail = async (c: Context): Promise<Response> => {
    try {
      const body = await c.req.json();

      // Validate required fields
      if (!body.to || !body.subject || !body.content) {
        return c.json(
          {
            success: false,
            error:
              "Missing required fields: 'to', 'subject', and 'content' are required",
          },
          400
        );
      }

      // Create email document
      const email = await this.repository.create({
        to: [body.to],
        subject: body.subject,
        textContent: body.content,
        status: "unread",
        priority: EmailPriority.Normal,
        category: [],
        labels: [],
        spam: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        messageId: `${Date.now()}.${Math.random().toString(36).substring(2)}`,
        from: "your-default-sender@example.com",
        receivedAt: new Date(),
        spamScore: 0,
        tags: [],
      });

      return c.json({
        success: true,
        data: email,
      });
    } catch (error) {
      return this.handleError(c, error);
    }
  };

  private getPaginationParams(c: Context): PaginationParams {
    const { page, limit } = Validator.validatePagination(
      Number(c.req.query("page")),
      Number(c.req.query("limit"))
    );

    return { page, limit };
  }

  private buildQuery(params: {
    status?: string | undefined;
    [key: string]: any;
  }): Record<string, any> {
    return Object.entries(params)
      .filter(([_, value]) => value !== undefined)
      .reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: value,
        }),
        {}
      );
  }

  private async fetchEmailsWithCount(
    query: Record<string, any>,
    { page, limit }: PaginationParams
  ): Promise<{
    emails: EmailDocument[];
    total: number;
  }> {
    const [emails, total] = await Promise.all([
      this.repository.findMany(query, { page, limit }),
      this.baseRepository.getCount(query),
    ]);

    return { emails, total };
  }

  private buildPaginationMeta({
    page,
    limit,
    total,
  }: PaginationParams & { total: number }): PaginationMeta {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  private handleError(c: Context, error: unknown): Response {
    const errorMessage =
      error instanceof Error ? error.message : "An unexpected error occurred";

    this.logger.error("Email handler error:", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      path: c.req.path,
      method: c.req.method,
    });

    return c.json(
      {
        success: false,
        error: errorMessage,
      },
      500
    );
  }
}
