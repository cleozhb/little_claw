import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { SessionRouter } from "../../src/gateway/SessionRouter.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";

const TEST_DB = "/tmp/little_claw_session_router_test.db";

let db: Database;
let agentDir: string;

beforeEach(() => {
  cleanupDb();
  db = new Database(TEST_DB);
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-session-router-agents-"));
});

afterEach(() => {
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
  cleanupDb();
});

describe("SessionRouter", () => {
  test("uses configured registry agent as the chat main agent", async () => {
    const registry = new AgentRegistry(agentDir);
    registry.create("assistant", {
      config: {
        name: "assistant",
        role: "Direct chat assistant",
        tools: [],
      },
      soul: "# Soul\nAssistant soul marker.\n",
      operatingInstructions: "# Agent Operating Instructions\nAssistant process marker.\n",
    });
    registry.loadAll();

    let capturedSystem = "";
    let capturedMainCall = false;
    const llmProvider: LLMProvider = {
      async *chat(_messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
        if (!capturedMainCall) {
          capturedSystem = options?.system ?? "";
          capturedMainCall = true;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      getModel() {
        return "session-router-test-model";
      },
      setModel() {},
    };

    const session = db.createSession();
    const router = new SessionRouter({
      db,
      llmProvider,
      toolRegistry: new ToolRegistry(),
      getAgentRegistry: () => registry,
      mainAgentName: "assistant",
      cleanupIntervalMs: 60_000,
    });

    await router.handleChat(session.id, "hello", () => {});
    router.dispose();

    expect(capturedSystem).toContain("Assistant soul marker");
    expect(capturedSystem).toContain("Assistant process marker");
  });
});

function cleanupDb(): void {
  for (const path of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
