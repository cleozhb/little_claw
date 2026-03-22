import type { Message, TextBlock, ToolUseBlock, ToolResultBlock } from "../types/message.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant with access to tools. You can read and write files, and execute shell commands. When the user asks you to perform tasks that require interacting with the filesystem or running commands, use the available tools. Always explain what you're about to do before using a tool.";

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
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: content }],
    });
  }

  addAssistantBlocks(blocks: Array<TextBlock | ToolUseBlock>): void {
    this.messages.push({ role: "assistant", content: blocks });
  }

  addToolResults(results: ToolResultBlock[]): void {
    this.messages.push({ role: "user", content: results });
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
