import type { VectorStore } from "./VectorStore.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { Database } from "../db/Database.ts";
import type { Message } from "../types/message.ts";
import { generateSummary } from "./SummaryGenerator.ts";
import type { FileMemoryManager } from "./FileMemoryManager.ts";

// ---------------------------------------------------------------------------
// MemoryManager — 长期记忆的存储与检索
// ---------------------------------------------------------------------------

/**
 * 同频道/无频道记忆的最低相似度阈值。
 *
 * 注意：LocalEmbeddingProvider 使用 256 维 bag-of-words hash 向量，
 * 中文中常见字（的、是、了等）会产生大量 hash 碰撞，导致无关文本之间
 * 也有 0.3-0.4 的虚假相似度。因此阈值不能设太低，0.5 是实测经验值：
 * 同主题文本通常 > 0.55，跨主题中文文本通常 < 0.45。
 */
const RECALL_SIMILARITY_THRESHOLD = 0.5;

/**
 * 跨频道记忆的最低相似度阈值。
 *
 * 跨频道记忆与当前任务上下文无关的可能性更高，需要更严格的过滤。
 * 例如：chat 模式下的"马斯克"角色对话不应出现在 project 频道的编程任务中。
 * 0.65 的阈值足以过滤掉大部分跨频道的噪声记忆。
 */
const CROSS_CHANNEL_SIMILARITY_THRESHOLD = 0.65;

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
   * @param channelId 可选的频道/项目 ID，用于记忆隔离。Team 模式下传入 project 频道 ID。
   */
  async saveSummary(sessionId: string, messages: Message[], channelId?: string): Promise<void> {
    if (messages.length === 0) return;

    const summary = await generateSummary(this.llmProvider, messages);
    if (!summary) return;

    // 获取 session 信息用于丰富 metadata
    const session = this.db.getSession(sessionId);
    const metadata: Record<string, unknown> = {
      sessionId,
      channelId: channelId ?? null,
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
   * 将对话消息增量写入每日 JSONL 日志文件。
   * 不经过 LLM，零额外 token 消耗，纯格式化追加写入。
   * session title 从数据库自动获取。
   */
  saveDailyLog(
    sessionId: string,
    channelId: string | undefined,
    messages: Message[],
  ): void {
    if (!this.fileMemory || messages.length === 0) return;
    try {
      const session = this.db.getSession(sessionId);
      const title = session?.title ?? null;
      this.fileMemory.appendDailyLog(sessionId, title, channelId, messages);
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`[debug] Daily log write failed:`, err);
      }
    }
  }

  /**
   * 根据查询语句检索相关的历史对话摘要。
   * 自动过滤掉当前 session 的结果和 similarity 低于阈值的结果。
   *
   * 频道隔离策略：
   * - 同频道记忆（channelId 匹配，或双方均无 channelId）：使用标准阈值 0.5
   * - 跨频道记忆（channelId 不匹配）：使用更严格的阈值 0.65
   *   防止 chat 模式的闲聊记忆污染 project 频道的编程任务上下文
   */
  async recall(
    query: string,
    currentSessionId: string,
    topK: number = 5,
    channelId?: string,
  ): Promise<string[]> {
    // 多取一些以弥补过滤掉当前 session 后可能不够的情况
    const results = await this.vectorStore.search(query, topK + 3);

    return results
      .filter((r) => {
        if (r.sessionId === currentSessionId) return false;

        // 频道隔离：根据记忆来源频道与当前频道的匹配情况，使用不同的相似度阈值
        const memoryChannelId = r.metadata.channelId as string | null ?? undefined;
        const sameChannel = channelId != null && memoryChannelId != null && channelId === memoryChannelId;
        // 同频道（或双方均无频道信息）→ 标准阈值；跨频道 → 更严格阈值
        const threshold = sameChannel || (channelId == null && memoryChannelId == null)
          ? RECALL_SIMILARITY_THRESHOLD
          : CROSS_CHANNEL_SIMILARITY_THRESHOLD;

        return r.similarity >= threshold;
      })
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
