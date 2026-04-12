import type { LLMProvider, ToolDefinition } from "../llm/types";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { Tool } from "../tools/types";
import type {
  ParsedPersona,
  ParsedScenario,
  ResponseStyle,
  SimulationEvent,
} from "./types";
import type { Message } from "../types/message";
import type { SkillManager } from "../skills/SkillManager";
import { ArgumentExtractor } from "./ArgumentExtractor";
import { createPersonaSandboxTools } from "./SandboxTools";
import { SpeakerSelector } from "./SpeakerSelector";
import { mkdir } from "node:fs/promises";
import { createLogger } from "../utils/logger";

const log = createLogger("Simulation");

type RoundAction =
  | { type: "next" }
  | { type: "speak"; message: string }
  | { type: "end" };

const THINKING_RE = /\[THINKING\]([\s\S]*?)\[\/THINKING\]/g;
const TRANSCRIPT_SUMMARY_THRESHOLD = 4000;

// --- Response Style Rules ---

const RESPONSE_STYLE_RULES: Record<ResponseStyle, string> = {
  conversational: `--- RESPONSE RULES ---
Keep your response SHORT and conversational:
- 2 to 4 sentences for a normal response
- 6 sentences maximum, only when making a complex argument
- Do NOT write essays, lists, or structured analysis
- Speak like you're in a real room talking to real people
- It's okay to be brief — you'll get more turns to speak
- React to the last 1-2 speakers, don't try to address everyone at once`,
  formal: `--- RESPONSE RULES ---
Keep your response focused and structured:
- 4 to 6 sentences, structured arguments welcome
- You may use brief lists or numbered points when clarifying a position
- Maintain a professional, deliberative tone
- Address specific arguments from other participants
- It's okay to be thorough — but stay on point`,
  rapid: `--- RESPONSE RULES ---
Keep your response VERY short:
- 1 to 2 sentences maximum, quick gut reactions, fragments okay
- React instantly — don't overthink
- One idea per turn, no elaboration
- You'll get plenty of turns to add more`,
};

// --- Simulation Rules ---

type ResponseTag = "ACT" | "SKIP" | "DONE";

/**
 * 构建追加到每个 Agent prompt 末尾的标准 SIMULATION RULES 文本。
 * 如果 scenario 设了 completion_hint，则包含在规则中。
 * responseStyle 控制发言长度约束，默认 conversational。
 */
function buildSimulationRules(completionHint?: string, responseStyle?: ResponseStyle): string {
  const style = responseStyle ?? "conversational";
  let rules = RESPONSE_STYLE_RULES[style];

  rules += `\n\n--- SIMULATION RULES ---
After reviewing the situation, choose ONE of these actions:

[ACT] — You have work to do. Do it now (write files, run commands, share your analysis, state your argument).
[SKIP] — You're waiting for someone else's output, or there's nothing for you to do yet. Briefly say what you're waiting for.
[DONE] — Your part is fully complete. You have nothing more to contribute.`;

  if (completionHint) {
    rules += `\n\n${completionHint}`;
  }

  rules += `\n\nStart your response with one of these tags, then proceed with your response.`;
  return rules;
}

/**
 * 从 Agent 响应开头解析 [ACT] / [SKIP] / [DONE] 标记。
 * 没有标记时默认当作 [ACT]（兼容纯对话场景）。
 */
function parseResponseTag(text: string): { tag: ResponseTag; body: string } {
  const trimmed = text.trimStart();
  const tagMatch = trimmed.match(/^\[(ACT|SKIP|DONE)\]\s*/i);
  if (tagMatch) {
    const tag = tagMatch[1]!.toUpperCase() as ResponseTag;
    const body = trimmed.slice(tagMatch[0].length);
    return { tag, body };
  }
  return { tag: "ACT", body: text };
}

// --- Streaming thinking filter ---

type FilteredChunk =
  | { type: "public_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; fullText: string };

/**
 * 包装原始 LLM 流，实时过滤 [THINKING]...[/THINKING] 标签。
 * 公开文本逐 token yield，thinking 内容在块结束时 yield。
 */
async function* streamWithThinkingFilter(
  rawStream: AsyncGenerator<{ type: "delta"; text: string } | { type: "done"; fullText: string }>,
): AsyncGenerator<FilteredChunk> {
  const OPEN_TAG = "[THINKING]";
  const CLOSE_TAG = "[/THINKING]";

  let inThinking = false;
  let pendingTag = "";       // 可能是标签前缀的缓冲
  let thinkingContent = "";
  let fullPublicText = "";

  for await (const chunk of rawStream) {
    if (chunk.type === "done") {
      // flush 残留
      if (pendingTag) {
        if (inThinking) {
          thinkingContent += pendingTag;
        } else {
          fullPublicText += pendingTag;
          yield { type: "public_delta", text: pendingTag };
        }
        pendingTag = "";
      }
      if (thinkingContent) {
        yield { type: "thinking", text: thinkingContent };
        thinkingContent = "";
      }
      yield { type: "done", fullText: fullPublicText };
      continue;
    }

    // 逐字符处理 delta
    const text = chunk.text;
    let i = 0;
    while (i < text.length) {
      const char = text[i]!;

      if (pendingTag) {
        pendingTag += char;
        i++;

        const targetTag = inThinking ? CLOSE_TAG : OPEN_TAG;
        if (targetTag.startsWith(pendingTag)) {
          if (pendingTag === targetTag) {
            // 完整匹配到标签
            if (inThinking) {
              // [/THINKING] 结束
              yield { type: "thinking", text: thinkingContent };
              thinkingContent = "";
              inThinking = false;
            } else {
              // [THINKING] 开始
              inThinking = true;
            }
            pendingTag = "";
          }
          // 否则继续缓冲
        } else {
          // 不匹配 — flush pendingTag
          if (inThinking) {
            thinkingContent += pendingTag;
          } else {
            fullPublicText += pendingTag;
            yield { type: "public_delta", text: pendingTag };
          }
          pendingTag = "";
        }
      } else if (char === "[") {
        pendingTag = "[";
        i++;
      } else {
        // 普通字符，批量收集连续非 '[' 字符
        let end = i + 1;
        while (end < text.length && text[end] !== "[") {
          end++;
        }
        const segment = text.slice(i, end);
        if (inThinking) {
          thinkingContent += segment;
        } else {
          fullPublicText += segment;
          yield { type: "public_delta", text: segment };
        }
        i = end;
      }
    }
  }
}

/** 生成唯一的模拟 ID */
function generateSimId(): string {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  "en": "English",
  "ja": "Japanese",
  "ko": "Korean",
};

/**
 * 构建 persona 的 system prompt。
 * hasTools 为 true 时不添加 [THINKING] 指令（tool-using 路径不需要文本标签思考）。
 * skillInstructions 不为空时，追加到 persona body 之后作为认知框架细节。
 */
function buildPersonaSystemPrompt(
  persona: ParsedPersona,
  scenarioBody: string,
  language?: string,
  hasTools?: boolean,
  skillInstructions?: string,
): string {
  let prompt = persona.body;

  // 如果有关联的 Skill instructions，追加到 persona body 之后
  if (skillInstructions) {
    prompt += "\n\n" + skillInstructions;
  }

  prompt += "\n\n[SCENARIO]\n" + scenarioBody;

  if (!hasTools) {
    prompt += "\n\nBefore your public response, write private thoughts in [THINKING]...[/THINKING] tags. This will not be shared with others.";
  }

  if (language) {
    const langName = LANGUAGE_NAMES[language] || language;
    prompt += `\n\nIMPORTANT: You MUST respond in ${langName}. All your responses must be written in ${langName}.`;
  }

  return prompt;
}

/**
 * 从 LLM 输出中分离 THINKING 部分和公开发言部分。
 */
function separateThinking(text: string): {
  thinking: string;
  publicText: string;
} {
  const thinkingParts: string[] = [];

  // 提取所有 [THINKING]...[/THINKING] 块
  let match: RegExpExecArray | null;
  const re = new RegExp(THINKING_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    thinkingParts.push(match[1]!.trim());
  }

  // 移除 THINKING 块后的公开发言
  const publicText = text.replace(THINKING_RE, "").trim();
  const thinking = thinkingParts.join("\n");

  return { thinking, publicText };
}

/**
 * 通过 LLM 单次对话获取完整回复文本（非流式收集）。
 */
async function llmChat(
  llmProvider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  log.llmCall("llmChat (non-streaming)", {
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const messages: Message[] = [{ role: "user", content: userMessage }];
  let fullText = "";

  const stream = llmProvider.chat(messages, {
    system: systemPrompt,
    signal,
  });

  for await (const event of stream) {
    if (event.type === "text_delta") {
      fullText += event.text;
    }
  }

  log.llmResponse("llmChat result", { text: fullText });
  return fullText;
}

/**
 * 通过 LLM 流式对话，yield 每个文本增量。
 */
async function* llmChatStreaming(
  llmProvider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): AsyncGenerator<{ type: "delta"; text: string } | { type: "done"; fullText: string }> {
  const messages: Message[] = [{ role: "user", content: userMessage }];
  let fullText = "";

  const stream = llmProvider.chat(messages, {
    system: systemPrompt,
    signal,
  });

  for await (const event of stream) {
    if (event.type === "text_delta") {
      fullText += event.text;
      yield { type: "delta", text: event.text };
    }
  }

  yield { type: "done", fullText };
}

/**
 * 使用 LLM 对过长的 transcript 进行摘要压缩。
 */
async function summarizeTranscript(
  llmProvider: LLMProvider,
  transcript: string,
): Promise<string> {
  return llmChat(
    llmProvider,
    "You are a concise summarizer. Summarize the key points of this discussion in under 2000 characters. You MUST preserve:\n- Each speaker's main positions and arguments\n- All concrete ACTIONS taken (files created/modified, commands run, code written) — include file paths and what was done\n- Current project state and what has been completed vs what remains\nDo NOT omit action details — they are critical for participants to avoid redoing work.",
    `Summarize this discussion transcript:\n\n${transcript}`,
  );
}

/**
 * tool call + tool result 的解析结果
 */
interface ParsedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * 从 LLM 流中收集文本和 tool_use 块。
 * 返回最终文本和所有 tool call。
 */
async function collectStreamWithTools(
  llmProvider: LLMProvider,
  messages: Message[],
  systemPrompt: string,
  tools?: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{
  text: string;
  toolCalls: ParsedToolCall[];
  stopReason: string;
}> {
  log.llmCall("collectStreamWithTools (persona with tools)", {
    system: systemPrompt,
    messages,
    tools,
  });

  const stream = llmProvider.chat(messages, {
    system: systemPrompt,
    tools,
    signal,
  });

  let text = "";
  const toolCalls: ParsedToolCall[] = [];
  let currentToolId = "";
  let currentToolName = "";
  let currentToolJson = "";
  let stopReason = "end_turn";

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_use_start":
        currentToolId = event.id;
        currentToolName = event.name;
        currentToolJson = "";
        break;
      case "tool_use_delta":
        currentToolJson += event.input_json;
        break;
      case "tool_use_end": {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(currentToolJson);
        } catch {
          // parse 失败用空对象
        }
        toolCalls.push({ id: currentToolId, name: currentToolName, input });
        currentToolId = "";
        currentToolName = "";
        currentToolJson = "";
        break;
      }
      case "message_end":
        stopReason = event.stop_reason;
        break;
    }
  }

  log.llmResponse("collectStreamWithTools result", {
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason,
  });

  return { text, toolCalls, stopReason };
}

export class SimulationRunner {
  private scenario: ParsedScenario;
  private personas: ParsedPersona[];
  private llmProvider: LLMProvider;
  private toolRegistry?: ToolRegistry;
  private skillManager?: SkillManager;
  private argumentExtractor: ArgumentExtractor;

  // --- 控制状态 ---
  private paused = false;
  private stopped = false;
  private pauseResolve: (() => void) | null = null;
  private pendingInjections: string[] = [];

  // --- 轮次等待控制 ---
  private roundWaitResolve: ((action: RoundAction) => void) | null = null;

  /** 对话记录（公开发言部分），所有 persona 共享 */
  private transcript = "";
  private simId: string;

  /** 行动型模拟：每个 Persona 的沙盒工具集 */
  private personaTools = new Map<string, Tool[]>();
  /** 行动型模拟：每个 Persona 的工作目录 */
  private personaDirs = new Map<string, string>();
  /** 行动型模拟：共享目录 */
  private sharedDir = "";

  /** 下一轮只执行这些 persona（为空表示全部执行） */
  private nextRoundTargetPersonas: ParsedPersona[] = [];

  /** 已标记 [DONE] 的 persona 名字集合，后续轮次不再调用 */
  private donePersonas = new Set<string>();

  /** 每个 persona 的行动日志，用于保持跨轮次的行动记忆 */
  private personaActionLogs = new Map<string, string[]>();

  /** Free 模式：动态发言人选择器 */
  private speakerSelector = new SpeakerSelector();

  constructor(
    scenario: ParsedScenario,
    personas: ParsedPersona[],
    llmProvider: LLMProvider,
    toolRegistry?: ToolRegistry,
    skillManager?: SkillManager,
  ) {
    this.scenario = scenario;
    this.personas = personas;
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    this.argumentExtractor = new ArgumentExtractor();
    this.simId = generateSimId();
  }

  // ----------------------------------------------------------
  // 控制接口
  // ----------------------------------------------------------

  /**
   * 解析 persona 关联的 Skill instructions。
   * 如果 persona.skill 设置了且 SkillManager 中对应 Skill 已加载，返回其 instructions；
   * 否则打印警告并返回 undefined。
   */
  private resolveSkillInstructions(persona: ParsedPersona): string | undefined {
    if (!persona.skill) return undefined;
    if (!this.skillManager) {
      log.warn(`Persona "${persona.name}" references skill "${persona.skill}" but SkillManager is not available`);
      return undefined;
    }
    const managed = this.skillManager.getSkill(persona.skill);
    if (!managed) {
      log.warn(`Persona "${persona.name}" references skill "${persona.skill}" but it was not found`);
      return undefined;
    }
    if (managed.status !== "loaded") {
      log.warn(`Persona "${persona.name}" references skill "${persona.skill}" but its status is "${managed.status}"`);
      return undefined;
    }
    return managed.parsed.instructions;
  }

  inject(message: string): void {
    this.pendingInjections.push(message);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  stop(): void {
    this.stopped = true;
    // 如果暂停中，也要唤醒以便结束
    this.resume();
    // 如果在等待用户操作，也要唤醒以便结束
    if (this.roundWaitResolve) {
      this.roundWaitResolve({ type: "end" });
      this.roundWaitResolve = null;
    }
  }

  /** 直接开始下一轮 */
  nextRound(): void {
    if (this.roundWaitResolve) {
      this.roundWaitResolve({ type: "next" });
      this.roundWaitResolve = null;
    }
  }

  /** 先加入用户发言，再开始下一轮 */
  speakThenNextRound(message: string): void {
    if (this.roundWaitResolve) {
      this.roundWaitResolve({ type: "speak", message });
      this.roundWaitResolve = null;
    }
  }

  /** 结束模拟 */
  endSimulation(): void {
    this.stopped = true;
    // 如果暂停中，也要唤醒以便结束
    this.resume();
    // 如果在等待用户操作，也要唤醒以便结束
    if (this.roundWaitResolve) {
      this.roundWaitResolve({ type: "end" });
      this.roundWaitResolve = null;
    }
  }

  // ----------------------------------------------------------
  // 核心执行
  // ----------------------------------------------------------

  async *run(): AsyncGenerator<SimulationEvent> {
    const personaNames = this.personas.map((p) => p.name);

    log.step("Simulation starting", {
      simId: this.simId,
      scenario: this.scenario.name,
      mode: this.scenario.mode,
      personas: personaNames.join(", "),
      language: this.scenario.language ?? "(default)",
    });

    // 如果有任何 persona 配了 tools，初始化沙盒目录
    if (this.personas.some((p) => p.tools.length > 0)) {
      await this.initActionDirs();
    }

    yield {
      type: "sim_start",
      simId: this.simId,
      scenario: this.scenario.name,
      personas: personaNames,
    };

    const mode = this.scenario.mode;

    switch (mode) {
      case "parallel":
        yield* this.runParallelMode();
        break;
      case "roundtable":
        yield* this.runRoundtableMode(1);
        break;
      case "parallel_then_roundtable":
        yield* this.runParallelThenRoundtable();
        break;
      case "free":
        yield* this.runFreeMode();
        break;
    }

    // 生成模拟结束摘要
    const summary = this.transcript.length > 0
      ? await this.generateSummary()
      : "No discussion took place.";

    yield {
      type: "sim_end",
      simId: this.simId,
      summary,
    };
  }

  // ----------------------------------------------------------
  // Parallel 模式 — 真并行
  // ----------------------------------------------------------

  private async *runParallelMode(): AsyncGenerator<SimulationEvent> {
    for (let round = 1; ; round++) {
      if (this.stopped) return;
      yield* this.waitForPause();

      yield {
        type: "round_start",
        simId: this.simId,
        round,
        mode: "parallel",
      };

      // 处理注入
      this.drainInjections();

      const roundTags = yield* this.executeParallelRound(round);

      // 提取论点
      yield* this.extractAndYieldArguments();

      yield { type: "round_end", simId: this.simId, round };

      const maxRounds = this.scenario.rounds;
      const withinRounds = maxRounds != null && round < maxRounds;

      // 自动结束检测：如果所有未 DONE 的 Agent 都返回了 SKIP 或 DONE，自动结束
      // 但在配置的 rounds 轮数结束之前不自动结束
      if (!withinRounds && roundTags.length > 0 && roundTags.every((t) => t === "SKIP" || t === "DONE")) {
        log.step(`[Parallel] All agents returned SKIP or DONE at round ${round}, auto-ending`);
        return;
      }

      // 在配置的 rounds 轮数结束之前自动继续，不等待用户
      if (withinRounds) continue;

      // 等待外部指令
      const action = yield* this.waitForRoundAction(round);
      if (action.type === "end") return;
      if (action.type === "speak") {
        yield* this.handleUserSpeak(action.message);
      }
    }
  }

  /**
   * 执行一轮 parallel 模式：所有 persona 并行发言，交错流式输出。
   * 同时启动所有 persona 的 LLM 调用，通过异步队列收集事件后 yield。
   * 如果 persona 配了 tools，使用 ReAct 循环执行工具调用。
   * 返回本轮各 persona 的响应标记，用于自动结束检测。
   */
  private async *executeParallelRound(
    _round: number,
  ): AsyncGenerator<SimulationEvent, ResponseTag[]> {
    const scenarioPrompt = this.scenario.parallelPrompt || this.scenario.roundtablePrompt;
    const simulationRules = buildSimulationRules(this.scenario.completionHint, this.scenario.responseStyle);
    const prompt = scenarioPrompt + `\n\n${simulationRules}`;
    const activePersonas = this.getPersonasForRound();

    // 先为所有 persona 发出 persona_start，前端同时创建多个 streaming entry
    for (const persona of activePersonas) {
      yield {
        type: "persona_start",
        simId: this.simId,
        persona: persona.name,
        emoji: persona.emoji,
      };
    }

    // 异步事件队列：多路流的事件统一汇入
    const queue: SimulationEvent[] = [];
    let queueResolve: (() => void) | null = null;
    let activeCount = activePersonas.length;

    const enqueue = (event: SimulationEvent) => {
      queue.push(event);
      if (queueResolve) {
        const resolve = queueResolve;
        queueResolve = null;
        resolve();
      }
    };

    // 每个 persona 的最终结果，用于写 transcript
    const personaResults = new Map<string, { publicText: string; actionSummaries: string[] }>();

    // 并行启动所有 persona
    for (const persona of activePersonas) {
      const tools = this.personaTools.get(persona.name);
      const hasTools = !!(tools && tools.length > 0);
      const systemPrompt = buildPersonaSystemPrompt(persona, this.scenario.body, this.scenario.language, hasTools, this.resolveSkillInstructions(persona));
      console.log(`[SimulationRunner] systemPrompt for persona ${persona.name}:\n${systemPrompt}`);

      (async () => {
        try {
          if (tools && tools.length > 0) {
            // 行动型 Persona：ReAct 循环，通过 enqueue 推送事件
            log.step(`[Parallel] Persona "${persona.name}" starting (with tools)`, {
              tools: tools.map((t) => t.name).join(", "),
            });
            const MAX_TOOL_TURNS = 8;
            const toolDefs: ToolDefinition[] = tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            }));
            // 注入历史行动日志
            const priorActions = this.personaActionLogs.get(persona.name) ?? [];
            let toolUserMessage = prompt;
            if (priorActions.length > 0) {
              toolUserMessage += `\n\n--- YOUR PREVIOUS ACTIONS (do NOT redo these) ---\n${priorActions.join("\n")}\n--- END PREVIOUS ACTIONS ---`;
            }
            toolUserMessage += `\n\nYou have tools available to take real actions (read files, write files, run commands). Use them to accomplish your goals. After taking actions, provide a brief public summary of what you did.`;
            const messages: Message[] = [{ role: "user", content: toolUserMessage }];
            const actionSummaries: string[] = [];
            let finalPublicText = "";

            for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
              log.info(`[Parallel] [${persona.name}] ReAct turn ${turn + 1}/${MAX_TOOL_TURNS}`);
              const { text, toolCalls } = await collectStreamWithTools(
                this.llmProvider, messages, systemPrompt, toolDefs,
              );

              const { thinking, publicText } = separateThinking(text);
              if (thinking) {
                log.info(`[Parallel] [${persona.name}] Thinking`, thinking);
                enqueue({ type: "persona_thinking", simId: this.simId, persona: persona.name, thinking });
              }
              if (publicText) {
                log.info(`[Parallel] [${persona.name}] Public text`, publicText);
                enqueue({ type: "persona_text_delta", simId: this.simId, persona: persona.name, text: publicText });
                finalPublicText += (finalPublicText ? "\n" : "") + publicText;
              }

              if (toolCalls.length === 0) {
                log.info(`[Parallel] [${persona.name}] No tool calls, ending at turn ${turn + 1}`);
                break;
              }

              // Build assistant message for conversation history
              const assistantContent: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
              if (text) assistantContent.push({ type: "text", text });
              for (const tc of toolCalls) {
                assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
              }
              messages.push({ role: "assistant", content: assistantContent });

              const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];
              for (const tc of toolCalls) {
                log.toolCall(`[Parallel] [${persona.name}] ${tc.name}`, tc.input);
                enqueue({ type: "persona_tool_call", simId: this.simId, persona: persona.name, toolName: tc.name, params: tc.input });
                const tool = tools.find((t) => t.name === tc.name);
                let resultText: string;
                let isError = false;
                if (tool) {
                  const result = await tool.execute(tc.input);
                  resultText = result.success ? result.output : `Error: ${result.error || "Unknown error"}`;
                  isError = !result.success;
                  log.toolResult(`[Parallel] [${persona.name}] ${tc.name}`, { success: result.success, output: result.output, error: result.error });
                  actionSummaries.push(this.summarizeToolAction(persona, tc.name, tc.input, result.output, result.success));
                } else {
                  resultText = `Error: Tool "${tc.name}" not available.`;
                  isError = true;
                }
                enqueue({ type: "persona_tool_result", simId: this.simId, persona: persona.name, toolName: tc.name, result: resultText });
                toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: resultText, is_error: isError });
              }
              messages.push({ role: "user", content: toolResults });
            }

            personaResults.set(persona.name, { publicText: finalPublicText, actionSummaries });
            enqueue({ type: "persona_done", simId: this.simId, persona: persona.name, fullResponse: finalPublicText });
          } else {
            // 纯文本 Persona：流式文本生成
            log.step(`[Parallel] Persona "${persona.name}" starting (text-only)`);
            const rawStream = llmChatStreaming(this.llmProvider, systemPrompt, prompt);
            const filteredStream = streamWithThinkingFilter(rawStream);

            let fullPublicText = "";
            let fullThinking = "";

            for await (const event of filteredStream) {
              if (event.type === "public_delta") {
                fullPublicText += event.text;
                enqueue({
                  type: "persona_text_delta",
                  simId: this.simId,
                  persona: persona.name,
                  text: event.text,
                });
              } else if (event.type === "thinking") {
                fullThinking += event.text;
              }
            }

            if (fullThinking) {
              enqueue({
                type: "persona_thinking",
                simId: this.simId,
                persona: persona.name,
                thinking: fullThinking.trim(),
              });
            }

            personaResults.set(persona.name, {
              publicText: fullPublicText.trim(),
              actionSummaries: [],
            });

            enqueue({
              type: "persona_done",
              simId: this.simId,
              persona: persona.name,
              fullResponse: fullPublicText.trim(),
            });
          }
        } catch (err) {
          log.error(`[Parallel] Persona "${persona.name}" failed`, err instanceof Error ? err.message : String(err));
          console.warn(`[SimulationRunner] Parallel persona failed:`, err);
          enqueue({
            type: "persona_done",
            simId: this.simId,
            persona: persona.name,
            fullResponse: "",
          });
        } finally {
          activeCount--;
          if (queueResolve) {
            const resolve: () => void = queueResolve;
            queueResolve = null;
            resolve();
          }
        }
      })();
    }

    // 主循环：从队列中消费事件并 yield
    while (activeCount > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { queueResolve = resolve; });
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }

    // 写入 transcript，解析响应标记，累积 action log
    const roundTags: ResponseTag[] = [];
    for (const persona of activePersonas) {
      const result = personaResults.get(persona.name);
      if (!result) continue;

      // 累积行动日志
      if (result.actionSummaries.length > 0) {
        const existing = this.personaActionLogs.get(persona.name) ?? [];
        this.personaActionLogs.set(persona.name, [...existing, ...result.actionSummaries]);
      }

      const { tag, body: publicBody } = parseResponseTag(result.publicText);
      roundTags.push(tag);

      if (tag === "SKIP") {
        this.transcript += `\n\n[${persona.name}] Skipped — ${publicBody}`;
      } else if (tag === "DONE") {
        this.donePersonas.add(persona.name);
        if (result.actionSummaries.length > 0) {
          const allActions = result.actionSummaries.join("\n");
          this.transcript += `\n\n${persona.emoji} **${persona.name}**:\n${allActions}`;
        } else {
          this.transcript += `\n\n${persona.emoji} **${persona.name}**: ${result.publicText}`;
        }
      } else {
        if (result.actionSummaries.length > 0) {
          const allActions = result.actionSummaries.join("\n");
          this.transcript += `\n\n${persona.emoji} **${persona.name}**:\n${allActions}`;
        } else if (result.publicText) {
          this.transcript += `\n\n${persona.emoji} **${persona.name}**: ${result.publicText}`;
        }
      }
    }

    return roundTags;
  }

  // ----------------------------------------------------------
  // Roundtable 模式 — 顺序执行
  // ----------------------------------------------------------

  private async *runRoundtableMode(
    startRound: number,
  ): AsyncGenerator<SimulationEvent> {
    for (let round = startRound; ; round++) {
      if (this.stopped) return;
      yield* this.waitForPause();

      yield {
        type: "round_start",
        simId: this.simId,
        round,
        mode: "roundtable",
      };

      // 处理注入
      this.drainInjections();

      const roundTags = yield* this.executeRoundtableRound(round);

      // 提取论点
      yield* this.extractAndYieldArguments();

      yield { type: "round_end", simId: this.simId, round };

      const maxRounds = this.scenario.rounds;
      const withinRounds = maxRounds != null && round < maxRounds;

      // 自动结束检测：如果所有未 DONE 的 Agent 都返回了 SKIP 或 DONE，自动结束
      // 但在配置的 rounds 轮数结束之前不自动结束
      if (!withinRounds && roundTags.length > 0 && roundTags.every((t) => t === "SKIP" || t === "DONE")) {
        log.step(`[Roundtable] All agents returned SKIP or DONE at round ${round}, auto-ending`);
        return;
      }

      // 在配置的 rounds 轮数结束之前自动继续，不等待用户
      if (withinRounds) continue;

      // 等待外部指令
      const action = yield* this.waitForRoundAction(round);
      if (action.type === "end") return;
      if (action.type === "speak") {
        yield* this.handleUserSpeak(action.message);
      }
    }
  }

  /**
   * 执行一轮 roundtable：每个 persona 顺序发言，能看到之前所有人的发言。
   * 如果 persona 配了 tools，使用 ReAct 循环执行工具调用。
   * 返回本轮各 persona 的响应标记，用于自动结束检测。
   */
  private async *executeRoundtableRound(
    round: number,
  ): AsyncGenerator<SimulationEvent, ResponseTag[]> {
    // 第一轮使用 parallelPrompt（开场/初始反应），后续轮使用 roundtablePrompt（互动讨论）
    const scenarioPrompt = round === 1
      ? (this.scenario.parallelPrompt || this.scenario.roundtablePrompt)
      : (this.scenario.roundtablePrompt || this.scenario.parallelPrompt);
    const simulationRules = buildSimulationRules(this.scenario.completionHint, this.scenario.responseStyle);
    const activePersonas = this.getPersonasForRound();
    const roundTags: ResponseTag[] = [];

    for (const persona of activePersonas) {
      if (this.stopped) return roundTags;
      yield* this.waitForPause();

      yield {
        type: "persona_start",
        simId: this.simId,
        persona: persona.name,
        emoji: persona.emoji,
      };

      // 如果 transcript 太长，摘要压缩
      let transcriptForContext = this.transcript;
      if (transcriptForContext.length > TRANSCRIPT_SUMMARY_THRESHOLD) {
        transcriptForContext = await summarizeTranscript(
          this.llmProvider,
          transcriptForContext,
        );
      }

      // 组装 user message：transcript + scenario prompt + SIMULATION RULES
      let userMessage = transcriptForContext
        ? `Discussion so far:\n${transcriptForContext}\n\n---\n\n${scenarioPrompt}`
        : scenarioPrompt;
      userMessage += `\n\n${simulationRules}`;

      const tools = this.personaTools.get(persona.name);

      if (tools && tools.length > 0) {
        // 行动型 Persona：ReAct 循环
        log.step(`[Roundtable] Persona "${persona.name}" starting (with tools)`);
        const priorActions = this.personaActionLogs.get(persona.name) ?? [];
        let toolUserMessage = userMessage;
        if (priorActions.length > 0) {
          toolUserMessage += `\n\n--- YOUR PREVIOUS ACTIONS (do NOT redo these) ---\n${priorActions.join("\n")}\n--- END PREVIOUS ACTIONS ---`;
        }
        toolUserMessage += `\n\nYou have tools available to take real actions (read files, write files, run commands). Use them to accomplish your goals. After taking actions, provide a brief public summary of what you did.`;
        const { publicText, actionSummaries } = yield* this.executePersonaWithTools(
          persona,
          toolUserMessage,
          tools,
        );

        // 累积行动日志
        if (actionSummaries.length > 0) {
          const existing = this.personaActionLogs.get(persona.name) ?? [];
          this.personaActionLogs.set(persona.name, [...existing, ...actionSummaries]);
        }

        // 解析响应标记
        const fullText = actionSummaries.length > 0
          ? actionSummaries.join("\n")
          : publicText;
        const { tag } = parseResponseTag(publicText);
        roundTags.push(tag);

        if (tag === "SKIP") {
          const skipEntry = `[${persona.name}] Skipped — ${publicText}`;
          this.transcript += `\n\n${skipEntry}`;
        } else if (tag === "DONE") {
          this.donePersonas.add(persona.name);
          const actionEntry = `${persona.emoji} **${persona.name}**:\n${fullText}`;
          this.transcript += `\n\n${actionEntry}`;
        } else {
          const actionEntry = `${persona.emoji} **${persona.name}**:\n${fullText}`;
          this.transcript += `\n\n${actionEntry}`;
        }
      } else {
        // 纯文本 Persona：流式文本生成
        log.step(`[Roundtable] Persona "${persona.name}" starting (text-only)`, {
          userMessage,
        });
        const systemPrompt = buildPersonaSystemPrompt(
          persona,
          this.scenario.body,
          this.scenario.language,
          undefined,
          this.resolveSkillInstructions(persona),
        );
        console.log(`[SimulationRunner] systemPrompt for persona ${persona.name}:\n${systemPrompt}`);

        const rawStream = llmChatStreaming(
          this.llmProvider,
          systemPrompt,
          userMessage,
        );
        const filteredStream = streamWithThinkingFilter(rawStream);

        let fullPublicText = "";
        let fullThinking = "";

        for await (const event of filteredStream) {
          if (event.type === "public_delta") {
            fullPublicText += event.text;
            yield {
              type: "persona_text_delta",
              simId: this.simId,
              persona: persona.name,
              text: event.text,
            };
          } else if (event.type === "thinking") {
            fullThinking += event.text;
          }
        }

        if (fullThinking) {
          log.info(`[Roundtable] [${persona.name}] Thinking`, fullThinking.trim());
          yield {
            type: "persona_thinking",
            simId: this.simId,
            persona: persona.name,
            thinking: fullThinking.trim(),
          };
        }

        // 解析响应标记
        const { tag, body: publicBody } = parseResponseTag(fullPublicText.trim());
        roundTags.push(tag);

        yield {
          type: "persona_done",
          simId: this.simId,
          persona: persona.name,
          fullResponse: fullPublicText.trim(),
        };

        if (tag === "SKIP") {
          this.transcript += `\n\n[${persona.name}] Skipped — ${publicBody}`;
        } else if (tag === "DONE") {
          this.donePersonas.add(persona.name);
          this.transcript += `\n\n${persona.emoji} **${persona.name}**: ${fullPublicText.trim()}`;
        } else {
          this.transcript += `\n\n${persona.emoji} **${persona.name}**: ${fullPublicText.trim()}`;
        }
      }
    }

    return roundTags;
  }

  // ----------------------------------------------------------
  // Parallel-then-Roundtable 模式
  // ----------------------------------------------------------

  private async *runParallelThenRoundtable(): AsyncGenerator<SimulationEvent> {
    // 第 1 轮：Parallel
    yield {
      type: "round_start",
      simId: this.simId,
      round: 1,
      mode: "parallel",
    };

    this.drainInjections();
    const roundTags = yield* this.executeParallelRound(1);
    yield* this.extractAndYieldArguments();
    yield { type: "round_end", simId: this.simId, round: 1 };

    const maxRounds = this.scenario.rounds;
    const withinRounds = maxRounds != null && 1 < maxRounds;

    // 自动结束检测（rounds 轮数内不自动结束）
    if (!withinRounds && roundTags.length > 0 && roundTags.every((t) => t === "SKIP" || t === "DONE")) {
      log.step(`[ParallelThenRoundtable] All agents returned SKIP or DONE at round 1, auto-ending`);
      return;
    }

    // rounds 轮数内自动继续
    if (!withinRounds) {
      // 等待外部指令
      const action = yield* this.waitForRoundAction(1);
      if (action.type === "end") return;
      if (action.type === "speak") {
        yield* this.handleUserSpeak(action.message);
      }
    }

    // 第 2 轮开始：Roundtable
    if (!this.stopped) {
      yield* this.runRoundtableMode(2);
    }
  }

  // ----------------------------------------------------------
  // Free 模式（行动型模拟）
  // ----------------------------------------------------------

  /**
   * 初始化行动型模拟的目录结构：
   * /tmp/little_claw_sim/{simId}/shared/         — 共享区域
   * /tmp/little_claw_sim/{simId}/{personaName}/   — 各 Persona 的私有目录
   */
  private async initActionDirs(): Promise<void> {
    const baseDir = `/tmp/little_claw_sim/${this.simId}`;
    this.sharedDir = `${baseDir}/shared`;
    await mkdir(this.sharedDir, { recursive: true });

    for (const persona of this.personas) {
      const safeName = persona.name.toLowerCase().replace(/\s+/g, "-");
      const dir = `${baseDir}/${safeName}`;
      await mkdir(dir, { recursive: true });
      this.personaDirs.set(persona.name, dir);

      // 如果 persona 配置了 tools，创建沙盒工具集
      if (persona.tools.length > 0) {
        const tools = createPersonaSandboxTools(dir, this.sharedDir, persona.tools);
        this.personaTools.set(persona.name, tools);
      }
    }
  }

  /**
   * 将 worldState 写入 shared/worldState.md
   */
  private async writeWorldState(worldState: string): Promise<void> {
    await Bun.write(`${this.sharedDir}/worldState.md`, worldState);
  }

  private async *runFreeMode(): AsyncGenerator<SimulationEvent> {
    const simulationRules = buildSimulationRules(this.scenario.completionHint, this.scenario.responseStyle);
    const scenarioPrompt = this.scenario.roundtablePrompt || this.scenario.parallelPrompt;

    // 初始化 SpeakerSelector
    this.speakerSelector.init(this.personas);

    // 初始发言人：kickoff_agent 或 personas[0]
    let currentSpeaker: ParsedPersona = this.personas[0]!;
    let step = 0;

    this.drainInjections();

    while (true) {
      if (this.stopped) return;
      yield* this.waitForPause();

      step++;

      // 每步发出 round_start，让前端更新轮数显示
      yield {
        type: "round_start",
        simId: this.simId,
        round: step,
        mode: "free",
      };

      // --- 执行当前发言人（带容错）---
      let tag: ResponseTag;

      try {
        yield {
          type: "persona_start",
          simId: this.simId,
          persona: currentSpeaker.name,
          emoji: currentSpeaker.emoji,
        };

        // 如果 transcript 太长，摘要压缩
        let transcriptForContext = this.transcript;
        if (transcriptForContext.length > TRANSCRIPT_SUMMARY_THRESHOLD) {
          transcriptForContext = await summarizeTranscript(
            this.llmProvider,
            transcriptForContext,
          );
        }

        let userMessage = transcriptForContext
          ? `Discussion so far:\n${transcriptForContext}\n\n---\n\n${scenarioPrompt}`
          : scenarioPrompt;
        userMessage += `\n\n${simulationRules}`;

        const tools = this.personaTools.get(currentSpeaker.name);

        if (tools && tools.length > 0) {
          // 行动型 Persona：注入历史行动日志
          const priorActions = this.personaActionLogs.get(currentSpeaker.name) ?? [];
          let toolUserMessage = userMessage;
          if (priorActions.length > 0) {
            toolUserMessage += `\n\n--- YOUR PREVIOUS ACTIONS (do NOT redo these) ---\n${priorActions.join("\n")}\n--- END PREVIOUS ACTIONS ---`;
          }
          toolUserMessage += `\n\nYou have tools available to take real actions (read files, write files, run commands). Use them to accomplish your goals. After taking actions, provide a brief public summary of what you did.`;

          const { publicText, actionSummaries } = yield* this.executePersonaWithTools(
            currentSpeaker,
            toolUserMessage,
            tools,
          );

          // 累积行动日志
          if (actionSummaries.length > 0) {
            const existing = this.personaActionLogs.get(currentSpeaker.name) ?? [];
            this.personaActionLogs.set(currentSpeaker.name, [...existing, ...actionSummaries]);
          }

          const fullText = actionSummaries.length > 0
            ? actionSummaries.join("\n")
            : publicText;
          const parsed = parseResponseTag(publicText);
          tag = parsed.tag;

          if (tag === "SKIP") {
            this.transcript += `\n\n[${currentSpeaker.name}] Skipped — ${publicText}`;
          } else {
            this.transcript += `\n\n${currentSpeaker.emoji} **${currentSpeaker.name}**:\n${fullText}`;
          }
          if (tag === "DONE") {
            this.donePersonas.add(currentSpeaker.name);
          }
        } else {
          // 纯文本 Persona：流式文本生成（复用 roundtable 的流式路径）
          const systemPrompt = buildPersonaSystemPrompt(
            currentSpeaker,
            this.scenario.body,
            this.scenario.language,
            undefined,
            this.resolveSkillInstructions(currentSpeaker),
          );

          const rawStream = llmChatStreaming(
            this.llmProvider,
            systemPrompt,
            userMessage,
          );
          const filteredStream = streamWithThinkingFilter(rawStream);

          let fullPublicText = "";
          let fullThinking = "";

          for await (const event of filteredStream) {
            if (event.type === "public_delta") {
              fullPublicText += event.text;
              yield {
                type: "persona_text_delta",
                simId: this.simId,
                persona: currentSpeaker.name,
                text: event.text,
              };
            } else if (event.type === "thinking") {
              fullThinking += event.text;
            }
          }

          if (fullThinking) {
            yield {
              type: "persona_thinking",
              simId: this.simId,
              persona: currentSpeaker.name,
              thinking: fullThinking.trim(),
            };
          }

          const parsed = parseResponseTag(fullPublicText.trim());
          tag = parsed.tag;

          yield {
            type: "persona_done",
            simId: this.simId,
            persona: currentSpeaker.name,
            fullResponse: fullPublicText.trim(),
          };

          if (tag === "SKIP") {
            this.transcript += `\n\n[${currentSpeaker.name}] Skipped — ${parsed.body}`;
          } else {
            this.transcript += `\n\n${currentSpeaker.emoji} **${currentSpeaker.name}**: ${fullPublicText.trim()}`;
          }
          if (tag === "DONE") {
            this.donePersonas.add(currentSpeaker.name);
          }
        }
      } catch (err) {
        // LLM 超时或网络错误：标记为 SKIP，记录错误，继续模拟
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`[Free] Persona "${currentSpeaker.name}" failed, skipping`, errMsg);
        tag = "SKIP";
        const skipEntry = `[${currentSpeaker.name}] Skipped — (error: ${errMsg})`;
        this.transcript += `\n\n${skipEntry}`;

        yield {
          type: "persona_done",
          simId: this.simId,
          persona: currentSpeaker.name,
          fullResponse: `[SKIP] (error: ${errMsg})`,
        };
      }

      // 记录发言
      this.speakerSelector.recordSpoke(currentSpeaker.name);
      const lastSpeaker = currentSpeaker.name;

      // --- 检查是否所有人都 DONE ---
      const activeCandidates = this.personas.filter((p) => !this.donePersonas.has(p.name));
      if (activeCandidates.length === 0) {
        log.step("[Free] All personas marked DONE, auto-ending");
        return;
      }

      // --- 定期提取论点（每 3 步一次）---
      if (step % 3 === 0) {
        yield* this.extractAndYieldArguments();
      }

      // --- 轮次控制 ---
      const maxRounds = this.scenario.rounds;

      if (maxRounds != null && step < maxRounds) {
        // 在预设轮数内，自动继续，不等待用户
      } else {
        // 已达到预设轮数或未设轮数，等待外部指令
        const action = yield* this.waitForRoundAction(step);
        if (action.type === "end") return;
        if (action.type === "speak") {
          yield* this.handleUserSpeak(action.message);
          // 用户发言后，drain 注入并重新选下一个发言人
          this.drainInjections();
        }
      }

      // --- 选择下一个发言人 ---
      const candidates = this.personas.filter((p) => !this.donePersonas.has(p.name));
      if (candidates.length === 0) {
        log.step("[Free] All personas marked DONE after user interaction, auto-ending");
        return;
      }

      const { name: nextName, reason } = await this.speakerSelector.selectNextSpeaker(
        this.llmProvider,
        this.transcript,
        candidates,
        lastSpeaker,
      );

      const nextPersona = candidates.find((p) => p.name === nextName) ?? candidates[0]!;

      // yield speaker_selected 事件
      yield {
        type: "speaker_selected",
        simId: this.simId,
        persona: nextPersona.name,
        reason,
      };

      log.step("[Free] Next speaker selected", { persona: nextPersona.name, reason });
      currentSpeaker = nextPersona;
    }
  }

  /**
   * 纯文本 Persona 执行（无工具）
   * 返回该 persona 的响应标记。
   */
  private async *executePersonaTextOnly(
    persona: ParsedPersona,
    worldState: string,
    roundActions: string[],
    simulationRules?: string,
  ): AsyncGenerator<SimulationEvent, ResponseTag> {
    log.step(`Persona "${persona.name}" text-only execution`, {
      worldStateLength: worldState.length,
      roundActionsCount: roundActions.length,
    });

    const systemPrompt = buildPersonaSystemPrompt(persona, this.scenario.body, this.scenario.language, undefined, this.resolveSkillInstructions(persona));
    console.log(`[SimulationRunner] systemPrompt for persona ${persona.name}:\n${systemPrompt}`);

    const actionsContext = roundActions.length > 0
      ? roundActions.join("\n")
      : "No actions yet this round.";

    let userMessage =
      `Current world state:\n${worldState}\n\nActions by others this round:\n${actionsContext}\n\nBased on the current situation and your character, what do you do? Describe your action and reasoning.`;
    if (simulationRules) {
      userMessage += `\n\n${simulationRules}`;
    }

    const fullText = await llmChat(
      this.llmProvider,
      systemPrompt,
      userMessage,
    );

    const { thinking, publicText } = separateThinking(fullText);

    if (thinking) {
      log.info(`[${persona.name}] Thinking (text-only)`, thinking);
      yield {
        type: "persona_thinking",
        simId: this.simId,
        persona: persona.name,
        thinking,
      };
    }

    yield {
      type: "persona_text_delta",
      simId: this.simId,
      persona: persona.name,
      text: publicText,
    };

    yield {
      type: "persona_done",
      simId: this.simId,
      persona: persona.name,
      fullResponse: publicText,
    };

    // 解析响应标记
    const { tag, body: publicBody } = parseResponseTag(publicText);

    if (tag === "SKIP") {
      const skipEntry = `[${persona.name}] Skipped — ${publicBody}`;
      roundActions.push(skipEntry);
      this.transcript += `\n\n${skipEntry}`;
    } else if (tag === "DONE") {
      this.donePersonas.add(persona.name);
      const actionEntry = `${persona.emoji} ${persona.name}: ${publicText}`;
      roundActions.push(actionEntry);
      this.transcript += `\n\n${actionEntry}`;
    } else {
      const actionEntry = `${persona.emoji} ${persona.name}: ${publicText}`;
      roundActions.push(actionEntry);
      this.transcript += `\n\n${actionEntry}`;
    }

    return tag;
  }

  /**
   * 行动型 Persona 执行（带工具的 ReAct 循环）
   * LLM 可以进行多轮 tool call，最终输出 end_turn 时结束。
   *
   * @param persona - 当前 persona
   * @param userMessage - 发给 LLM 的 user message（由各模式的调用方自行组装）
   * @param tools - 沙盒工具列表
   * @returns { publicText, actionSummaries } 供调用方写入 transcript
   */
  private async *executePersonaWithTools(
    persona: ParsedPersona,
    userMessage: string,
    tools: Tool[],
  ): AsyncGenerator<SimulationEvent, { publicText: string; actionSummaries: string[] }> {
    const MAX_TOOL_TURNS = 8; // 防止无限循环

    log.step(`Persona "${persona.name}" ReAct loop started (with tools)`, {
      tools: tools.map((t) => t.name).join(", "),
      maxToolTurns: MAX_TOOL_TURNS,
      userMessage,
    });

    const systemPrompt = buildPersonaSystemPrompt(persona, this.scenario.body, this.scenario.language, true, this.resolveSkillInstructions(persona));
    console.log(`[SimulationRunner] systemPrompt for persona ${persona.name}:\n${systemPrompt}`);

    const toolDefs: ToolDefinition[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // 构建对话 messages
    const messages: Message[] = [
      { role: "user", content: userMessage },
    ];

    // 行动记录（给 transcript 用）
    const actionSummaries: string[] = [];
    let finalPublicText = "";

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      log.info(`[${persona.name}] ReAct turn ${turn + 1}/${MAX_TOOL_TURNS}`);

      const { text, toolCalls } = await collectStreamWithTools(
        this.llmProvider,
        messages,
        systemPrompt,
        toolDefs,
      );

      // 处理文本输出中的 thinking
      const { thinking, publicText } = separateThinking(text);
      if (thinking) {
        log.info(`[${persona.name}] Thinking`, thinking);
        yield {
          type: "persona_thinking",
          simId: this.simId,
          persona: persona.name,
          thinking,
        };
      }

      if (publicText) {
        log.info(`[${persona.name}] Public text`, publicText);
        yield {
          type: "persona_text_delta",
          simId: this.simId,
          persona: persona.name,
          text: publicText,
        };
        finalPublicText += (finalPublicText ? "\n" : "") + publicText;
      }

      // 如果没有 tool call，结束该 persona 的回合
      if (toolCalls.length === 0) {
        log.info(`[${persona.name}] No tool calls, ending ReAct loop at turn ${turn + 1}`);
        break;
      }

      log.info(`[${persona.name}] ${toolCalls.length} tool call(s) to execute`, toolCalls.map((tc) => tc.name).join(", "));

      // 执行每个 tool call
      const assistantContent: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
      if (text) {
        assistantContent.push({ type: "text", text });
      }
      for (const tc of toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];

      for (const tc of toolCalls) {
        // yield tool_call 事件
        log.toolCall(`[${persona.name}] ${tc.name}`, tc.input);
        yield {
          type: "persona_tool_call",
          simId: this.simId,
          persona: persona.name,
          toolName: tc.name,
          params: tc.input,
        };

        // 执行工具
        const tool = tools.find((t) => t.name === tc.name);
        let resultText: string;
        let isError = false;

        if (tool) {
          const result = await tool.execute(tc.input);
          resultText = result.success
            ? result.output
            : `Error: ${result.error || "Unknown error"}`;
          isError = !result.success;

          log.toolResult(`[${persona.name}] ${tc.name}`, {
            success: result.success,
            output: result.output,
            error: result.error,
          });

          // 生成行动摘要
          const summary = this.summarizeToolAction(persona, tc.name, tc.input, result.output, result.success);
          actionSummaries.push(summary);
        } else {
          resultText = `Error: Tool "${tc.name}" not available.`;
          isError = true;
        }

        // yield tool_result 事件
        yield {
          type: "persona_tool_result",
          simId: this.simId,
          persona: persona.name,
          toolName: tc.name,
          result: resultText,
        };

        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: resultText,
          is_error: isError,
        });
      }

      // 将 tool results 作为 user message 发回给 LLM
      messages.push({ role: "user", content: toolResults });
    }

    yield {
      type: "persona_done",
      simId: this.simId,
      persona: persona.name,
      fullResponse: finalPublicText,
    };

    return { publicText: finalPublicText, actionSummaries };
  }

  /**
   * 生成工具行动的简要摘要（给 transcript 用，其他 Persona 可见）
   */
  private summarizeToolAction(
    persona: ParsedPersona,
    toolName: string,
    params: Record<string, unknown>,
    output: string,
    success: boolean,
  ): string {
    const prefix = `[${persona.name}] ACTION:`;
    if (!success) {
      return `${prefix} Failed to ${toolName} — ${output.slice(0, 100)}`;
    }

    switch (toolName) {
      case "write_file": {
        const path = params.path as string;
        const content = params.content as string;
        const lines = content.split("\n").length;
        return `${prefix} Created/updated file ${path} (${lines} lines)`;
      }
      case "read_file": {
        const path = params.path as string;
        return `${prefix} Read file ${path}`;
      }
      case "shell": {
        const command = params.command as string;
        return `${prefix} Ran command: ${command.slice(0, 80)}`;
      }
      default:
        return `${prefix} Used ${toolName}`;
    }
  }

  // ----------------------------------------------------------
  // 辅助方法
  // ----------------------------------------------------------

  /**
   * 等待外部指令：yield round_end_waiting 事件，暂停直到调用 nextRound/speakThenNextRound/endSimulation。
   */
  private async *waitForRoundAction(round: number): AsyncGenerator<SimulationEvent, RoundAction> {
    yield {
      type: "round_end_waiting",
      simId: this.simId,
      round,
    };

    const action = await new Promise<RoundAction>((resolve) => {
      this.roundWaitResolve = resolve;
    });

    return action;
  }

  /**
   * 处理用户发言：加入 transcript，yield user_spoke 事件。
   */
  private async *handleUserSpeak(message: string): AsyncGenerator<SimulationEvent> {
    this.transcript += `\n\n[You]: ${message}`;
    yield {
      type: "user_spoke",
      simId: this.simId,
      content: message,
    };

    // 解析 @PersonaName 指定下一轮只运行特定 persona
    this.nextRoundTargetPersonas = this.parseTargetPersonas(message);
  }

  /**
   * 从用户消息中解析被点名的 persona，返回匹配的 persona 列表。
   * 支持自然语言提及：在消息中搜索 persona 名字或名字的前半部分。
   * 例如 "Alex你来回答" 匹配 "Alex (Backend Dev)"。
   */
  private parseTargetPersonas(message: string): ParsedPersona[] {
    const lowerMsg = message.toLowerCase();
    const targets: ParsedPersona[] = [];

    for (const persona of this.personas) {
      const fullName = persona.name.toLowerCase();
      // 提取简短名（括号前的部分），如 "Alex (Backend Dev)" → "alex"
      const shortName = fullName.replace(/\s*\(.*\)\s*$/, "").trim();

      if (lowerMsg.includes(fullName) || (shortName && lowerMsg.includes(shortName))) {
        targets.push(persona);
      }
    }
    return targets;
  }

  /**
   * 获取本轮应执行的 persona 列表。
   * 如果有 @mention 目标则返回目标列表，否则返回全部。
   * 调用后自动清空目标。
   */
  private getPersonasForRound(): ParsedPersona[] {
    let candidates: ParsedPersona[];
    if (this.nextRoundTargetPersonas.length > 0) {
      candidates = this.nextRoundTargetPersonas;
      this.nextRoundTargetPersonas = [];
    } else {
      candidates = this.personas;
    }
    // 过滤掉已标记 [DONE] 的 persona
    return candidates.filter((p) => !this.donePersonas.has(p.name));
  }

  /**
   * 从 scenario body 中提取 Environment 部分。
   * 查找 "# Environment" 标题到下一个 "#" 标题之间的内容。
   */
  private extractEnvironment(body: string): string {
    const envMatch = body.match(
      /#+\s*Environment\s*\n([\s\S]*?)(?=\n#+\s|\n*$)/i,
    );
    return envMatch?.[1]?.trim() ?? body;
  }

  /**
   * 消费注入队列，追加到 transcript。
   */
  private drainInjections(): void {
    while (this.pendingInjections.length > 0) {
      const msg = this.pendingInjections.shift()!;
      this.transcript += `\n\n[MODERATOR]: ${msg}`;
    }
  }

  /**
   * 等待暂停状态结束。
   */
  private async *waitForPause(): AsyncGenerator<never> {
    if (this.paused) {
      await new Promise<void>((resolve) => {
        this.pauseResolve = resolve;
      });
    }
  }

  /**
   * 提取论点并 yield argument_update 事件。
   */
  private async *extractAndYieldArguments(): AsyncGenerator<SimulationEvent> {
    const personaNames = this.personas.map((p) => p.name);
    const args = await this.argumentExtractor.extractArguments(
      this.llmProvider,
      this.transcript,
      personaNames,
    );

    if (args.length > 0) {
      yield {
        type: "argument_update",
        simId: this.simId,
        arguments: args,
      };
    }
  }

  /**
   * 生成模拟结束时的摘要。
   */
  private async generateSummary(): Promise<string> {
    const personaNames = this.personas.map((p) => p.name);
    return llmChat(
      this.llmProvider,
      "You are a discussion summarizer. Provide a concise summary of the key points, areas of agreement, and areas of disagreement.",
      `Summarize this ${this.scenario.mode} discussion between ${personaNames.join(", ")} about "${this.scenario.name}":\n\n${this.transcript}`,
    );
  }
}
