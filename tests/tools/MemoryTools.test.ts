import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/db/Database";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider";
import { FileMemoryManager } from "../../src/memory/FileMemoryManager";
import { MemoryIndexer } from "../../src/memory/MemoryIndexer";
import { createContextReadTool } from "../../src/tools/builtin/ContextReadTool";
import { createContextWriteTool } from "../../src/tools/builtin/ContextWriteTool";
import { createMemoryReadTool } from "../../src/tools/builtin/MemoryReadTool";
import { createMemoryWriteTool } from "../../src/tools/builtin/MemoryWriteTool";

const TMP = "/tmp/little_claw_memory_tools_test";

class FakeEmbeddingProvider implements EmbeddingProvider {
  getSignature(): string {
    return "fake:v1";
  }

  async embed(text: string): Promise<number[]> {
    return [text.length, 1];
  }
}

let fileMemory: FileMemoryManager;
let db: Database;
let indexer: MemoryIndexer;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  fileMemory = new FileMemoryManager(TMP);
  await fileMemory.initialize();
  db = new Database(join(TMP, "test.db"));
  indexer = new MemoryIndexer(db, new FakeEmbeddingProvider(), fileMemory.getMemoryStore());
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test("memory_write updates the memory index after a changed write", async () => {
  const tool = createMemoryWriteTool(fileMemory, indexer);

  const result = await tool.execute({
    file: "memory/inbox.md",
    content: "- remember the blue notebook",
    mode: "append",
  });

  expect(result.success).toBe(true);
  expect(db.getMemoryIndexBySourcePath("inbox.md")[0]?.content).toContain("blue notebook");
});

test("memory_read rejects context-hub paths and context_read rejects memory paths", async () => {
  const memoryRead = createMemoryReadTool(fileMemory);
  const contextRead = createContextReadTool(fileMemory);

  const memoryResult = await memoryRead.execute({ file: "context-hub/3-projects/demo/status.md" });
  const contextResult = await contextRead.execute({ file: "memory/MEMORY.md" });

  expect(memoryResult.success).toBe(false);
  expect(memoryResult.error).toContain("context_read");
  expect(contextResult.success).toBe(false);
  expect(contextResult.error).toContain("memory_read");
});

test("context_write rejects deprecated identity and inbox paths", async () => {
  const tool = createContextWriteTool(fileMemory);

  const identity = await tool.execute({
    path: "0-identity/profile.md",
    content: "x",
  });
  const inbox = await tool.execute({
    path: "context-hub/1-inbox/inbox.md",
    content: "x",
  });

  expect(identity.success).toBe(false);
  expect(identity.error).toContain("deprecated");
  expect(inbox.success).toBe(false);
  expect(inbox.error).toContain("deprecated");
});
