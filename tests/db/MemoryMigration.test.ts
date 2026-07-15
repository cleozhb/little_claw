import { afterEach, expect, test } from "bun:test";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Database } from "../../src/db/Database.ts";

const PATH = "/tmp/little_claw_memory_migration_test.db";

afterEach(() => {
  rmSync(PATH, { force: true });
  rmSync(`${PATH}-wal`, { force: true });
  rmSync(`${PATH}-shm`, { force: true });
});

test("initializes existing sessions at their last message and migrates embedding metadata", () => {
  const legacy = new SQLiteDatabase(PATH);
  legacy.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, system_prompt TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  legacy.run(`INSERT INTO sessions VALUES ('s1', NULL, NULL, '2026-01-01', '2026-01-01')`);
  legacy.run(`INSERT INTO messages VALUES ('m1', 's1', 'user', 'old', '2026-01-01')`);
  legacy.run(`INSERT INTO messages VALUES ('m2', 's1', 'assistant', 'old reply', '2026-01-01')`);
  legacy.run(`CREATE TABLE context_index (
    dir_path TEXT PRIMARY KEY, overview_content TEXT NOT NULL, content_hash TEXT NOT NULL,
    keywords TEXT NOT NULL, embedding TEXT NOT NULL,
    embedding_signature TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  )`);
  legacy.run(`INSERT INTO context_index VALUES (
    '3-projects/demo', '# Demo', 'hash', 'demo', '[1,2,3]', 'legacy:v1', '2026-01-01'
  )`);
  legacy.close();

  const db = new Database(PATH);
  const state = db.getMemoryFlushState("s1");
  expect(state.dailyCursorMessageId).toBe("m2");
  expect(state.longTermCursorMessageId).toBe("m2");
  const context = db.getAllContextIndex()[0]!;
  expect(context.embedding_dimensions).toBe(3);
  expect(context.embedding_status).toBe("ready");
  db.close();
});
