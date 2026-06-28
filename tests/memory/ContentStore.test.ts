import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ContentStore } from "../../src/memory/ContentStore.ts";

const TMP = "/tmp/little_claw_content_store_test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("ContentStore reuses hash refs and merges source metadata", async () => {
  const store = new ContentStore(TMP);

  const first = await store.storeText({
    sourceTool: "web_fetch",
    sourceUri: "https://example.com/a",
    title: "Same Content",
    content: "same content body",
  });
  const second = await store.storeText({
    sourceTool: "web_fetch",
    sourceUri: "https://example.com/b",
    title: "Same Content",
    content: "same content body",
  });

  expect(second.ref_id).toBe(first.ref_id);

  const meta = JSON.parse(await Bun.file(join(TMP, "content-refs", `${first.ref_id}.meta.json`)).text());
  expect(meta.metadata.sources).toContain("https://example.com/a");
  expect(meta.metadata.sources).toContain("https://example.com/b");
});

test("ContentStore cleanupExpired skips project refs unless explicitly included", async () => {
  const store = new ContentStore(TMP);
  const temporary = await store.storeText({
    sourceTool: "web_fetch",
    sourceUri: "https://example.com/temp",
    title: "Temp",
    content: "temporary content",
  });
  const project = await store.storeText({
    sourceTool: "web_fetch",
    sourceUri: "https://example.com/project",
    title: "Project",
    content: "project content",
    projectContextPath: "context-hub/3-projects/demo",
  });

  const db = new SQLiteDatabase(join(TMP, "content-store.sqlite"));
  db.run("UPDATE content_refs SET expires_at = '2026-01-01T00:00:00.000Z'");
  db.close();

  const firstCleanup = store.cleanupExpired({ now: new Date("2026-01-02T00:00:00.000Z") });
  expect(firstCleanup.deletedRefs).toBe(1);
  expect(existsSync(join(TMP, "content-refs", `${temporary.ref_id}.txt`))).toBe(false);
  expect(existsSync(join(TMP, "content-refs", `${temporary.ref_id}.meta.json`))).toBe(false);
  expect(existsSync(join(
    TMP,
    "context-hub",
    "3-projects",
    "demo",
    "content-refs",
    `${project.ref_id}.txt`,
  ))).toBe(true);

  const secondCleanup = store.cleanupExpired({
    now: new Date("2026-01-02T00:00:00.000Z"),
    includeProjectRefs: true,
  });
  expect(secondCleanup.deletedRefs).toBe(1);
  expect(existsSync(join(
    TMP,
    "context-hub",
    "3-projects",
    "demo",
    "content-refs",
    `${project.ref_id}.txt`,
  ))).toBe(false);
});

