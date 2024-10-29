import { EmailDocument, EmailPriority, EmailCategory } from "@/types/email";

export class EmailClassifier {
  private readonly priorityPatterns = {
    high: [/urgent/i, /asap/i, /important/i, /priority/i],
    low: [/newsletter/i, /subscription/i, /updates/i],
  };

  private readonly categoryPatterns: Record<EmailCategory, RegExp[]> = {
    business: [/invoice/i, /contract/i, /proposal/i, /meeting/i],
    personal: [/family/i, /friend/i, /personal/i],
    marketing: [/offer/i, /discount/i, /sale/i, /promotion/i],
    social: [/social/i, /network/i, /connection/i, /linkedin/i],
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

  public classify(email: Partial<EmailDocument>) {
    const content = `${email.subject} ${email.textContent}`.toLowerCase();

    return {
      priority: this.detectPriority(content),
      categories: this.detectCategories(content),
      spamScore: this.calculateSpamScore(content),
    };
  }

  private detectPriority(content: string): EmailPriority {
    if (this.priorityPatterns.high.some((pattern) => pattern.test(content))) {
      return "high";
    }
    if (this.priorityPatterns.low.some((pattern) => pattern.test(content))) {
      return "low";
    }
    return "normal";
  }

  private detectCategories(content: string): EmailCategory[] {
    return Object.entries(this.categoryPatterns)
      .filter(([_, patterns]) =>
        patterns.some((pattern) => pattern.test(content))
      )
      .map(([category]) => category as EmailCategory);
  }

  private calculateSpamScore(content: string): number {
    let score = 0;
    this.spamPatterns.forEach((pattern) => {
      if (pattern.test(content)) {
        score += 0.2;
      }
    });
    return Math.min(score, 1);
  }
}
