/**
 * src/skills/SkillRetriever.ts — BM25 + 向量混合检索
 *
 * 从 skill_index 表读取关键词和 embedding，
 * 对用户查询做 BM25 + 余弦相似度混合打分，返回 topK 结果。
 */

import type { Database } from "../db/Database";
import type { EmbeddingProvider } from "../memory/EmbeddingProvider";
import type { ParsedSkill, ScoredSkill } from "./types";
import { tokenize } from "../retrieval/tokenizer.ts";
import { retrieveHybrid } from "../retrieval/HybridRetriever.ts";
import { parseEmbedding } from "../retrieval/vector.ts";

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

    // --- 向量相似度 ---
    const queryEmbedding = await this.embedding.embed(query);
    const hybridResults = retrieveHybrid({
      queryTokens,
      queryEmbedding,
      topK: rows.length,
      documents: rows.map((row) => ({
        id: row.skill_name,
        tokens: row.keywords.split(/\s+/).filter(Boolean),
        embedding: parseEmbedding(row.embedding),
      })),
    });

    const rowByName = new Map(rows.map((row) => [row.skill_name, row]));
    const results: ScoredSkill[] = [];
    for (const scored of hybridResults) {
      const row = rowByName.get(scored.id);
      if (!row) continue;
      const skill = skillMap.get(row.skill_name);
      if (!skill) continue;

      // 构建 matchReason
      const reasons: string[] = [];
      if (scored.rawBm25Score > 0) {
        reasons.push(`keyword: ${scored.matchedTokens.join(", ")}`);
      }
      if (scored.vectorScore > 0.3) {
        reasons.push(`vector: ${scored.vectorScore.toFixed(2)}`);
      }

      results.push({
        skill,
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
