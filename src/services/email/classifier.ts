import { EmailCategory, EmailPriority, EmailDocument } from "@/types/email";

export class EmailClassifier {
  private readonly priorityPatterns = {
    high: [/urgent/i, /asap/i, /important/i, /priority/i],
    low: [/newsletter/i, /subscription/i, /updates/i],
  };

  private readonly categoryPatterns: Record<EmailCategory, RegExp[]> = {
    [EmailCategory.Business]: [
      /invoice/i,
      /contract/i,
      /proposal/i,
      /meeting/i,
    ],
    [EmailCategory.Personal]: [/family/i, /friend/i, /personal/i],
    [EmailCategory.Marketing]: [/offer/i, /discount/i, /sale/i, /promotion/i],
    [EmailCategory.Social]: [/social/i, /network/i, /connection/i, /linkedin/i],
  };

  private readonly spamPatterns = [
    /win|winner/i,
    /lottery/i,
    /prize/i,
    /million dollars/i,
    /cryptocurrency offer/i,
    /bank transfer/i,
    /nigerian prince/i,
  ];

  public classify(email: Partial<EmailDocument>): {
    priority: EmailPriority;
    categories: EmailCategory[];
    spamScore: number;
  } {
    const content =
      `${email.subject || ""} ${email.textContent || ""}`.toLowerCase();

    return {
      priority: this.detectPriority(content),
      categories: this.detectCategories(content),
      spamScore: this.calculateSpamScore(content),
    };
  }

  private detectPriority(content: string): EmailPriority {
    if (this.priorityPatterns.high.some((pattern) => pattern.test(content))) {
      return EmailPriority.High;
    }
    if (this.priorityPatterns.low.some((pattern) => pattern.test(content))) {
      return EmailPriority.Low;
    }
    return EmailPriority.Normal;
  }

  private detectCategories(content: string): EmailCategory[] {
    return Object.entries(this.categoryPatterns)
      .filter(([_, patterns]) =>
        patterns.some((pattern) => pattern.test(content))
      )
      .map(([category]) => category as EmailCategory);
  }

  private calculateSpamScore(content: string): number {
    const baseScore = this.spamPatterns.reduce((score, pattern) => {
      return pattern.test(content) ? score + 0.2 : score;
    }, 0);

    return Math.min(baseScore, 1);
  }

  public async classifyWithML(email: Partial<EmailDocument>): Promise<{
    priority: EmailPriority;
    categories: EmailCategory[];
    spamScore: number;
    confidence: number;
  }> {
    const basicResults = this.classify(email);
    const enhancedResults = await this.enhanceClassification(
      email,
      basicResults
    );

    return {
      ...enhancedResults,
      confidence: this.calculateConfidence(enhancedResults),
    };
  }

  private async enhanceClassification(
    email: Partial<EmailDocument>,
    basicResults: {
      priority: EmailPriority;
      categories: EmailCategory[];
      spamScore: number;
    }
  ) {
    // ML-based enhancements would go here
    return basicResults;
  }

  private calculateConfidence(results: {
    priority: EmailPriority;
    categories: EmailCategory[];
    spamScore: number;
  }): number {
    const categoryConfidence = results.categories.length > 0 ? 0.5 : 0.3;
    const spamConfidence = results.spamScore > 0.8 ? 0.9 : 0.5;
    const priorityConfidence =
      results.priority !== EmailPriority.Normal ? 0.8 : 0.4;

    return (categoryConfidence + spamConfidence + priorityConfidence) / 3;
  }

  public updatePatterns(newPatterns: {
    priority?: {
      high: RegExp[];
      low: RegExp[];
    };
    category?: Record<EmailCategory, RegExp[]>;
    spam?: RegExp[];
  }): void {
    if (newPatterns.priority) {
      this.validatePriorityPatterns(newPatterns.priority);
      Object.assign(this.priorityPatterns, newPatterns.priority);
    }

    if (newPatterns.category) {
      this.validateCategoryPatterns(newPatterns.category);
      Object.assign(this.categoryPatterns, newPatterns.category);
    }

    if (newPatterns.spam) {
      this.validateSpamPatterns(newPatterns.spam);
      this.spamPatterns.push(...newPatterns.spam);
    }
  }

  private validatePriorityPatterns(patterns: {
    high: RegExp[];
    low: RegExp[];
  }): void {
    if (!patterns.high?.length || !patterns.low?.length) {
      throw new Error("Invalid priority patterns structure");
    }
  }

  private validateCategoryPatterns(
    patterns: Record<EmailCategory, RegExp[]>
  ): void {
    for (const category of Object.values(EmailCategory)) {
      if (!patterns[category]?.length) {
        throw new Error(`Missing patterns for category: ${category}`);
      }
    }
  }

  private validateSpamPatterns(patterns: RegExp[]): void {
    if (!Array.isArray(patterns) || !patterns.length) {
      throw new Error("Spam patterns must be a non-empty array");
    }
  }
}
