import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/db/Database";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider";
import { MemoryIndexer } from "../../src/memory/MemoryIndexer";
import { MemoryRetriever } from "../../src/memory/MemoryRetriever";
import { MemoryStore } from "../../src/memory/MemoryStore";

const TMP = "/tmp/little_claw_memory_indexer_test";

class FakeEmbeddingProvider implements EmbeddingProvider {
  calls = 0;
  signature = "fake:v1";

  getSignature(): string {
    return this.signature;
  }

  async embed(text: string): Promise<number[]> {
    this.calls++;
    return [text.length % 10, text.includes("peanut") ? 1 : 0, 1];
  }
}

class ThrowingEmbeddingProvider implements EmbeddingProvider {
  getSignature(): string {
    return "down:v1";
  }

  async embed(): Promise<number[]> {
    throw new Error("embedding down");
  }
}

class PartialEmbeddingProvider implements EmbeddingProvider {
  calls = 0;
  getSignature(): string { return "partial:v1"; }
  async embed(): Promise<number[]> {
    this.calls++;
    if (this.calls === 2) throw new Error("second chunk failed");
    return [1, 0, 1];
  }
}

class DimensionAwareEmbeddingProvider implements EmbeddingProvider {
  dimensions: number | null = null;
  getSignature(): string { return `dynamic:dimensions=${this.dimensions ?? "unknown"}`; }
  async embed(): Promise<number[]> {
    this.dimensions = 3;
    return [1, 2, 3];
  }
}

let db: Database;
let store: MemoryStore;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  db = new Database(join(TMP, "test.db"));
  store = new MemoryStore(TMP);
  await store.initialize();
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test("indexes memory Markdown files and skips unchanged content", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\n- Likes peanut noodles.", "overwrite");
  await store.writeMemory("daily/2026-07-11.md", "# Daily\n\nFixed memory index.", "overwrite");
  const embedding = new FakeEmbeddingProvider();
  const indexer = new MemoryIndexer(db, embedding, store);

  await indexer.indexAll();
  const firstCallCount = embedding.calls;
  expect(db.getMemoryIndexCount()).toBeGreaterThanOrEqual(2);

  await indexer.indexAll();
  expect(embedding.calls).toBe(firstCallCount);
});

test("records the provider signature after discovering actual embedding dimensions", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\nDimension fact.", "overwrite");
  const indexer = new MemoryIndexer(db, new DimensionAwareEmbeddingProvider(), store);
  await indexer.reindexFile("MEMORY.md");
  expect(db.getMemoryIndexBySourcePath("MEMORY.md")[0]?.embedding_signature)
    .toBe("dynamic:dimensions=3");
});

test("reindexes when embedding signature changes", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\n- Likes peanut noodles.", "overwrite");
  const embedding = new FakeEmbeddingProvider();
  const indexer = new MemoryIndexer(db, embedding, store);

  await indexer.indexAll();
  const firstCallCount = embedding.calls;
  embedding.signature = "fake:v2";
  await indexer.indexAll();

  expect(embedding.calls).toBeGreaterThan(firstCallCount);
  expect(db.getAllMemoryIndex().every((row) => row.embedding_signature === "fake:v2")).toBe(true);
});

test("fills missing embeddings even when their stored signature is current", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\n- Durable fact.", "overwrite");
  const embedding = new FakeEmbeddingProvider();
  const indexer = new MemoryIndexer(db, embedding, store);
  await indexer.reindexFile("MEMORY.md");
  for (const existing of db.getMemoryIndexBySourcePath("MEMORY.md")) {
    db.upsertMemoryIndex({
      ...existing,
      embedding: "[]",
      embedding_dimensions: 0,
      embedding_status: "missing",
    });
  }
  const before = embedding.calls;

  await indexer.reindexFile("MEMORY.md");
  expect(embedding.calls).toBeGreaterThan(before);
  expect(db.getMemoryIndexBySourcePath("MEMORY.md").every((row) => row.embedding_status === "ready")).toBe(true);
});

test("falls back to BM25 search when embedding provider is unavailable", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\n- User is allergic to peanut dust.", "overwrite");
  const indexer = new MemoryIndexer(db, new ThrowingEmbeddingProvider(), store);
  await indexer.indexAll();

  const rows = db.getAllMemoryIndex();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.embedding_signature === "")).toBe(true);

  const retriever = new MemoryRetriever(db, new ThrowingEmbeddingProvider());
  const results = await retriever.retrieve("peanut allergy", 3);

  expect(results[0]?.sourcePath).toBe("MEMORY.md");
  expect(results[0]?.bm25Score).toBeGreaterThan(0);
});

test("preserves unchanged old rows when a new embedding signature is unavailable", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\nStable fact.", "overwrite");
  const ready = new MemoryIndexer(db, new FakeEmbeddingProvider(), store);
  await ready.reindexFile("MEMORY.md");
  const before = db.getMemoryIndexBySourcePath("MEMORY.md");

  const degraded = new MemoryIndexer(db, new ThrowingEmbeddingProvider(), store);
  const report = await degraded.reindexFile("MEMORY.md");
  const after = db.getMemoryIndexBySourcePath("MEMORY.md");

  expect(report.providerFailed).toBe(true);
  expect(after).toEqual(before);
});

test("replaces changed content with one complete BM25-only file state", async () => {
  await store.writeMemory("MEMORY.md", "# Memory\n\nOld fact.", "overwrite");
  await new MemoryIndexer(db, new FakeEmbeddingProvider(), store).reindexFile("MEMORY.md");
  await store.writeMemory("MEMORY.md", "# Memory\n\nNew searchable peanut fact.", "overwrite");

  await new MemoryIndexer(db, new ThrowingEmbeddingProvider(), store).reindexFile("MEMORY.md");
  const rows = db.getMemoryIndexBySourcePath("MEMORY.md");
  expect(rows.every((row) => row.embedding_status === "missing")).toBe(true);
  expect(rows.map((row) => row.content).join("\n")).toContain("New searchable peanut fact");
  expect(rows.map((row) => row.content).join("\n")).not.toContain("Old fact");
});

test("makes every chunk BM25-only when any chunk embedding fails", async () => {
  const longContent = `# Daily\n\n${"alpha ".repeat(400)}\n\n${"beta ".repeat(400)}`;
  await store.writeMemory("daily/2026-07-11.md", longContent, "overwrite");
  const indexer = new MemoryIndexer(db, new PartialEmbeddingProvider(), store);

  await indexer.reindexFile("daily/2026-07-11.md");
  const rows = db.getMemoryIndexBySourcePath("daily/2026-07-11.md");
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every((row) => row.embedding_status === "missing")).toBe(true);
});
