import { Redis } from "@upstash/redis";
import { Logger } from "@/utils/logger";
import { SearchIndexer } from "./indexer";

interface SearchOptions {
  from?: number;
  size?: number;
  filters?: Record<string, any>;
  highlight?: boolean;
  fuzzy?: boolean;
}

interface SearchDocument {
  id: string;
  content: string;
  type: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

interface SearchResult {
  id: string;
  score: number;
  document: SearchDocument;
  highlights?: Record<string, string[]>;
}

interface ZRangeEntry {
  member: string;
  score: number;
}

// Internal type for accessing private members
type InternalIndexer = SearchIndexer & {
  INVERTED_INDEX_PREFIX: string;
  METADATA_PREFIX: string;
  private: {
    tokenizeContent(content: string): Promise<string[]>;
    getDocument(type: string, id: string): Promise<SearchDocument | null>;
  };
};

export class SearchQueryEngine {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly indexer: InternalIndexer;

  constructor() {
    this.redis = new Redis({
      url: Bun.env.UPSTASH_REDIS_REST_URL,
      token: Bun.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.indexer = new SearchIndexer() as InternalIndexer;
  }

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    try {
      const {
        from = 0,
        size = 10,
        filters = {},
        highlight = false,
        fuzzy = false,
      } = options;

      // Access private method through internal type
      const tokens = await this.indexer.private.tokenizeContent(query);

      const termScores = await this.getTermScores(tokens, fuzzy);
      const combinedScores = this.combineScores(termScores);
      const filteredScores = await this.applyFilters(combinedScores, filters);
      const paginatedScores = this.paginateResults(filteredScores, from, size);
      const results = await this.prepareResults(paginatedScores, highlight);

      return results;
    } catch (error) {
      this.logger.error("Error performing search:", error);
      throw error;
    }
  }

  private async getTermScores(
    tokens: string[],
    fuzzy: boolean
  ): Promise<Map<string, number>[]> {
    const termScores: Map<string, number>[] = [];

    for (const token of tokens) {
      const scores = new Map<string, number>();

      const exactMatches = (await this.redis.zrange(
        `${this.indexer.INVERTED_INDEX_PREFIX}${token}`,
        0,
        -1,
        { withScores: true }
      )) as unknown as ZRangeEntry[];

      for (const { member, score } of exactMatches) {
        scores.set(member, score);
      }

      if (fuzzy) {
        const similarTokens = await this.getSimilarTokens(token);
        for (const similarToken of similarTokens) {
          const fuzzyMatches = (await this.redis.zrange(
            `${this.indexer.INVERTED_INDEX_PREFIX}${similarToken}`,
            0,
            -1,
            { withScores: true }
          )) as unknown as ZRangeEntry[];

          for (const { member, score } of fuzzyMatches) {
            const currentScore = scores.get(member) ?? 0;
            scores.set(member, currentScore + score * 0.5);
          }
        }
      }

      termScores.push(scores);
    }

    return termScores;
  }

  private async getSimilarTokens(token: string): Promise<string[]> {
    const allTokens = await this.getAllTokens();
    return allTokens.filter(
      (t) => this.levenshteinDistance(token, t) <= 2 && t !== token
    );
  }

  private levenshteinDistance(a: string, b: string): number {
    const memo = new Map<string, number>();

    const calculate = (i: number, j: number): number => {
      if (i === 0) return j;
      if (j === 0) return i;

      const key = `${i},${j}`;
      if (memo.has(key)) {
        return memo.get(key)!;
      }

      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      const result = Math.min(
        calculate(i - 1, j) + 1,
        calculate(i, j - 1) + 1,
        calculate(i - 1, j - 1) + cost
      );

      memo.set(key, result);
      return result;
    };

    return calculate(a.length, b.length);
  }

  private async getAllTokens(): Promise<string[]> {
    const keys =
      (await this.redis.keys(`${this.indexer.INVERTED_INDEX_PREFIX}*`)) ?? [];
    return keys.map((key) =>
      key.replace(this.indexer.INVERTED_INDEX_PREFIX, "")
    );
  }

  private combineScores(
    termScores: Map<string, number>[]
  ): Map<string, number> {
    const combinedScores = new Map<string, number>();

    for (const scores of termScores) {
      for (const [docId, score] of scores.entries()) {
        const currentScore = combinedScores.get(docId) ?? 0;
        combinedScores.set(docId, currentScore + score);
      }
    }

    return combinedScores;
  }

  private async applyFilters(
    scores: Map<string, number>,
    filters: Record<string, any>
  ): Promise<Map<string, number>> {
    const filteredScores = new Map<string, number>();

    for (const [docId, score] of scores.entries()) {
      const [type, id] = docId.split(":") ?? [];
      if (!type || !id) continue;

      const metadata = await this.redis.hget(
        `${this.indexer.METADATA_PREFIX}${type}`,
        id
      );

      if (!metadata) continue;

      try {
        const docMetadata = JSON.parse(metadata as string);
        let matches = true;

        for (const [key, value] of Object.entries(filters)) {
          if (docMetadata[key] !== value) {
            matches = false;
            break;
          }
        }

        if (matches) {
          filteredScores.set(docId, score);
        }
      } catch (error) {
        this.logger.error(
          `Error parsing metadata for document ${docId}:`,
          error
        );
      }
    }

    return filteredScores;
  }

  private paginateResults(
    scores: Map<string, number>,
    from: number,
    size: number
  ): Array<[string, number]> {
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(from, from + size);
  }

  private async prepareResults(
    scores: Array<[string, number]>,
    highlight: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const [docId, score] of scores) {
      const [type, id] = docId.split(":") ?? [];
      if (!type || !id) continue;

      const doc = await this.indexer.private.getDocument(type, id);
      if (!doc) continue;

      const result: SearchResult = {
        id: doc.id,
        score,
        document: doc,
      };

      if (highlight) {
        result.highlights = this.generateHighlights(doc);
      }

      results.push(result);
    }

    return results;
  }

  private generateHighlights(doc: SearchDocument): Record<string, string[]> {
    if (!doc.content) return {};

    return {
      content: [doc.content.substring(0, 100) + "..."],
    };
  }
}

export type { SearchOptions, SearchResult, SearchDocument };
