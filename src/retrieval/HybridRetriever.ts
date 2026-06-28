import { computeBM25, matchedTokens } from "./bm25.ts";
import { cosineSimilarity } from "./vector.ts";

export const DEFAULT_BM25_WEIGHT = 0.3;
export const DEFAULT_VECTOR_WEIGHT = 0.7;

export interface HybridDocument {
  id: string;
  tokens: string[];
  embedding?: number[];
  weight?: number;
}

export interface HybridSearchOptions {
  queryTokens: string[];
  queryEmbedding?: number[];
  documents: HybridDocument[];
  topK?: number;
  bm25Weight?: number;
  vectorWeight?: number;
}

export interface HybridSearchResult {
  id: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  rawBm25Score: number;
  matchedTokens: string[];
}

export function retrieveHybrid(options: HybridSearchOptions): HybridSearchResult[] {
  const topK = Math.max(1, Math.floor(options.topK ?? 5));
  if (options.documents.length === 0) return [];

  const bm25Scores = computeBM25(options.queryTokens, options.documents);
  const maxBM25 = Math.max(...bm25Scores.values(), 0);
  const hasVector =
    !!options.queryEmbedding &&
    options.documents.some((doc) => Array.isArray(doc.embedding) && doc.embedding.length > 0);
  const bm25Weight = hasVector ? options.bm25Weight ?? DEFAULT_BM25_WEIGHT : 1;
  const vectorWeight = hasVector ? options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT : 0;

  const results = options.documents.map((doc) => {
    const rawBm25Score = bm25Scores.get(doc.id) ?? 0;
    const bm25Score = maxBM25 > 0 ? rawBm25Score / maxBM25 : 0;
    const vectorScore = hasVector ? cosineSimilarity(options.queryEmbedding, doc.embedding) : 0;
    const score = (bm25Weight * bm25Score + vectorWeight * vectorScore) * (doc.weight ?? 1);
    return {
      id: doc.id,
      score,
      bm25Score,
      vectorScore,
      rawBm25Score,
      matchedTokens: matchedTokens(options.queryTokens, doc.tokens),
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

