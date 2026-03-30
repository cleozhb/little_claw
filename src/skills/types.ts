export interface SkillRequires {
  /** 需要的环境变量名 */
  env: string[];
  /** 需要全部存在的命令行工具 */
  bins: string[];
  /** 至少存在一个即可的命令行工具 */
  anyBins: string[];
  /** 需要的配置文件路径 */
  config: string[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  version: string;
  emoji?: string;
  author?: string;
  tags?: string[];
  requires: SkillRequires;
  /** 主要的认证环境变量 */
  primaryEnv?: string;
  /** Markdown body，即 LLM 要读的指令文本 */
  instructions: string;
  /** SKILL.md 所在目录的绝对路径 */
  sourcePath: string;
}

export interface GatingResult {
  /** 是否可以加载 */
  eligible: boolean;
  /** 缺少的环境变量 */
  missingEnv: string[];
  /** 缺少的命令行工具 */
  missingBins: string[];
  /** 缺少的配置文件 */
  missingConfig: string[];
}

export type SkillStatus = "loaded" | "unavailable" | "disabled" | "error";

/** SkillLoader 解析成功后返回的结构 */
export interface LoadedSkill {
  parsed: ParsedSkill;
  /** SKILL.md 文件的完整路径 */
  source: string;
}

/** SkillManager 管理的 Skill 完整状态 */
export interface ManagedSkill {
  parsed: ParsedSkill;
  status: SkillStatus;
  gating?: GatingResult;
  /** 加载失败时的错误信息 */
  error?: string;
}

/** Skill 级别的配置管理接口 */
export interface SkillConfigManager {
  /** 某个 Skill 是否被禁用 */
  isDisabled(skillName: string): boolean;
  /** 获取用户为某个 Skill 配置的环境变量覆盖 */
  getEnvOverrides(skillName: string): Record<string, string>;
}
