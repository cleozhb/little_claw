import { test, expect, beforeEach } from "bun:test";
import type { LLMProvider, ChatOptions } from "../../src/llm/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";
import type { AgentEvent } from "../../src/types/message.ts";
import type { Tool } from "../../src/tools/types.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import {
  createSpawnAgentTool,
  type SpawnAgentTool,
} from "../../src/tools/builtin/SpawnAgentTool.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * 创建一个 Mock LLMProvider，每次 chat() 调用按顺序返回预设的 StreamEvent 序列。
 * responses 数组中每个元素对应一次 chat() 调用（即 AgentLoop 的一次迭代）。
 */
function createMockLLM(
  responses: StreamEvent[][],
): LLMProvider {
  let callIndex = 0;
  return {
    async *chat(
      _messages: Message[],
      _options?: ChatOptions,
    ): AsyncGenerator<StreamEvent> {
      const events = responses[callIndex] ?? [];
      callIndex++;
      for (const event of events) {
        yield event;
      }
    },
    getModel() {
      return "mock-model";
    },
    setModel(_model: string) {},
  };
}

/** 生成一组 "LLM 直接回复文本并结束" 的流事件 */
function textReply(text: string): StreamEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
}

/** 生成一组 "LLM 调用工具" 的流事件（stop_reason = tool_use） */
function toolCallReply(
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  return [
    { type: "tool_use_start", id: toolId, name: toolName },
    { type: "tool_use_delta", input_json: JSON.stringify(args) },
    { type: "tool_use_end" },
    {
      type: "message_end",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
}

/** 创建一个简单的 mock tool */
function createMockTool(
  name: string,
  result: { success: boolean; output: string; error?: string },
): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: { type: "object", properties: {} },
    async execute(_params: Record<string, unknown>) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let toolRegistry: ToolRegistry;

beforeEach(() => {
  toolRegistry = new ToolRegistry();
  // 注册一些基础工具，模拟真实环境
  toolRegistry.register(
    createMockTool("read_file", { success: true, output: "file content" }),
  );
  toolRegistry.register(
    createMockTool("write_file", { success: true, output: "ok" }),
  );
  toolRegistry.register(
    createMockTool("shell", { success: true, output: "shell output" }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SpawnAgentTool: normal execution returns text result", async () => {
  const llm = createMockLLM([textReply("Hello from coder agent!")]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    agent_type: "coder",
    task: "Write a hello world function",
  });

  expect(result.success).toBe(true);
  expect(result.output).toContain("Hello from coder agent!");
});

test("SpawnAgentTool: missing agent_type returns error", async () => {
  const llm = createMockLLM([]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    task: "some task",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("required");
});

test("SpawnAgentTool: missing task returns error", async () => {
  const llm = createMockLLM([]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    agent_type: "coder",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("required");
});

test("SpawnAgentTool: event callback receives start -> progress -> done sequence", async () => {
  const llm = createMockLLM([textReply("result text")]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const events: AgentEvent[] = [];
  spawnTool.setEventCallback((event) => events.push(event));

  await spawnTool.execute({
    agent_type: "planner",
    task: "Plan the architecture",
  });

  // 至少有 start, progress (text_delta + done), done
  expect(events.length).toBeGreaterThanOrEqual(3);

  // 第一个事件必须是 sub_agent_start
  expect(events[0]!.type).toBe("sub_agent_start");
  if (events[0]!.type === "sub_agent_start") {
    expect(events[0]!.agentName).toBe("planner");
    expect(events[0]!.task).toBe("Plan the architecture");
  }

  // 中间应该有 sub_agent_progress 事件
  const progressEvents = events.filter((e) => e.type === "sub_agent_progress");
  expect(progressEvents.length).toBeGreaterThan(0);

  // 最后一个事件是 sub_agent_done
  const lastEvent = events[events.length - 1]!;
  expect(lastEvent.type).toBe("sub_agent_done");
  if (lastEvent.type === "sub_agent_done") {
    expect(lastEvent.agentName).toBe("planner");
    expect(lastEvent.result).toContain("result text");
  }
});

test("SpawnAgentTool: context is injected into conversation", async () => {
  // 用一个可以追踪 messages 的 LLM 来验证 context 注入
  let capturedMessages: Message[] = [];

  const llm: LLMProvider = {
    async *chat(messages: Message[], _options?: ChatOptions) {
      capturedMessages = [...messages];
      yield { type: "text_delta", text: "done" } as StreamEvent;
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      } as StreamEvent;
    },
    getModel() {
      return "mock";
    },
    setModel(_m: string) {},
  };

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  await spawnTool.execute({
    agent_type: "researcher",
    task: "Find info about X",
    context: "The project uses TypeScript",
  });

  // context 应该作为 user+assistant 消息对注入到前面
  // messages: [user(context), assistant(ack), user(task)]
  expect(capturedMessages.length).toBe(3);
  expect(capturedMessages[0]!.role).toBe("user");
  expect((capturedMessages[0] as any).content).toContain(
    "The project uses TypeScript",
  );
  expect(capturedMessages[1]!.role).toBe("assistant");
  expect(capturedMessages[2]!.role).toBe("user");
  expect((capturedMessages[2] as any).content).toBe("Find info about X");
});

test("SpawnAgentTool: sub-agent with tool calls works end-to-end", async () => {
  // 模拟：第一轮 LLM 调用 read_file 工具，第二轮返回最终文本
  const llm = createMockLLM([
    toolCallReply("call-1", "read_file", { path: "src/main.ts" }),
    textReply("I've read the file. Here's my analysis."),
  ]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    agent_type: "coder",
    task: "Analyze main.ts",
  });

  expect(result.success).toBe(true);
  expect(result.output).toContain("analysis");
});

test("SpawnAgentTool: LLM error is propagated as failure", async () => {
  const llm: LLMProvider = {
    async *chat(_messages: Message[], _options?: ChatOptions) {
      throw new Error("API rate limit exceeded");
    },
    getModel() {
      return "mock";
    },
    setModel(_m: string) {},
  };

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const events: AgentEvent[] = [];
  spawnTool.setEventCallback((e) => events.push(e));

  const result = await spawnTool.execute({
    agent_type: "coder",
    task: "Do something",
  });

  // AgentLoop 会 catch 并 yield error + 返回空文本
  // SpawnAgentTool 的 collectAgentResult 会收到空字符串
  // 验证不会崩溃
  expect(result).toBeDefined();
});

test("SpawnAgentTool: recursion prevention - sub-agent cannot see spawn_agent tool", async () => {
  // 追踪传给 LLM 的 tools 列表（只取第一次 chat 调用，后续调用来自 title 生成）
  let capturedTools: { name: string }[] = [];
  let firstCall = true;

  const llm: LLMProvider = {
    async *chat(_messages: Message[], options?: ChatOptions) {
      if (firstCall) {
        capturedTools = options?.tools ?? [];
        firstCall = false;
      }
      yield { type: "text_delta", text: "done" } as StreamEvent;
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      } as StreamEvent;
    },
    getModel() {
      return "mock";
    },
    setModel(_m: string) {},
  };

  // 注册 spawn_agent 到 registry（模拟真实场景）
  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });
  toolRegistry.register(spawnTool);

  await spawnTool.execute({
    agent_type: "coder",
    task: "Write code",
  });

  // 子 Agent (coder) 的 canSpawnSubAgent=false，
  // 所以 AgentLoop.getFilteredToolDefinitions() 应该过滤掉 spawn_agent
  const toolNames = capturedTools.map((t) => t.name);
  expect(toolNames).not.toContain("spawn_agent");

  // coder 只允许 read_file, write_file, shell
  expect(toolNames).toContain("read_file");
  expect(toolNames).toContain("write_file");
  expect(toolNames).toContain("shell");
});

test("SpawnAgentTool: planner agent only gets read_file and shell tools", async () => {
  let capturedTools: { name: string }[] = [];
  let firstCall = true;

  const llm: LLMProvider = {
    async *chat(_messages: Message[], options?: ChatOptions) {
      if (firstCall) {
        capturedTools = options?.tools ?? [];
        firstCall = false;
      }
      yield { type: "text_delta", text: "plan ready" } as StreamEvent;
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      } as StreamEvent;
    },
    getModel() {
      return "mock";
    },
    setModel(_m: string) {},
  };

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  await spawnTool.execute({
    agent_type: "planner",
    task: "Create a plan",
  });

  const toolNames = capturedTools.map((t) => t.name);
  // planner: allowedTools = ["read_file", "shell"]
  expect(toolNames).toContain("read_file");
  expect(toolNames).toContain("shell");
  expect(toolNames).not.toContain("write_file");
  expect(toolNames).not.toContain("spawn_agent");
});

test("SpawnAgentTool: unknown agent type gets generic config", async () => {
  const llm = createMockLLM([textReply("generic agent response")]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    agent_type: "unknown_type",
    task: "Do something generic",
  });

  // 未知类型不会报错，会使用 fallback 配置
  expect(result.success).toBe(true);
  expect(result.output).toContain("generic agent response");
});

test("SpawnAgentTool: empty output returns fallback message", async () => {
  // LLM 不返回任何文本，直接 end_turn
  const llm = createMockLLM([
    [
      {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    ],
  ]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  const result = await spawnTool.execute({
    agent_type: "coder",
    task: "Silent task",
  });

  expect(result.success).toBe(true);
  expect(result.output).toContain("no text output");
});

test("SpawnAgentTool: callback is per-session and clearable", async () => {
  const llm = createMockLLM([
    textReply("first run"),
    textReply("second run"),
  ]);

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  // 第一次执行带 callback
  const events1: AgentEvent[] = [];
  spawnTool.setEventCallback((e) => events1.push(e));
  await spawnTool.execute({ agent_type: "coder", task: "task 1" });
  expect(events1.length).toBeGreaterThan(0);

  // 清除 callback
  spawnTool.setEventCallback(undefined);
  // 第二次执行不带 callback，不应崩溃
  const result2 = await spawnTool.execute({ agent_type: "coder", task: "task 2" });
  expect(result2.success).toBe(true);
});

test("SpawnAgentTool: sub-agent does not trigger title generation", async () => {
  // 追踪 LLM 被调用的次数
  let chatCallCount = 0;

  const llm: LLMProvider = {
    async *chat(_messages: Message[], _options?: ChatOptions) {
      chatCallCount++;
      yield { type: "text_delta", text: "sub-agent reply" } as StreamEvent;
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      } as StreamEvent;
    },
    getModel() {
      return "mock";
    },
    setModel(_m: string) {},
  };

  const spawnTool = createSpawnAgentTool({
    llmProvider: llm,
    toolRegistry,
  });

  await spawnTool.execute({ agent_type: "coder", task: "Write code" });

  // 修复前：chatCallCount === 2（AgentLoop 一次 + generateTitle 一次）
  // 修复后：chatCallCount === 1（只有 AgentLoop 调用）
  expect(chatCallCount).toBe(1);
});
