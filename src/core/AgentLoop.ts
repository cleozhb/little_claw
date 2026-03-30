import type { LLMProvider } from "../llm/types.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { Conversation } from "./Conversation.ts";
import type {
  AgentEvent,
  TextBlock,
  ToolUseBlock,
} from "../types/message.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ShellTool } from "../tools/types.ts";
import { SkillPromptBuilder } from "../skills/SkillPromptBuilder.ts";
import { generateTitle } from "./TitleGenerator.ts";

const MAX_ITERATIONS = 20;

export class AgentLoop {
  private client: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: Conversation;
  private maxIterations: number;
  private pendingTitleGeneration: Promise<void> | null = null;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;

  constructor(
    client: LLMProvider,
    toolRegistry: ToolRegistry,
    conversation: Conversation,
    options?: {
      maxIterations?: number;
      skillManager?: SkillManager;
      shellTool?: ShellTool;
    },
  ) {
    this.client = client;
    this.toolRegistry = toolRegistry;
    this.conversation = conversation;
    this.maxIterations = options?.maxIterations ?? MAX_ITERATIONS;
    this.skillManager = options?.skillManager;
    this.shellTool = options?.shellTool;
  }

  /**
   * ReAct (Reason + Act) 循环：LLM 先推理（生成文本/工具调用），再执行工具，
   * 将工具结果反馈给 LLM 进行下一轮推理，如此反复直到 LLM 给出最终回复。
   */
  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    const isFirstRound = this.conversation.getMessages().length === 0;
    this.conversation.addUser(userMessage);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // ReAct 主循环：最多迭代 maxIterations 次，防止无限循环
    for (let i = 0; i < this.maxIterations; i++) {
      // === Reason 阶段：调用 LLM，流式接收推理结果 ===
      // --- Call LLM ---
      let textContent = "";
      const toolUseBlocks: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // Track tool calls being streamed: index -> accumulated args JSON
      // 跟踪流式传输中的工具调用：按索引累积参数 JSON 片段
      const pendingToolArgs = new Map<number, string>();
      const pendingToolMeta = new Map<number, { id: string; name: string }>();

      try {
        const chatStream = this.client.chat(
          this.conversation.getMessages(),
          {
            system: this.getEffectiveSystemPrompt(),
            tools: this.toolRegistry.toToolDefinitions(),
          },
        );
        for await (const event of chatStream) {
          // 处理流式事件：文本增量、工具调用开始/增量/结束、消息结束
          if (process.env.DEBUG) {
            console.error(`[debug] stream event: ${event.type}`, JSON.stringify(event).slice(0, 200));
          }
          switch (event.type) {
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "error", message: msg };
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

      // --- No tool calls: end turn ---
      // 判断停止条件：LLM 没有请求工具调用，说明推理完成，保存回复并结束循环
      if (stopReason === "end_turn" || toolUseBlocks.length === 0) {
        this.conversation.addAssistant(textContent);

        // Auto-generate session title after first round (fire-and-forget)
        if (isFirstRound) {
          this.maybeGenerateTitle(userMessage, textContent);
        }

        yield {
          type: "done",
          usage: { totalInputTokens, totalOutputTokens },
        };
        return;
      }

      // --- Has tool calls: execute them ---
      // === Act 阶段：LLM 请求了工具调用，逐个执行并收集结果 ===
      const assistantBlocks: Array<TextBlock | ToolUseBlock> = [];
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

      for (const block of toolUseBlocks) {
        yield { type: "tool_call", name: block.name, params: block.input };

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

        // 执行 shell 工具前，注入所有已加载 Skill 的环境变量
        if (block.name === "shell" && this.shellTool && this.skillManager) {
          this.shellTool.setExtraEnv(this.collectSkillEnv());
        }

        try {
          const result = await tool.execute(block.input);
          yield { type: "tool_result", name: block.name, result };
          toolResultParams.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            output: result.success
              ? result.output
              : result.error ?? "Unknown error",
            isError: !result.success,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
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

      this.conversation.addToolResults(messageId, toolResultParams);
      // continue loop — LLM will see tool results and respond
      // 继续循环 — LLM 在下一轮迭代中会看到工具执行结果，并据此继续推理
    }

    // Max iterations reached
    // 安全阀：达到最大迭代次数，强制终止循环并报错
    yield {
      type: "error",
      message: `Agent loop exceeded maximum iterations (${this.maxIterations})`,
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

  /**
   * 构建有效的 system prompt：基础 prompt + skill 指令。
   * 没有 skillManager 或没有已加载的 skill 时，回退到原始 system prompt。
   */
  private getEffectiveSystemPrompt(): string {
    const basePrompt = this.conversation.getSystemPrompt();

    if (!this.skillManager) return basePrompt;

    const loadedSkills = this.skillManager.getLoadedSkills();
    if (loadedSkills.length === 0) return basePrompt;

    const builder = new SkillPromptBuilder();
    const skillPrompt = builder.buildSkillPrompt(
      loadedSkills,
      undefined,
      this.skillManager.getRecentlyUsed(),
    );

    if (!skillPrompt) return basePrompt;

    return `${basePrompt}\n\nYou have access to skills that extend your capabilities. When a user's request matches a skill's description, follow the skill's instructions. Skills may require you to use shell commands or other tools to complete tasks.\n\n${skillPrompt}`;
  }

  /**
   * 收集所有已加载 Skill 的环境变量，合并为一个 Record。
   * 项目级 Skill 的值覆盖全局级（由 SkillLoader 的加载顺序保证）。
   */
  private collectSkillEnv(): Record<string, string> {
    if (!this.skillManager) return {};

    const merged: Record<string, string> = {};
    const loadedSkills = this.skillManager.getLoadedSkills();

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
}
