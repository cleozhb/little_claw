import type { Message, StreamEvent } from "../types/message.ts";

// --- Tool definition (provider-agnostic) ---

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// --- Chat options ---

export interface ChatOptions {
  tools?: ToolDefinition[];
  system?: string;
  /** AbortSignal for cancelling the request */
  signal?: AbortSignal;
}

// --- LLM Provider interface ---

export interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent>;
  getModel(): string;
  setModel(model: string): void;
}
