/**
 * src/skills/SkillReranker.ts — Rerank 二次确认
 *
 * 对通过初筛的 skill 候选，调用 rerank 模型做精确相关性判断。
 */

import type { ScoredSkill } from "./types";

export interface RerankConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  threshold?: number;
}

const DEFAULT_MODEL = "qwen3-reranker-8b";
const DEFAULT_BASE_URL = "https://qianfan.baidubce.com/v2/rerank";
const DEFAULT_THRESHOLD = 0.5;

export class SkillReranker {
  private apiKey: string;
  private model: string;
  private baseURL: string;
  readonly threshold: number;

  constructor(config: RerankConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
  }

  async rerank(query: string, candidates: ScoredSkill[]): Promise<ScoredSkill[]> {
    if (candidates.length === 0) return [];

    const documents = candidates.map(c =>
      `${c.skill.name}: ${c.skill.description}\n${c.skill.instructions.slice(0, 500)}`
    );

    const response = await fetch(this.baseURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, query, documents, top_n: candidates.length }),
    });

    if (!response.ok) {
      if (process.env.DEBUG) {
        const text = await response.text();
        console.error(`[SkillReranker] API error ${response.status}: ${text}`);
      }
      return candidates;
    }

    const data = await response.json() as { results: { index: number; relevance_score: number }[] };

    return data.results
      .filter(r => r.relevance_score >= this.threshold)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map(r => candidates[r.index]!);
  }
}
