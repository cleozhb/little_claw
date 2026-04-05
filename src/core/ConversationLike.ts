import type {
  Message,
  TextBlock,
  ToolUseBlock,
} from "../types/message.ts";

/**
 * AgentLoop 所需的对话容器接口。
 * Conversation（持久化）和 EphemeralConversation（临时）都实现此接口。
 */
export interface ConversationLike {
  addUser(content: string): void;
  addAssistant(content: string): void;
  addToolUse(assistantContent: Array<TextBlock | ToolUseBlock>): string;
  addToolResults(
    messageId: string,
    results: Array<{
      toolUseId: string;
      toolName: string;
      input: unknown;
      output: string;
      isError: boolean;
    }>,
  ): void;
  getMessages(): Message[];
  getSystemPrompt(): string;
  getSessionId(): string;
  updateSessionTitle(title: string): void;
}
