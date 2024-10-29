export class SearchQueryEngine {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly indexer: SearchIndexer;

  constructor() {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.logger = Logger.getInstance("production");
    this.indexer = new SearchIndexer();
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

      // Tokenize query
      const tokens = await this.indexer["tokenizeContent"](query);

      // Get document scores for each term
      const termScores = await this.getTermScores(tokens, fuzzy);

      // Combine scores across terms
      const combinedScores = this.combineScores(termScores);

      // Apply filters
      const filteredScores = await this.applyFilters(combinedScores, filters);

      // Sort and paginate
      const paginatedScores = this.paginateResults(filteredScores, from, size);

      // Fetch full documents and prepare results
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

      // Get exact matches
      const exactMatches = await this.redis.zrange(
        `${this.indexer["INVERTED_INDEX_PREFIX"]}${token}`,
        0,
        -1,
        { withScores: true }
      );

      for (const { member, score } of exactMatches) {
        scores.set(member, score);
      }

      // If fuzzy matching is enabled, get similar terms
      if (fuzzy) {
        const similarTokens = await this.getSimilarTokens(token);
        for (const similarToken of similarTokens) {
          const fuzzyMatches = await this.redis.zrange(
            `${this.indexer["INVERTED_INDEX_PREFIX"]}${similarToken}`,
            0,
            -1,
            { withScores: true }
          );

          for (const { member, score } of fuzzyMatches) {
            const currentScore = scores.get(member) || 0;
            scores.set(member, currentScore + score * 0.5); // Reduce score for fuzzy matches
          }
        }
      }

      termScores.push(scores);
    }

    return termScores;
  }

  private async getSimilarTokens(token: string): Promise<string[]> {
    // Implement fuzzy matching logic (e.g., Levenshtein distance)
    // This is a simplified version
    const allTokens = await this.getAllTokens();
    return allTokens.filter(
      (t) => this.levenshteinDistance(token, t) <= 2 && t !== token
    );
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix = Array(b.length + 1)
      .fill(null)
      .map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }

    return matrix[b.length][a.length];
  }

  private async getAllTokens(): Promise<string[]> {
    // In practice, you'd want to cache this and update periodically
    const keys = await this.redis.keys(
      `${this.indexer["INVERTED_INDEX_PREFIX"]}*`
    );
    return keys.map((key) =>
      key.replace(this.indexer["INVERTED_INDEX_PREFIX"], "")
    );
  }

  private combineScores(
    termScores: Map<string, number>[]
  ): Map<string, number> {
    const combinedScores = new Map<string, number>();

    for (const scores of termScores) {
      for (const [docId, score] of scores.entries()) {
        const currentScore = combinedScores.get(docId) || 0;
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
      const [type, id] = docId.split(":");
      const metadata = await this.redis.hget(
        `${this.indexer["METADATA_PREFIX"]}${type}`,
        id
      );

      if (!metadata) continue;

      const docMetadata = JSON.parse(metadata);
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
      const [type, id] = docId.split(":");
      const doc = await this.indexer["getDocument"](type, id);

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
    // Implement highlighting logic
    return {
      content: [doc.content.substring(0, 100) + "..."],
    };
  }
}
