import { expect, test } from "bun:test";
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

type ScriptedReply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown> };

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

    yield { type: "tool_use_start", id: `tool-${this.replies.length}`, name: reply.name };
    yield { type: "tool_use_delta", input_json: JSON.stringify(reply.input) };
    yield { type: "tool_use_end" };
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
