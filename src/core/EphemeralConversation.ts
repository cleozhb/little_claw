import type {
  AssistantContentBlock,
  Message,
  ToolResultBlock,
} from "../types/message.ts";

/**
 * 临时对话容器，不持久化到数据库。
 * 用于 Sub-Agent 场景：执行完毕后即丢弃。
 * 接口与 Conversation 对齐，使 AgentLoop 可以无差别使用。
 */
export class EphemeralConversation {
  private messages: Message[] = [];
  private systemPrompt: string;
  private idCounter = 0;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
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

  addToolUse(assistantContent: AssistantContentBlock[]): string {
    this.messages.push({ role: "assistant", content: assistantContent });
    return `ephemeral-${++this.idCounter}`;
  }

  addToolResults(
    _messageId: string,
    results: Array<{
      toolUseId: string;
      toolName: string;
      input: unknown;
      output: string;
      isError: boolean;
    }>,
  ): void {
    const blocks: ToolResultBlock[] = results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.toolUseId,
      content: r.output,
      is_error: r.isError,
    }));
    this.messages.push({ role: "user", content: blocks });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getSessionId(): string {
    return "ephemeral";
  }

  updateSessionTitle(_title: string): void {
    // no-op: ephemeral conversations don't have persistent titles
  }

  replaceLastToolResult(toolUseId: string, output: string, isError: boolean): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      const blocks = msg.content as ToolResultBlock[];
      for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          block.content = output;
          block.is_error = isError;
          return true;
        }
      }
    }
    return false;
  }
}
