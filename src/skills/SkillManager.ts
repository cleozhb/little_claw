import { checkGating } from "./SkillGating";
import type { SkillLoader } from "./SkillLoader";
import type {
  ParsedSkill,
  ManagedSkill,
  SkillConfigManager,
} from "./types";
import type { Database } from "../db/Database";
import type { EmbeddingProvider } from "../memory/EmbeddingProvider";
import { SkillIndexer } from "./SkillIndexer";
import { SkillRetriever } from "./SkillRetriever";

export interface SkillSummary {
  total: number;
  loaded: number;
  unavailable: number;
  disabled: number;
  error: number;
}

export class SkillManager {
  private loader: SkillLoader;
  private configManager: SkillConfigManager;
  private skills = new Map<string, ManagedSkill>();
  private recentlyUsedSkills = new Set<string>();
  private db?: Database;
  private embeddingProvider?: EmbeddingProvider;
  private indexer?: SkillIndexer;
  private retriever?: SkillRetriever;

  constructor(
    loader: SkillLoader,
    configManager: SkillConfigManager,
    options?: { db?: Database; embeddingProvider?: EmbeddingProvider },
  ) {
    this.loader = loader;
    this.configManager = configManager;
    this.db = options?.db;
    this.embeddingProvider = options?.embeddingProvider;
  }

  /**
   * 初始化所有 Skill：加载 → 检查配置 → 检查 gating → 标记状态。
   */
  async initializeAll(): Promise<void> {
    let loadedSkills;
    try {
      loadedSkills = await this.loader.loadAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SkillManager] Failed to load skills: ${message}`);
      return;
    }

    for (const { parsed } of loadedSkills) {
      // 检查是否被用户禁用
      if (this.configManager.isDisabled(parsed.name)) {
        this.skills.set(parsed.name, {
          parsed,
          status: "disabled",
        });
        continue;
      }

      // 获取用户为该 Skill 配置的 env overrides
      const envOverrides = this.configManager.getEnvOverrides(parsed.name);

      // 检查 gating 条件
      try {
        const gating = await checkGating(parsed, envOverrides);

        if (gating.eligible) {
          this.skills.set(parsed.name, {
            parsed,
            status: "loaded",
            gating,
          });
        } else {
          this.skills.set(parsed.name, {
            parsed,
            status: "unavailable",
            gating,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.skills.set(parsed.name, {
          parsed,
          status: "error",
          error: `Gating check failed: ${message}`,
        });
      }
    }

    // 若 db + embeddingProvider 可用，构建索引和检索器
    if (this.db && this.embeddingProvider) {
      try {
        this.indexer = new SkillIndexer(this.db, this.embeddingProvider);
        await this.indexer.indexAll(this.getLoadedSkills());

        this.retriever = new SkillRetriever(
          this.db,
          this.embeddingProvider,
          () => {
            const map = new Map<string, ParsedSkill>();
            for (const s of this.skills.values()) {
              if (s.status === "loaded") map.set(s.parsed.name, s.parsed);
            }
            return map;
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SkillManager] Failed to build skill index: ${message}`);
      }
    }
  }

  /** 只返回 status 为 loaded 的 Skill */
  getLoadedSkills(): ParsedSkill[] {
    return Array.from(this.skills.values())
      .filter((s) => s.status === "loaded")
      .map((s) => s.parsed);
  }

  /** 返回所有 Skill 包含状态 */
  getAllSkills(): ManagedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 返回某个 Skill 需要的环境变量（合并用户配置和 process.env）。
   * 给 ShellTool 执行命令时注入用。
   */
  getSkillEnv(skillName: string): Record<string, string> {
    const managed = this.skills.get(skillName);
    if (!managed) return {};

    const envOverrides = this.configManager.getEnvOverrides(skillName);
    const result: Record<string, string> = {};

    // 收集该 Skill 声明的所有环境变量
    const requiredEnvs = managed.parsed.requires.env;
    const primaryEnv = managed.parsed.primaryEnv;

    // 汇总需要的 env key
    const envKeys = new Set(requiredEnvs);
    if (primaryEnv) envKeys.add(primaryEnv);

    for (const key of envKeys) {
      // 优先使用用户配置覆盖，其次 process.env
      if (envOverrides[key] !== undefined) {
        result[key] = envOverrides[key];
      } else if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }

    return result;
  }

  /** 标记某个 Skill 最近被 Agent 使用过 */
  markUsed(skillName: string): void {
    if (this.skills.has(skillName)) {
      this.recentlyUsedSkills.add(skillName);
    }
  }

  /** 获取最近使用过的 Skill name 集合 */
  getRecentlyUsed(): Set<string> {
    return new Set(this.recentlyUsedSkills);
  }

  /** 获取指定名称的 ManagedSkill */
  getSkill(name: string): ManagedSkill | undefined {
    return this.skills.get(name);
  }

  /** 获取 skill prompt 的 token 预算 */
  getTokenBudget(): number {
    return this.configManager.getTokenBudget();
  }

  /** 获取混合检索器（若索引已建立） */
  getRetriever(): SkillRetriever | undefined {
    return this.retriever;
  }

  /** 获取用户 pin 的 skill 列表 */
  getPinnedSkills(): string[] {
    return this.configManager.getPinnedSkills();
  }

  /** 重新加载所有 Skill（清空现有状态，重新扫描） */
  async reload(): Promise<void> {
    this.skills.clear();
    this.recentlyUsedSkills.clear();
    await this.initializeAll();
  }

  /** 返回 Skill 加载摘要统计 */
  getSummary(): SkillSummary {
    let loaded = 0;
    let unavailable = 0;
    let disabled = 0;
    let error = 0;

    for (const skill of this.skills.values()) {
      switch (skill.status) {
        case "loaded":
          loaded++;
          break;
        case "unavailable":
          unavailable++;
          break;
        case "disabled":
          disabled++;
          break;
        case "error":
          error++;
          break;
      }
    }

    return {
      total: this.skills.size,
      loaded,
      unavailable,
      disabled,
      error,
    };
  }

  /** 返回所有 unavailable Skill 及其缺失的依赖信息 */
  getUnavailableDetails(): Array<{ name: string; missing: string }> {
    const details: Array<{ name: string; missing: string }> = [];

    for (const skill of this.skills.values()) {
      if (skill.status !== "unavailable" || !skill.gating) continue;

      const parts: string[] = [];
      if (skill.gating.missingEnv.length > 0) {
        parts.push(`missing env ${skill.gating.missingEnv.join(", ")}`);
      }
      if (skill.gating.missingBins.length > 0) {
        parts.push(`missing bin ${skill.gating.missingBins.join(", ")}`);
      }
      if (skill.gating.missingConfig.length > 0) {
        parts.push(`missing config ${skill.gating.missingConfig.join(", ")}`);
      }

      details.push({
        name: skill.parsed.name,
        missing: parts.join("; "),
      });
    }

    return details;
  }
}
