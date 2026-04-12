/**
 * src/skills/SkillIndexer.ts — Skill 索引构建器
 *
 * 从 ParsedSkill 中提取关键词、生成 embedding，写入 skill_index 表。
 * 支持变更检测，description 未变则跳过重建。
 */

import type { Database, SkillIndexRow } from "../db/Database";
import type { EmbeddingProvider } from "../memory/EmbeddingProvider";
import type { ParsedSkill } from "./types";
import { tokenize } from "./tokenize";

export class SkillIndexer {
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
  ) {}

  /**
   * 对所有 skill 建立索引（跳过未变化的）。
   */
  async indexAll(skills: ParsedSkill[]): Promise<void> {
    const existing = new Map<string, SkillIndexRow>();
    for (const row of this.db.getAllSkillIndex()) {
      existing.set(row.skill_name, row);
    }

    for (const skill of skills) {
      const old = existing.get(skill.name);
      const descHash = simpleHash(skill.description);

      // 变更检测：description hash 存在 instructions_summary 字段中
      if (old && old.instructions_summary === descHash) {
        continue;
      }

      await this.indexOne(skill, descHash);
    }

    // 删除已不存在的 skill 索引
    const currentNames = new Set(skills.map((s) => s.name));
    for (const name of existing.keys()) {
      if (!currentNames.has(name)) {
        this.db.deleteSkillIndex(name);
      }
    }
  }

  /**
   * 对单个 skill 建立索引。
   */
  async indexOne(skill: ParsedSkill, descHash?: string): Promise<void> {
    const keywords = extractKeywords(skill);
    const embeddingVec = await this.embedding.embed(skill.description);

    const row: SkillIndexRow = {
      skill_name: skill.name,
      description: skill.description,
      instructions_summary: descHash ?? simpleHash(skill.description),
      keywords,
      embedding: JSON.stringify(embeddingVec),
      updated_at: new Date().toISOString(),
    };

    this.db.upsertSkillIndex(row);
  }
}

/**
 * 从 skill 中提取关键词，用于 BM25 检索。
 */
function extractKeywords(skill: ParsedSkill): string {
  // 合并名称（按 - 拆分）、描述、tags、instructions 前 1000 字符
  const parts: string[] = [];

  // name 按 - 拆分
  parts.push(...skill.name.split(/[-_]/));

  // description
  parts.push(skill.description);

  // tags
  if (skill.tags) {
    parts.push(...skill.tags);
  }

  // instructions 前 1000 字符
  parts.push(skill.instructions.slice(0, 1000));

  const text = parts.join(" ");
  const tokens = tokenize(text);
  return [...new Set(tokens)].join(" ");
}

/**
 * 简单的字符串 hash（用于变更检测，非安全用途）。
 */
function simpleHash(str: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(str);
  return hasher.digest("hex").slice(0, 16);
}
