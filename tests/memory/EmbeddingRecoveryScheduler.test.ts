import { expect, test } from "bun:test";
import { EmbeddingRecoveryScheduler } from "../../src/memory/EmbeddingRecoveryScheduler.ts";
import type { MemoryIndexer, MemoryIndexRunResult } from "../../src/memory/MemoryIndexer.ts";
import type { ContextIndexer, ContextIndexRunResult } from "../../src/memory/ContextIndexer.ts";

class FakeMemoryIndexer {
  calls = 0;
  handler?: () => void;
  onProviderFailure(handler: () => void): void { this.handler = handler; }
  async indexAll(): Promise<MemoryIndexRunResult> {
    this.calls++;
    return this.calls === 1
      ? { indexed: 0, skipped: 0, missingEmbeddings: 1, providerFailed: true }
      : { indexed: 1, skipped: 0, missingEmbeddings: 0, providerFailed: false };
  }
}

class FakeContextIndexer {
  calls = 0;
  handler?: () => void;
  onProviderFailure(handler: () => void): void { this.handler = handler; }
  async indexAll(): Promise<ContextIndexRunResult> {
    this.calls++;
    return this.calls === 1
      ? { indexed: 0, skipped: 0, missingEmbeddings: 1, providerFailed: true }
      : { indexed: 1, skipped: 0, missingEmbeddings: 0, providerFailed: false };
  }
}

test("retries degraded embedding indexes and stops after recovery", async () => {
  const memory = new FakeMemoryIndexer();
  const context = new FakeContextIndexer();
  const scheduler = new EmbeddingRecoveryScheduler(
    memory as unknown as MemoryIndexer,
    context as unknown as ContextIndexer,
    [0, 0, 0],
  );

  memory.handler?.();
  await Bun.sleep(30);
  await scheduler.stop();
  expect(memory.calls).toBe(2);
  expect(context.calls).toBe(2);
});
