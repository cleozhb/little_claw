import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { SessionRouter } from "../../src/gateway/SessionRouter.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { ContextHub } from "../../src/memory/ContextHub.ts";
import { ContextIndexer } from "../../src/memory/ContextIndexer.ts";
import { ContextRetriever } from "../../src/memory/ContextRetriever.ts";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { FileMemoryManager } from "../../src/memory/FileMemoryManager.ts";
import { LongTermMemoryExtractor } from "../../src/memory/LongTermMemoryExtractor.ts";
import { MemoryFlushCoordinator } from "../../src/memory/MemoryFlushCoordinator.ts";
import { MemoryIndexer } from "../../src/memory/MemoryIndexer.ts";
import { MemoryManager } from "../../src/memory/MemoryManager.ts";
import { MemoryRetriever } from "../../src/memory/MemoryRetriever.ts";
import { VectorStore } from "../../src/memory/VectorStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import { AgentWorker } from "../../src/team/AgentWorker.ts";
import type { RegisteredAgent } from "../../src/team/AgentRegistry.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";
import type { AppClock } from "../../src/utils/AppClock.ts";

const TMP = "/tmp/little_claw_memory_context_e2e";

const fixedClock: AppClock = {
  now: () => new Date("2026-07-12T04:30:00.000Z"),
  formatDate: () => "2026-07-12",
  formatTime: () => "12:30",
};

class DeterministicEmbedding implements EmbeddingProvider {
  getSignature(): string {
    return "e2e:3:normalized-v1";
  }

  async embed(text: string): Promise<number[]> {
    return [
      text.includes("LC-DURABLE-20260712") ? 1 : 0,
      text.includes("SECOND-BATCH-20260712") ? 1 : 0,
      1,
    ];
  }
}

class ThrowingEmbedding implements EmbeddingProvider {
  getSignature(): string {
    return "e2e:provider-down";
  }

  async embed(): Promise<number[]> {
    throw new Error("embedding provider unavailable");
  }
}

class RoutingLLM implements LLMProvider {
  summaryInputs: string[] = [];
  longTermInputs: string[] = [];

  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const input = messages.map(messageText).join("\n");
    let response: string;

    if (options?.system?.includes("Summarize this conversation")) {
      this.summaryInputs.push(input);
      response = input.includes("IDLE-FLUSH-20260712")
        ? "Summary contains IDLE-FLUSH-20260712."
        : input.includes("SECOND-BATCH-20260712")
          ? "Summary contains SECOND-BATCH-20260712 only."
          : "Summary contains FIRST-BATCH-20260712 and LC-DURABLE-20260712.";
    } else if (input.includes("=== 合并后的完整 MEMORY.md ===")) {
      this.longTermInputs.push(input);
      response = input.includes("LC-DURABLE-20260712")
        ? "# Memory\n\n- User prefers Chinese manual-test reports. Token: LC-DURABLE-20260712."
        : "NONE";
    } else if (options?.system?.toLowerCase().includes("title")) {
      response = "Memory E2E";
    } else {
      response = "ACK";
    }

    yield { type: "text_delta", text: response };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  getModel(): string {
    return "memory-e2e-model";
  }

  setModel(): void {}
}

let db: Database;
let fileMemory: FileMemoryManager;
let vectorStore: VectorStore;
let memoryIndexer: MemoryIndexer;
let memoryRetriever: MemoryRetriever;
let memoryManager: MemoryManager;
let flushCoordinator: MemoryFlushCoordinator;
let router: SessionRouter;
let llm: RoutingLLM;
let embedding: DeterministicEmbedding;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  db = new Database(join(TMP, "little_claw.db"));
  fileMemory = new FileMemoryManager(TMP);
  await fileMemory.initialize();
  embedding = new DeterministicEmbedding();
  llm = new RoutingLLM();
  vectorStore = new VectorStore(join(TMP, "legacy-memory.db"), embedding);
  memoryIndexer = new MemoryIndexer(db, embedding, fileMemory.getMemoryStore());
  memoryRetriever = new MemoryRetriever(db, embedding);
  flushCoordinator = new MemoryFlushCoordinator(
    db,
    llm,
    fileMemory.getMemoryStore(),
    new LongTermMemoryExtractor(fileMemory.getMemoryStore(), llm),
    memoryIndexer,
    fixedClock,
  );
  memoryManager = new MemoryManager(
    vectorStore,
    llm,
    db,
    fileMemory,
    memoryIndexer,
    memoryRetriever,
    flushCoordinator,
  );
  router = new SessionRouter({
    db,
    llmProvider: llm,
    toolRegistry: new ToolRegistry(),
    memoryManager,
    cleanupIntervalMs: 60_000,
  });
});

afterEach(async () => {
  router.dispose();
  await memoryManager.drainFlushes();
  await memoryIndexer.drain();
  vectorStore.close();
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("Memory / Context consistency E2E", () => {
  test("chat interval, cursors, switch, shutdown, Markdown indexing and search stay consistent", async () => {
    const session = db.createSession("Memory E2E system prompt");

    for (let round = 1; round <= 5; round++) {
      await router.handleChat(
        session.id,
        `FIRST-BATCH-20260712 round ${round}. ` +
          (round === 1
            ? "Please remember LC-DURABLE-20260712 and that I prefer Chinese manual-test reports."
            : "Reply ACK."),
        () => {},
      );
    }
    await drainMemoryPipeline();

    let daily = await fileMemory.readFile("daily/2026-07-12.md");
    expect(daily).toContain("FIRST-BATCH-20260712");
    expect(daily?.match(/little-claw:daily-flush/g)).toHaveLength(1);
    expect(await fileMemory.readIdentity()).toContain("LC-DURABLE-20260712");
    expect(llm.summaryInputs).toHaveLength(1);
    expect(llm.longTermInputs).toHaveLength(1);

    let state = db.getMemoryFlushState(session.id);
    expect(state.dailyCursorMessageId).not.toBeNull();
    expect(state.longTermCursorMessageId).not.toBeNull();

    for (let round = 1; round <= 5; round++) {
      await router.handleChat(
        session.id,
        `SECOND-BATCH-20260712 round ${round}. Reply ACK.`,
        () => {},
      );
    }
    await drainMemoryPipeline();

    daily = await fileMemory.readFile("daily/2026-07-12.md");
    expect(daily?.match(/little-claw:daily-flush/g)).toHaveLength(2);
    expect(daily).toContain("SECOND-BATCH-20260712");
    expect(llm.summaryInputs).toHaveLength(2);
    expect(llm.summaryInputs[1]).toContain("SECOND-BATCH-20260712");
    expect(llm.summaryInputs[1]).not.toContain("FIRST-BATCH-20260712");

    const markerCountBeforeLifecycleFlushes = countDailyMarkers(daily);
    router.saveMemoryForSession(session.id);
    await memoryManager.drainFlushes();
    await router.saveAllMemories();
    await drainMemoryPipeline();
    daily = await fileMemory.readFile("daily/2026-07-12.md");
    expect(countDailyMarkers(daily)).toBe(markerCountBeforeLifecycleFlushes);

    const durableResults = await memoryRetriever.retrieve("LC-DURABLE-20260712", {
      topK: 5,
      maxPerSource: 1,
    });
    expect(durableResults.some(result => result.sourcePath === "MEMORY.md")).toBe(true);
    const secondBatchResults = await memoryRetriever.retrieve("SECOND-BATCH-20260712", 5);
    expect(secondBatchResults.some(result => result.sourcePath === "daily/2026-07-12.md"))
      .toBe(true);

    const logFiles = (await fileMemory.listLogFiles()).filter(path => path.endsWith(".jsonl"));
    expect(logFiles.length).toBeGreaterThan(0);
    const rawLog = (await Promise.all(logFiles.map(path => Bun.file(path).text()))).join("\n");
    expect(rawLog).toContain("FIRST-BATCH-20260712");
    expect(rawLog).toContain("SECOND-BATCH-20260712");

    state = db.getMemoryFlushState(session.id);
    expect(db.getMessagesAfter(session.id, state.dailyCursorMessageId)).toEqual([]);
    expect(db.getMessagesAfter(session.id, state.longTermCursorMessageId)).toEqual([]);
  });

  test("idle cleanup force-flushes a session that has fewer than five turns", async () => {
    router.dispose();
    router = new SessionRouter({
      db,
      llmProvider: llm,
      toolRegistry: new ToolRegistry(),
      memoryManager,
      idleTimeoutMs: 0,
      cleanupIntervalMs: 5,
    });
    const session = db.createSession("Idle E2E");
    await router.handleChat(session.id, "IDLE-FLUSH-20260712 one turn only.", () => {});

    await Bun.sleep(30);
    await drainMemoryPipeline();
    const daily = await fileMemory.readFile("daily/2026-07-12.md");
    expect(daily).toContain("IDLE-FLUSH-20260712");
    expect(daily).toContain("- Trigger: idle");
    expect(db.getMemoryFlushState(session.id).dailyCursorMessageId).not.toBeNull();
  });

  test("changed Markdown stays searchable with BM25 when embeddings fail, then rebuild recovers", async () => {
    await fileMemory.writeFile(
      "MEMORY.md",
      "# Memory\n\n- Stable fact that must retain its old vector.",
    );
    await memoryIndexer.reindexFile("MEMORY.md");
    const stableRows = db.getMemoryIndexBySourcePath("MEMORY.md");

    const degradedIndexer = new MemoryIndexer(db, new ThrowingEmbedding(), fileMemory.getMemoryStore());
    const unchangedReport = await degradedIndexer.reindexFile("MEMORY.md");
    expect(unchangedReport.providerFailed).toBe(true);
    expect(db.getMemoryIndexBySourcePath("MEMORY.md")).toEqual(stableRows);

    await fileMemory.appendToFile(
      "inbox.md",
      "\nBM25-DEGRADED-20260712 embedding outage test.",
    );
    const degradedReport = await degradedIndexer.reindexFile("inbox.md");
    expect(degradedReport.providerFailed).toBe(true);
    expect(db.getMemoryIndexBySourcePath("inbox.md").every(row =>
      row.embedding_status === "missing" && row.embedding_dimensions === 0
    )).toBe(true);

    const degradedRetriever = new MemoryRetriever(db, new ThrowingEmbedding());
    const bm25Results = await degradedRetriever.retrieve("BM25-DEGRADED-20260712", 5);
    expect(bm25Results[0]?.sourcePath).toBe("inbox.md");
    expect(bm25Results[0]?.bm25Score).toBeGreaterThan(0);

    const recoveryReport = await memoryIndexer.rebuildAll();
    expect(recoveryReport.providerFailed).toBe(false);
    expect(db.getAllMemoryIndex().every(row => row.embedding_status === "ready")).toBe(true);
    const recoveredResults = await memoryRetriever.retrieve("BM25-DEGRADED-20260712", 5);
    expect(recoveredResults[0]?.sourcePath).toBe("inbox.md");
  });

  test("context overview rebuild and retrieval reflect the latest Markdown", async () => {
    const contextHub: ContextHub = fileMemory.getContextHub();
    await contextHub.writeFile(
      "3-projects/e2e-project/.overview.md",
      "# E2E Project\n\nCONTEXT-FIRST-20260712",
      "overwrite",
    );
    const contextIndexer = new ContextIndexer(db, embedding, contextHub);
    const contextRetriever = new ContextRetriever(db, embedding);
    await contextIndexer.rebuildAll();

    let results = await contextRetriever.retrieve("CONTEXT-FIRST-20260712", 5);
    expect(results[0]?.dirPath).toBe("3-projects/e2e-project");

    await contextHub.writeFile(
      "3-projects/e2e-project/.overview.md",
      "# E2E Project\n\nCONTEXT-SECOND-20260712",
      "overwrite",
    );
    await contextIndexer.reindexDir("3-projects/e2e-project");
    results = await contextRetriever.retrieve("CONTEXT-SECOND-20260712", 5);
    expect(results[0]?.dirPath).toBe("3-projects/e2e-project");
    expect(results[0]?.overviewContent).toContain("CONTEXT-SECOND-20260712");
    expect(results[0]?.overviewContent).not.toContain("CONTEXT-FIRST-20260712");
  });

  test("AgentWorker uses one custom project context path for prompt, writes and terminal archive", async () => {
    const messages = new TeamMessageStore(db);
    const tasks = new TaskQueue(db);
    const channels = new ProjectChannelStore(db, messages);
    const channel = channels.createChannel({
      slug: "demo",
      title: "Demo",
      contextPath: "context-hub/3-projects/custom-demo",
    });
    const contextHub = fileMemory.getContextHub();
    await contextHub.writeFile(
      "3-projects/custom-demo/.overview.md",
      "# Custom Demo\n\nCustom project overview.",
      "overwrite",
    );
    await contextHub.writeFile(
      "3-projects/custom-demo/status.md",
      "# Custom Demo Status",
      "overwrite",
    );

    const tools = new ToolRegistry();
    tools.register(projectWriteTool(TMP));
    const workerLLM = new ProjectWorkerLLM();
    const worker = new AgentWorker({
      agent: testAgent("coder", ["write_file"]),
      tasks,
      messages,
      projectChannels: channels,
      db,
      llmProvider: workerLLM,
      toolRegistry: tools,
      memoryManager,
      contextHub,
      maxTurns: 3,
    });
    const task = tasks.createTask({
      title: "Write custom project result",
      description: "Create result.md in the resolved project workspace.",
      createdBy: "human",
      assignedTo: "coder",
      project: "demo",
      channelId: channel.id,
    });

    await worker.tick();
    await drainMemoryPipeline();

    expect(tasks.getTask(task.id)?.status).toBe("completed");
    expect(workerLLM.firstSystem).toContain("context-hub/3-projects/custom-demo");
    expect(workerLLM.firstUserInput).toContain(
      "project_workspace: context-hub/3-projects/custom-demo",
    );
    expect(await Bun.file(join(
      TMP,
      "context-hub/3-projects/custom-demo/result.md",
    )).exists()).toBe(true);
    expect(await Bun.file(join(
      TMP,
      "context-hub/3-projects/demo/result.md",
    )).exists()).toBe(false);
    const status = await contextHub.readFile("3-projects/custom-demo/status.md");
    expect(status).toContain("Project task completed through custom context path.");
  });
});

async function drainMemoryPipeline(): Promise<void> {
  await memoryManager.drainFlushes();
  await memoryIndexer.drain();
}

function countDailyMarkers(content: string | null): number {
  return content?.match(/little-claw:daily-flush/g)?.length ?? 0;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(block => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use") return `[tool:${block.name}]`;
    return block.content;
  }).join("\n");
}

class ProjectWorkerLLM implements LLMProvider {
  private mainCalls = 0;
  firstSystem = "";
  firstUserInput = "";

  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.mainCalls++;
    if (this.mainCalls === 1) {
      this.firstSystem = options?.system ?? "";
      this.firstUserInput = messageText(messages[0]!);
      yield { type: "tool_use_start", id: "write-1", name: "write_file" };
      yield {
        type: "tool_use_delta",
        input_json: JSON.stringify({
          path: "result.md",
          content: "custom project output",
        }),
      };
      yield { type: "tool_use_end" };
      yield {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      return;
    }

    yield {
      type: "text_delta",
      text: "Project task completed through custom context path.",
    };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  getModel(): string {
    return "project-worker-e2e";
  }

  setModel(): void {}
}

function projectWriteTool(baseDir: string): Tool {
  return {
    name: "write_file",
    description: "Write a project file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async execute(params) {
      const path = String(params.path);
      await Bun.write(join(baseDir, path), String(params.content));
      return { success: true, output: `wrote ${path}` };
    },
  };
}

function testAgent(name: string, tools: string[]): RegisteredAgent {
  return {
    config: {
      name,
      display_name: name,
      role: "E2E worker",
      status: "active",
      aliases: [],
      direct_message: true,
      tools,
      skills: [],
      task_tags: ["code"],
      cron_jobs: [],
      requires_approval: [],
      approval_rules: [],
      max_concurrent_tasks: 1,
      max_tokens_per_task: 10_000,
      timeout_minutes: 1,
    },
    soul: "# Soul\nE2E worker.",
    operatingInstructions: "# Instructions\nWrite the requested project file.",
    currentTasks: [],
    status: "idle",
  };
}
