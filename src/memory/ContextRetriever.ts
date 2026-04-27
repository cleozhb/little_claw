/**
 * src/memory/ContextRetriever.ts — BM25 + 向量混合检索 .overview.md
 *
 * 从 context_index 表读取关键词和 embedding，
 * 对用户查询做 BM25 + 余弦相似度混合打分，返回 topK 结果。
 *
 * 权重配置（按目录）：
 *   2-areas/    × 1.2
 *   3-projects/  × 1.3（活跃项目最重要）
 *   4-knowledge/ × 1.0
 *   5-archive/   × 0.3（大幅降权）
 */

import type { Database, ContextIndexRow } from "../db/Database.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import { tokenize } from "../skills/tokenize.ts";

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_WEIGHT = 0.3;
const VECTOR_WEIGHT = 0.7;

/** 各目录前缀的检索权重乘数 */
const DIR_WEIGHT_MULTIPLIERS: Record<string, number> = {
  "2-areas": 1.2,
  "3-projects": 1.3,
  "4-knowledge": 1.0,
  "5-archive": 0.3,
};

export interface ScoredContext {
  dirPath: string;
  overviewContent: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  matchReason: string;
}

export class ContextRetriever {
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
  ) {}

  /**
   * 混合检索：BM25 + 向量相似度，对 .overview.md 文件检索。
   */
  async retrieve(query: string, topK = 2): Promise<ScoredContext[]> {
    const rows = this.db.getAllContextIndex();
    if (rows.length === 0) return [];

    const queryTokens = tokenize(query);

    // --- BM25 ---
    const bm25Scores = this.computeBM25(queryTokens, rows);

    // --- 向量相似度 ---
    const queryEmbedding = await this.embedding.embed(query);
    const vectorScores = new Map<string, number>();
    for (const row of rows) {
      const embedding: number[] = JSON.parse(row.embedding);
      vectorScores.set(row.dir_path, cosineSimilarity(queryEmbedding, embedding));
    }

    // --- 混合打分 ---
    const maxBM25 = Math.max(...bm25Scores.values(), 0);
    const results: ScoredContext[] = [];

    for (const row of rows) {
      const rawBM25 = bm25Scores.get(row.dir_path) ?? 0;
      const normalizedBM25 = maxBM25 > 0 ? rawBM25 / maxBM25 : 0;
      const vecScore = vectorScores.get(row.dir_path) ?? 0;
      let finalScore = BM25_WEIGHT * normalizedBM25 + VECTOR_WEIGHT * vecScore;

      // 按目录前缀应用权重乘数
      const dirPrefix = row.dir_path.split("/")[0] ?? "";
      const multiplier = DIR_WEIGHT_MULTIPLIERS[dirPrefix] ?? 1.0;
      finalScore *= multiplier;

      // 构建 matchReason
      const reasons: string[] = [];
      if (rawBM25 > 0) {
        const matchedTokens = this.getMatchedTokens(queryTokens, row.keywords);
        reasons.push(`keyword: ${matchedTokens.join(", ")}`);
      }
      if (vecScore > 0.3) {
        reasons.push(`vector: ${vecScore.toFixed(2)}`);
      }
      if (multiplier !== 1.0) {
        reasons.push(`weight: ×${multiplier}`);
      }

      results.push({
        dirPath: row.dir_path,
        overviewContent: row.overview_content,
        score: finalScore,
        bm25Score: normalizedBM25,
        vectorScore: vecScore,
        matchReason: reasons.join(" | ") || "low relevance",
      });
    }

    // 按分数降序排列，取 topK
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * BM25 计算。
   */
  private computeBM25(
    queryTokens: string[],
    rows: ContextIndexRow[],
  ): Map<string, number> {
    const N = rows.length;

    const docTokens = new Map<string, string[]>();
    let totalLength = 0;
    for (const row of rows) {
      const tokens = row.keywords.split(/\s+/).filter(Boolean);
      docTokens.set(row.dir_path, tokens);
      totalLength += tokens.length;
    }
    const avgdl = totalLength / N;

    // IDF
    const idf = new Map<string, number>();
    for (const qt of queryTokens) {
      let n = 0;
      for (const tokens of docTokens.values()) {
        if (tokens.includes(qt)) n++;
      }
      idf.set(qt, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }

    // BM25 score per document
    const scores = new Map<string, number>();
    for (const row of rows) {
      const tokens = docTokens.get(row.dir_path)!;
      const dl = tokens.length;
      let score = 0;

      for (const qt of queryTokens) {
        const tf = tokens.filter((t) => t === qt).length;
        if (tf === 0) continue;
        const idfVal = idf.get(qt) ?? 0;
        score += idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));
      }

      scores.set(row.dir_path, score);
    }

    return scores;
  }

  /**
   * 找出查询 token 中与文档 keywords 匹配的词。
   */
  private getMatchedTokens(queryTokens: string[], keywords: string): string[] {
    const keywordSet = new Set(keywords.split(/\s+/));
    return queryTokens.filter((t) => keywordSet.has(t));
  }
}

/**
 * 余弦相似度计算。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
