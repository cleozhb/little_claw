export const DEFAULT_BM25_K1 = 1.5;
export const DEFAULT_BM25_B = 0.75;

export interface BM25Document {
  id: string;
  tokens: string[];
}

export interface BM25Options {
  k1?: number;
  b?: number;
}

export function computeBM25(
  queryTokens: string[],
  documents: BM25Document[],
  options: BM25Options = {},
): Map<string, number> {
  const scores = new Map<string, number>();
  if (documents.length === 0 || queryTokens.length === 0) return scores;

  const k1 = options.k1 ?? DEFAULT_BM25_K1;
  const b = options.b ?? DEFAULT_BM25_B;
  const totalLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0);
  const avgdl = totalLength > 0 ? totalLength / documents.length : 1;
  const query = [...new Set(queryTokens)];
  const idf = new Map<string, number>();

  for (const token of query) {
    let docsWithToken = 0;
    for (const doc of documents) {
      if (doc.tokens.includes(token)) docsWithToken++;
    }
    idf.set(token, Math.log((documents.length - docsWithToken + 0.5) / (docsWithToken + 0.5) + 1));
  }

  for (const doc of documents) {
    const termFrequency = new Map<string, number>();
    for (const token of doc.tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }

    let score = 0;
    const dl = Math.max(1, doc.tokens.length);
    for (const token of query) {
      const tf = termFrequency.get(token) ?? 0;
      if (tf === 0) continue;
      const idfVal = idf.get(token) ?? 0;
      score += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
    }
    scores.set(doc.id, score);
  }

  return scores;
}

export function matchedTokens(queryTokens: string[], documentTokens: string[] | string): string[] {
  const docSet = new Set(Array.isArray(documentTokens) ? documentTokens : documentTokens.split(/\s+/).filter(Boolean));
  return [...new Set(queryTokens.filter((token) => docSet.has(token)))];
}

