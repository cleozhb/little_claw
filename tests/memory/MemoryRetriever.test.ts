import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database, type MemoryIndexRow } from "../../src/db/Database.ts";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { MemoryRetriever } from "../../src/memory/MemoryRetriever.ts";

const TMP = "/tmp/little_claw_memory_retriever_test";

class QueryEmbedding implements EmbeddingProvider {
  getSignature(): string { return "current:v1"; }
  async embed(): Promise<number[]> { return [1, 0]; }
}

let db: Database;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  db = new Database(join(TMP, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

function row(overrides: Partial<MemoryIndexRow>): MemoryIndexRow {
  return {
    id: "MEMORY.md#0",
    source_path: "MEMORY.md",
    source_kind: "memory",
    chunk_index: 0,
    content: "User has a peanut allergy",
    file_hash: "file",
    chunk_hash: "chunk",
    keywords: "user peanut allergy",
    embedding: "[]",
    embedding_signature: "",
    embedding_dimensions: 0,
    embedding_status: "missing",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

test("returns highly relevant BM25-only memory", async () => {
  db.upsertMemoryIndex(row({}));
  const results = await new MemoryRetriever(db, new QueryEmbedding()).retrieve("peanut allergy");
  expect(results[0]?.sourcePath).toBe("MEMORY.md");
  expect(results[0]?.embeddingStatus).toBe("missing");
  expect(results[0]?.bm25Score).toBeGreaterThan(0);
});

test("does not use vectors from a different embedding signature", async () => {
  db.upsertMemoryIndex(row({
    content: "unrelated text",
    keywords: "unrelated text",
    embedding: "[1,0]",
    embedding_signature: "old:v1",
    embedding_dimensions: 2,
    embedding_status: "ready",
  }));
  const results = await new MemoryRetriever(db, new QueryEmbedding()).retrieve("nothing matches");
  expect(results).toEqual([]);
});

test("drops vector-only candidates below the relevance threshold", async () => {
  db.upsertMemoryIndex(row({
    content: "unrelated text",
    keywords: "unrelated text",
    embedding: "[0,1]",
    embedding_signature: "current:v1",
    embedding_dimensions: 2,
    embedding_status: "ready",
  }));
  const results = await new MemoryRetriever(db, new QueryEmbedding()).retrieve("nothing matches");
  expect(results).toEqual([]);
});
