/**
 * src/skills/SkillFilter.ts — Skill 候选过滤（A+B+D）
 *
 * A: 向量阈值 — vectorScore >= 0.5 或 BM25 > 0
 * B: Gap 判断 — BM25 全为 0 时，top1 与 top2 vectorScore 差值 >= 0.05
 * D: Rerank  — 通过 A+B 的候选送 rerank 模型二次确认
 */

import type { ScoredSkill } from "./types";
import type { SkillReranker } from "./SkillReranker";

const MIN_VECTOR_SCORE = 0.5;
const MIN_VECTOR_GAP = 0.05;

export async function filterSkillCandidates(
  query: string,
  results: ScoredSkill[],
  reranker?: SkillReranker,
): Promise<ScoredSkill[]> {
  // A: 向量阈值
  const passed = results.filter(r => r.bm25Score > 0 || r.vectorScore >= MIN_VECTOR_SCORE);
  if (passed.length === 0) return [];

  // B: gap 判断（BM25 全为 0 时）
  const hasBM25 = passed.some(r => r.bm25Score > 0);
  if (!hasBM25 && passed.length >= 2) {
    const gap = passed[0]!.vectorScore - passed[1]!.vectorScore;
    if (gap < MIN_VECTOR_GAP) return [];
  }

  // D: rerank
  if (reranker) {
    const top3 = passed.slice(0, 3);
    return reranker.rerank(query, top3);
  }

  return passed;
}
