import { join } from "node:path";
import { ContextHub } from "./ContextHub.ts";
import type { Message } from "../types/message.ts";
import { MemoryStore } from "./MemoryStore.ts";

// ---------------------------------------------------------------------------
// FileMemoryManager — 基于文件的记忆层（OpenClaw 风格）
// ---------------------------------------------------------------------------
//
// 管理 ~/.little_claw/ 下的文件记忆：
//   memory/      — 个人长期记忆 + 每日工作笔记
//   logs/        — 原始对话流水
//   context-hub/ — 项目/领域/知识库资料
// ---------------------------------------------------------------------------

export class FileMemoryManager {
  private baseDir: string;
  private contextHub: ContextHub;
  private memoryStore: MemoryStore;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.env.HOME ?? "~", ".little_claw");
    this.contextHub = new ContextHub(this.baseDir);
    this.memoryStore = new MemoryStore(this.baseDir);
  }

  /**
   * 首次启动时创建目录结构和模板文件。
   * 已存在的文件不会被覆盖。
   */
  async initialize(): Promise<void> {
    await this.memoryStore.initialize();
    await this.contextHub.initialize();
  }

  // --- Context Hub 读取接口 ---

  /** 获取 ContextHub 实例 */
  getContextHub(): ContextHub {
    return this.contextHub;
  }

  getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  /**
   * 读取 L0 全局地图（所有 .abstract.md 拼接）。
   * 每次对话自动加载，不走检索。
   */
  async readContextMap(): Promise<string | null> {
    const map = await this.contextHub.scanAbstracts();
    return map || null;
  }

  /**
   * 读取长期个人记忆（memory/MEMORY.md）。
   * 每次对话自动加载，不走检索。
   */
  async readIdentity(): Promise<string | null> {
    return this.memoryStore.readMemory("MEMORY.md");
  }

  /**
   * 读取 memory inbox（memory/inbox.md）。
   * 每次对话自动加载，不走检索。
   */
  async readInbox(): Promise<string | null> {
    return this.memoryStore.readMemory("inbox.md");
  }

  /** 读取指定的记忆文件（支持相对路径和绝对路径） */
  async readFile(filePath: string): Promise<string | null> {
    return this.memoryStore.readMemory(filePath);
  }

  // --- 写入接口 ---

  /** 写入指定的记忆文件 */
  async writeFile(filePath: string, content: string): Promise<boolean> {
    return this.memoryStore.writeMemory(filePath, content, "overwrite");
  }

  /** 追加内容到指定的记忆文件 */
  async appendToFile(filePath: string, content: string): Promise<boolean> {
    return this.memoryStore.writeMemory(filePath, content, "append");
  }

  /** 写入今天的日志文件（旧接口，保留向后兼容） */
  async writeTodayLog(content: string): Promise<{ path: string; changed: boolean }> {
    return this.memoryStore.writeDailyNote(content);
  }

  /**
   * 将对话消息增量追加到每日 JSONL 日志文件。
   *
   * 文件路径: ~/.little_claw/logs/conversations/YYYY-MM-DD.jsonl
   * 每行一条 JSON 记录，包含 session 元信息和消息原文。
   * 使用 appendFileSync 保证每条消息即时落盘，即使进程崩溃也不丢数据。
   *
   * @param sessionId 当前 session ID
   * @param sessionTitle session 标题
   * @param channelId 频道 ID（Team 模式）
   * @param messages 要写入的消息列表（通常是增量部分）
   */
  appendDailyLog(
    sessionId: string,
    sessionTitle: string | null,
    channelId: string | undefined,
    messages: Message[],
  ): void {
    if (messages.length === 0) return;

    this.memoryStore.appendConversationLog(sessionId, sessionTitle, channelId, messages);
  }

  /** 获取今天的日期字符串 YYYY-MM-DD */
  getTodayDate(): string {
    return this.memoryStore.getTodayDate();
  }

  /** 获取所有日志文件路径（包括 .md 和 .jsonl） */
  async listLogFiles(): Promise<string[]> {
    const glob = new Bun.Glob("*.{md,jsonl}");
    const files: string[] = [];
    for await (const path of glob.scan({ cwd: this.memoryStore.getMemoryDir() })) {
      if (/^\d{4}-\d{2}-\d{2}\.(md|jsonl)$/.test(path)) {
        files.push(join(this.memoryStore.getMemoryDir(), path));
      }
    }
    for await (const path of glob.scan({ cwd: this.memoryStore.getConversationLogsDir() })) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) {
        files.push(join(this.memoryStore.getConversationLogsDir(), path));
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
    return this.memoryStore.getMemoryDir();
  }
}
