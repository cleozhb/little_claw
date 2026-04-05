import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// FileMemoryManager — 基于文件的记忆层（OpenClaw 风格）
// ---------------------------------------------------------------------------
//
// 管理 ~/.little_claw/ 下的文件记忆：
//   SOUL.md    — Agent 身份和行为准则（用户手动编辑，只读）
//   USER.md    — 用户偏好（Agent 可写入，用户可编辑）
//   memory/
//     MEMORY.md      — 长期知识（Agent 定期整理）
//     YYYY-MM-DD.md  — 每日日志
// ---------------------------------------------------------------------------

const SOUL_TEMPLATE = `# Soul

Describe your agent's personality and behavior guidelines here.
`;

const USER_TEMPLATE = `# User Preferences

Your agent will update this file as it learns about you.
`;

const MEMORY_TEMPLATE = `# Long-term Memory

Important knowledge and decisions are recorded here.
`;

export class FileMemoryManager {
  private baseDir: string;
  private memoryDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.env.HOME ?? "~", ".little_claw");
    this.memoryDir = join(this.baseDir, "memory");
  }

  /**
   * 首次启动时创建目录结构和模板文件。
   * 已存在的文件不会被覆盖。
   */
  async initialize(): Promise<void> {
    mkdirSync(this.memoryDir, { recursive: true });

    await this.ensureFile(join(this.baseDir, "SOUL.md"), SOUL_TEMPLATE);
    await this.ensureFile(join(this.baseDir, "USER.md"), USER_TEMPLATE);
    await this.ensureFile(join(this.memoryDir, "MEMORY.md"), MEMORY_TEMPLATE);
  }

  // --- 读取接口 ---

  /** 读取 SOUL.md（Agent 身份准则），不存在返回 null */
  async readSoul(): Promise<string | null> {
    return this.readFileIfExists(join(this.baseDir, "SOUL.md"));
  }

  /** 读取 USER.md（用户偏好），不存在返回 null */
  async readUser(): Promise<string | null> {
    return this.readFileIfExists(join(this.baseDir, "USER.md"));
  }

  /** 读取 memory/MEMORY.md（长期知识），不存在返回 null */
  async readMemory(): Promise<string | null> {
    return this.readFileIfExists(join(this.memoryDir, "MEMORY.md"));
  }

  /** 读取指定的记忆文件（支持相对路径和绝对路径） */
  async readFile(filePath: string): Promise<string | null> {
    const resolved = this.resolveMemoryPath(filePath);
    return this.readFileIfExists(resolved);
  }

  // --- 写入接口 ---

  /** 写入指定的记忆文件 */
  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolveMemoryPath(filePath);
    // 确保父目录存在
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    await Bun.write(resolved, content);
  }

  /** 追加内容到指定的记忆文件 */
  async appendToFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolveMemoryPath(filePath);
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });

    const existing = await this.readFileIfExists(resolved);
    const newContent = existing ? `${existing}\n${content}` : content;
    await Bun.write(resolved, newContent);
  }

  /** 写入今天的日志文件 */
  async writeTodayLog(content: string): Promise<void> {
    const today = this.getTodayDate();
    await this.appendToFile(`memory/${today}.md`, content);
  }

  /** 获取今天的日期字符串 YYYY-MM-DD */
  getTodayDate(): string {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  }

  /** 获取所有日志文件路径（用于向量索引） */
  async listLogFiles(): Promise<string[]> {
    const glob = new Bun.Glob("*.md");
    const files: string[] = [];
    for await (const path of glob.scan({ cwd: this.memoryDir })) {
      // 排除 MEMORY.md，只返回日期日志
      if (path !== "MEMORY.md") {
        files.push(join(this.memoryDir, path));
      }
    }
    return files.sort();
  }

  /** 获取基础目录路径 */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** 获取 memory 目录路径 */
  getMemoryDir(): string {
    return this.memoryDir;
  }

  // --- 内部方法 ---

  /**
   * 解析记忆文件路径。支持：
   * - "USER.md" → ~/.little_claw/USER.md
   * - "memory/2026-04-04.md" → ~/.little_claw/memory/2026-04-04.md
   * - "memory/MEMORY.md" → ~/.little_claw/memory/MEMORY.md
   * - 绝对路径但必须在 baseDir 下
   */
  private resolveMemoryPath(filePath: string): string {
    // 如果已经是绝对路径，检查是否在 baseDir 下
    if (filePath.startsWith("/")) {
      if (!filePath.startsWith(this.baseDir)) {
        throw new Error(
          `Path must be within ${this.baseDir}, got: ${filePath}`,
        );
      }
      return filePath;
    }
    // 相对路径，拼接 baseDir
    const resolved = join(this.baseDir, filePath);
    // 防止路径遍历
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error(
        `Path traversal detected: ${filePath}`,
      );
    }
    return resolved;
  }

  private async readFileIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return file.text();
  }

  private async ensureFile(path: string, template: string): Promise<void> {
    if (!existsSync(path)) {
      await Bun.write(path, template);
    }
  }
}
