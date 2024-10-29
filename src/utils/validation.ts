import { constants } from "../config/constants";

        export class Validator {
        static isValidEmail(email: string): boolean {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
        }

        static isValidAttachment(
            filename: string,
            size: number,
            mimeType: string
        ): boolean {
            return (
            size <= constants.email.maxAttachmentSize &&
            constants.email.allowedMimeTypes.includes(mimeType)
            );
        }

  static sanitizeString(str: string): string {
    return str.replace(/[<>]/g, "");
  }

  static validatePagination(
    page?: number,
    limit?: number
  ): { page: number; limit: number } {
    return {
      page: Math.max(1, page || 1),
      limit: Math.min(
        constants.pagination.maxLimit,
        limit || constants.pagination.defaultLimit
      ),
    };
  }
}
