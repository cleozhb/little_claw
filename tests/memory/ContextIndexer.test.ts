import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { ContextHub } from "../../src/memory/ContextHub.ts";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { ContextIndexer } from "../../src/memory/ContextIndexer.ts";

const TMP = "/tmp/little_claw_context_indexer_test";

class FakeEmbedding implements EmbeddingProvider {
  calls = 0;
  signature = "context:v1";
  fail = false;
  getSignature(): string { return this.signature; }
  async embed(text: string): Promise<number[]> {
    this.calls++;
    if (this.fail) throw new Error("provider down");
    return [text.length, 1, 0];
  }
}

let db: Database;
let hub: ContextHub;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  db = new Database(join(TMP, "test.db"));
  hub = new ContextHub(TMP);
  await hub.initialize();
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test("reindexDir skips unchanged overview content and embedding signature", async () => {
  const embedding = new FakeEmbedding();
  const indexer = new ContextIndexer(db, embedding, hub);
  await indexer.indexAll();
  const calls = embedding.calls;
  const before = db.getAllContextIndex().find((row) => row.dir_path === "3-projects")!;

  const report = await indexer.reindexDir("3-projects");
  const after = db.getAllContextIndex().find((row) => row.dir_path === "3-projects")!;
  expect(report.skipped).toBe(1);
  expect(embedding.calls).toBe(calls);
  expect(after.updated_at).toBe(before.updated_at);
});

test("keeps unchanged old context vectors when the provider fails", async () => {
  const embedding = new FakeEmbedding();
  const indexer = new ContextIndexer(db, embedding, hub);
  await indexer.indexAll();
  const before = db.getAllContextIndex().find((row) => row.dir_path === "3-projects")!;
  embedding.signature = "context:v2";
  embedding.fail = true;

  const report = await indexer.reindexDir("3-projects");
  const after = db.getAllContextIndex().find((row) => row.dir_path === "3-projects")!;
  expect(report.providerFailed).toBe(true);
  expect(after).toEqual(before);
});

test("removes stale directory rows during indexAll", async () => {
  await hub.writeFile("3-projects/demo/.overview.md", "# Demo", "overwrite");
  const indexer = new ContextIndexer(db, new FakeEmbedding(), hub);
  await indexer.indexAll();
  expect(db.getAllContextIndex().some((row) => row.dir_path === "3-projects/demo")).toBe(true);

  rmSync(join(TMP, "context-hub", "3-projects", "demo"), { recursive: true, force: true });
  await indexer.indexAll();
  expect(db.getAllContextIndex().some((row) => row.dir_path === "3-projects/demo")).toBe(false);
});
