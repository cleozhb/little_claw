import type { LLMProvider, ToolDefinition } from "../llm/types.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ConversationLike } from "./ConversationLike.ts";
import type {
  AgentEvent,
  AssistantContentBlock,
  ToolUseBlock,
  AgentSkillsMatchedEvent,
} from "../types/message.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ParsedSkill, ScoredSkill } from "../skills/types.ts";
import type { ShellTool } from "../tools/types.ts";
import type { AgentConfig } from "../agents/AgentConfig.ts";
import { FALLBACK_AGENT_CONFIG } from "../agents/AgentConfig.ts";
import { checkApprovalGate } from "../team/ApprovalGate.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { ContextRetriever, ScoredContext } from "../memory/ContextRetriever.ts";
import { SkillPromptBuilder, SKILL_GUIDE } from "../skills/SkillPromptBuilder.ts";
import { filterSkillCandidates } from "../skills/SkillFilter.ts";
import { generateTitle } from "./TitleGenerator.ts";
import {
  allocateBudget,
  estimateTokens,
  formatLongTermMemory,
  limitStringsToTokenBudget,
  truncateToTokenBudget,
} from "../memory/TokenBudget.ts";
import { ContentStore } from "../memory/ContentStore.ts";
import { createLogger } from "../utils/logger.ts";
import { APP_TIME_ZONE } from "../utils/AppClock.ts";
import {
  buildContextPolicy,
  type AgentRunMode,
  type ContextMode,
  type ContextPolicy,
} from "./ContextPolicy.ts";
import {
  normalizeProjectContextPath,
  projectWorkspaceRoot,
  scopeProjectWriteFileInput,
} from "./ProjectWorkspace.ts";
import { compactConversationHistory } from "./ConversationCompaction.ts";
import type { ToolExecuteOptions } from "../tools/types.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createLogger("AgentLoop");

const SPAWN_AGENT_TOOL_NAME = "spawn_agent";
const MAX_STREAM_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;
const DEFAULT_STREAM_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_BACKGROUND_STREAM_CHUNK_TIMEOUT_MS = 900_000;
const SKILL_RETRIEVAL_TOP_K = 5;
const EMPTY_MODEL_RESPONSE_MESSAGE = "[Model returned an empty response. Please try again.]";
const TOOL_RESULT_SINGLE_HARD_CHARS = 4_000;
const TOOL_RESULT_PAGE_HARD_CHARS = 9_000;
const TOOL_RESULT_ROUND_HARD_CHARS = 12_000;
const MAX_CONTENT_REF_READS_PER_ROUND = 3;

const PERSONAL_SCHEDULER_GUIDANCE = `You can create scheduled tasks using the manage_cron tool. When a user asks you to do something periodically or at a specific time, create a cron job. For example, if asked "remind me every morning at 8am about my schedule", create a cron job with expression "0 8 * * *".

You can also create event watchers using the manage_watcher tool. When a user asks you to monitor something and notify them when a condition is met, create a watcher. For example, if asked "let me know when the API is back up", create a watcher with check_command "curl -sf https://api.example.com/health" that checks periodically.`;

const TEAM_SCHEDULER_GUIDANCE = `You can create internal Lovely Octopus team schedules using the create_team_schedule tool. When a project/channel user asks for a recurring reminder, periodic work, or future-time task, create a TeamScheduleStore schedule instead of creating a normal long-running task.

Do not use shell, crontab, launchd, Reminders, Calendar, or OS-level schedulers for team/project scheduling unless the user explicitly asks for an OS integration and approves the risk.`;

const NO_SCHEDULER_TOOL_GUIDANCE = `Scheduled-task tools are not available in this run. If asked to create recurring reminders, periodic work, or future-time tasks, do not implement them with shell, crontab, launchd, Reminders, Calendar, or other OS-level schedulers. Explain that the coordinator must create an internal team schedule.`;

const MEMORY_GUIDANCE = `You have persistent Memory and Context Hub tools with separate responsibilities:

## Memory (personal long-term memory and daily notes)
- Durable user preferences and collaboration facts → memory_write path="memory/MEMORY.md" (read it first before overwriting)
- Unsorted memory candidates or reminders → memory_write path="memory/inbox.md"
- Daily decisions, completed work, problems, and searchable work notes → memory_write path="memory/daily/YYYY-MM-DD.md"
- Read memory files with memory_read.

## Context Hub (projects, areas, and reusable knowledge)
Save project, area, and knowledge material to context-hub using context_write.
context_write paths are RELATIVE to context-hub/ — do NOT include the "context-hub/" prefix:
- Area updates → context_write path="2-areas/{area}/{file}"
- Project updates → context_write path="3-projects/{project}/{file}"
- Reusable knowledge → context_write path="4-knowledge/{file}"
- Do not write 0-identity/ or 1-inbox/; those paths are deprecated.

Read context-hub files with context_read. memory_read is only for memory/ files.

## How to navigate context-hub
You have access to the user's context-hub through a three-layer system.
Load only what you need. Scan first, understand second, work third.

L0 — .abstract.md (one line per folder)
  Already loaded in your context as "Context Map".
  Use this to know WHAT EXISTS across all areas and projects.

L1 — .overview.md (structure + status + file index)
  Automatically retrieved based on your conversation.
  Also visible via: context_read("context-hub/{path}/.overview.md")
  Use this to know WHERE to look and WHAT each file contains.

L2 — Full files (actual content)
  Only load when you are actually working with that content.
  Command: context_read("context-hub/{path}/{file}")

Your workflow for any user request:
1. Check L0 abstracts (already in your context) — which area is relevant?
2. Read the L1 overview of that area — which specific file do I need?
3. Read only that L2 file — now work with it.

NEVER load all L2 files in a directory at once.
NEVER skip L1 and guess which file to read.
Always go L0 → L1 → L2 in order.

## Archiving suggestions
When you notice an entry has gone stale, suggest archiving it (do not move it yourself):
- A 3-projects/{project}/ has been completed, abandoned, or untouched for 3+ months.
- A memory/inbox.md todo references a date that has clearly passed and the task is no longer relevant.
- A 4-knowledge/ note describes a tool/process the user has explicitly stopped using.

When you spot one of these, mention it briefly in your reply:
"Heads up: 3-projects/old-thing looks stale (last updated 2026-01). Want me to suggest archiving it?"
NEVER write to 5-archive/ yourself — the user moves items there manually.`;

const SHORT_MEMORY_GUIDANCE = `You have persistent memory and context-hub tools. Use memory_read/write for memory/ files and context_read/write for context-hub files. Load specific files on demand.`;

const PROJECT_MEMORY_GUIDANCE = `You have persistent memory and context-hub tools. For project work, use the project workspace named in the task context, and read or write only specific files that are relevant to the task. Use context_read for exact context-hub paths and context_write for updates relative to context-hub/. Use memory_read/write only for memory/ files. Do not assume the global context map is loaded.`;

export class AgentLoop {
  private client: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationLike;
  private config: AgentConfig;
  private pendingTitleGeneration: Promise<void> | null = null;
  private skillManager?: SkillManager;
  private configuredSkillNames: string[];
  private skillScopeNames: string[];
  private shellTool?: ShellTool;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  /** 当前频道/项目 ID，用于记忆隔离 */
  private channelId?: string;
  private runMode: AgentRunMode;
  private contextMode: ContextMode;
  private projectContextPath?: string;
  private currentContextPolicy?: ContextPolicy;
  private cachedMemories: string[] = [];
  /** L1 检索命中的 .overview.md 内容，每次 run() 开始时刷新 */
  private cachedContextOverviews: ScoredContext[] = [];
  /** Team/project 模式下直接加载的项目 overview */
  private cachedProjectOverview: { path: string; content: string } | null = null;
  /** 文件记忆层缓存，每次 run() 开始时刷新 */
  private cachedFileMemory: {
    contextMap: string | null;
    identity: string | null;
    inbox: string | null;
  } = { contextMap: null, identity: null, inbox: null };

  /** 当前轮次检索命中的 skill 列表（由 runInner 设置，getEffectiveLLMInput 使用） */
  private selectedSkills: ParsedSkill[] = [];

  /** 已写入每日日志的消息数量，用于增量追加 */
  private lastWrittenMsgCount = 0;

  // --- Abort 机制 ---
  /** 是否已中断 */
  private aborted = false;
  /** 当前 LLM 请求的 AbortController，允许取消正在进行的 fetch */
  private currentAbortController: AbortController | null = null;
  /** 当前工具执行的 AbortController，允许 abort 时 kill 子进程 */
  private currentToolAbortController: AbortController | null = null;

  // --- 运行中注入指令 ---
  /** 待注入的消息队列 */
  private pendingInjections: string[] = [];

  /** 审批放行：记录已被人类批准的工具调用签名，同一次 run 内不再重复拦截 */
  private approvedCalls = new Set<string>();

  /** 当前是否正在 run() 中 */
  private _isRunning = false;
  /** Lazily created content store for tool-result budget fallback. */
  private contentStore?: ContentStore;

  constructor(
    client: LLMProvider,
    toolRegistry: ToolRegistry,
    conversation: ConversationLike,
    options?: {
      config?: AgentConfig;
      skillManager?: SkillManager;
      configuredSkillNames?: string[];
      skillScopeNames?: string[];
      shellTool?: ShellTool;
      memoryManager?: MemoryManager;
      contextRetriever?: ContextRetriever;
      /** 当前频道/项目 ID，用于记忆的频道隔离。Team 模式下传入 project 频道 ID。 */
      channelId?: string;
      runMode?: AgentRunMode;
      contextMode?: ContextMode;
      projectContextPath?: string;
    },
  ) {
    this.client = client;
    this.toolRegistry = toolRegistry;
    this.conversation = conversation;
    this.config = options?.config ?? FALLBACK_AGENT_CONFIG;
    this.skillManager = options?.skillManager;
    this.configuredSkillNames = uniqueNonEmpty(options?.configuredSkillNames ?? []);
    this.skillScopeNames = uniqueNonEmpty(options?.skillScopeNames ?? []);
    this.shellTool = options?.shellTool;
    this.memoryManager = options?.memoryManager;
    this.contextRetriever = options?.contextRetriever;
    this.channelId = options?.channelId;
    this.runMode = options?.runMode ?? "chat";
    this.contextMode = options?.contextMode ?? "auto";
    this.projectContextPath = options?.projectContextPath;
  }

  // ----------------------------------------------------------
  // Approval gate — 放行机制
  // ----------------------------------------------------------

  /** 批准一次工具调用，下次执行时跳过 gate 拦截 */
  approveToolCall(toolName: string, params?: Record<string, unknown>): void {
    const key = params ? `${toolName}:${JSON.stringify(params)}` : toolName;
    this.approvedCalls.add(key);
  }

  /** 直接添加预构建的 callKey（用于从 DB 恢复已批准记录） */
  approveCallKey(callKey: string): void {
    this.approvedCalls.add(callKey);
  }

  // ----------------------------------------------------------
  // Abort 机制
  // ----------------------------------------------------------

  /**
   * 中断当前 AgentLoop 执行：
   * 1. 设置 aborted 标志位
   * 2. 如果正在等 LLM 响应，用 AbortController 取消 fetch
   * 3. 如果正在执行工具，通过 AbortController 取消（ShellTool 会 kill 子进程）
   */
  abort(): void {
    log.step("Abort requested", {
      hasLLMController: !!this.currentAbortController,
      hasToolController: !!this.currentToolAbortController,
    });
    this.aborted = true;
    // 取消正在进行的 LLM 请求
    if (this.currentAbortController) {
      log.info("Aborting LLM request via AbortController");
      this.currentAbortController.abort();
    }
    // 取消正在执行的工具（会触发 ShellTool 里的 proc.kill()）
    if (this.currentToolAbortController) {
      log.info("Aborting tool execution via AbortController");
      this.currentToolAbortController.abort();
    }
  }

  // ----------------------------------------------------------
  // 运行中注入指令
  // ----------------------------------------------------------

  /**
   * 向 Agent 注入一条消息，将在下一个合适时机（工具执行后或 end_turn 后）被处理。
   */
  inject(message: string): void {
    this.pendingInjections.push(message);
  }

  /** 是否正在执行 run() */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * 消费 pendingInjections 队列，合并为一段注入文本。
   * 返回 null 表示队列为空。
   */
  private drainInjections(): string | null {
    if (this.pendingInjections.length === 0) return null;
    const messages = this.pendingInjections.splice(0);
    const merged = messages.map((m) => `"${m}"`).join("\n");
    return `\n\n---\n[USER UPDATE]: 用户在执行过程中补充了新的指令：\n${merged}\n请根据这个新指令调整你的后续行为。\n---`;
  }

  /**
   * ReAct (Reason + Act) 循环：LLM 先推理（生成文本/工具调用），再执行工具，
   * 将工具结果反馈给 LLM 进行下一轮推理，如此反复直到 LLM 给出最终回复。
   */
  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    // 重置 abort 状态
    this.aborted = false;
    this._isRunning = true;

    try {
      yield* this.runInner(userMessage);
    } finally {
      this._isRunning = false;
      this.currentAbortController = null;
      this.currentToolAbortController = null;
      // 清空未消费的注入队列，防止泄漏到下一次 run()
      this.pendingInjections.length = 0;
    }
  }

  private async *runInner(userMessage: string): AsyncGenerator<AgentEvent> {
    const isFirstRound = this.conversation.getMessages().length === 0;
    this.conversation.addUser(userMessage);

    log.step("Run started", {
      agent: this.config.name ?? "main",
      session: this.conversation.getSessionId(),
      userMessage: userMessage,
      isFirstRound,
    });

    const contextPolicy = buildContextPolicy({
      userMessage,
      runMode: this.runMode,
      contextMode: this.contextMode,
      hasProjectContext: !!this.projectContextPath,
      hasConfiguredSkills: this.configuredSkillNames.length > 0,
    });
    this.currentContextPolicy = contextPolicy;

    // 每轮对话开始时，加载文件记忆层 + 从向量数据库检索相关上下文
    if (this.memoryManager) {
      try {
        // 并行加载文件记忆和向量检索。
        const sessionId = this.conversation.getSessionId();
        const [fileMemoryCtx, memories] = await Promise.all([
          this.memoryManager.loadFileMemoryContext({
            contextMap: contextPolicy.loadContextMap,
            identity: contextPolicy.loadIdentity && contextPolicy.memoryLoadMode === "full_budgeted",
            inbox: contextPolicy.loadInbox,
          }),
          contextPolicy.retrieveLongTermMemory && contextPolicy.memoryRecallTopK > 0
            ? this.memoryManager.recall(
              userMessage,
              sessionId,
              contextPolicy.memoryRecallTopK,
              this.channelId,
            )
            : Promise.resolve([]),
        ]);
        this.cachedFileMemory = fileMemoryCtx;
        this.cachedMemories = memories;
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[debug] Memory recall failed:`, err);
        }
        this.cachedMemories = [];
        this.cachedFileMemory = { contextMap: null, identity: null, inbox: null };
      }
    }

    this.cachedProjectOverview = null;
    if (contextPolicy.loadProjectOverview && this.projectContextPath && this.memoryManager) {
      try {
        const overview = await this.memoryManager.getFileMemory()
          ?.getContextHub()
          .readOverview(this.projectContextPath);
        if (overview) {
          this.cachedProjectOverview = {
            path: this.projectContextPath,
            content: overview,
          };
        }
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[debug] Project overview load failed:`, err);
        }
      }
    }

    // Context Hub L1 overview 检索
    if (this.contextRetriever && userMessage && contextPolicy.retrieveContextOverviews) {
      try {
        const matched = await this.contextRetriever.retrieve(userMessage, contextPolicy.contextOverviewTopK);
        this.cachedContextOverviews = matched;
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[debug] Context overview retrieval failed:`, err);
        }
        this.cachedContextOverviews = [];
      }
    } else {
      this.cachedContextOverviews = [];
    }

    // Skill 选择：Team agent 可通过 agent.yaml.skills 固定注入；未配置时走检索。
    // 没有命中时保持为空，避免把所有 skill 都塞进 system prompt。
    if (this.skillManager) {
      if (this.configuredSkillNames.length > 0) {
        this.selectedSkills = this.getConfiguredLoadedSkills();
        const loadedNames = new Set(this.selectedSkills.map((skill) => skill.name));
        const missing = this.configuredSkillNames.filter((name) => !loadedNames.has(name));
        if (missing.length > 0) {
          log.warn(
            `Configured skill(s) are not loaded for agent ${this.config.name}`,
            missing.join(", "),
          );
        }
        if (this.selectedSkills.length > 0) {
          yield {
            type: "skills_matched",
            skills: this.selectedSkills.map((skill) => ({
              name: skill.name,
              score: 1,
              matchReason: "configured in agent.yaml",
            })),
          };
        }
      } else {
        const retriever = this.skillManager.getRetriever();
        const pinnedNames = new Set(this.skillManager.getPinnedSkills());
        const allLoaded = this.skillManager.getLoadedSkills();
        const pinned = allLoaded.filter(s => pinnedNames.has(s.name));
        if (retriever && userMessage) {
          try {
            // 构造检索 query：当前用户消息 + 最近几轮对话摘要，提供足够上下文
            const query = this.buildSkillQuery(userMessage);
            const retrievalLimit = this.skillScopeNames.length > 0
              ? Math.max(SKILL_RETRIEVAL_TOP_K, this.skillScopeNames.length * 3)
              : SKILL_RETRIEVAL_TOP_K;
            const matched = (await retriever.retrieve(query, retrievalLimit))
              .filter((match) => this.isSkillInScope(match.skill.name));
            const filtered = await filterSkillCandidates(query, matched, this.skillManager!.getReranker());
            const selectedMatches = this.selectRetrievedSkills(filtered);
            // 合并 pinned + retrieved（去重）。不保留上一轮未命中的 skill，避免上下文漂移。
            const matchedNames = new Set(selectedMatches.map(m => m.skill.name));
            const extraPinned = pinned.filter(s => !matchedNames.has(s.name));

            this.selectedSkills = [...extraPinned, ...selectedMatches.map(m => m.skill)];

            if (selectedMatches.length > 0) {
              const matchedEvent: AgentSkillsMatchedEvent = {
                type: "skills_matched",
                skills: selectedMatches.map(m => ({
                  name: m.skill.name,
                  score: m.score,
                  matchReason: m.matchReason,
                })),
              };
              yield matchedEvent;
            }
          } catch (err) {
            if (process.env.DEBUG) {
              console.error(`[debug] Skill retrieval failed:`, err);
            }
            // 失败时只保留显式 pinned skill，不回退到全量。
            this.selectedSkills = pinned;
          }
        } else {
          this.selectedSkills = pinned;
        }
      }
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolCallCounts = new Map<string, number>();

    // ReAct 主循环：最多迭代 config.maxTurns 次，防止无限循环
    for (let i = 0; i < this.config.maxTurns; i++) {
      // === Abort 检查 ===
      if (this.aborted) {
        log.warn(`Aborted at loop start (turn ${i + 1})`);
        yield { type: "text_delta", text: "\n\n[Aborted by user]" };
        yield { type: "done", usage: { totalInputTokens, totalOutputTokens } };
        return;
      }

      const messages = this.conversation.getMessages();
      const estimatedTokens = JSON.stringify(messages).length / 4; // rough estimate: 1 token ≈ 4 chars
      log.step(`====== ReAct Turn ${i + 1}/${this.config.maxTurns} START ======`, {
        agent: this.config.name ?? "main",
        session: this.conversation.getSessionId(),
        messageCount: messages.length,
        estimatedTokens: Math.round(estimatedTokens),
      });

      // === Reason 阶段：调用 LLM，流式接收推理结果 ===
      // --- Call LLM ---
      let textContent = "";
      let reasoningContent = "";
      const toolUseBlocks: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // Track tool calls being streamed: index -> accumulated args JSON
      // 跟踪流式传输中的工具调用：按索引累积参数 JSON 片段
      const pendingToolArgs = new Map<number, string>();
      const pendingToolMeta = new Map<number, { id: string; name: string }>();

      let streamSuccess = false;
      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
        // Abort 检查
        if (this.aborted) {
          log.warn(`Aborted at retry start (attempt ${attempt})`);
          yield { type: "text_delta", text: "\n\n[Aborted by user]" };
          yield { type: "done", usage: { totalInputTokens, totalOutputTokens } };
          return;
        }

        // 每次重试前重置流式状态
        textContent = "";
        reasoningContent = "";
        pendingToolArgs.clear();
        pendingToolMeta.clear();
        stopReason = "end_turn";

        // 创建 AbortController 用于取消当前 LLM 请求
        const abortController = new AbortController();
        this.currentAbortController = abortController;

        try {
          const llmInput = this.getEffectiveLLMInput();
          const systemPrompt = llmInput.systemPrompt;
          const filteredTools = this.getFilteredToolDefinitions();

          log.llmCall(`Turn ${i + 1} (attempt ${attempt})`, {
            system: systemPrompt,
            messages: llmInput.messages,
            tools: filteredTools,
          });

          const chatStream = this.client.chat(
            llmInput.messages,
            {
              system: systemPrompt,
              tools: filteredTools,
              signal: abortController.signal,
              streamChunkTimeoutMs: this.getStreamChunkTimeoutMs(),
            },
          );
          for await (const event of chatStream) {
            // Abort 检查（流式过程中）
            if (this.aborted) {
              log.warn(`Aborted during LLM stream, textContent length=${textContent.length}`);
              // 尝试保存已收到的部分文本
              if (textContent) {
                this.conversation.addAssistant(textContent + "\n\n[Aborted by user]");
              }
              yield { type: "text_delta", text: "\n\n[Aborted by user]" };
              yield { type: "done", usage: { totalInputTokens, totalOutputTokens } };
              return;
            }

            // 处理流式事件：文本增量、工具调用开始/增量/结束、消息结束
            if (process.env.DEBUG) {
              console.error(`[debug] stream event: ${event.type}`, JSON.stringify(event).slice(0, 200));
            }
            switch (event.type) {
              case "reasoning_delta":
                reasoningContent += event.reasoning_content;
                break;

              case "text_delta":
                textContent += event.text;
                yield { type: "text_delta", text: event.text };
                break;

              case "tool_use_start":
                pendingToolMeta.set(pendingToolMeta.size, {
                  id: event.id,
                  name: event.name,
                });
                pendingToolArgs.set(pendingToolArgs.size, "");
                break;

              case "tool_use_delta": {
                // Append to the last pending tool call's args
                const lastIdx = pendingToolArgs.size - 1;
                const prev = pendingToolArgs.get(lastIdx) ?? "";
                pendingToolArgs.set(lastIdx, prev + event.input_json);
                break;
              }

              case "tool_use_end":
                // Nothing to do here; we finalize after message_end
                break;

              case "message_end":
                stopReason = event.stop_reason;
                totalInputTokens += event.usage.input_tokens;
                totalOutputTokens += event.usage.output_tokens;
                break;
            }
          }
          streamSuccess = true;
          this.currentAbortController = null;
          break; // 流式读取成功，跳出重试循环
        } catch (err) {
          this.currentAbortController = null;

          // 如果是因为 abort 导致的错误，直接退出
          if (this.aborted) {
            log.warn(`Aborted during stream error catch, textContent length=${textContent.length}`);
            if (textContent) {
              this.conversation.addAssistant(textContent + "\n\n[Aborted by user]");
            }
            yield { type: "text_delta", text: "\n\n[Aborted by user]" };
            yield { type: "done", usage: { totalInputTokens, totalOutputTokens } };
            return;
          }

          const msg = err instanceof Error ? err.message : String(err);
          const isRetryable = msg.includes("Stream timeout") || msg.includes("ECONNRESET") || msg.includes("fetch failed");
          const hasMoreRetries = attempt < MAX_STREAM_RETRIES;

          if (isRetryable && hasMoreRetries) {
            yield { type: "error", message: `${msg} — retrying (${attempt + 1}/${MAX_STREAM_RETRIES})...` };
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }

          // 不可重试或重试次数用尽
          yield { type: "error", message: msg };
          return;
        }
      }

      if (!streamSuccess) {
        yield { type: "error", message: "LLM stream failed after all retries" };
        return;
      }

      // --- Build tool use blocks from accumulated streaming data ---
      // 将流式累积的工具调用片段组装为完整的 ToolUseBlock（解析 JSON 参数）
      for (const [idx, meta] of pendingToolMeta) {
        const argsJson = pendingToolArgs.get(idx) ?? "{}";
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(argsJson);
        } catch {
          input = {};
        }
        toolUseBlocks.push({
          type: "tool_use",
          id: meta.id,
          name: meta.name,
          input,
        });
      }

      // 记录 LLM 返回的完整响应
      log.llmResponse(`Turn ${i + 1} response`, {
        stopReason,
        text: textContent,
        toolCalls: toolUseBlocks.length > 0
          ? toolUseBlocks.map((t) => ({ name: t.name, input: t.input }))
          : undefined,
        usage: { totalInputTokens, totalOutputTokens },
      });

      // --- No tool calls: end turn ---
      // 判断停止条件：LLM 没有请求工具调用，说明推理完成，保存回复并结束循环
      // 注意：不能仅凭 stopReason === "end_turn" 就结束，某些 provider 会在返回 tool_calls 的同时
      // 标记 stop_reason 为 end_turn，此时应优先按 tool_calls 执行
      if (toolUseBlocks.length === 0) {
        let finalTextContent = stopReason === "max_tokens"
          ? `${textContent}\n\n[Response stopped because the model hit its output limit. Send "continue" to resume.]`
          : textContent;
        let supplementalText = finalTextContent !== textContent
          ? finalTextContent.slice(textContent.length)
          : "";

        if (finalTextContent.trim().length === 0) {
          log.warn(
            `Turn ${i + 1} produced an empty model response`,
            JSON.stringify({
              stopReason,
              usage: { totalInputTokens, totalOutputTokens },
            }),
          );
          finalTextContent = EMPTY_MODEL_RESPONSE_MESSAGE;
          supplementalText = EMPTY_MODEL_RESPONSE_MESSAGE;
        }

        if (supplementalText) {
          yield { type: "text_delta", text: supplementalText };
        }

        log.step(`Turn ${i + 1} COMPLETE — end_turn (no tool calls)`, {
          stopReason,
          textLength: finalTextContent.length,
          response: finalTextContent,
        });

        this.conversation.addAssistant(finalTextContent);

        // Auto-generate session title after first round (fire-and-forget)
        // 只有主 Agent 才需要生成 title，sub-agent 的 EphemeralConversation 无需标题
        if (!this.pendingTitleGeneration && this.config.canSpawnSubAgent) {
          const firstUserMsg = this.conversation.getMessages().find((m) => m.role === "user");
          const titleInput = (firstUserMsg?.content as string) ?? userMessage;
          this.maybeGenerateTitle(titleInput, finalTextContent);
        }

        // === 注入检查（end_turn 场景）===
        // LLM 返回了 end_turn，如果有待注入消息，作为新一轮 user message 追加并继续循环
        const injection = this.drainInjections();
        if (injection) {
          this.conversation.addUser(injection);
          log.info("Injection applied as new user message after end_turn", injection);
          // 不 yield done，继续循环让 LLM 处理注入内容
          continue;
        }

        yield {
          type: "done",
          usage: { totalInputTokens, totalOutputTokens },
        };

        // 增量写入每日 JSONL 日志（同步追加，即时落盘）
        if (this.memoryManager) {
          const allMsgs = this.conversation.getMessages();
          const newMsgs = allMsgs.slice(this.lastWrittenMsgCount);
          if (newMsgs.length > 0) {
            const sid = this.conversation.getSessionId();
            this.memoryManager.saveDailyLog(sid, this.channelId, newMsgs);
            this.lastWrittenMsgCount = allMsgs.length;
          }
        }

        // 每轮都通知 flush coordinator；是否达到五个新增 assistant 回合由持久化 cursor 判断。
        if (this.memoryManager) {
          const sid = this.conversation.getSessionId();
          if (sid !== "ephemeral") this.memoryManager.flushSession(sid, { reason: "interval" })?.catch((err) => {
            if (process.env.DEBUG) {
              console.error(`[debug] Auto memory save failed:`, err);
            }
          });
        }

        return;
      }

      // --- Has tool calls: execute them ---
      // === Act 阶段：LLM 请求了工具调用，逐个执行并收集结果 ===
      const assistantBlocks: AssistantContentBlock[] = [];
      if (reasoningContent) {
        assistantBlocks.push({
          type: "reasoning",
          reasoning_content: reasoningContent,
        });
      }
      if (textContent) {
        assistantBlocks.push({ type: "text", text: textContent });
      }
      assistantBlocks.push(...toolUseBlocks);
      const messageId = this.conversation.addToolUse(assistantBlocks);

      const toolResultParams: Array<{
        toolUseId: string;
        toolName: string;
        input: unknown;
        output: string;
        isError: boolean;
      }> = [];
      let roundToolResultChars = 0;
      let contentRefReadsThisRound = 0;

      for (const block of toolUseBlocks) {
        // Abort 检查（工具执行前）
        if (this.aborted) {
          log.warn(`Aborted before tool execution, tool=${block.name}`);
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            output: "[Aborted by user]",
            isError: true,
          });
          continue;
        }

        const preparedToolInput = this.prepareToolInput(block.name, block.input);
        if (!preparedToolInput.ok) {
          const result = { success: false, output: "", error: preparedToolInput.error };
          yield { type: "tool_call", name: block.name, params: block.input };
          yield { type: "tool_result", name: block.name, result };
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            output: preparedToolInput.error,
            isError: true,
          });
          continue;
        }
        const toolInput = preparedToolInput.input;

        yield { type: "tool_call", name: block.name, params: toolInput };
        log.toolCall(block.name, toolInput);
        if (preparedToolInput.note) {
          log.info(preparedToolInput.note);
        }

        if (block.name === "read_content_ref") {
          if (contentRefReadsThisRound >= MAX_CONTENT_REF_READS_PER_ROUND) {
            const error =
              `read_content_ref is limited to ${MAX_CONTENT_REF_READS_PER_ROUND} pages per agent turn. ` +
              "Use search_content_ref to locate relevant chunks, or explain the missing fields before continuing in the next turn.";
            const result = { success: false, output: "", error };
            yield { type: "tool_result", name: block.name, result };
            toolResultParams.push({
              toolUseId: block.id,
              toolName: block.name,
              input: toolInput,
              output: error,
              isError: true,
            });
            continue;
          }
          contentRefReadsThisRound++;
        }

        // --- Pre-execute approval gate ---
        if (this.config.approvalRules?.length) {
          const callKey = `${block.name}:${JSON.stringify(toolInput)}`;
          if (!this.approvedCalls.has(callKey) && !this.approvedCalls.has(block.name)) {
            const gateResult = checkApprovalGate(this.config.approvalRules, block.name, toolInput, {
              workspaceRoot: this.getContentStoreBaseDir(),
            });
            if (gateResult.action !== "allow") {
              const msg = (gateResult.rule as { message?: string })?.message
                ?? `Tool "${block.name}" requires human approval (matched: ${(gateResult.rule as { pattern?: string })?.pattern ?? "all calls"}).`;
              if (gateResult.action === "deny") {
                const result = { success: false, output: "", error: `[DENIED] ${msg}` };
                yield { type: "tool_result", name: block.name, result };
                toolResultParams.push({
                  toolUseId: block.id,
                  toolName: block.name,
                  input: toolInput,
                  output: result.error,
                  isError: true,
                });
                continue;
              }
              const result = { success: true, output: `[APPROVAL REQUIRED] ${msg}` };
              yield { type: "tool_result", name: block.name, result };
              yield { type: "approval_gate_triggered", rule: gateResult.rule, toolName: block.name, params: toolInput };
              toolResultParams.push({
                toolUseId: block.id,
                toolName: block.name,
                input: toolInput,
                output: result.output,
                isError: false,
              });
              continue;
            }
          }
        }

        const tool = this.toolRegistry.get(block.name);
        if (!tool) {
          const result = {
            success: false,
            output: "",
            error: `Unknown tool: ${block.name}`,
          };
          yield { type: "tool_result", name: block.name, result };
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            output: `Unknown tool: ${block.name}`,
            isError: true,
          });
          continue;
        }

        const toolLimit = this.config.toolLimits?.[block.name];
        if (toolLimit !== undefined) {
          const used = toolCallCounts.get(block.name) ?? 0;
          if (used >= toolLimit) {
            const error = this.formatToolLimitError(block.name, toolLimit);
            const result = { success: false, output: "", error };
            yield { type: "tool_result", name: block.name, result };
            toolResultParams.push({
              toolUseId: block.id,
              toolName: block.name,
              input: toolInput,
              output: error,
              isError: true,
            });
            continue;
          }
          toolCallCounts.set(block.name, used + 1);
        }

        try {
          const toolAbortController = new AbortController();
          this.currentToolAbortController = toolAbortController;
          // 如果已经 aborted，立即取消
          if (this.aborted) {
            toolAbortController.abort();
          }
          const executeOptions = this.buildToolExecuteOptions(block.name, toolAbortController.signal);
          const result = await tool.execute(toolInput, executeOptions);
          this.currentToolAbortController = null;
          const originalOutput = result.success
            ? result.output
            : result.error ?? result.output ?? "Unknown error";
          const budgetedOutput = await this.applyToolResultBudget({
            toolName: block.name,
            input: toolInput,
            output: originalOutput,
            isError: !result.success,
            currentRoundChars: roundToolResultChars,
          });
          roundToolResultChars += budgetedOutput.length;
          const budgetedResult = result.success
            ? { success: true, output: budgetedOutput }
            : { success: false, output: "", error: budgetedOutput };
          log.toolResult(block.name, {
            success: budgetedResult.success,
            output: budgetedResult.output,
            error: budgetedResult.error,
          });
          yield { type: "tool_result", name: block.name, result: budgetedResult };
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: toolInput,
            output: budgetedOutput,
            isError: !budgetedResult.success,
          });
        } catch (err) {
          this.currentToolAbortController = null;
          const errMsg = err instanceof Error ? err.message : String(err);
          log.toolResult(block.name, { success: false, error: errMsg });
          const result = { success: false, output: "", error: errMsg };
          yield { type: "tool_result", name: block.name, result };
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            output: errMsg,
            isError: true,
          });
        }
      }

      // Abort 检查（所有工具执行完成后）
      if (this.aborted) {
        log.warn("Aborted after all tools executed");
        this.conversation.addToolResults(messageId, toolResultParams);
        yield { type: "done", usage: { totalInputTokens, totalOutputTokens } };
        return;
      }

      // === 注入检查（tool_result 场景）===
      // 执行完工具、准备把 tool_result 发给 LLM 之前，检查 pendingInjections 队列
      const injection = this.drainInjections();
      if (injection) {
        // 把注入文本附加到最后一个 tool_result 的 output 末尾
        const lastParam = toolResultParams[toolResultParams.length - 1];
        if (lastParam) {
          lastParam.output += injection;
        }
        console.log(`[DEBUG] Injection appended to tool_result`);
      }

      this.conversation.addToolResults(messageId, toolResultParams);

      // 增量写入每日 JSONL 日志（每个 tool turn 完成后即时落盘）
      if (this.memoryManager) {
        const allMsgs = this.conversation.getMessages();
        const newMsgs = allMsgs.slice(this.lastWrittenMsgCount);
        if (newMsgs.length > 0) {
          const sid = this.conversation.getSessionId();
          this.memoryManager.saveDailyLog(sid, this.channelId, newMsgs);
          this.lastWrittenMsgCount = allMsgs.length;
        }
      }

      log.step(`Turn ${i + 1} COMPLETE — has tool calls, continuing loop`, {
        stopReason,
        toolCalls: toolUseBlocks.map((t) => t.name).join(", "),
        textLength: textContent.length,
        text: textContent,
      });
      // continue loop — LLM will see tool results and respond
      // 继续循环 — LLM 在下一轮迭代中会看到工具执行结果，并据此继续推理
    }

    // Max iterations reached
    // 安全阀：达到最大迭代次数，强制终止循环并报错
    yield {
      type: "error",
      message: `Agent loop exceeded maximum iterations (${this.config.maxTurns})`,
    };
    yield {
      type: "done",
      usage: { totalInputTokens, totalOutputTokens },
    };
  }

  private maybeGenerateTitle(userMessage: string, assistantReply: string): void {
    this.pendingTitleGeneration = generateTitle(this.client, userMessage, assistantReply)
      .then((title) => {
        if (title) {
          this.conversation.updateSessionTitle(title);
        }
      })
      .catch((err) => {
        if (process.env.DEBUG) {
          console.error(`[debug] Title generation failed:`, err);
        }
      });
  }

  private prepareToolInput(
    toolName: string,
    input: Record<string, unknown>,
  ): { ok: true; input: Record<string, unknown>; note?: string } | { ok: false; error: string } {
    if (toolName !== "write_file" || !this.projectContextPath) {
      return { ok: true, input };
    }
    return scopeProjectWriteFileInput(input, this.projectContextPath);
  }

  private formatToolLimitError(toolName: string, limit: number): string {
    const base = `${toolName} is limited to ${limit} call(s) per agent run and the quota is exhausted.`;
    if (toolName === "web_search" || toolName === "web_fetch") {
      return `${base} Do not call web_search or web_fetch again in this task. Use existing raw JSON, content_ref data, and prior tool results; proceed to analysis and write the final output.`;
    }
    if (toolName === "read_content_ref" || toolName === "search_content_ref") {
      return `${base} Do not call read_content_ref or search_content_ref again in this task. Use already-read pages, raw JSON digests, and prior tool results; proceed to write the final output and stop.`;
    }
    return `${base} Continue with existing information or finish the task without this tool.`;
  }

  private buildToolExecuteOptions(toolName: string, signal: AbortSignal): ToolExecuteOptions {
    const options: ToolExecuteOptions = {
      signal,
      projectContextPath: this.projectContextPath,
      contentStoreBaseDir: this.getContentStoreBaseDir(),
    };
    if (toolName !== "shell") return options;

    const env = this.collectShellEnv();
    if (Object.keys(env).length > 0) {
      options.env = env;
    }

    const cwd = this.getProjectWorkspaceRoot();
    if (cwd) {
      options.cwd = cwd;
    }
    return options;
  }

  private async applyToolResultBudget(input: {
    toolName: string;
    input: unknown;
    output: string;
    isError: boolean;
    currentRoundChars: number;
  }): Promise<string> {
    if (!input.output) return input.output;

    const singleHard = input.toolName === "read_content_ref"
      ? TOOL_RESULT_PAGE_HARD_CHARS
      : TOOL_RESULT_SINGLE_HARD_CHARS;
    const overSingle = input.output.length > singleHard;
    const overRound = input.currentRoundChars + input.output.length > TOOL_RESULT_ROUND_HARD_CHARS;
    if (!overSingle && !overRound) return input.output;

    try {
      const digest = await this.getContentStore().storeText({
        sourceTool: input.toolName,
        sourceUri: this.getToolSourceUri(input.toolName, input.input),
        title: `Tool result: ${input.toolName}`,
        content: input.output,
        mimeType: "text/plain",
        projectContextPath: this.projectContextPath,
        metadata: {
          tool_name: input.toolName,
          tool_input: input.input,
          is_error: input.isError,
          budget_reason: overSingle ? "single_tool_result_hard_limit" : "round_tool_result_hard_limit",
          original_output_length: input.output.length,
        },
      });
      return JSON.stringify({
        ...digest,
        budget_note:
          `Tool output was ${input.output.length} chars and was stored as content_ref to keep the LLM context small.`,
      }, null, 2);
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      return truncateHeadTail(
        input.output,
        singleHard,
        `\n\n[truncated: tool output exceeded context budget and Content Store failed: ${note}]`,
      );
    }
  }

  private getContentStore(): ContentStore {
    if (!this.contentStore) {
      this.contentStore = new ContentStore(this.getContentStoreBaseDir());
    }
    return this.contentStore;
  }

  private getContentStoreBaseDir(): string {
    return this.memoryManager?.getFileMemory()?.getBaseDir() ?? join(homedir(), ".little_claw");
  }

  private getToolSourceUri(toolName: string, input: unknown): string | null {
    if (!input || typeof input !== "object") return toolName;
    const record = input as Record<string, unknown>;
    for (const key of ["url", "path", "file", "query", "command"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return toolName;
  }

  private collectShellEnv(): Record<string, string> {
    const env = this.skillManager ? this.collectSkillEnv() : {};
    const projectRoot = this.getProjectWorkspaceRoot();
    const projectContextPath = normalizeProjectContextPath(this.projectContextPath);
    if (projectRoot && projectContextPath) {
      env.LITTLE_CLAW_PROJECT_WORKSPACE = projectRoot;
      env.LITTLE_CLAW_PROJECT_CONTEXT_PATH = projectContextPath;
    }
    return env;
  }

  private getProjectWorkspaceRoot(): string | null {
    return projectWorkspaceRoot(
      this.memoryManager?.getFileMemory()?.getBaseDir(),
      this.projectContextPath,
    );
  }

  /**
   * 构造 skill 检索 query：当前用户消息 + 最近几轮用户消息，
   * 避免多轮对话中后续短消息（如"继续"）缺乏上下文导致检索失效。
   */
  private buildSkillQuery(currentMessage: string): string {
    const messages = this.conversation.getMessages();
    // 取最近 3 条用户消息（不含当前这条，因为它刚刚被 addUser 加入）
    const recentUserMsgs: string[] = [];
    for (let i = messages.length - 2; i >= 0 && recentUserMsgs.length < 3; i--) {
      const m = messages[i]!;
      if (m.role === "user" && typeof m.content === "string") {
        recentUserMsgs.push(m.content);
      }
    }
    if (recentUserMsgs.length === 0) return currentMessage;
    // 当前消息权重最高，放在最前面
    return [currentMessage, ...recentUserMsgs.reverse()].join("\n");
  }

  private selectRetrievedSkills(matches: ScoredSkill[]): ScoredSkill[] {
    if (matches.length === 0) return [];
    const policy = this.currentContextPolicy;

    const fullLimit = Math.max(1, policy?.skillFullLimit ?? 1);
    const summaryLimit = Math.max(0, policy?.skillSummaryLimit ?? 0);
    return matches.slice(0, fullLimit + summaryLimit);
  }

  /**
   * 构建完整的 LLM 输入上下文，按优先级分配 token 预算：
   *
   * Context Assembler 加载顺序：
   *   1. identity / inbox / contextMap — 按 ContextPolicy 加载
   *   2. contextOverviews — 按 ContextPolicy 检索或加载项目 overview
   *   3. System prompt（角色定义 + workspace + scheduler）
   *   4. 向量检索结果 — 根据用户新消息检索相关的日志片段
   *   5. Skill 指令（来自 SkillPromptBuilder）
   *   6. 对话历史（来自 Conversation）
   *   7. 用户新消息
   *
   * 如果总量超预算，从 Skill 指令和向量检索开始砍。
   */
  private getEffectiveLLMInput(): { systemPrompt: string; messages: ReturnType<ConversationLike["getMessages"]> } {
    // 基础 system prompt = 会话 prompt + 角色定义 + scheduler 指导 + 记忆指引
    const basePrompt = this.conversation.getSystemPrompt();
    const policy = this.currentContextPolicy ?? buildContextPolicy({
      userMessage: "",
      runMode: this.runMode,
      contextMode: this.contextMode,
      hasProjectContext: !!this.projectContextPath,
      hasConfiguredSkills: this.configuredSkillNames.length > 0,
    });
    const memoryGuidance = this.getMemoryGuidance(policy);
    const configSystemPrompt = this.config.systemPrompt.trim();
    const coreSystemParts = [basePrompt];
    if (configSystemPrompt && basePrompt.trim() !== configSystemPrompt) {
      coreSystemParts.push(this.config.systemPrompt);
    }
    const schedulerGuidance = this.getSchedulerGuidance();
    if (schedulerGuidance) {
      coreSystemParts.push(schedulerGuidance);
    }
    const projectWorkspaceGuidance = this.getProjectWorkspaceGuidance();
    if (projectWorkspaceGuidance) {
      coreSystemParts.push(projectWorkspaceGuidance);
    }
    const toolLimitGuidance = this.getToolLimitGuidance();
    if (toolLimitGuidance) {
      coreSystemParts.push(toolLimitGuidance);
    }
    coreSystemParts.push(memoryGuidance);
    coreSystemParts.push(`Current time: ${new Date().toLocaleString("zh-CN", { timeZone: APP_TIME_ZONE, hour12: false })}`);
    const coreSystemPrompt = coreSystemParts.join("\n\n");

    // 获取当前对话中最后一条用户消息（用于 skill 相关性匹配和预算分配）
    const rawMessages = this.conversation.getMessages();
    const lastUserMsg = rawMessages.length > 0
      ? rawMessages.filter((m) => m.role === "user").pop()
      : undefined;
    const userMessageText = lastUserMsg
      ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
      : "";
    const compaction = compactConversationHistory(rawMessages);
    const messages = compaction.messages;
    if (compaction.compacted) {
      log.step("Conversation compaction", {
        omittedMessages: compaction.omittedMessages,
        originalTokens: compaction.originalTokens,
        compactedTokens: compaction.compactedTokens,
        keptMessages: messages.length,
      });
    }

    // 构建 skill prompt
    let skillPrompt = "";
    if (this.skillManager) {
      const skills = this.configuredSkillNames.length > 0
        ? this.selectedSkills
        : this.selectedSkills;
      if (skills.length > 0) {
        const builder = new SkillPromptBuilder();
        const raw = builder.buildSkillPrompt(
          skills,
          this.skillManager.getTokenBudget(),
          {
            fullLimit: this.configuredSkillNames.length > 0
              ? Number.POSITIVE_INFINITY
              : policy.skillFullLimit,
            summaryLimit: this.configuredSkillNames.length > 0
              ? 0
              : policy.skillSummaryLimit,
          },
        );
        if (raw) {
          skillPrompt = `${SKILL_GUIDE}\n\n${raw}`;
        }
      }
    }

    // Memory + Context Hub: MEMORY.md + inbox.md + context map
    const budgetedIdentity = this.cachedFileMemory.identity
      ? truncateToTokenBudget(this.cachedFileMemory.identity, policy.memoryFileTokenBudget)
      : "";
    const budgetedInbox = this.cachedFileMemory.inbox
      ? truncateToTokenBudget(this.cachedFileMemory.inbox, policy.inboxTokenBudget)
      : "";
    const identityPrompt = budgetedIdentity
      ? `<memory_file path="memory/MEMORY.md">\n${budgetedIdentity}\n</memory_file>`
      : "";
    const inboxPrompt = budgetedInbox
      ? `<memory_file path="memory/inbox.md">\n${budgetedInbox}\n</memory_file>`
      : "";
    const contextMapPrompt = this.cachedFileMemory.contextMap
      ? `<context_map>\nThe following is the user's context hub directory map (L0 abstracts):\n${this.cachedFileMemory.contextMap}\n</context_map>`
      : "";

    // L1 检索命中的 .overview.md
    let contextOverviewsPrompt = "";
    const overviewBlocks: string[] = [];
    if (this.cachedProjectOverview) {
      overviewBlocks.push(`## ${this.cachedProjectOverview.path}/.overview.md\n${this.cachedProjectOverview.content}`);
    }
    if (this.cachedContextOverviews.length > 0) {
      overviewBlocks.push(...this.cachedContextOverviews.map(
        (ctx) => `## ${ctx.dirPath}/.overview.md\n${ctx.overviewContent}`,
      ));
    }
    if (overviewBlocks.length > 0) {
      contextOverviewsPrompt = `<context_overviews>\nThe following overviews were loaded for this turn. Use them to decide which L2 files to read.\n\n${overviewBlocks.join("\n\n")}\n</context_overviews>`;
    }

    // 使用 TokenBudget 进行预算分配
    const allocation = allocateBudget({
      systemPrompt: coreSystemPrompt,
      userMessage: userMessageText,
      conversationHistory: messages,
      longTermMemory: limitStringsToTokenBudget(
        dedupeInjectedMemories(this.cachedMemories, budgetedIdentity),
        policy.memoryLoadMode === "retrieved_only" ? policy.memoryFileTokenBudget : 2_000,
      ),
      skillPrompt,
      identity: identityPrompt,
      inbox: inboxPrompt,
      contextMap: contextMapPrompt,
      contextOverviews: contextOverviewsPrompt,
    });

    // 组装最终的 system prompt，按加载顺序：
    // identity → inbox → contextMap → contextOverviews → core → 向量检索 → skill
    let finalPrompt = "";

    if (allocation.identity) {
      finalPrompt += allocation.identity + "\n\n";
    }

    if (allocation.inbox) {
      finalPrompt += allocation.inbox + "\n\n";
    }

    if (allocation.contextMap) {
      finalPrompt += allocation.contextMap + "\n\n";
    }

    if (allocation.contextOverviews) {
      finalPrompt += allocation.contextOverviews + "\n\n";
    }

    finalPrompt += allocation.systemPrompt;

    const memoryBlock = formatLongTermMemory(allocation.longTermMemory);
    if (memoryBlock) {
      finalPrompt += `\n\n${memoryBlock}`;
    }

    if (allocation.skillPrompt) {
      finalPrompt += `\n\n${allocation.skillPrompt}`;
    }

    this.logContextAssembly(finalPrompt, allocation, policy);

    return {
      systemPrompt: finalPrompt,
      messages: allocation.conversationHistory,
    };
  }

  private logContextAssembly(
    systemPrompt: string,
    allocation: ReturnType<typeof allocateBudget>,
    policy: ContextPolicy,
  ): void {
    log.step("Context assembly", {
      runMode: policy.runMode,
      contextMode: policy.contextMode,
      reason: policy.reason,
      systemTokens: estimateTokens(systemPrompt),
      messageCount: allocation.conversationHistory.length,
      includedBlocks: [
        allocation.identity ? { name: "identity", tokens: estimateTokens(allocation.identity) } : null,
        allocation.inbox ? { name: "inbox", tokens: estimateTokens(allocation.inbox) } : null,
        allocation.contextMap ? { name: "context_map", tokens: estimateTokens(allocation.contextMap) } : null,
        allocation.contextOverviews ? { name: "context_overviews", tokens: estimateTokens(allocation.contextOverviews) } : null,
        allocation.longTermMemory.length > 0
          ? { name: "long_term_memory", count: allocation.longTermMemory.length }
          : null,
        allocation.skillPrompt ? { name: "skills", tokens: estimateTokens(allocation.skillPrompt) } : null,
      ].filter(Boolean),
      skippedBlocks: [
        !policy.loadContextMap ? { name: "context_map", reason: "policy disabled global map" } : null,
        !policy.retrieveContextOverviews && !policy.loadProjectOverview
          ? { name: "context_overviews", reason: "policy disabled overview retrieval" }
          : null,
        !policy.retrieveLongTermMemory ? { name: "long_term_memory", reason: "policy disabled recall" } : null,
      ].filter(Boolean),
    });
  }

  private getMemoryGuidance(policy: ContextPolicy): string {
    if (policy.useFullMemoryGuidance && policy.loadContextMap) {
      return MEMORY_GUIDANCE;
    }
    if (policy.loadProjectOverview || policy.contextMode === "project" || policy.runMode === "team_worker") {
      return PROJECT_MEMORY_GUIDANCE;
    }
    return SHORT_MEMORY_GUIDANCE;
  }

  private getToolLimitGuidance(): string | null {
    const limits = this.config.toolLimits;
    if (!limits || Object.keys(limits).length === 0) return null;
    const lines = Object.entries(limits)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolName, limit]) => `- ${toolName}: at most ${limit} call(s) per run`);
    return `Tool call hard limits:
${lines.join("\n")}
When a quota is exhausted, do not try alternate queries or replacement URLs for that tool. Continue with existing evidence and finish the requested output.`;
  }

  private getProjectWorkspaceGuidance(): string | null {
    const projectContextPath = normalizeProjectContextPath(this.projectContextPath);
    if (!projectContextPath) return null;
    return `Project workspace boundary:
- Current project workspace: ${projectContextPath}/
- Keep project artifacts, scratch scripts, extracted source text, translations, notes, and status files inside this project workspace.
- write_file paths are scoped to this project workspace. Prefer simple relative filenames such as "extract_urls.py" or "translation.md" unless a subfolder is useful.
- The shell tool starts in the project workspace directory for project tasks. In shell commands, use relative paths such as "extract_content.py" and do not prefix ${projectContextPath}/ again.
- For context_write, use paths relative to context-hub/, e.g. "${projectContextPath.slice("context-hub/".length)}/notes.md".`;
  }

  private getSchedulerGuidance(): string | null {
    const toolNames = new Set(this.getFilteredToolDefinitions().map((tool) => tool.name));
    const hasPersonalScheduler = toolNames.has("manage_cron") || toolNames.has("manage_watcher");
    const hasTeamScheduler = toolNames.has("create_team_schedule");

    if (hasTeamScheduler) return TEAM_SCHEDULER_GUIDANCE;
    if (hasPersonalScheduler) return PERSONAL_SCHEDULER_GUIDANCE;
    if (this.runMode === "team_worker" || this.runMode === "agent_dm") {
      return NO_SCHEDULER_TOOL_GUIDANCE;
    }
    return null;
  }

  /**
   * 根据 config.allowedTools 过滤工具列表：
   * - allowedTools 为空：传所有工具
   * - allowedTools 非空：只取名称匹配的工具
   * - spawn_agent 工具只在 config.canSpawnSubAgent 为 true 时才加入
   */
  private getFilteredToolDefinitions(): ToolDefinition[] {
    let tools = this.toolRegistry.toToolDefinitions();

    // 按 allowedTools 白名单过滤
    if (this.config.allowedTools.length > 0) {
      const allowed = new Set(this.config.allowedTools);
      tools = tools.filter((t) => allowed.has(t.name));
    }

    // spawn_agent 工具的准入控制
    if (!this.config.canSpawnSubAgent) {
      tools = tools.filter((t) => t.name !== SPAWN_AGENT_TOOL_NAME);
    }

    return tools;
  }

  private getStreamChunkTimeoutMs(): number {
    const envKey = this.runMode === "team_worker"
      ? "LLM_BACKGROUND_STREAM_CHUNK_TIMEOUT_MS"
      : "LLM_STREAM_CHUNK_TIMEOUT_MS";
    const configured = readPositiveIntegerEnv(envKey);
    if (configured) return configured;
    return this.runMode === "team_worker"
      ? DEFAULT_BACKGROUND_STREAM_CHUNK_TIMEOUT_MS
      : DEFAULT_STREAM_CHUNK_TIMEOUT_MS;
  }

  /**
   * 收集所有已加载 Skill 的环境变量，合并为一个 Record。
   * 项目级 Skill 的值覆盖全局级（由 SkillLoader 的加载顺序保证）。
   */
  private collectSkillEnv(): Record<string, string> {
    if (!this.skillManager) return {};

    const merged: Record<string, string> = {};
    const loadedSkills = this.configuredSkillNames.length > 0
      ? this.getConfiguredLoadedSkills()
      : this.selectedSkills;

    // 反向遍历：先填入低优先级，后填入高优先级覆盖
    // SkillManager.getLoadedSkills() 按加载顺序返回（项目级在前），
    // 所以反向遍历后项目级的值会覆盖全局级
    for (let i = loadedSkills.length - 1; i >= 0; i--) {
      const env = this.skillManager.getSkillEnv(loadedSkills[i]!.name);
      Object.assign(merged, env);
    }

    return merged;
  }

  async waitForTitle(timeoutMs = 5000): Promise<void> {
    if (!this.pendingTitleGeneration) return;
    await Promise.race([
      this.pendingTitleGeneration,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private getConfiguredLoadedSkills(): ParsedSkill[] {
    if (!this.skillManager || this.configuredSkillNames.length === 0) return [];
    const configured = new Set(this.configuredSkillNames);
    return this.skillManager.getLoadedSkills().filter((skill) => configured.has(skill.name));
  }

  private isSkillInScope(skillName: string): boolean {
    if (this.skillScopeNames.length === 0) return true;
    return this.skillScopeNames.includes(skillName);
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function readPositiveIntegerEnv(key: string): number | null {
  const raw = process.env[key];
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function truncateHeadTail(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(200, maxChars - suffix.length - 32);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.max(0, budget - head);
  return `${text.slice(0, head)}\n\n...[middle truncated]...\n\n${tail > 0 ? text.slice(-tail) : ""}${suffix}`;
}

function dedupeInjectedMemories(memories: string[], injectedMemory: string): string[] {
  if (!injectedMemory) return [...new Set(memories)];
  const normalizedIdentity = normalizeMemoryText(injectedMemory);
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const content = memory.replace(/^\[[^\]]+\]\s*/, "");
    const normalized = normalizeMemoryText(content);
    if (!normalized || seen.has(normalized) || normalizedIdentity.includes(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
