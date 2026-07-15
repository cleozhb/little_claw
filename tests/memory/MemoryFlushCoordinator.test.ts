import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";
import type { AppClock } from "../../src/utils/AppClock.ts";
import { LongTermMemoryExtractor } from "../../src/memory/LongTermMemoryExtractor.ts";
import { MemoryFlushCoordinator } from "../../src/memory/MemoryFlushCoordinator.ts";
import { MemoryStore } from "../../src/memory/MemoryStore.ts";

const TMP = "/tmp/little_claw_memory_flush_test";

class RecordingLLM implements LLMProvider {
  calls: Message[][] = [];
  constructor(private responses: string[]) {}
  async *chat(messages: Message[]): AsyncGenerator<StreamEvent> {
    this.calls.push(messages);
    yield { type: "text_delta", text: this.responses.shift() ?? "summary" };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class ThrowingLLM implements LLMProvider {
  async *chat(): AsyncGenerator<StreamEvent> {
    throw new Error("LLM unavailable");
  }
}

const fixedClock: AppClock = {
  now: () => new Date("2026-07-10T16:30:00.000Z"),
  formatDate: () => "2026-07-11",
  formatTime: () => "00:30",
};

let db: Database;
let store: MemoryStore;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  db = new Database(join(TMP, "test.db"));
  store = new MemoryStore(TMP, fixedClock);
  await store.initialize();
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

function addTurn(sessionId: string, index: number): void {
  db.addMessage(sessionId, "user", `user-${index}`);
  db.addMessage(sessionId, "assistant", [{ type: "text", text: `assistant-${index}` }]);
}

test("processes only cursor-new messages every five completed assistant turns", async () => {
  const session = db.createSession("system");
  const summaries = new RecordingLLM(["first summary", "second summary"]);
  const coordinator = new MemoryFlushCoordinator(db, summaries, store, undefined, undefined, fixedClock);

  for (let index = 1; index <= 4; index++) addTurn(session.id, index);
  expect((await coordinator.flushSession(session.id, { reason: "interval" })).daily.status).toBe("skipped");
  expect(summaries.calls).toHaveLength(0);

  addTurn(session.id, 5);
  expect((await coordinator.flushSession(session.id, { reason: "interval" })).daily.status).toBe("written");
  for (let index = 6; index <= 10; index++) addTurn(session.id, index);
  expect((await coordinator.flushSession(session.id, { reason: "interval" })).daily.status).toBe("written");

  expect(summaries.calls).toHaveLength(2);
  const secondInput = JSON.stringify(summaries.calls[1]);
  expect(secondInput).toContain("user-6");
  expect(secondInput).not.toContain("user-5");
  const daily = (await store.readMemory("daily/2026-07-11.md")) ?? "";
  expect(daily.match(/little-claw:daily-flush/g)).toHaveLength(2);

  expect((await coordinator.flushSession(session.id, {
    reason: "session_switch",
    force: true,
  })).daily.status).toBe("skipped");
  expect((await store.readMemory("daily/2026-07-11.md"))?.match(/little-claw:daily-flush/g)).toHaveLength(2);
});

test("advances daily independently while retrying failed long-term extraction", async () => {
  const session = db.createSession("system");
  addTurn(session.id, 1);
  const failingExtractor = new LongTermMemoryExtractor(store, new ThrowingLLM());
  const first = new MemoryFlushCoordinator(
    db,
    new RecordingLLM(["daily summary"]),
    store,
    failingExtractor,
    undefined,
    fixedClock,
  );

  const failed = await first.flushSession(session.id, { reason: "execution_end", force: true });
  expect(failed.daily.status).toBe("written");
  expect(failed.longTerm.status).toBe("failed");
  let state = db.getMemoryFlushState(session.id);
  expect(state.dailyCursorMessageId).not.toBeNull();
  expect(state.longTermCursorMessageId).toBeNull();

  const retryExtractor = new LongTermMemoryExtractor(store, new RecordingLLM(["NONE"]));
  const retry = new MemoryFlushCoordinator(
    db,
    new RecordingLLM([]),
    store,
    retryExtractor,
    undefined,
    fixedClock,
  );
  const retried = await retry.flushSession(session.id, { reason: "shutdown", force: true });
  expect(retried.daily.status).toBe("skipped");
  expect(retried.longTerm.status).toBe("no_candidate");
  state = db.getMemoryFlushState(session.id);
  expect(state.longTermCursorMessageId).toBe(state.dailyCursorMessageId);
});
