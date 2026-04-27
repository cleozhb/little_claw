import type { VectorStore } from "./VectorStore.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { Database } from "../db/Database.ts";
import type { Message } from "../types/message.ts";
import { generateSummary } from "./SummaryGenerator.ts";
import type { FileMemoryManager } from "./FileMemoryManager.ts";

// ---------------------------------------------------------------------------
// MemoryManager — 长期记忆的存储与检索
// ---------------------------------------------------------------------------

/** similarity 低于此阈值的记忆不注入 system prompt，避免干扰 */
const RECALL_SIMILARITY_THRESHOLD = 0.3;

export class MemoryManager {
  private vectorStore: VectorStore;
  private llmProvider: LLMProvider;
  private db: Database;
  private fileMemory?: FileMemoryManager;

  constructor(
    vectorStore: VectorStore,
    llmProvider: LLMProvider,
    db: Database,
    fileMemory?: FileMemoryManager,
  ) {
    this.vectorStore = vectorStore;
    this.llmProvider = llmProvider;
    this.db = db;
    this.fileMemory = fileMemory;
  }

  /**
   * 生成对话摘要并存入向量数据库 + sessions 表备份。
   */
  async saveSummary(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    const summary = await generateSummary(this.llmProvider, messages);
    if (!summary) return;

    // 获取 session 信息用于丰富 metadata
    const session = this.db.getSession(sessionId);
    const metadata: Record<string, unknown> = {
      sessionId,
      title: session?.title ?? null,
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
    };

    // 存入向量数据库
    await this.vectorStore.store(sessionId, summary, metadata);

    // 纯文本备份到 sessions 表
    this.db.updateSessionSummary(sessionId, summary);
  }

  /**
   * 根据查询语句检索相关的历史对话摘要。
   * 自动过滤掉当前 session 的结果和 similarity 低于阈值的结果。
   */
  async recall(
    query: string,
    currentSessionId: string,
    topK: number = 5,
  ): Promise<string[]> {
    // 多取一些以弥补过滤掉当前 session 后可能不够的情况
    const results = await this.vectorStore.search(query, topK + 3);

    return results
      .filter(
        (r) =>
          r.sessionId !== currentSessionId &&
          r.similarity >= RECALL_SIMILARITY_THRESHOLD,
      )
      .slice(0, topK)
      .map((r) => {
        const meta = r.metadata;
        const date = (meta.createdAt as string)?.slice(0, 10) ?? "unknown";
        const title = (meta.title as string) ?? "untitled";
        return `[${date}, session "${title}"] ${r.content}`;
      });
  }

  // --- 文件记忆层 ---

  /** 获取 FileMemoryManager 实例 */
  getFileMemory(): FileMemoryManager | undefined {
    return this.fileMemory;
  }

  /**
   * 加载文件记忆上下文。
   * 三层加载系统：
   *   - SOUL.md（Agent 身份，必定加载）
   *   - identity（0-identity/profile.md，必定加载）
   *   - inbox（1-inbox/inbox.md，必定加载）
   *   - contextMap（所有 .abstract.md 拼接的 L0 全局地图，必定加载）
   *   - user / memory（旧系统 fallback，迁移后为 null）
   */
  async loadFileMemoryContext(): Promise<{
    soul: string | null;
    user: string | null;
    memory: string | null;
    contextMap: string | null;
    identity: string | null;
    inbox: string | null;
  }> {
    if (!this.fileMemory) {
      return { soul: null, user: null, memory: null, contextMap: null, identity: null, inbox: null };
    }

    const [soul, user, memory, contextMap, identity, inbox] = await Promise.all([
      this.fileMemory.readSoul(),
      this.fileMemory.readUser(),
      this.fileMemory.readMemory(),
      this.fileMemory.readContextMap(),
      this.fileMemory.readIdentity(),
      this.fileMemory.readInbox(),
    ]);

    return { soul, user, memory, contextMap, identity, inbox };
  }

  /** 获取 VectorStore 实例（供 Gateway 直接查询统计/搜索） */
  getVectorStore(): VectorStore {
    return this.vectorStore;
  }
}
