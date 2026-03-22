import OpenAI from "openai";
import type { Message } from "../types/message.ts";

const DEFAULT_BASE_URL = "https://qianfan.baidubce.com/v2";
const TIMEOUT_MS = 30_000;

export interface ChatResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
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
    systemPrompt?: string,
  ): AsyncGenerator<string, ChatResult> {
    const allMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      allMessages.push({ role: "system", content: systemPrompt });
    }
    for (const m of messages) {
      allMessages.push({ role: m.role, content: m.content });
    }

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: allMessages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let content = "";

    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        content += delta;
        yield delta;
      }
    }

    return { content, inputTokens, outputTokens };
  }
}
