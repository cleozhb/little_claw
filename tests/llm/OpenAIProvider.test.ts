import { afterEach, expect, test } from "bun:test";
import { OpenAIProvider } from "../../src/llm/OpenAIProvider.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("OpenAIProvider streams reasoning and replays only the current user turn", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBodies.push(await request.json() as Record<string, unknown>);
      return reasoningStreamResponse();
    },
  });
  servers.push(server);

  const provider = new OpenAIProvider(
    "test-key",
    "deepseek-v4-pro",
    `http://127.0.0.1:${server.port}/v1`,
    true,
  );
  const messages: Message[] = [
    { role: "user", content: "old question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", reasoning_content: "old hidden reasoning" },
        { type: "tool_use", id: "old-tool", name: "lookup", input: { q: "old" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "old-tool", content: "old result" }],
    },
    { role: "user", content: "new question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", reasoning_content: "current hidden reasoning" },
        { type: "tool_use", id: "new-tool", name: "lookup", input: { q: "new" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "new-tool", content: "new result" }],
    },
  ];

  const events: StreamEvent[] = [];
  for await (const event of provider.chat(messages)) events.push(event);

  expect(events).toContainEqual({
    type: "reasoning_delta",
    reasoning_content: "streamed hidden reasoning",
  });
  expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });

  const body = requestBodies[0]!;
  expect(body.thinking).toEqual({ type: "enabled" });
  const apiMessages = body.messages as Array<Record<string, unknown>>;
  const assistants = apiMessages.filter((message) => message.role === "assistant");
  expect(assistants[0]!.reasoning_content).toBeUndefined();
  expect(assistants[1]!.reasoning_content).toBe("current hidden reasoning");
  expect(assistants[1]!.content).toBe("");
});

test("OpenAIProvider sends the explicit disabled switch and omits reasoning replay", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBodies.push(await request.json() as Record<string, unknown>);
      return reasoningStreamResponse();
    },
  });
  servers.push(server);

  const provider = new OpenAIProvider(
    "test-key",
    "deepseek-v4-pro",
    `http://127.0.0.1:${server.port}/v1`,
    false,
  );
  const messages: Message[] = [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", reasoning_content: "must not replay" },
        { type: "text", text: "answer" },
      ],
    },
  ];

  for await (const _event of provider.chat(messages)) {}

  const body = requestBodies[0]!;
  expect(body.thinking).toEqual({ type: "disabled" });
  const apiMessages = body.messages as Array<Record<string, unknown>>;
  expect(apiMessages[1]!.reasoning_content).toBeUndefined();
});

function reasoningStreamResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        delta: { role: "assistant", reasoning_content: "streamed hidden reasoning" },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        delta: { content: "visible answer" },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
