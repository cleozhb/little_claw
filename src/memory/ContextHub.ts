import { join, relative } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// ContextHub — 三层上下文加载系统的核心管理器
// ---------------------------------------------------------------------------
//
// 管理 ~/.little_claw/context-hub/ 下的分层目录结构：
//   L0 — .abstract.md  一行摘要（全量加载）
//   L1 — .overview.md  结构化索引（检索命中时加载）
//   L2 — 具体文件       按需加载
//
// 目录结构：
//   context-hub/
//   ├── 2-areas/       持续关注的大方向
//   ├── 3-projects/    具体项目
//   ├── 4-knowledge/   个人知识库
//   └── 5-archive/     归档
// ---------------------------------------------------------------------------

/** 顶层目录定义 */
const TOP_LEVEL_DIRS = [
  "2-areas",
  "3-projects",
  "4-knowledge",
  "5-archive",
] as const;

/** 各顶层目录的默认 abstract 内容 */
const DEFAULT_ABSTRACTS: Record<string, string> = {
  "context-hub": "Project and knowledge context hub",
  "2-areas": "Ongoing life areas with no end date",
  "3-projects": "Active time-bound projects",
  "4-knowledge": "Personal knowledge base — SOPs, research, collections",
  "5-archive": "Completed or deprecated items",
};

/** 默认 overview 内容 */
const DEFAULT_ROOT_OVERVIEW = `# Context Hub Overview

## 2-areas/
Ongoing life areas with no end date.

## 3-projects/
Active time-bound projects.

## 4-knowledge/
Personal knowledge base — SOPs, research, collections.

## 5-archive/
Completed or deprecated items.
`;

const AREAS_OVERVIEW = `# Areas Overview

Ongoing life areas with no fixed end date.

## Key directories
`;

const PROJECTS_OVERVIEW = `# Projects Overview

Active time-bound projects.

## Key directories
`;

const KNOWLEDGE_OVERVIEW = `# Knowledge Overview

Reusable knowledge, SOPs, research, and collections.

## Key files
`;

const ARCHIVE_OVERVIEW = `# Archive Overview

Completed or deprecated items.

## Key directories
`;

export class ContextHub {
  private hubDir: string;
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.hubDir = join(baseDir, "context-hub");
  }

  /** context-hub 根目录路径 */
  getHubDir(): string {
    return this.hubDir;
  }

  /**
   * 初始化 context-hub 目录结构。
   * 全新安装则创建模板；已存在的用户文件不会被覆盖。
   */
  async initialize(): Promise<void> {
    this.createDirectoryStructure();
    await this.ensureTemplates();
  }

  /**
   * 扫描所有 .abstract.md，拼成 L0 全局地图。
   * 格式：
   *   context-hub/2-areas/content/ — YouTube and LinkedIn content strategy
   */
  async scanAbstracts(): Promise<string> {
    const lines: string[] = [];
    await this.collectAbstracts(this.hubDir, lines);
    return lines.join("\n");
  }

  /**
   * 读取指定目录的 .overview.md
   */
  async readOverview(dirPath: string): Promise<string | null> {
    const resolved = this.resolvePath(dirPath);
    const overviewPath = join(resolved, ".overview.md");
    return this.readFileIfExists(overviewPath);
  }

  /**
   * 读取多个目录的 .overview.md
   */
  async readOverviews(dirPaths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    await Promise.all(
      dirPaths.map(async (p) => {
        const content = await this.readOverview(p);
        if (content) result.set(p, content);
      }),
    );
    return result;
  }

  /**
   * 读取 L2 文件
   */
  async readFile(filePath: string): Promise<string | null> {
    const resolved = this.resolvePath(filePath);
    return this.readFileIfExists(resolved);
  }

  /**
   * 写入 L2 文件
   */
  async writeFile(
    filePath: string,
    content: string,
    mode: "append" | "overwrite" = "append",
  ): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });

    if (mode === "overwrite") {
      await Bun.write(resolved, content);
    } else {
      const existing = await this.readFileIfExists(resolved);
      const newContent = existing ? `${existing}\n${content}` : content;
      await Bun.write(resolved, newContent);
    }
  }

  /**
   * 列出 context-hub 下所有目录（递归，返回相对路径）
   */
  async listDirectories(): Promise<string[]> {
    const dirs: string[] = [];
    await this.collectDirs(this.hubDir, dirs);
    return dirs;
  }

  /**
   * 列出指定目录下的所有文件（不含 .abstract.md / .overview.md）
   */
  async listFiles(dirPath: string): Promise<string[]> {
    const resolved = this.resolvePath(dirPath);
    const glob = new Bun.Glob("*");
    const files: string[] = [];
    for await (const entry of glob.scan({ cwd: resolved, onlyFiles: true })) {
      if (entry !== ".abstract.md" && entry !== ".overview.md") {
        files.push(entry);
      }
    }
    return files.sort();
  }

  // ---------------------------------------------------------------------------
  // Private: 目录和模板
  // ---------------------------------------------------------------------------

  private createDirectoryStructure(): void {
    mkdirSync(this.hubDir, { recursive: true });
    for (const dir of TOP_LEVEL_DIRS) {
      mkdirSync(join(this.hubDir, dir), { recursive: true });
    }
  }

  private async ensureTemplates(): Promise<void> {
    // 根目录元文件
    await this.ensureFile(
      join(this.hubDir, ".abstract.md"),
      DEFAULT_ABSTRACTS["context-hub"]!,
    );
    await this.ensureFile(
      join(this.hubDir, ".overview.md"),
      DEFAULT_ROOT_OVERVIEW,
    );

    // 各顶层目录的 .abstract.md
    for (const dir of TOP_LEVEL_DIRS) {
      const abstract = DEFAULT_ABSTRACTS[dir];
      if (abstract) {
        await this.ensureFile(
          join(this.hubDir, dir, ".abstract.md"),
          abstract,
        );
      }
    }

    // Navigable L1 indexes for top-level sections that do not have seed files.
    await this.ensureFile(
      join(this.hubDir, "2-areas", ".overview.md"),
      AREAS_OVERVIEW,
    );
    await this.ensureFile(
      join(this.hubDir, "3-projects", ".overview.md"),
      PROJECTS_OVERVIEW,
    );
    await this.ensureFile(
      join(this.hubDir, "4-knowledge", ".overview.md"),
      KNOWLEDGE_OVERVIEW,
    );
    await this.ensureFile(
      join(this.hubDir, "5-archive", ".overview.md"),
      ARCHIVE_OVERVIEW,
    );
  }

  // ---------------------------------------------------------------------------
  // Private: 递归扫描
  // ---------------------------------------------------------------------------

  private async collectAbstracts(dir: string, lines: string[]): Promise<void> {
    if (this.isDeprecatedPath(dir)) return;

    const abstractPath = join(dir, ".abstract.md");
    const content = await this.readFileIfExists(abstractPath);
    if (content) {
      const relPath = relative(this.baseDir, dir);
      lines.push(`${relPath}/ — ${content.trim()}`);
    }

    // 递归扫描子目录
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const child = join(dir, entry.name);
          if (!this.isDeprecatedPath(child)) {
            await this.collectAbstracts(child, lines);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private async collectDirs(dir: string, result: string[]): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = join(dir, entry.name);
          if (this.isDeprecatedPath(fullPath)) continue;
          const relPath = relative(this.baseDir, fullPath);
          result.push(relPath);
          await this.collectDirs(fullPath, result);
        }
      }
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Private: 文件操作
  // ---------------------------------------------------------------------------

  /**
   * 解析路径：支持相对路径（相对于 context-hub/）和绝对路径。
   */
  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) {
      const absoluteRel = relative(this.hubDir, filePath);
      if (absoluteRel.startsWith("..") || absoluteRel.startsWith("/") || absoluteRel === "") {
        throw new Error(
          `Path must be within ${this.hubDir}, got: ${filePath}`,
        );
      }
      return filePath;
    }
    // 支持 "context-hub/xxx" 和 "2-areas/xxx" 两种写法
    const cleaned = filePath.startsWith("context-hub/")
      ? filePath.slice("context-hub/".length)
      : filePath;
    const resolved = join(this.hubDir, cleaned);
    const rel = relative(this.hubDir, resolved);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return resolved;
  }

  private async readFileIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return file.text();
  }

  private async ensureFile(path: string, content: string): Promise<void> {
    if (!existsSync(path)) {
      await Bun.write(path, content);
    }
  }

  private isDeprecatedPath(path: string): boolean {
    const relPath = relative(this.hubDir, path).replace(/\\/g, "/");
    return relPath === "0-identity" ||
      relPath.startsWith("0-identity/") ||
      relPath === "1-inbox" ||
      relPath.startsWith("1-inbox/");
  }
}
