import type { LLMProvider } from "../llm/types";
import type { Database } from "../db/Database";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ShellTool } from "../tools/types";
import type { ServerMessage } from "./protocol";
import type { SpawnAgentTool } from "../tools/builtin/SpawnAgentTool";
import type { MemoryManager } from "../memory/MemoryManager";
import type { ContextRetriever } from "../memory/ContextRetriever";
import { createAgentConfig } from "../agents/AgentConfig";
import { AgentLoop } from "../core/AgentLoop";
import { Conversation } from "../core/Conversation";
import type { SkillManager } from "../skills/SkillManager";
import type { AgentRegistry } from "../team/AgentRegistry";
import { buildTeamAgentSystemPrompt } from "../team/AgentWorker";
import { createLogger } from "../utils/logger";

const log = createLogger("SessionRouter");

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
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  getAgentRegistry?: () => AgentRegistry | undefined;
  mainAgentName?: string;
  /** session 空闲超时（ms），默认 30 分钟 */
  idleTimeoutMs?: number;
  /** 清理扫描间隔（ms），默认 5 分钟 */
  cleanupIntervalMs?: number;
}

interface PendingApproval {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  rule: unknown;
  message: string;
}

interface SessionEntry {
  agentLoop: AgentLoop;
  conversation: Conversation;
  lastActiveAt: number;
  /** per-session 串行队列，保证同一 session 不会并发 run() */
  queue: Promise<void>;
  pendingApproval?: PendingApproval;
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
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private getAgentRegistry?: () => AgentRegistry | undefined;
  private mainAgentName: string;
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
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.getAgentRegistry = options.getAgentRegistry;
    this.mainAgentName = options.mainAgentName ?? "assistant";
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
    log.step("handleChat", {
      sessionId,
      content,
    });
    const entry = this.getOrCreate(sessionId);
    entry.lastActiveAt = Date.now();

    // 如果有 pending approval，用户的新消息视为隐式取消当前审批
    if (entry.pendingApproval) {
      log.info(`Session ${sessionId} had pending approval, clearing on new user message`);
      this.db.rejectSessionApproval(entry.pendingApproval.id);
      entry.pendingApproval = undefined;
    }

    // 排队执行，保证同一 session 串行
    const job = entry.queue.then(() =>
      this.runAgent(sessionId, entry, content, onEvent),
    );
    entry.queue = job.catch(() => {});
    await job;
  }

  // ----------------------------------------------------------
  // Abort & Inject
  // ----------------------------------------------------------

  /**
   * 中断指定 session 的当前 AgentLoop 执行。
   * 返回 true 表示成功发送中断信号，false 表示 session 不存在或未在运行。
   */
  abortSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      log.warn(`Abort: session ${sessionId} not found`);
      return false;
    }
    if (!entry.agentLoop.isRunning) {
      log.warn(`Abort: session ${sessionId} agent not running, skip`);
      return false;
    }
    log.step(`Aborting AgentLoop for session ${sessionId}`);
    entry.agentLoop.abort();
    return true;
  }

  /**
   * 向指定 session 的 AgentLoop 注入一条消息。
   * 返回 true 表示成功注入，false 表示 session 不存在或未在运行。
   */
  injectMessage(sessionId: string, content: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (!entry.agentLoop.isRunning) return false;
    log.info(`Injecting message to session ${sessionId}`, content);
    entry.agentLoop.inject(content);
    return true;
  }

  // ----------------------------------------------------------
  // Chat Approval (HITL)
  // ----------------------------------------------------------

  /**
   * 批准 chat session 中被拦截的工具调用，恢复执行。
   * 支持跨实例：从 DB 读取 pending 状态，不依赖内存。
   */
  async approveChat(
    sessionId: string,
    approvalId: string,
    onEvent: (event: ServerMessage) => void,
  ): Promise<boolean> {
    const dbApproval = this.db.getSessionPendingApproval(sessionId);
    if (!dbApproval || dbApproval.id !== approvalId) return false;

    this.db.approveSessionApproval(approvalId);

    const entry = this.getOrCreate(sessionId);
    entry.pendingApproval = undefined;

    const params: Record<string, unknown> = JSON.parse(dbApproval.params);
    entry.agentLoop.approveToolCall(dbApproval.tool_name, params);
    // 也按工具名放行，防止 LLM 重新生成的参数与原始不完全一致导致重复拦截
    entry.agentLoop.approveToolCall(dbApproval.tool_name);

    const resumeMsg = `[APPROVED] The user has approved the "${dbApproval.tool_name}" tool call. Please proceed and re-execute it.`;
    await this.handleChat(sessionId, resumeMsg, onEvent);
    return true;
  }

  /**
   * 拒绝 chat session 中被拦截的工具调用。
   */
  async rejectChat(
    sessionId: string,
    approvalId: string,
    reason: string | undefined,
    onEvent: (event: ServerMessage) => void,
  ): Promise<boolean> {
    const dbApproval = this.db.getSessionPendingApproval(sessionId);
    if (!dbApproval || dbApproval.id !== approvalId) return false;

    this.db.rejectSessionApproval(approvalId);

    const entry = this.getOrCreate(sessionId);
    entry.pendingApproval = undefined;

    const rejectMsg = reason
      ? `[REJECTED] The user rejected the "${dbApproval.tool_name}" tool call. Reason: ${reason}. Please find an alternative approach.`
      : `[REJECTED] The user rejected the "${dbApproval.tool_name}" tool call. Please find an alternative approach or ask the user what to do.`;
    await this.handleChat(sessionId, rejectMsg, onEvent);
    return true;
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
    if (existing) {
      log.debug(`Session ${sessionId} found in cache`);
      return existing;
    }

    log.info(`Session ${sessionId} not in cache, loading from DB`);
    // 从 DB 加载 session + 恢复对话历史
    const conversation = Conversation.loadExisting(this.db, sessionId);
    const mainAgent = this.getAgentRegistry?.()?.get(this.mainAgentName);
    const agentLoop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: mainAgent
        ? createAgentConfig({
          name: mainAgent.config.name,
          systemPrompt: buildTeamAgentSystemPrompt(mainAgent),
          allowedTools: mainAgent.config.tools,
          approvalRules: mainAgent.config.approval_rules,
          maxTurns: 25,
          canSpawnSubAgent: true,
        })
        : undefined,
      skillManager: this.skillManager,
      configuredSkillNames: mainAgent?.config.skills,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      runMode: "chat",
      contextMode: "auto",
    });

    // 从 DB 恢复已批准的工具调用（跨实例/session 重建场景）
    const approvedKeys = this.db.getApprovedCallKeys(sessionId);
    for (const key of approvedKeys) {
      agentLoop.approveCallKey(key);
    }

    // 恢复 pending approval 状态
    const dbPending = this.db.getSessionPendingApproval(sessionId);

    const entry: SessionEntry = {
      agentLoop,
      conversation,
      lastActiveAt: Date.now(),
      queue: Promise.resolve(),
      pendingApproval: dbPending ? {
        id: dbPending.id,
        toolName: dbPending.tool_name,
        params: JSON.parse(dbPending.params),
        rule: dbPending.rule ? JSON.parse(dbPending.rule) : null,
        message: dbPending.message,
      } : undefined,
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
    log.step(`runAgent START`, {
      sessionId,
      content,
    });
    // 每次 run 前，为 SpawnAgentTool 设置当前 session 的事件回调
    if (this.spawnAgentTool) {
      this.spawnAgentTool.setEventCallback((agentEvent) => {
        switch (agentEvent.type) {
          case "sub_agent_start":
            log.info(`[Event→Client] sub_agent_start: agent="${agentEvent.agentName}", task="${agentEvent.task}"`);
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
            log.info(`[Event→Client] sub_agent_done: agent="${agentEvent.agentName}"`, agentEvent.result.slice(0, 200));
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
            log.info(`[Event→Client] tool_call: "${event.name}"`, JSON.stringify(event.params).slice(0, 200));
            onEvent({ type: "tool_call", sessionId, name: event.name, params: event.params });
            break;
          case "tool_result":
            log.info(`[Event→Client] tool_result: "${event.name}", success=${event.result.success}`);
            onEvent({ type: "tool_result", sessionId, name: event.name, result: event.result });
            break;
          case "done":
            log.step("runAgent DONE", {
              sessionId,
              usage: event.usage,
            });
            onEvent({ type: "done", sessionId, usage: event.usage });
            break;
          case "error":
            log.error(`[Event→Client] error`, event.message);
            onEvent({ type: "error", sessionId, message: event.message });
            break;
          case "skills_matched":
            log.info(`[Event→Client] skills_matched: ${event.skills.map(s => s.name).join(", ")}`);
            onEvent({
              type: "skills_matched",
              sessionId,
              skills: event.skills,
            });
            break;
          case "approval_gate_triggered": {
            const rule = event.rule as { message?: string; pattern?: string } | undefined;
            const msg = rule?.message
              ?? `Tool "${event.toolName}" requires approval (pattern: ${rule?.pattern ?? "all"}).`;

            const approvalId = this.db.createSessionApproval(sessionId, {
              toolName: event.toolName,
              params: event.params,
              rule: event.rule,
              message: msg,
            });

            entry.pendingApproval = {
              id: approvalId,
              toolName: event.toolName,
              params: event.params,
              rule: event.rule,
              message: msg,
            };

            log.info(`[HITL] Approval gate triggered for session ${sessionId}, tool="${event.toolName}", approvalId=${approvalId}`);
            onEvent({
              type: "chat_approval_needed",
              sessionId,
              approvalId,
              toolName: event.toolName,
              params: event.params,
              message: msg,
            });
            entry.agentLoop.abort();
            break;
          }
        }
      }

      // 等待标题生成完成，若有新标题则推送给客户端
      await entry.agentLoop.waitForTitle();
      const session = this.db.getSession(sessionId);
      if (session?.title) {
        onEvent({ type: "title_updated", sessionId, title: session.title });
      }
    } catch (err) {
      log.error(`runAgent exception for session ${sessionId}`, err instanceof Error ? err.message : String(err));
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
   * 移除前同步触发一次 saveSummary，将对话摘要保存到长期记忆。
   * 不删除数据库数据，下次有消息时会重新从 DB 加载。
   */
  private cleanupIdle(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActiveAt > this.idleTimeoutMs) {
        log.info(`Cleaning up idle session ${sessionId}, idle for ${Math.round((now - entry.lastActiveAt) / 1000)}s`);
        // 移除前触发记忆保存（fire-and-forget）
        this.saveSessionMemory(sessionId, entry);
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * 对所有活跃 session 触发 saveSummary。
   * 由 server shutdown 时调用，返回 Promise 等待全部完成。
   */
  async saveAllMemories(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [sessionId, entry] of this.sessions) {
      tasks.push(this.saveSessionMemory(sessionId, entry));
    }
    await Promise.allSettled(tasks);
  }

  /** 对单个 session 触发记忆保存 */
  private async saveSessionMemory(
    sessionId: string,
    entry: SessionEntry,
  ): Promise<void> {
    if (!this.memoryManager) return;
    const messages = entry.conversation.getMessages();
    if (messages.length === 0) return;
    try {
      await this.memoryManager.saveSummary(sessionId, messages);
    } catch (err) {
      log.error(`Memory save for session ${sessionId} failed`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 外部调用：对指定 session 触发记忆保存（如 session 切换时）。
   * 如果该 session 不在内存缓存中则跳过（没有对话数据可保存）。
   */
  saveMemoryForSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // fire-and-forget，不阻塞切换
    this.saveSessionMemory(sessionId, entry).catch(() => {});
  }
}
