import type { Message } from "../types/message.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. You can help users with coding, analysis, and general questions. Respond concisely and clearly.";

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt: string;

  constructor(systemPrompt?: string) {
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
  }

  addAssistant(content: string): void {
    this.messages.push({ role: "assistant", content });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  clear(): void {
    this.messages = [];
  }

  getLastNMessages(n: number): Message[] {
    return this.messages.slice(-n);
  }

  popLast(): void {
    this.messages.pop();
  }
}
