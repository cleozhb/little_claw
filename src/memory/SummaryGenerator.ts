import type { LLMProvider } from "../llm/types.ts";
import type { Message } from "../types/message.ts";

const SUMMARY_SYSTEM_PROMPT =
  "Summarize this conversation into a concise paragraph for future reference. " +
  "Focus on: key decisions made, tasks completed (include file paths and tool outputs), " +
  "user preferences revealed, important facts mentioned, and any unresolved questions. " +
  "Be specific — include names, numbers, paths, and technical details. Keep under 300 words.";

const INCREMENTAL_SUMMARY_SYSTEM_PROMPT =
  "Update the existing summary with new information from the recent conversation. " +
  "Merge, don't repeat. Keep under 300 words.";

const DEFAULT_MAX_MESSAGES = 20;
const SUMMARY_MAX_TOKENS = 500;

/** Format a Message into a readable string for the summarizer. */
function formatMessage(msg: Message): string {
  if (typeof msg.content === "string") {
    return `[${msg.role}]: ${msg.content}`;
  }
  // AssistantMessage or ToolResultMessage — content is an array of blocks
  const parts = msg.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use") return `[tool_use: ${block.name}]`;
    if (block.type === "tool_result") {
      const prefix = block.is_error ? "[tool_error]" : "[tool_result]";
      return `${prefix} ${block.content}`;
    }
    return "";
  });
  return `[${msg.role}]: ${parts.join("\n")}`;
}

/** Collect streamed text from an LLM chat call. */
async function collectStreamText(
  llmClient: LLMProvider,
  messages: Message[],
  system: string,
): Promise<string> {
  let result = "";
  for await (const event of llmClient.chat(messages, { system })) {
    if (event.type === "text_delta") {
      result += event.text;
    }
  }
  return result.trim();
}

/**
 * Generate a summary from a slice of conversation messages.
 * Takes the most recent `maxMessages` to stay within token limits.
 */
export async function generateSummary(
  llmProvider: LLMProvider,
  messages: Message[],
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): Promise<string> {
  const recent = messages.slice(-maxMessages);
  if (recent.length === 0) return "";

  const formatted = recent.map(formatMessage).join("\n\n");
  return collectStreamText(
    llmProvider,
    [{ role: "user", content: formatted }],
    SUMMARY_SYSTEM_PROMPT,
  );
}

/**
 * Generate an incremental summary by merging a previous summary with new messages.
 * Avoids re-summarising the entire conversation from scratch.
 */
export async function generateIncrementalSummary(
  llmProvider: LLMProvider,
  previousSummary: string,
  newMessages: Message[],
): Promise<string> {
  if (newMessages.length === 0) return previousSummary;

  const formatted = newMessages.map(formatMessage).join("\n\n");
  const userContent =
    `Previous summary:\n${previousSummary}\n\nNew conversation:\n${formatted}`;

  return collectStreamText(
    llmProvider,
    [{ role: "user", content: userContent }],
    INCREMENTAL_SUMMARY_SYSTEM_PROMPT,
  );
}

// ---------------------------------------------------------------------------
// Integration helpers — trigger timing constants
// ---------------------------------------------------------------------------

/** Number of new conversation turns before triggering an incremental summary. */
export const INCREMENTAL_SUMMARY_THRESHOLD = 10;
