import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createAgentConfig } from "../../src/agents/AgentConfig.ts";
import { AgentLoop } from "../../src/core/AgentLoop.ts";
import { EphemeralConversation } from "../../src/core/EphemeralConversation.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import type { MemoryManager } from "../../src/memory/MemoryManager.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool, ToolExecuteOptions } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

test("AgentLoop scopes project write_file calls into the project workspace", async () => {
  const inputs: Record<string, unknown>[] = [];
  const registry = new ToolRegistry();
  registry.register(capturingTool("write_file", inputs));
  const llm = new ScriptedLLM([
    { type: "tool", name: "write_file", input: { path: "translation.md", content: "hello" } },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test project workspace"), {
    config: createAgentConfig({
      name: "coder",
      systemPrompt: "test coder",
      allowedTools: ["write_file"],
      maxTurns: 3,
      canSpawnSubAgent: false,
    }),
    runMode: "team_worker",
    contextMode: "project",
    projectContextPath: "context-hub/3-projects/technology-blog",
  });

  for await (const _event of loop.run("write a translation")) {}

  expect(inputs).toEqual([
    {
      path: "context-hub/3-projects/technology-blog/translation.md",
      content: "hello",
    },
  ]);
});

test("AgentLoop runs project shell calls from the project workspace", async () => {
  const calls: Array<{ input: Record<string, unknown>; options?: ToolExecuteOptions }> = [];
  const registry = new ToolRegistry();
  registry.register(capturingTool("shell", [], calls));
  const llm = new ScriptedLLM([
    { type: "tool", name: "shell", input: { command: "printf ok > extract_urls.py" } },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test project shell"), {
    config: createAgentConfig({
      name: "coder",
      systemPrompt: "test coder",
      allowedTools: ["shell"],
      maxTurns: 3,
      canSpawnSubAgent: false,
    }),
    memoryManager: fakeMemoryManager("/tmp/little_claw_agent_loop_project"),
    runMode: "team_worker",
    contextMode: "project",
    projectContextPath: "context-hub/3-projects/technology-blog",
  });

  for await (const _event of loop.run("extract URLs")) {}

  expect(calls[0]?.options?.cwd).toBe(
    "/tmp/little_claw_agent_loop_project/context-hub/3-projects/technology-blog",
  );
  expect(calls[0]?.options?.env?.LITTLE_CLAW_PROJECT_CONTEXT_PATH).toBe(
    "context-hub/3-projects/technology-blog",
  );
});

test("AgentLoop stores oversized tool output as content_ref before continuing", async () => {
  rmSync("/tmp/little_claw_agent_loop_budget", { recursive: true, force: true });
  const registry = new ToolRegistry();
  registry.register(outputTool("noisy_tool", "x".repeat(8_000)));
  const llm = new RecordingLLM([
    { type: "tool", name: "noisy_tool", input: {} },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test budget"), {
    config: createAgentConfig({
      name: "coder",
      systemPrompt: "test coder",
      allowedTools: ["noisy_tool"],
      maxTurns: 3,
      canSpawnSubAgent: false,
    }),
    memoryManager: fakeMemoryManager("/tmp/little_claw_agent_loop_budget"),
  });

  const toolResults: string[] = [];
  for await (const event of loop.run("run noisy tool")) {
    if (event.type === "tool_result") {
      toolResults.push(event.result.output || event.result.error || "");
    }
  }

  expect(toolResults[0]).toContain('"type": "content_ref"');
  expect(toolResults[0]).toContain('"budget_note"');
  expect(JSON.stringify(llm.seenMessages.at(-1))).not.toContain("x".repeat(5_000));
});

test("AgentLoop limits read_content_ref calls per round", async () => {
  const calls: Array<{ input: Record<string, unknown>; options?: ToolExecuteOptions }> = [];
  const registry = new ToolRegistry();
  registry.register(capturingTool("read_content_ref", [], calls));
  const llm = new ScriptedLLM([
    {
      type: "tools",
      calls: [
        { name: "read_content_ref", input: { ref_id: "ctx_test", page: 1 } },
        { name: "read_content_ref", input: { ref_id: "ctx_test", page: 2 } },
        { name: "read_content_ref", input: { ref_id: "ctx_test", page: 3 } },
        { name: "read_content_ref", input: { ref_id: "ctx_test", page: 4 } },
      ],
    },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test read limit"), {
    config: createAgentConfig({
      name: "coder",
      systemPrompt: "test coder",
      allowedTools: ["read_content_ref"],
      maxTurns: 3,
      canSpawnSubAgent: false,
    }),
  });

  const toolResults: string[] = [];
  for await (const event of loop.run("read too many pages")) {
    if (event.type === "tool_result") {
      toolResults.push(event.result.output || event.result.error || "");
    }
  }

  expect(calls).toHaveLength(3);
  expect(toolResults).toHaveLength(4);
  expect(toolResults[3]).toContain("limited to 3 pages");
  expect(toolResults[3]).toContain("search_content_ref");
});

test("AgentLoop enforces per-run tool call limits before execution", async () => {
  const calls: Array<{ input: Record<string, unknown>; options?: ToolExecuteOptions }> = [];
  const registry = new ToolRegistry();
  registry.register(capturingTool("web_search", [], calls));
  const llm = new ScriptedLLM([
    {
      type: "tools",
      calls: Array.from({ length: 6 }, (_, index) => ({
        name: "web_search",
        input: { query: `query ${index + 1}` },
      })),
    },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test tool limits"), {
    config: createAgentConfig({
      name: "vc-analyst",
      systemPrompt: "test vc analyst",
      allowedTools: ["web_search"],
      maxTurns: 3,
      canSpawnSubAgent: false,
      toolLimits: { web_search: 5 },
    }),
  });

  const toolResults: string[] = [];
  for await (const event of loop.run("search too much")) {
    if (event.type === "tool_result") {
      toolResults.push(event.result.output || event.result.error || "");
    }
  }

  expect(calls).toHaveLength(5);
  expect(toolResults).toHaveLength(6);
  expect(toolResults[5]).toContain("web_search is limited to 5 call(s) per agent run");
  expect(toolResults[5]).toContain("proceed to analysis and write the final output");
});

test("AgentLoop gives stop guidance when content_ref tool limits are exhausted", async () => {
  const calls: Array<{ input: Record<string, unknown>; options?: ToolExecuteOptions }> = [];
  const registry = new ToolRegistry();
  registry.register(capturingTool("search_content_ref", [], calls));
  const llm = new ScriptedLLM([
    {
      type: "tools",
      calls: [
        { name: "search_content_ref", input: { ref_id: "ctx_test", query: "amount" } },
        { name: "search_content_ref", input: { ref_id: "ctx_test", query: "investors" } },
      ],
    },
    { type: "text", text: "done" },
  ]);
  const loop = new AgentLoop(llm, registry, new EphemeralConversation("test content ref limit"), {
    config: createAgentConfig({
      name: "vc-analyst",
      systemPrompt: "test vc analyst",
      allowedTools: ["search_content_ref"],
      maxTurns: 3,
      canSpawnSubAgent: false,
      toolLimits: { search_content_ref: 1 },
    }),
  });

  const toolResults: string[] = [];
  for await (const event of loop.run("search refs too much")) {
    if (event.type === "tool_result") {
      toolResults.push(event.result.output || event.result.error || "");
    }
  }

  expect(calls).toHaveLength(1);
  expect(toolResults).toHaveLength(2);
  expect(toolResults[1]).toContain("search_content_ref is limited to 1 call(s) per agent run");
  expect(toolResults[1]).toContain("Do not call read_content_ref or search_content_ref again");
  expect(toolResults[1]).toContain("write the final output and stop");
});

test("AgentLoop sends a compacted conversation view to the model", async () => {
  const conversation = new EphemeralConversation("test compaction");
  for (let i = 0; i < 7; i++) {
    const payload = i < 4 ? "A".repeat(4_000) : `short recent ${i}`;
    conversation.addUser(`old request ${i} ${payload}`);
    conversation.addAssistant(`old answer ${i}`);
  }
  const registry = new ToolRegistry();
  const llm = new RecordingLLM([{ type: "text", text: "done" }]);
  const loop = new AgentLoop(llm, registry, conversation, {
    config: createAgentConfig({
      name: "coder",
      systemPrompt: "test coder",
      allowedTools: [],
      maxTurns: 2,
      canSpawnSubAgent: false,
    }),
  });

  for await (const _event of loop.run("new request")) {}

  const firstCallMessages = llm.seenMessages[0] ?? [];
  const serialized = JSON.stringify(firstCallMessages);
  expect(firstCallMessages[0]?.role).toBe("user");
  expect(String(firstCallMessages[0]?.content)).toContain("Conversation history compacted");
  expect(serialized).toContain("new request");
  expect(serialized).not.toContain("A".repeat(1_000));
});

type ScriptedReply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown> }
  | { type: "tools"; calls: Array<{ name: string; input: Record<string, unknown> }> };

class ScriptedLLM implements LLMProvider {
  constructor(private replies: ScriptedReply[]) {}

  async *chat(_messages: Message[], _options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const reply = this.replies.shift() ?? { type: "text", text: "" };
    if (reply.type === "text") {
      yield { type: "text_delta", text: reply.text };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return;
    }

    const calls = reply.type === "tools" ? reply.calls : [reply];
    for (const [index, call] of calls.entries()) {
      const id = `tool-${this.replies.length}-${index}`;
      yield { type: "tool_use_start", id, name: call.name };
      yield { type: "tool_use_delta", input_json: JSON.stringify(call.input) };
      yield { type: "tool_use_end" };
    }
    yield {
      type: "message_end",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  getModel(): string {
    return "scripted-test-model";
  }

  setModel(_model: string): void {}
}

class RecordingLLM extends ScriptedLLM {
  seenMessages: Message[][] = [];

  override async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seenMessages.push(messages);
    yield* super.chat(messages, options);
  }
}

function capturingTool(
  name: string,
  inputs: Record<string, unknown>[] = [],
  calls?: Array<{ input: Record<string, unknown>; options?: ToolExecuteOptions }>,
): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    async execute(input: Record<string, unknown>, options?: ToolExecuteOptions) {
      inputs.push(input);
      calls?.push({ input, options });
      return { success: true, output: "ok" };
    },
  };
}

function outputTool(name: string, output: string): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { success: true, output };
    },
  };
}

function fakeMemoryManager(baseDir: string): MemoryManager {
  return {
    async loadFileMemoryContext() {
      return { contextMap: null, identity: null, inbox: null };
    },
    async recall() {
      return [];
    },
    getFileMemory() {
      return {
        getBaseDir() {
          return baseDir;
        },
        getContextHub() {
          return {
            async readOverview() {
              return null;
            },
          };
        },
      };
    },
    saveDailyLog() {},
  } as unknown as MemoryManager;
}
