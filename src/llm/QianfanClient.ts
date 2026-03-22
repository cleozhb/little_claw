import OpenAI from "openai";
import type {
  Message,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../types/message.ts";

const DEFAULT_BASE_URL = "https://qianfan.baidubce.com/v2";
const TIMEOUT_MS = 30_000;

export interface ChatOptions {
  tools?: OpenAI.ChatCompletionTool[];
  system?: string;
}

export class QianfanClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl || DEFAULT_BASE_URL,
      timeout: TIMEOUT_MS,
    });
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    const apiMessages = this.toOpenAIMessages(messages, options?.system);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: apiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options?.tools?.length) {
      params.tools = options.tools;
    }

    const stream = await this.client.chat.completions.create(params);

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "end_turn";

    // Track active tool calls being streamed (keyed by index)
    const activeToolCalls = new Map<
      number,
      { id: string; name: string; started: boolean }
    >();

    for await (const chunk of stream) {
      // Usage info (arrives in the final chunk)
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        // Map OpenAI finish reasons to our stop reasons
        stopReason =
          choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      }

      const delta = choice.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          // First chunk for this tool call — has id and function.name
          if (tc.id) {
            activeToolCalls.set(idx, {
              id: tc.id,
              name: tc.function?.name ?? "",
              started: false,
            });
          }

          const tracked = activeToolCalls.get(idx);
          if (!tracked) continue;

          // Update name if provided (may come in first chunk)
          if (tc.function?.name) {
            tracked.name = tc.function.name;
          }

          // Emit start event once we have both id and name
          if (!tracked.started && tracked.id && tracked.name) {
            tracked.started = true;
            yield {
              type: "tool_use_start",
              id: tracked.id,
              name: tracked.name,
            };
          }

          // Argument deltas
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

  private toOpenAIMessages(
    messages: Message[],
    system?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (system) {
      result.push({ role: "system", content: system });
    }

    for (const msg of messages) {
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
        // Each tool result becomes a separate tool message in OpenAI format
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
        const blocks = msg.content as Array<TextBlock | ToolUseBlock>;
        let textContent = "";
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

        for (const block of blocks) {
          if (block.type === "text") {
            textContent += block.text;
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

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: textContent || null,
        };
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
