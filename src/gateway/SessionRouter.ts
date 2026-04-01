import type { LLMProvider } from "../llm/types";
import type { Database } from "../db/Database";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ShellTool } from "../tools/types";
import type { ServerMessage } from "./protocol";
import type { SpawnAgentTool } from "../tools/builtin/SpawnAgentTool";
import { AgentLoop } from "../core/AgentLoop";
import { Conversation } from "../core/Conversation";
import type { SkillManager } from "../skills/SkillManager";

// ============================================================
// Types
// ============================================================

export interface SessionRouterOptions {
  db: Database;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  spawnAgentTool?: SpawnAgentTool;
  /** session 空闲超时（ms），默认 30 分钟 */
  idleTimeoutMs?: number;
  /** 清理扫描间隔（ms），默认 5 分钟 */
  cleanupIntervalMs?: number;
}

interface SessionEntry {
  agentLoop: AgentLoop;
  conversation: Conversation;
  lastActiveAt: number;
  /** per-session 串行队列，保证同一 session 不会并发 run() */
  queue: Promise<void>;
}

// ============================================================
// SessionRouter
// ============================================================

export class SessionRouter {
  private db: Database;
  private llmProvider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;
  private spawnAgentTool?: SpawnAgentTool;
  private sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimeoutMs: number;

  constructor(options: SessionRouterOptions) {
    this.db = options.db;
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.skillManager = options.skillManager;
    this.shellTool = options.shellTool;
    this.spawnAgentTool = options.spawnAgentTool;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), cleanupIntervalMs);
  }

  // ----------------------------------------------------------
  // 核心方法：处理 chat 消息
  // ----------------------------------------------------------

  async handleChat(
    sessionId: string,
    content: string,
    onEvent: (event: ServerMessage) => void,
  ): Promise<void> {
    const entry = this.getOrCreate(sessionId);
    entry.lastActiveAt = Date.now();

    // 排队执行，保证同一 session 串行
    const job = entry.queue.then(() =>
      this.runAgent(sessionId, entry, content, onEvent),
    );
    entry.queue = job.catch(() => {});
    await job;
  }

  // ----------------------------------------------------------
  // 监控
  // ----------------------------------------------------------

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  // ----------------------------------------------------------
  // 生命周期
  // ----------------------------------------------------------

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  // ----------------------------------------------------------
  // 内部方法
  // ----------------------------------------------------------

  /**
   * 获取缓存的 session entry，不存在则从 DB 恢复并创建新的 AgentLoop。
   */
  private getOrCreate(sessionId: string): SessionEntry {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // 从 DB 加载 session + 恢复对话历史
    const conversation = Conversation.loadExisting(this.db, sessionId);
    const agentLoop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      skillManager: this.skillManager,
      shellTool: this.shellTool,
    });

    const entry: SessionEntry = {
      agentLoop,
      conversation,
      lastActiveAt: Date.now(),
      queue: Promise.resolve(),
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * 执行单次 AgentLoop.run()，将 AgentEvent 转为 ServerMessage 推出去。
   */
  private async runAgent(
    sessionId: string,
    entry: SessionEntry,
    content: string,
    onEvent: (event: ServerMessage) => void,
  ): Promise<void> {
    // 每次 run 前，为 SpawnAgentTool 设置当前 session 的事件回调
    if (this.spawnAgentTool) {
      this.spawnAgentTool.setEventCallback((agentEvent) => {
        switch (agentEvent.type) {
          case "sub_agent_start":
            onEvent({
              type: "sub_agent_start",
              sessionId,
              agentName: agentEvent.agentName,
              task: agentEvent.task,
            });
            break;
          case "sub_agent_progress": {
            // 将内部 AgentEvent 转为 ServerMessage
            const inner = agentEvent.event;
            let innerMsg: ServerMessage | undefined;
            switch (inner.type) {
              case "text_delta":
                innerMsg = { type: "text_delta", sessionId, text: inner.text };
                break;
              case "tool_call":
                innerMsg = { type: "tool_call", sessionId, name: inner.name, params: inner.params };
                break;
              case "tool_result":
                innerMsg = { type: "tool_result", sessionId, name: inner.name, result: inner.result };
                break;
              case "done":
                innerMsg = { type: "done", sessionId, usage: inner.usage };
                break;
              case "error":
                innerMsg = { type: "error", sessionId, message: inner.message };
                break;
            }
            if (innerMsg) {
              onEvent({
                type: "sub_agent_progress",
                sessionId,
                agentName: agentEvent.agentName,
                innerEvent: innerMsg,
              });
            }
            break;
          }
          case "sub_agent_done":
            onEvent({
              type: "sub_agent_done",
              sessionId,
              agentName: agentEvent.agentName,
              result: agentEvent.result,
            });
            break;
        }
      });
    }

    try {
      for await (const event of entry.agentLoop.run(content)) {
        switch (event.type) {
          case "text_delta":
            onEvent({ type: "text_delta", sessionId, text: event.text });
            break;
          case "tool_call":
            onEvent({ type: "tool_call", sessionId, name: event.name, params: event.params });
            break;
          case "tool_result":
            onEvent({ type: "tool_result", sessionId, name: event.name, result: event.result });
            break;
          case "done":
            onEvent({ type: "done", sessionId, usage: event.usage });
            break;
          case "error":
            onEvent({ type: "error", sessionId, message: event.message });
            break;
        }
      }

      // 等待标题生成完成，若有新标题则推送给客户端
      await entry.agentLoop.waitForTitle();
      const session = this.db.getSession(sessionId);
      if (session?.title) {
        onEvent({ type: "title_updated", sessionId, title: session.title });
      }
    } catch (err) {
      onEvent({
        type: "error",
        sessionId,
        message: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      // 清理回调，防止泄漏
      this.spawnAgentTool?.setEventCallback(undefined);
    }
  }

  /**
   * 清理空闲超时的 session，释放内存中的 AgentLoop 实例。
   * 不删除数据库数据，下次有消息时会重新从 DB 加载。
   */
  private cleanupIdle(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActiveAt > this.idleTimeoutMs) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
