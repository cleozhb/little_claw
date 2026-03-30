import type { ParsedSkill } from "./types";

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

/** 引导语，追加到基础 system prompt 之后、skill 列表之前 */
export const SKILL_GUIDE =
  "You have access to skills that extend your capabilities. When a user's request matches a skill's description, follow the skill's instructions. Skills may require you to use shell commands or other tools to complete tasks.";

/**
 * 粗略估算字符串的 token 数（字符数 / 4）。
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 将 instructions 中的 {baseDir} 占位符替换为 Skill 的实际目录路径。
 * 兼容 OpenClaw 规范中引用 Skill 目录内文件的方式。
 */
function resolveBaseDir(instructions: string, sourcePath: string): string {
  return instructions.replaceAll("{baseDir}", sourcePath);
}

/**
 * 生成单个 Skill 的完整 XML 块（含 instructions body）。
 */
function buildFullSkillBlock(skill: ParsedSkill): string {
  const instructions = resolveBaseDir(skill.instructions, skill.sourcePath);
  return `<skill name="${escapeXmlAttr(skill.name)}" description="${escapeXmlAttr(skill.description)}">\n${instructions}\n</skill>`;
}

/**
 * 生成单个 Skill 的摘要 XML 块（仅 name + description，不含 body）。
 */
function buildSummarySkillBlock(skill: ParsedSkill): string {
  return `<skill name="${escapeXmlAttr(skill.name)}" description="${escapeXmlAttr(skill.description)}" />`;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class SkillPromptBuilder {
  /**
   * 把已加载的 Skill 列表组装成嵌入 system prompt 的 XML 文本。
   *
   * @param skills 已加载的 Skill 列表
   * @param tokenBudget token 预算（默认 4000）
   * @param recentlyUsed 最近被 Agent 使用过的 Skill name 集合（优先保留完整指令）
   */
  buildSkillPrompt(
    skills: ParsedSkill[],
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    recentlyUsed?: Set<string>,
  ): string {
    if (skills.length === 0) return "";

    const charBudget = tokenBudget * CHARS_PER_TOKEN;

    // 尝试全量包含
    const fullBlocks = skills.map(buildFullSkillBlock);
    const fullContent = fullBlocks.join("\n");
    const wrappedFull = `<available_skills>\n${fullContent}\n</available_skills>`;

    if (wrappedFull.length <= charBudget) {
      return wrappedFull;
    }

    // 超出预算：按优先级分配
    // 优先保留最近使用过的 Skill 完整指令
    const used = recentlyUsed ?? new Set<string>();
    const prioritized: ParsedSkill[] = [];
    const rest: ParsedSkill[] = [];

    for (const skill of skills) {
      if (used.has(skill.name)) {
        prioritized.push(skill);
      } else {
        rest.push(skill);
      }
    }

    // wrapper 的固定开销
    const wrapperOverhead = "<available_skills>\n</available_skills>".length;
    let remaining = charBudget - wrapperOverhead;

    const blocks: string[] = [];

    // 1. 优先加入最近使用过的 Skill（完整指令）
    for (const skill of prioritized) {
      const block = buildFullSkillBlock(skill);
      if (block.length + 1 <= remaining) {
        // +1 for newline
        blocks.push(block);
        remaining -= block.length + 1;
      } else {
        // 即使是优先的，超出预算也降级为摘要
        const summary = buildSummarySkillBlock(skill);
        if (summary.length + 1 <= remaining) {
          blocks.push(summary);
          remaining -= summary.length + 1;
        }
      }
    }

    // 2. 剩余 Skill：尝试完整包含，不够则摘要
    for (const skill of rest) {
      const fullBlock = buildFullSkillBlock(skill);
      if (fullBlock.length + 1 <= remaining) {
        blocks.push(fullBlock);
        remaining -= fullBlock.length + 1;
      } else {
        const summary = buildSummarySkillBlock(skill);
        if (summary.length + 1 <= remaining) {
          blocks.push(summary);
          remaining -= summary.length + 1;
        }
        // 摘要也放不下就跳过
      }
    }

    if (blocks.length === 0) return "";

    return `<available_skills>\n${blocks.join("\n")}\n</available_skills>`;
  }
}
