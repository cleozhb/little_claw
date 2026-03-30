import { resolve } from "node:path";
import { homedir } from "node:os";
import { SkillMarkdownParser } from "./SkillMarkdownParser";
import type { LoadedSkill } from "./types";

/** 扫描目录优先级：项目级 > 全局 */
const SEARCH_DIRS = [
  "./.little_claw/skills", // 项目级（相对于 cwd）
  "~/.little_claw/skills", // 全局
] as const;

/**
 * 将路径中的 ~ 展开为用户主目录。
 */
function expandHome(dir: string): string {
  if (dir.startsWith("~/") || dir === "~") {
    return dir.replace("~", homedir());
  }
  return dir;
}

/**
 * 扫描指定目录下的子目录，查找包含 SKILL.md 的 Skill。
 */
async function scanDirectory(
  dir: string,
  parser: SkillMarkdownParser,
): Promise<LoadedSkill[]> {
  const absoluteDir = resolve(expandHome(dir));

  try {
    const glob = new Bun.Glob("*/SKILL.md");
    const results: LoadedSkill[] = [];

    for await (const match of glob.scan({ cwd: absoluteDir, absolute: true })) {
      try {
        const parsed = await parser.parse(match);
        results.push({
          parsed,
          source: match,
        });
      } catch (err) {
        // 单个 Skill 加载失败不影响其他 Skill
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SkillLoader] Failed to load ${match}: ${message}`);
      }
    }

    return results;
  } catch {
    // 目录不存在或无法读取，跳过
    return [];
  }
}

export class SkillLoader {
  private parser: SkillMarkdownParser;

  constructor(parser?: SkillMarkdownParser) {
    this.parser = parser ?? new SkillMarkdownParser();
  }

  /**
   * 扫描所有 Skill 目录，返回成功解析的 Skill 列表。
   * 同名 Skill 出现在多个目录时，高优先级（靠前）覆盖低优先级。
   */
  async loadAll(): Promise<LoadedSkill[]> {
    const seen = new Map<string, LoadedSkill>();

    // 按优先级从高到低扫描
    for (const dir of SEARCH_DIRS) {
      const skills = await scanDirectory(dir, this.parser);
      for (const skill of skills) {
        // 高优先级覆盖低优先级：已存在则跳过
        if (!seen.has(skill.parsed.name)) {
          seen.set(skill.parsed.name, skill);
        }
      }
    }

    return Array.from(seen.values());
  }
}
