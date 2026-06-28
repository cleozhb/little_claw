import type { Message, TextBlock, ToolResultBlock, ToolUseBlock } from "../types/message.ts";
import { estimateTokens } from "../memory/TokenBudget.ts";

const DEFAULT_MIN_MESSAGES = 12;
const DEFAULT_TOKEN_THRESHOLD = 16_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 6;
const DEFAULT_MAX_SUMMARY_CHARS = 6_000;

export interface ConversationCompactionOptions {
  minMessages?: number;
  tokenThreshold?: number;
  keepRecentMessages?: number;
  maxSummaryChars?: number;
}

export interface ConversationCompactionResult {
  messages: Message[];
  compacted: boolean;
  omittedMessages: number;
  originalTokens: number;
  compactedTokens: number;
  summary?: string;
}

export function compactConversationHistory(
  messages: Message[],
  options: ConversationCompactionOptions = {},
): ConversationCompactionResult {
  const originalTokens = estimateTokens(JSON.stringify(messages));
  const minMessages = options.minMessages ?? DEFAULT_MIN_MESSAGES;
  const tokenThreshold = options.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
  if (messages.length <= minMessages && originalTokens <= tokenThreshold) {
    return {
      messages,
      compacted: false,
      omittedMessages: 0,
      originalTokens,
      compactedTokens: originalTokens,
    };
  }

  const keepRecentMessages = Math.max(1, options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  const boundary = findSafeRecentBoundary(messages, keepRecentMessages);
  const older = messages.slice(0, boundary);
  if (older.length === 0) {
    return {
      messages,
      compacted: false,
      omittedMessages: 0,
      originalTokens,
      compactedTokens: originalTokens,
    };
  }

  const summary = buildCompactionSummary(older, options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS);
  const compactedMessages: Message[] = [
    {
      role: "user",
      content: summary,
    },
    ...messages.slice(boundary),
  ];

  return {
    messages: compactedMessages,
    compacted: true,
    omittedMessages: older.length,
    originalTokens,
    compactedTokens: estimateTokens(JSON.stringify(compactedMessages)),
    summary,
  };
}

function findSafeRecentBoundary(messages: Message[], keepRecentMessages: number): number {
  let boundary = Math.max(0, messages.length - keepRecentMessages);

  // Do not keep a tool_result without its paired assistant tool_use message.
  while (boundary > 0 && isToolResultMessage(messages[boundary])) {
    boundary--;
  }

  // If a kept assistant tool_use is at the end of the dropped region, keep its result too.
  while (
    boundary > 0 &&
    isAssistantToolUseMessage(messages[boundary - 1]) &&
    isToolResultMessage(messages[boundary])
  ) {
    boundary--;
  }

  return boundary;
}

function buildCompactionSummary(messages: Message[], maxChars: number): string {
  const lines: string[] = [
    "[Conversation history compacted]",
    "Older turns are summarized below to keep the LLM context small. Recent turns remain verbatim.",
  ];

  for (const [index, message] of messages.entries()) {
    const line = summarizeMessage(message, index + 1);
    if (!line) continue;
    lines.push(line);
    const current = lines.join("\n");
    if (current.length > maxChars) {
      return `${current.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n... [older compacted history truncated]`;
    }
  }

  return lines.join("\n");
}

function summarizeMessage(message: Message, ordinal: number): string {
  if (typeof message.content === "string") {
    return `${ordinal}. ${message.role}: ${truncate(message.content.replace(/\s+/g, " ").trim(), 450)}`;
  }

  const blocks = message.content as Array<TextBlock | ToolUseBlock | ToolResultBlock>;
  if (message.role === "assistant") {
    const parts = blocks.map((block) => {
      if (block.type === "text") {
        return `text=${truncate(block.text.replace(/\s+/g, " ").trim(), 320)}`;
      }
      if (block.type === "tool_use") {
        return `tool_use=${block.name} input=${truncate(JSON.stringify(block.input), 240)}`;
      }
      return "";
    }).filter(Boolean);
    return parts.length > 0 ? `${ordinal}. assistant: ${parts.join("; ")}` : "";
  }

  const parts = blocks.map((block) => {
    if (block.type !== "tool_result") return "";
    return `tool_result ${block.tool_use_id}${block.is_error ? " error" : ""}: ${
      summarizeToolResult(block.content)
    }`;
  }).filter(Boolean);
  return parts.length > 0 ? `${ordinal}. user: ${parts.join("; ")}` : "";
}

function summarizeToolResult(content: string): string {
  const parsed = parseJson(content);
  if (isRecord(parsed) && parsed.type === "content_ref") {
    const refId = typeof parsed.ref_id === "string" ? parsed.ref_id : "(unknown ref)";
    const title = typeof parsed.title === "string" ? parsed.title : undefined;
    const source = typeof parsed.source === "string" ? parsed.source : undefined;
    const digest = typeof parsed.digest === "string" ? parsed.digest : undefined;
    const length = typeof parsed.content_length === "number" ? ` length=${parsed.content_length}` : "";
    return [
      `content_ref=${refId}${length}`,
      title ? `title=${truncate(title, 120)}` : "",
      source ? `source=${truncate(source, 160)}` : "",
      digest ? `digest=${truncate(digest, 260)}` : "",
    ].filter(Boolean).join(" ");
  }

  if (isRecord(parsed)) {
    const keys = Object.keys(parsed).slice(0, 8).join(",");
    return `json keys=[${keys}] ${truncate(JSON.stringify(parsed), 360)}`;
  }

  return truncate(content.replace(/\s+/g, " ").trim(), 420);
}

function isToolResultMessage(message: Message | undefined): boolean {
  return !!message && message.role === "user" && Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result");
}

function isAssistantToolUseMessage(message: Message | undefined): boolean {
  return !!message && message.role === "assistant" && Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_use");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

