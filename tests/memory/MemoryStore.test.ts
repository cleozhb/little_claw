import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/MemoryStore";

const TMP = "/tmp/little_claw_memory_store_test";

let store: MemoryStore;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  store = new MemoryStore(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("initializes memory and logs directory structure", async () => {
  await store.initialize();

  expect(existsSync(join(TMP, "memory", "MEMORY.md"))).toBe(true);
  expect(existsSync(join(TMP, "memory", "inbox.md"))).toBe(true);
  expect(existsSync(join(TMP, "memory", "daily"))).toBe(true);
  expect(existsSync(join(TMP, "logs", "conversations"))).toBe(true);
});

test("migrates legacy identity, inbox, daily notes, and jsonl logs by copy", async () => {
  mkdirSync(join(TMP, "context-hub", "0-identity"), { recursive: true });
  mkdirSync(join(TMP, "context-hub", "1-inbox"), { recursive: true });
  mkdirSync(join(TMP, "memory"), { recursive: true });
  writeFileSync(join(TMP, "context-hub", "0-identity", "profile.md"), "# Profile\nLegacy profile\n");
  writeFileSync(join(TMP, "context-hub", "1-inbox", "inbox.md"), "# Inbox\nLegacy inbox\n");
  writeFileSync(join(TMP, "memory", "2026-07-11.md"), "# Old daily\n");
  writeFileSync(join(TMP, "memory", "2026-07-11.jsonl"), "{\"role\":\"user\"}\n");

  await store.initialize();

  expect(readFileSync(join(TMP, "memory", "MEMORY.md"), "utf8")).toContain("Legacy profile");
  expect(readFileSync(join(TMP, "memory", "inbox.md"), "utf8")).toContain("Legacy inbox");
  expect(readFileSync(join(TMP, "memory", "daily", "2026-07-11.md"), "utf8")).toContain("Old daily");
  expect(readFileSync(join(TMP, "logs", "conversations", "2026-07-11.jsonl"), "utf8")).toContain("user");

  expect(existsSync(join(TMP, "context-hub", "0-identity", "profile.md"))).toBe(true);
  expect(existsSync(join(TMP, "memory", "2026-07-11.md"))).toBe(true);
});

test("rejects context-hub paths through memory reads and writes", async () => {
  await store.initialize();

  await expect(store.readMemory("context-hub/3-projects/demo/status.md")).rejects.toThrow(/context_read/);
  await expect(store.writeMemory("../escape.md", "x")).rejects.toThrow(/traversal/);
});

test("serializes concurrent appends without losing entries", async () => {
  await store.initialize();
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      store.writeMemory("daily/2026-07-11.md", `entry-${index}\n`, "append")
    ),
  );

  const content = await store.readMemory("daily/2026-07-11.md");
  for (let index = 0; index < 40; index++) expect(content).toContain(`entry-${index}\n`);
});

test("deduplicates concurrent idempotent appends by marker", async () => {
  await store.initialize();
  const marker = '<!-- little-claw:daily-flush id="same" -->';
  const results = await Promise.all([
    store.appendMemoryOnce("daily/2026-07-11.md", `${marker}\nfirst`, marker),
    store.appendMemoryOnce("daily/2026-07-11.md", `${marker}\nsecond`, marker),
  ]);

  expect(results.filter((result) => result.status === "written")).toHaveLength(1);
  const content = (await store.readMemory("daily/2026-07-11.md")) ?? "";
  expect(content.match(/little-claw:daily-flush/g)).toHaveLength(1);
});

test("keeps the full long-term read-modify-write operation in one file queue", async () => {
  await store.initialize();
  await store.writeMemory("MEMORY.md", "base", "overwrite");
  await Promise.all([
    store.updateMemory("MEMORY.md", async (current) => {
      await Promise.resolve();
      return { action: "write", content: `${current}\nA`, status: "updated" } as const;
    }),
    store.updateMemory("MEMORY.md", async (current) => ({
      action: "write",
      content: `${current}\nB`,
      status: "updated",
    } as const)),
  ]);

  expect(await store.readMemory("MEMORY.md")).toBe("base\nA\nB");
});
