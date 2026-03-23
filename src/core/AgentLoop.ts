import type { QianfanClient } from "../llm/QianfanClient.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { Conversation } from "./Conversation.ts";
import type {
  AgentEvent,
  TextBlock,
  ToolUseBlock,
} from "../types/message.ts";
import { generateTitle } from "./TitleGenerator.ts";

const MAX_ITERATIONS = 20;

export class AgentLoop {
  private client: QianfanClient;
  private toolRegistry: ToolRegistry;
  private conversation: Conversation;
  private maxIterations: number;

  constructor(
    client: QianfanClient,
    toolRegistry: ToolRegistry,
    conversation: Conversation,
    maxIterations = MAX_ITERATIONS,
  ) {
    this.client = client;
    this.toolRegistry = toolRegistry;
    this.conversation = conversation;
    this.maxIterations = maxIterations;
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    const isFirstRound = this.conversation.getMessages().length === 0;
    this.conversation.addUser(userMessage);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < this.maxIterations; i++) {
      // --- Call LLM ---
      let textContent = "";
      const toolUseBlocks: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // Track tool calls being streamed: index -> accumulated args JSON
      const pendingToolArgs = new Map<number, string>();
      const pendingToolMeta = new Map<number, { id: string; name: string }>();

      try {
        for await (const event of this.client.chat(
          this.conversation.getMessages(),
          {
            system: this.conversation.getSystemPrompt(),
            tools: this.toolRegistry.toOpenAIFormat(),
          },
        )) {
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
    }

    // Max iterations reached
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
    generateTitle(this.client, userMessage, assistantReply)
      .then((title) => {
        if (title) {
          this.conversation.updateSessionTitle(title);
        }
      })
      .catch(() => {
        // Title generation is best-effort; silently ignore errors
      });
  }
}
