import OpenAI from "openai";
import type { LLMProvider, ChatOptions, ToolDefinition } from "./types.ts";
import type {
  AssistantContentBlock,
  Message,
  StreamEvent,
  ToolResultBlock,
} from "../types/message.ts";

const TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TOKENS = readMaxOutputTokens();

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private thinkingEnabled?: boolean;

  constructor(apiKey: string, model: string, baseURL?: string, thinkingEnabled?: boolean) {
    this.model = model;
    this.thinkingEnabled = thinkingEnabled;
    this.client = new OpenAI({
      apiKey,
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
   * 流式调用 OpenAI Chat Completions API，将 SDK 返回的 SSE 事件
   * 解析并转换为统一的 StreamEvent 格式（text_delta / tool_use_* / message_end）。
   */
  async *chat(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    const apiMessages = this.toOpenAIMessages(messages, options?.system);

    const params: OpenAI.ChatCompletionCreateParamsStreaming & {
      thinking?: { type: "enabled" | "disabled" };
    } = {
      model: this.model,
      messages: apiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: DEFAULT_MAX_TOKENS,
    };

    // thinking is a provider extension supported by DeepSeek/Qianfan-compatible APIs.
    // Leave it absent when the env switch is unset so standard OpenAI endpoints keep working.
    if (this.thinkingEnabled !== undefined) {
      params.thinking = { type: this.thinkingEnabled ? "enabled" : "disabled" };
    }

    if (options?.tools?.length) {
      params.tools = this.toOpenAITools(options.tools);
    }

    const stream = await this.client.chat.completions.create(params, {
      signal: options?.signal,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "end_turn";

    // Track active tool calls being streamed (keyed by index)
    // 按索引跟踪正在流式传输的工具调用（OpenAI 用 index 区分并行工具调用）
    const activeToolCalls = new Map<
      number,
      { id: string; name: string; started: boolean }
    >();

    // 逐块读取 SSE 流，每个 chunk 带超时保护（60s 无数据则报错）
    const iterator = stream[Symbol.asyncIterator]();
    const streamChunkTimeoutMs = options?.streamChunkTimeoutMs ?? DEFAULT_STREAM_CHUNK_TIMEOUT_MS;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Stream timeout: no data received for ${Math.round(streamChunkTimeoutMs / 1000)}s`)),
            streamChunkTimeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) break;
      const chunk = result.value;
      if (process.env.DEBUG) {
        console.error(`[debug] raw chunk: ${JSON.stringify(chunk)}`);
      }
      // Usage info (arrives in the final chunk)
      // 用量信息在最后一个 chunk 中到达（prompt_tokens / completion_tokens）
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
      }

      const delta = choice.delta as typeof choice.delta & {
        reasoning_content?: string | null;
      };
      if (!delta) continue;

      // Thinking content is hidden from the user, but must be replayed with the
      // assistant tool-call message on the next API request in the same turn.
      if (delta.reasoning_content) {
        yield {
          type: "reasoning_delta",
          reasoning_content: delta.reasoning_content,
        };
      }

      // Text content
      // 文本增量：LLM 生成的文本内容片段
      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }

      // Tool calls
      // 工具调用增量：OpenAI 以 delta.tool_calls 数组分块传输工具调用的 id、名称和参数
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          // First chunk for this tool call — has id and function.name
          // 该工具调用的第一个 chunk —— 携带 id 和 function.name
          if (tc.id) {
            activeToolCalls.set(idx, {
              id: tc.id,
              name: tc.function?.name ?? "",
              started: false,
            });
          }

          const tracked = activeToolCalls.get(idx);
          if (!tracked) continue;

          if (tc.function?.name) {
            tracked.name = tc.function.name;
          }

          // Emit start event once we have both id and name
          // 当 id 和 name 都齐备后，发出 tool_use_start 事件
          if (!tracked.started && tracked.id && tracked.name) {
            tracked.started = true;
            yield {
              type: "tool_use_start",
              id: tracked.id,
              name: tracked.name,
            };
          }

          // Argument deltas
          // 参数增量：将 JSON 参数片段透传为 tool_use_delta 事件
          if (tc.function?.arguments) {
            yield {
              type: "tool_use_delta",
              input_json: tc.function.arguments,
            };
          }
        }
      }
    }

    // Emit tool_use_end for each tracked tool call
    // 流结束后，为每个已开始的工具调用发出 tool_use_end 事件
    for (const tracked of activeToolCalls.values()) {
      if (tracked.started) {
        yield { type: "tool_use_end" };
      }
    }

    yield {
      type: "message_end",
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  // --- Format conversions ---

  private toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private toOpenAIMessages(
    messages: Message[],
    system?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (system) {
      result.push({ role: "system", content: system });
    }

    // reasoning_content is only valid during the tool sub-turns of the latest
    // user request. Older turns are intentionally stripped per provider docs.
    let latestUserTurnIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "user" && typeof message.content === "string") {
        latestUserTurnIndex = i;
        break;
      }
    }

    for (const [messageIndex, msg] of messages.entries()) {
      if (msg.role === "system") {
        result.push({ role: "system", content: msg.content });
        continue;
      }

      // Simple user message (string content)
      if (msg.role === "user" && typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      // Tool result message (array of ToolResultBlock)
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResults = msg.content as ToolResultBlock[];
        for (const tr of toolResults) {
          result.push({
            role: "tool" as const,
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `Error: ${tr.content}` : tr.content,
          });
        }
        continue;
      }

      // Assistant message with content blocks
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = msg.content as AssistantContentBlock[];
        let textContent = "";
        let reasoningContent = "";
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

        for (const block of blocks) {
          if (block.type === "text") {
            textContent += block.text;
          } else if (block.type === "reasoning") {
            reasoningContent += block.reasoning_content;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam & {
          reasoning_content?: string;
        } = {
          role: "assistant",
          // DeepSeek thinking tool-call messages require content to be present;
          // an empty string is valid and safer than null across compatible APIs.
          content: textContent,
        };
        if (
          reasoningContent &&
          this.thinkingEnabled !== false &&
          messageIndex > latestUserTurnIndex
        ) {
          assistantMsg.reasoning_content = reasoningContent;
        }
        if (toolCalls.length) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
        continue;
      }
    }

    return result;
  }
}

function mapFinishReason(reason: OpenAI.ChatCompletion.Choice["finish_reason"]): string {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "content_filter";
  return "end_turn";
}

function readMaxOutputTokens(): number {
  const raw = process.env.LLM_MAX_OUTPUT_TOKENS;
  if (!raw) return 16384;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16384;
}
