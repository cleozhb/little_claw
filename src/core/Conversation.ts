import type {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../types/message.ts";
import type { Database } from "../db/Database.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant with access to tools. You can read and write files, and execute shell commands. When the user asks you to perform tasks that require interacting with the filesystem or running commands, use the available tools. Always explain what you're about to do before using a tool.";

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt: string;
  private db: Database;
  private sessionId: string;

  constructor(db: Database, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;

    const session = db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.systemPrompt = session.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  // --- Static Factory Methods ---

  static createNew(db: Database, systemPrompt?: string): Conversation {
    const session = db.createSession(systemPrompt);
    return new Conversation(db, session.id);
  }

  /**
   * 从数据库加载已有会话，恢复完整的对话历史。
   */
  static loadExisting(db: Database, sessionId: string): Conversation {
    const conv = new Conversation(db, sessionId);
    conv.rebuildFromDB();
    return conv;
  }

  // --- Rebuild messages from database ---
  // --- 从数据库重建消息历史 ---

  /**
   * 从数据库读取当前 session 的所有消息记录，重建内存中的 messages 数组。
   * 关键逻辑：还原 assistant → tool_use / user → tool_result 的交替消息结构，
   * 这是 LLM API 要求的对话格式。
   */
  private rebuildFromDB(): void {
    // 从 DB 按时间顺序获取所有消息记录
    const records = this.db.getMessages(this.sessionId);
    this.messages = [];

    for (const record of records) {
      const role = record.role as "user" | "assistant";

      if (role === "user") {
        // User messages: could be plain text or tool_result blocks
        // 用户消息：可能是纯文本，也可能是工具执行结果（tool_result 块）
        const content = this.deserializeContent(record.content);

        if (Array.isArray(content) && content.length > 0 && content[0]?.type === "tool_result") {
          // This is a tool_result message
          // 这是一条工具结果消息，直接作为 ToolResultBlock[] 还原
          this.messages.push({ role: "user", content: content as ToolResultBlock[] });
        } else {
          // Plain text user message
          // 纯文本用户消息
          this.messages.push({ role: "user", content: typeof content === "string" ? content : String(content) });
        }
      } else if (role === "assistant") {
        const content = this.deserializeContent(record.content);

        if (typeof content === "string") {
          // Plain text assistant message (stored as string)
          // 纯文本助手消息（DB 中存储为字符串），包装为 TextBlock
          this.messages.push({
            role: "assistant",
            content: [{ type: "text", text: content }],
          });
        } else if (Array.isArray(content)) {
          // Blocks (text + tool_use)
          // 结构化助手消息（text + tool_use 混合块）
          this.messages.push({
            role: "assistant",
            content: content as Array<TextBlock | ToolUseBlock>,
          });

          // If this assistant message contains tool_use blocks,
          // load corresponding tool_results and insert the user tool_result message
          // 如果助手消息包含 tool_use 块，需要从 tool_results 表加载对应的
          // 工具执行结果，并插入一条 user/tool_result 消息，还原完整的对话链路
          const hasToolUse = content.some(
            (b: { type: string }) => b.type === "tool_use"
          );
          if (hasToolUse) {
            const toolResultRecords = this.db.getToolResults(record.id);
            if (toolResultRecords.length > 0) {
              const toolResultBlocks: ToolResultBlock[] =
                toolResultRecords.map((tr) => ({
                  type: "tool_result" as const,
                  tool_use_id: tr.tool_use_id,
                  content: tr.tool_output,
                  is_error: tr.is_error === 1,
                }));
              this.messages.push({ role: "user", content: toolResultBlocks });
            }
          }
        }
      }
    }
  }

  private deserializeContent(raw: string): unknown {
    // Try to parse as JSON; if it fails, treat as plain text
    // 尝试将 DB 中的原始字符串解析为 JSON；解析失败则视为纯文本
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  // --- Mutators (write both memory + DB) ---

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
    this.db.addMessage(this.sessionId, "user", content);
  }

  addAssistant(content: string): void {
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: content }],
    });
    this.db.addMessage(this.sessionId, "assistant", [
      { type: "text", text: content },
    ]);
  }

  addToolUse(assistantContent: Array<TextBlock | ToolUseBlock>): string {
    this.messages.push({ role: "assistant", content: assistantContent });
    const record = this.db.addMessage(
      this.sessionId,
      "assistant",
      assistantContent
    );
    return record.id;
  }

  addToolResults(
    messageId: string,
    results: Array<{
      toolUseId: string;
      toolName: string;
      input: unknown;
      output: string;
      isError: boolean;
    }>
  ): void {
    // Build tool_result blocks for the in-memory messages array
    const blocks: ToolResultBlock[] = results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.toolUseId,
      content: r.output,
      is_error: r.isError,
    }));
    this.messages.push({ role: "user", content: blocks });

    // Persist each tool result to the database
    for (const r of results) {
      this.db.addToolResult({
        sessionId: this.sessionId,
        messageId,
        toolUseId: r.toolUseId,
        toolName: r.toolName,
        toolInput: r.input,
        toolOutput: r.output,
        isError: r.isError,
      });
    }
  }

  // --- Accessors ---

  getSessionId(): string {
    return this.sessionId;
  }

  updateSessionTitle(title: string): void {
    this.db.updateSessionTitle(this.sessionId, title);
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
