import type { ParsedSkill } from "./types";

const DEFAULT_TOKEN_BUDGET = 20000;
const CHARS_PER_TOKEN = 4;

/** 引导语，追加到基础 system prompt 之后、skill 列表之前 */
export const SKILL_GUIDE =
  `Below are skills that provide specialized knowledge and instructions.
IMPORTANT: Skills are NOT tools — do NOT attempt to call them via tool_use. Instead, when a user's request matches a skill's description, directly follow the skill's instructions in your response. You may use your available tools (shell, read_file, write_file, etc.) as needed to carry out the skill's instructions.
When you decide to follow a skill's instructions, you MUST begin your response with a brief note indicating which skill you are using, in this exact format: "> {skill-name}". For example: "> elon-musk-perspective". This helps the user understand which skill is guiding your response.`;

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
   * 把预筛选的 Skill 列表组装成嵌入 system prompt 的 XML 文本。
   *
   * skills 已由 SkillRetriever 按相关性排好序，这里只做 token 预算控制：
   * 按顺序尝试完整包含，超预算时降级为摘要或截断。
   *
   * @param skills 已排序的 Skill 列表（检索器输出 or 全量）
   * @param tokenBudget token 预算（默认 20000）
   */
  buildSkillPrompt(
    skills: ParsedSkill[],
    tokenBudget = DEFAULT_TOKEN_BUDGET,
  ): string {
    if (skills.length === 0) return "";

    const charBudget = tokenBudget * CHARS_PER_TOKEN;

    // 尝试全量包含（skill 少且预算够时直接全量）
    const fullBlocks = skills.map(buildFullSkillBlock);
    const fullContent = fullBlocks.join("\n");
    const wrappedFull = `<available_skills>\n${fullContent}\n</available_skills>`;

    if (wrappedFull.length <= charBudget) {
      return wrappedFull;
    }

    // 超出预算：按顺序尝试完整包含，放不下则降级为摘要
    const wrapperOverhead = "<available_skills>\n</available_skills>".length;
    let remaining = charBudget - wrapperOverhead;

    const blocks: string[] = [];

    for (const skill of skills) {
      const fullBlock = buildFullSkillBlock(skill);
      if (fullBlock.length + 1 <= remaining) {
        blocks.push(fullBlock);
        remaining -= fullBlock.length + 1;
        continue;
      }

      // 降级为摘要
      const summary = buildSummarySkillBlock(skill);
      if (summary.length + 1 <= remaining) {
        blocks.push(summary);
        remaining -= summary.length + 1;
      }
      // 摘要也放不下就跳过
    }

    if (blocks.length === 0) return "";

    return `<available_skills>\n${blocks.join("\n")}\n</available_skills>`;
  }
}
