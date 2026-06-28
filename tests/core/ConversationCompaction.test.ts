import { expect, test } from "bun:test";
import { compactConversationHistory } from "../../src/core/ConversationCompaction.ts";
import type { Message } from "../../src/types/message.ts";

test("compactConversationHistory summarizes older turns and preserves recent messages", () => {
  const contentRef = JSON.stringify({
    type: "content_ref",
    ref_id: "ctx_20260624_abc123",
    title: "Large Fetch",
    source: "https://example.com/article",
    content_length: 42_000,
    digest: "Article digest",
  });
  const messages: Message[] = [
    { role: "user", content: `old request ${"A".repeat(4_000)}` },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://example.com/article" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: contentRef, is_error: false }],
    },
    { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: "recent question" },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
  ];

  const result = compactConversationHistory(messages, {
    minMessages: 2,
    keepRecentMessages: 2,
    maxSummaryChars: 1_500,
  });

  expect(result.compacted).toBe(true);
  expect(result.messages).toHaveLength(3);
  expect(result.messages[0]?.role).toBe("user");
  expect(String(result.messages[0]?.content)).toContain("Conversation history compacted");
  expect(String(result.messages[0]?.content)).toContain("ctx_20260624_abc123");
  expect(String(result.messages[0]?.content)).not.toContain("A".repeat(1_000));
  expect(result.messages.slice(1)).toEqual(messages.slice(-2));
});

test("compactConversationHistory keeps tool_use with a recent tool_result", () => {
  const messages: Message[] = [
    { role: "user", content: "older question" },
    { role: "assistant", content: [{ type: "text", text: "older answer" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t2", name: "read_content_ref", input: { ref_id: "ctx_test", page: 1 } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "page text", is_error: false }],
    },
  ];

  const result = compactConversationHistory(messages, {
    minMessages: 1,
    keepRecentMessages: 1,
  });

  expect(result.compacted).toBe(true);
  expect(result.messages).toHaveLength(3);
  expect(result.messages[1]).toEqual(messages[2]);
  expect(result.messages[2]).toEqual(messages[3]);
});

