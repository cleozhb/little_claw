/**
 * src/skills/SkillConfigFile.ts — 读写 ~/.little_claw/config.json
 *
 * 负责：
 * 1. 自动创建默认配置文件（含空 skills.entries）
 * 2. 实现 SkillConfigManager 接口，供 SkillManager 使用
 * 3. 支持运行时 reload
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { SkillConfigManager } from "./types";

export interface SkillEntryConfig {
  enabled?: boolean;
  env?: Record<string, string>;
}

export interface SkillsConfig {
  tokenBudget?: number;
  pinned?: string[];
  entries: Record<string, SkillEntryConfig>;
}

export interface ConfigFile {
  skills: SkillsConfig;
}

const DEFAULT_CONFIG: ConfigFile = {
  skills: {
    tokenBudget: 20000,
    pinned: [],
    entries: {},
  },
};

export class SkillConfigFile implements SkillConfigManager {
  private configPath: string;
  private config: ConfigFile = DEFAULT_CONFIG;

  constructor(configPath?: string) {
    this.configPath =
      configPath ?? join(homedir(), ".little_claw", "config.json");
  }

  /**
   * 加载配置文件。不存在时自动创建默认模板。
   */
  async load(): Promise<void> {
    const file = Bun.file(this.configPath);
    const exists = await file.exists();

    if (!exists) {
      await this.createDefault();
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<ConfigFile>;
      this.config = {
        skills: {
          tokenBudget: parsed.skills?.tokenBudget ?? 20000,
          pinned: parsed.skills?.pinned ?? [],
          entries: parsed.skills?.entries ?? {},
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[SkillConfig] Failed to parse ${this.configPath}: ${message}, using defaults`,
      );
      this.config = DEFAULT_CONFIG;
    }
  }

  /**
   * 重新加载配置文件。
   */
  async reload(): Promise<void> {
    await this.load();
  }

  // --- SkillConfigManager 接口 ---

  isDisabled(skillName: string): boolean {
    const entry = this.config.skills.entries[skillName];
    if (!entry) return false;
    return entry.enabled === false;
  }

  getEnvOverrides(skillName: string): Record<string, string> {
    const entry = this.config.skills.entries[skillName];
    if (!entry?.env) return {};
    return { ...entry.env };
  }

  // --- 额外 API ---

  getTokenBudget(): number {
    return this.config.skills.tokenBudget ?? 4000;
  }

  getPinnedSkills(): string[] {
    return this.config.skills.pinned ?? [];
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getRawConfig(): ConfigFile {
    return this.config;
  }

  // --- 内部方法 ---

  private async createDefault(): Promise<void> {
    const dir = join(this.configPath, "..");
    mkdirSync(dir, { recursive: true });

    const content = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
    await Bun.write(this.configPath, content);

    this.config = DEFAULT_CONFIG;
    console.log(`[SkillConfig] Created default config at ${this.configPath}`);
  }
}
