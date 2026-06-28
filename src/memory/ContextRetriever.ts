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
import { retrieveHybrid } from "../retrieval/HybridRetriever.ts";
import { parseEmbedding } from "../retrieval/vector.ts";

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

    // --- 向量相似度 ---
    const queryEmbedding = await this.embedding.embed(query);
    const hybridResults = retrieveHybrid({
      queryTokens,
      queryEmbedding,
      topK: rows.length,
      documents: rows.map((row) => {
        const dirPrefix = row.dir_path.split("/")[0] ?? "";
        return {
          id: row.dir_path,
          tokens: row.keywords.split(/\s+/).filter(Boolean),
          embedding: parseEmbedding(row.embedding),
          weight: DIR_WEIGHT_MULTIPLIERS[dirPrefix] ?? 1.0,
        };
      }),
    });

    const rowByPath = new Map(rows.map((row) => [row.dir_path, row]));
    const results: ScoredContext[] = [];

    for (const scored of hybridResults) {
      const row = rowByPath.get(scored.id);
      if (!row) continue;
      const dirPrefix = row.dir_path.split("/")[0] ?? "";
      const multiplier = DIR_WEIGHT_MULTIPLIERS[dirPrefix] ?? 1.0;

      // 构建 matchReason
      const reasons: string[] = [];
      if (scored.rawBm25Score > 0) {
        reasons.push(`keyword: ${scored.matchedTokens.join(", ")}`);
      }
      if (scored.vectorScore > 0.3) {
        reasons.push(`vector: ${scored.vectorScore.toFixed(2)}`);
      }
      if (multiplier !== 1.0) {
        reasons.push(`weight: ×${multiplier}`);
      }

      results.push({
        dirPath: row.dir_path,
        overviewContent: row.overview_content,
        score: scored.score,
        bm25Score: scored.bm25Score,
        vectorScore: scored.vectorScore,
        matchReason: reasons.join(" | ") || "low relevance",
      });
    }

    // 按分数降序排列，取 topK
    return results.slice(0, topK);
  }
}
