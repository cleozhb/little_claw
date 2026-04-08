"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { wsClient } from "@/lib/websocket";
import type { DisplayMessage, DisplayMessageType } from "@/lib/mock-data";
import type { ServerMessage, MessageSummary } from "@/types/protocol";

let msgCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

// Anthropic content block types stored in DB
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** Polyfill — Array.findLastIndex may not be available in all TS targets */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

/**
 * Parse the content field from a MessageSummary.
 * It can be:
 *  - a plain string
 *  - a JSON string encoding a ContentBlock[]
 *  - a JSON string encoding a single string
 */
function parseContent(raw: string): ContentBlock[] | string {
  // If it doesn't look like JSON, return as-is
  if (!raw.startsWith("[") && !raw.startsWith('"')) return raw;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Convert a MessageSummary (from session_loaded) into one or more DisplayMessages.
 * A single DB message may contain multiple content blocks (text + tool_use).
 */
function toDisplayMessages(m: MessageSummary): DisplayMessage[] {
  const role = m.role as DisplayMessage["role"];
  const timestamp = new Date(m.createdAt);
  const content = parseContent(m.content);

  // Plain text content
  if (typeof content === "string") {
    return [
      { id: nextId(), role, type: "text", content, timestamp },
    ];
  }

  // Array of content blocks
  const results: DisplayMessage[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text": {
        if (block.text.trim()) {
          results.push({
            id: nextId(),
            role,
            type: "text",
            content: block.text,
            timestamp,
          });
        }
        break;
      }
      case "tool_use": {
        results.push({
          id: nextId(),
          role: "assistant",
          type: "tool_call",
          content: `调用工具 ${block.name}`,
          meta: {
            toolName: block.name,
            toolParams: block.input,
          },
          timestamp,
        });
        break;
      }
      case "tool_result": {
        const output =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c) => c.text).join("\n");
        results.push({
          id: nextId(),
          role: "assistant",
          type: "tool_result",
          content: block.is_error ? "执行失败" : "执行成功",
          meta: {
            success: !block.is_error,
            result: output,
          },
          timestamp,
        });
        break;
      }
    }
  }

  // Fallback: if no blocks produced anything, show raw
  if (results.length === 0) {
    results.push({
      id: nextId(),
      role,
      type: "text",
      content: m.content,
      timestamp,
    });
  }

  return results;
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  // Track current session to filter messages
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  // ---- Load history when session changes ----
  const loadHistory = useCallback((history: MessageSummary[]) => {
    setMessages(history.flatMap(toDisplayMessages));
    setIsStreaming(false);
  }, []);

  // ---- Handle incoming server messages ----
  useEffect(() => {
    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      // Only process messages for the current session (or session-less messages)
      if ("sessionId" in msg && msg.sessionId !== sessionRef.current) return;

      switch (msg.type) {
        case "text_delta": {
          setIsStreaming(true);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.type === "text") {
              // Append delta to existing assistant text message
              const updated = { ...last, content: last.content + msg.text };
              return [...prev.slice(0, -1), updated];
            }
            // Create new assistant text message
            return [
              ...prev,
              {
                id: nextId(),
                role: "assistant" as const,
                type: "text" as DisplayMessageType,
                content: msg.text,
                timestamp: new Date(),
              },
            ];
          });
          break;
        }

        case "tool_call": {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              type: "tool_call",
              content: `调用工具 ${msg.name}`,
              meta: {
                toolName: msg.name,
                toolParams: msg.params,
              },
              timestamp: new Date(),
            },
          ]);
          break;
        }

        case "tool_result": {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              type: "tool_result",
              content: msg.result.success
                ? `${msg.name} 执行成功`
                : `${msg.name} 执行失败`,
              meta: {
                toolName: msg.name,
                success: msg.result.success,
                result: msg.result.output || msg.result.error,
              },
              timestamp: new Date(),
            },
          ]);
          break;
        }

        case "sub_agent_start": {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              type: "sub_agent_start",
              content: `启动子 Agent: ${msg.agentName}`,
              meta: {
                agentName: msg.agentName,
                task: msg.task,
                nestedEvents: [],
              },
              timestamp: new Date(),
            },
          ]);
          break;
        }

        case "sub_agent_progress": {
          // Append inner event to the most recent sub_agent_start for this agent
          setMessages((prev) => {
            const idx = findLastIndex(
              prev,
              (m) =>
                (m.type === "sub_agent_start" || m.type === "sub_agent_progress") &&
                m.meta?.agentName === msg.agentName,
            );
            if (idx === -1) return prev;

            const target = prev[idx];
            const inner = msg.innerEvent;
            let nested: DisplayMessage | null = null;

            if (inner.type === "text_delta") {
              // Accumulate text deltas into a single nested text entry
              const existing = target.meta?.nestedEvents ?? [];
              const lastNested = existing[existing.length - 1];
              if (lastNested && lastNested.type === "text") {
                const updatedNested = [
                  ...existing.slice(0, -1),
                  { ...lastNested, content: lastNested.content + inner.text },
                ];
                const updated = {
                  ...target,
                  type: "sub_agent_progress" as DisplayMessageType,
                  meta: { ...target.meta, nestedEvents: updatedNested },
                };
                return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
              }
              nested = {
                id: nextId(),
                role: "assistant" as const,
                type: "text" as DisplayMessageType,
                content: inner.text,
                timestamp: new Date(),
              };
            } else if (inner.type === "tool_call") {
              nested = {
                id: nextId(),
                role: "assistant" as const,
                type: "tool_call" as DisplayMessageType,
                content: `调用工具 ${inner.name}`,
                meta: { toolName: inner.name, toolParams: inner.params },
                timestamp: new Date(),
              };
            } else if (inner.type === "tool_result") {
              nested = {
                id: nextId(),
                role: "assistant" as const,
                type: "tool_result" as DisplayMessageType,
                content: inner.result.success ? "执行成功" : "执行失败",
                meta: {
                  toolName: inner.name,
                  success: inner.result.success,
                  result: inner.result.output || inner.result.error,
                },
                timestamp: new Date(),
              };
            }

            if (!nested) return prev;

            const updated = {
              ...target,
              type: "sub_agent_progress" as DisplayMessageType,
              meta: {
                ...target.meta,
                nestedEvents: [...(target.meta?.nestedEvents ?? []), nested],
              },
            };
            return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
          });
          break;
        }

        case "sub_agent_done": {
          setMessages((prev) => {
            // Find the matching start/progress card and replace it with done
            const idx = findLastIndex(
              prev,
              (m) =>
                (m.type === "sub_agent_start" || m.type === "sub_agent_progress") &&
                m.meta?.agentName === msg.agentName,
            );
            const nestedEvents = idx !== -1 ? prev[idx].meta?.nestedEvents ?? [] : [];
            const doneMsg: DisplayMessage = {
              id: idx !== -1 ? prev[idx].id : nextId(),
              role: "assistant",
              type: "sub_agent_done",
              content: `子 Agent ${msg.agentName} 完成`,
              meta: {
                agentName: msg.agentName,
                result: msg.result,
                nestedEvents,
              },
              timestamp: new Date(),
            };
            if (idx !== -1) {
              return [...prev.slice(0, idx), doneMsg, ...prev.slice(idx + 1)];
            }
            return [...prev, doneMsg];
          });
          break;
        }

        case "injected": {
          // The inject was acknowledged — no extra UI needed
          break;
        }

        case "memory_results": {
          if (msg.results.length > 0) {
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "system",
                type: "memory_recall",
                content: `Recalled ${msg.results.length} memories`,
                meta: {
                  memories: msg.results.map((r) => ({
                    content: r.content,
                    similarity: r.similarity,
                  })),
                },
                timestamp: new Date(),
              },
            ]);
          }
          break;
        }

        case "done": {
          setIsStreaming(false);
          break;
        }

        case "error": {
          setIsStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "system",
              type: "text",
              content: `⚠ 错误: ${msg.message}`,
              timestamp: new Date(),
            },
          ]);
          break;
        }

        case "session_loaded": {
          if (msg.session.id === sessionRef.current) {
            loadHistory(msg.recentMessages);
          }
          break;
        }
      }
    });

    return unsub;
  }, [loadHistory]);

  // ---- Actions ----

  const sendMessage = useCallback(
    (content: string) => {
      if (!sessionId) return;
      // Optimistically add user message
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          type: "text",
          content,
          timestamp: new Date(),
        },
      ]);
      setIsStreaming(true);
      wsClient.send({ type: "chat", sessionId, content });
    },
    [sessionId],
  );

  const abort = useCallback(() => {
    if (!sessionId) return;
    wsClient.send({ type: "abort", sessionId });
  }, [sessionId]);

  const inject = useCallback(
    (content: string) => {
      if (!sessionId) return;
      wsClient.send({ type: "inject", sessionId, content });
    },
    [sessionId],
  );

  // Clear messages when session changes
  useEffect(() => {
    setMessages([]);
    setIsStreaming(false);
  }, [sessionId]);

  return { messages, isStreaming, sendMessage, abort, inject };
}
