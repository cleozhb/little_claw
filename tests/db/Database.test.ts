import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_test.db";

let db: Database;

beforeEach(() => {
  db = new Database(TEST_DB);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

test("createSession and getSession", () => {
  const session = db.createSession("You are a helpful assistant.");
  expect(session.id).toBeTruthy();
  expect(session.system_prompt).toBe("You are a helpful assistant.");
  expect(session.title).toBeNull();

  const fetched = db.getSession(session.id);
  expect(fetched).not.toBeNull();
  expect(fetched!.id).toBe(session.id);
  expect(fetched!.system_prompt).toBe("You are a helpful assistant.");
});

test("createSession without systemPrompt", () => {
  const session = db.createSession();
  expect(session.system_prompt).toBeNull();
});

test("getSession returns null for non-existent id", () => {
  expect(db.getSession("non-existent")).toBeNull();
});

test("listSessions returns sessions ordered by updated_at desc", () => {
  const s1 = db.createSession("first");
  Bun.sleepSync(10);
  const s2 = db.createSession("second");
  Bun.sleepSync(10);
  const s3 = db.createSession("third");

  const list = db.listSessions();
  expect(list.length).toBe(3);
  // Most recently created should be first
  expect(list[0]!.id).toBe(s3.id);
  expect(list[2]!.id).toBe(s1.id);
});

test("listSessions respects limit", () => {
  db.createSession();
  db.createSession();
  db.createSession();

  const list = db.listSessions(2);
  expect(list.length).toBe(2);
});

test("updateSessionTitle", () => {
  const session = db.createSession();
  db.updateSessionTitle(session.id, "My Chat");

  const fetched = db.getSession(session.id);
  expect(fetched!.title).toBe("My Chat");
});

test("deleteSession removes session and related data", () => {
  const session = db.createSession();
  const msg = db.addMessage(session.id, "user", "hello");
  db.addToolResult({
    sessionId: session.id,
    messageId: msg.id,
    toolUseId: "tu_123",
    toolName: "bash",
    toolInput: { command: "ls" },
    toolOutput: "file1.txt",
  });

  db.deleteSession(session.id);

  expect(db.getSession(session.id)).toBeNull();
  expect(db.getMessages(session.id)).toEqual([]);
  expect(db.getToolResults(msg.id)).toEqual([]);
});

test("addMessage and getMessages", () => {
  const session = db.createSession();

  db.addMessage(session.id, "user", "Hello!");
  db.addMessage(session.id, "assistant", [
    { type: "text", text: "Hi there!" },
  ]);

  const messages = db.getMessages(session.id);
  expect(messages.length).toBe(2);
  expect(messages[0]!.role).toBe("user");
  expect(messages[0]!.content).toBe("Hello!");
  expect(messages[1]!.role).toBe("assistant");
  expect(JSON.parse(messages[1]!.content)).toEqual([
    { type: "text", text: "Hi there!" },
  ]);
});

test("addMessage updates session timestamp", () => {
  const session = db.createSession();
  const originalUpdatedAt = session.updated_at;

  // Small delay to ensure different timestamp
  Bun.sleepSync(10);
  db.addMessage(session.id, "user", "hello");

  const fetched = db.getSession(session.id);
  expect(fetched!.updated_at).not.toBe(originalUpdatedAt);
});

test("addToolResult and getToolResults", () => {
  const session = db.createSession();
  const msg = db.addMessage(session.id, "assistant", [
    { type: "tool_use", id: "tu_abc", name: "bash", input: { command: "ls" } },
  ]);

  db.addToolResult({
    sessionId: session.id,
    messageId: msg.id,
    toolUseId: "tu_abc",
    toolName: "bash",
    toolInput: { command: "ls" },
    toolOutput: "file1.txt\nfile2.txt",
  });

  const results = db.getToolResults(msg.id);
  expect(results.length).toBe(1);
  expect(results[0]!.tool_name).toBe("bash");
  expect(results[0]!.tool_use_id).toBe("tu_abc");
  expect(JSON.parse(results[0]!.tool_input)).toEqual({ command: "ls" });
  expect(results[0]!.tool_output).toBe("file1.txt\nfile2.txt");
  expect(results[0]!.is_error).toBe(0);
});

test("addToolResult with isError", () => {
  const session = db.createSession();
  const msg = db.addMessage(session.id, "assistant", "test");

  db.addToolResult({
    sessionId: session.id,
    messageId: msg.id,
    toolUseId: "tu_err",
    toolName: "bash",
    toolInput: { command: "bad-cmd" },
    toolOutput: "command not found",
    isError: true,
  });

  const results = db.getToolResults(msg.id);
  expect(results[0]!.is_error).toBe(1);
});
