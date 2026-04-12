/**
 * src/skills/SkillRetriever.ts — BM25 + 向量混合检索
 *
 * 从 skill_index 表读取关键词和 embedding，
 * 对用户查询做 BM25 + 余弦相似度混合打分，返回 topK 结果。
 */

import type { Database, SkillIndexRow } from "../db/Database";
import type { EmbeddingProvider } from "../memory/EmbeddingProvider";
import type { ParsedSkill, ScoredSkill } from "./types";
import { tokenize } from "./tokenize";

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_WEIGHT = 0.3;
const VECTOR_WEIGHT = 0.7;

export class SkillRetriever {
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    private getSkillMap: () => Map<string, ParsedSkill>,
  ) {}

  /**
   * 混合检索：BM25 + 向量相似度。
   */
  async retrieve(query: string, topK = 5): Promise<ScoredSkill[]> {
    const rows = this.db.getAllSkillIndex();
    if (rows.length === 0) return [];

    const skillMap = this.getSkillMap();
    const queryTokens = tokenize(query);

    // --- BM25 ---
    const bm25Scores = this.computeBM25(queryTokens, rows);

    // --- 向量相似度 ---
    const queryEmbedding = await this.embedding.embed(query);
    const vectorScores = new Map<string, number>();
    for (const row of rows) {
      const embedding: number[] = JSON.parse(row.embedding);
      vectorScores.set(row.skill_name, cosineSimilarity(queryEmbedding, embedding));
    }

    // --- 混合打分 ---
    const maxBM25 = Math.max(...bm25Scores.values(), 0);
    const results: ScoredSkill[] = [];

    for (const row of rows) {
      const skill = skillMap.get(row.skill_name);
      if (!skill) continue;

      const rawBM25 = bm25Scores.get(row.skill_name) ?? 0;
      const normalizedBM25 = maxBM25 > 0 ? rawBM25 / maxBM25 : 0;
      const vecScore = vectorScores.get(row.skill_name) ?? 0;
      const finalScore = BM25_WEIGHT * normalizedBM25 + VECTOR_WEIGHT * vecScore;

      // 构建 matchReason
      const reasons: string[] = [];
      if (rawBM25 > 0) {
        const matchedTokens = this.getMatchedTokens(queryTokens, row.keywords);
        reasons.push(`keyword: ${matchedTokens.join(", ")}`);
      }
      if (vecScore > 0.3) {
        reasons.push(`vector: ${vecScore.toFixed(2)}`);
      }

      results.push({
        skill,
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
    rows: SkillIndexRow[],
  ): Map<string, number> {
    const N = rows.length;

    // 预计算：每个文档的 token 列表和文档长度
    const docTokens = new Map<string, string[]>();
    let totalLength = 0;
    for (const row of rows) {
      const tokens = row.keywords.split(/\s+/).filter(Boolean);
      docTokens.set(row.skill_name, tokens);
      totalLength += tokens.length;
    }
    const avgdl = totalLength / N;

    // 计算每个 query token 的 IDF
    const idf = new Map<string, number>();
    for (const qt of queryTokens) {
      let n = 0;
      for (const tokens of docTokens.values()) {
        if (tokens.includes(qt)) n++;
      }
      idf.set(qt, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }

    // 计算每个文档的 BM25 分数
    const scores = new Map<string, number>();
    for (const row of rows) {
      const tokens = docTokens.get(row.skill_name)!;
      const dl = tokens.length;
      let score = 0;

      for (const qt of queryTokens) {
        const tf = tokens.filter((t) => t === qt).length;
        if (tf === 0) continue;
        const idfVal = idf.get(qt) ?? 0;
        score += idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));
      }

      scores.set(row.skill_name, score);
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
