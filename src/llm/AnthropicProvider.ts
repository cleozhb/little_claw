import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, ChatOptions, ToolDefinition } from "./types.ts";
import type {
  Message,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../types/message.ts";

const TIMEOUT_MS = 30_000;
const STREAM_CHUNK_TIMEOUT_MS = 300_000;

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      authToken: null, // Prevent SDK from reading ANTHROPIC_AUTH_TOKEN env var
      baseURL,
      timeout: TIMEOUT_MS,
    });
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * 流式调用 Anthropic Messages API，将 SDK 返回的 SSE 事件
   * 解析并转换为统一的 StreamEvent 格式（text_delta / tool_use_* / message_end）。
   */
  async *chat(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    const { system, apiMessages } = this.toAnthropicMessages(messages, options?.system);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: 8192,
      stream: true,
      messages: apiMessages as Anthropic.MessageParam[],
    };

    if (system) {
      params.system = system;
    }

    if (options?.tools?.length) {
      params.tools = this.toAnthropicTools(options.tools);
    }

    const stream = this.client.messages.stream(params, {
      signal: options?.signal,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "end_turn";

    // 逐事件读取 SSE 流，每次读取带超时保护（60s 无数据则报错）
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Stream timeout: no data received for 300s")),
            STREAM_CHUNK_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) break;
      const event = result.value;

      if (process.env.DEBUG) {
        console.error(`[debug] anthropic event: ${JSON.stringify(event).slice(0, 200)}`);
      }

      // 根据 Anthropic SSE 事件类型分发处理
      switch (event.type) {
        case "message_start": {
          // 消息开始：提取输入 token 用量
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
          }
          break;
        }

        case "content_block_start": {
          // 内容块开始：如果是 tool_use 类型，发出 tool_use_start 事件
          if (event.content_block?.type === "tool_use") {
            yield {
              type: "tool_use_start",
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;
        }

        case "content_block_delta": {
          // 内容块增量：文本增量(text_delta)或工具参数增量(input_json_delta)
          if (event.delta?.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta") {
            yield { type: "tool_use_delta", input_json: event.delta.partial_json };
          }
          break;
        }

        case "content_block_stop": {
          // 内容块结束：发出 tool_use_end 事件
          // SDK doesn't tell us which block stopped, but if we were in a tool_use
          // the previous content_block_start would have been tool_use type
          yield { type: "tool_use_end" };
          break;
        }

        case "message_delta": {
          // 消息增量：获取停止原因(stop_reason)和输出 token 用量
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason === "tool_use" ? "tool_use" : "end_turn";
          }
          if (event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }
          break;
        }

        case "message_stop": {
          // 消息结束：无需额外操作
          break;
        }
      }
    }

    yield {
      type: "message_end",
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  // --- Format conversions ---

  private toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool["input_schema"],
    }));
  }

  private toAnthropicMessages(
    messages: Message[],
    systemPrompt?: string,
  ): { system: string | null; apiMessages: Anthropic.MessageParam[] } {
    const systemParts: string[] = [];
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }

    const apiMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
        continue;
      }

      // Simple user message
      if (msg.role === "user" && typeof msg.content === "string") {
        apiMessages.push({ role: "user", content: msg.content });
        continue;
      }

      // Tool result message — Anthropic uses role: "user" with tool_result blocks
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResults = msg.content as ToolResultBlock[];
        const blocks: Anthropic.ToolResultBlockParam[] = toolResults.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: tr.is_error ? `Error: ${tr.content}` : tr.content,
          is_error: tr.is_error ?? false,
        }));
        apiMessages.push({ role: "user", content: blocks });
        continue;
      }

      // Assistant message with content blocks — native Anthropic format
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = msg.content as Array<TextBlock | ToolUseBlock>;
        const anthropicBlocks: Anthropic.ContentBlockParam[] = blocks.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          // tool_use block
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        });
        apiMessages.push({ role: "assistant", content: anthropicBlocks });
        continue;
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : null,
      apiMessages,
    };
  }
}
