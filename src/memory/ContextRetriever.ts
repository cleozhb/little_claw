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

import type { Database } from "../db/Database.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import { tokenize } from "../retrieval/tokenizer.ts";
import { computeBM25, matchedTokens } from "../retrieval/bm25.ts";
import { cosineSimilarity, parseEmbedding } from "../retrieval/vector.ts";

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
  embeddingStatus: "ready" | "missing";
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
    const rows = this.db.getAllContextIndex().filter((row) => isActiveContextPath(row.dir_path));
    if (rows.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryEmbedding = await this.embedQuerySafely(query);
    const signature = this.embedding.getSignature?.() ?? "unknown";
    const docs = rows.map((row) => ({ id: row.dir_path, tokens: row.keywords.split(/\s+/).filter(Boolean) }));
    const bm25 = computeBM25(queryTokens, docs);
    const maxBM25 = Math.max(0, ...bm25.values());
    const bm25Ranking = [...rows]
      .filter((row) => (bm25.get(row.dir_path) ?? 0) > 0)
      .sort((a, b) => (bm25.get(b.dir_path) ?? 0) - (bm25.get(a.dir_path) ?? 0));
    const vectorScores = new Map<string, number>();
    if (queryEmbedding?.length) {
      for (const row of rows) {
        if (
          row.embedding_status !== "ready" || row.embedding_signature !== signature ||
          row.embedding_dimensions !== queryEmbedding.length
        ) continue;
        vectorScores.set(row.dir_path, cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding)));
      }
    }
    const vectorRanking = [...rows]
      .filter((row) => (vectorScores.get(row.dir_path) ?? -1) >= 0.4)
      .sort((a, b) => (vectorScores.get(b.dir_path) ?? 0) - (vectorScores.get(a.dir_path) ?? 0));
    const fused = reciprocalRankFusion(
      bm25Ranking.map((row) => row.dir_path),
      vectorRanking.map((row) => row.dir_path),
    );

    const rowByPath = new Map(rows.map((row) => [row.dir_path, row]));
    const results: ScoredContext[] = [];

    for (const [id, fusedScore] of fused) {
      const row = rowByPath.get(id);
      if (!row) continue;
      const dirPrefix = row.dir_path.split("/")[0] ?? "";
      const multiplier = DIR_WEIGHT_MULTIPLIERS[dirPrefix] ?? 1.0;

      // 构建 matchReason
      const reasons: string[] = [];
      const rawBm25 = bm25.get(id) ?? 0;
      const bm25Score = maxBM25 > 0 ? rawBm25 / maxBM25 : 0;
      const vectorScore = vectorScores.get(id) ?? 0;
      if (rawBm25 > 0) {
        reasons.push(`keyword: ${matchedTokens(queryTokens, row.keywords).join(", ")}`);
      }
      if (vectorScore >= 0.4) {
        reasons.push(`vector: ${vectorScore.toFixed(2)}`);
      }
      if (multiplier !== 1.0) {
        reasons.push(`weight: ×${multiplier}`);
      }

      results.push({
        dirPath: row.dir_path,
        overviewContent: row.overview_content,
        score: fusedScore * multiplier,
        bm25Score,
        vectorScore,
        matchReason: reasons.join(" | ") || "low relevance",
        embeddingStatus: row.embedding_status,
      });
    }

    // 按分数降序排列，取 topK
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private async embedQuerySafely(query: string): Promise<number[] | undefined> {
    try {
      return await this.embedding.embed(query);
    } catch {
      return undefined;
    }
  }
}

function reciprocalRankFusion(...rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + index)));
  }
  return scores;
}

function isActiveContextPath(path: string): boolean {
  return path.startsWith("2-areas") ||
    path.startsWith("3-projects") ||
    path.startsWith("4-knowledge") ||
    path.startsWith("5-archive");
}
