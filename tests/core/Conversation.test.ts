import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { Conversation } from "../../src/core/Conversation";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_conv_test.db";

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

test("createNew creates a session and conversation", () => {
  const conv = Conversation.createNew(db);
  expect(conv.getSessionId()).toBeTruthy();
  expect(conv.getMessages()).toEqual([]);
  expect(conv.getSystemPrompt()).toContain("helpful AI assistant");
});

test("createNew with custom system prompt", () => {
  const conv = Conversation.createNew(db, "You are a pirate.");
  expect(conv.getSystemPrompt()).toBe("You are a pirate.");
});

test("addUser persists to database", () => {
  const conv = Conversation.createNew(db);
  conv.addUser("Hello!");

  const messages = conv.getMessages();
  expect(messages.length).toBe(1);
  expect(messages[0]).toEqual({ role: "user", content: "Hello!" });

  // Verify in DB
  const dbMessages = db.getMessages(conv.getSessionId());
  expect(dbMessages.length).toBe(1);
  expect(dbMessages[0]!.role).toBe("user");
  expect(dbMessages[0]!.content).toBe("Hello!");
});

test("addAssistant persists to database", () => {
  const conv = Conversation.createNew(db);
  conv.addAssistant("Hi there!");

  const messages = conv.getMessages();
  expect(messages.length).toBe(1);
  expect(messages[0]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi there!" }],
  });

  const dbMessages = db.getMessages(conv.getSessionId());
  expect(dbMessages.length).toBe(1);
  expect(dbMessages[0]!.role).toBe("assistant");
});

test("addToolUse persists and returns messageId", () => {
  const conv = Conversation.createNew(db);
  const blocks = [
    { type: "text" as const, text: "Let me check." },
    {
      type: "tool_use" as const,
      id: "tu_123",
      name: "bash",
      input: { command: "ls" },
    },
  ];

  const messageId = conv.addToolUse(blocks);
  expect(messageId).toBeTruthy();

  const messages = conv.getMessages();
  expect(messages.length).toBe(1);
  expect(messages[0]!.role).toBe("assistant");
});

test("addToolResults persists and builds correct in-memory message", () => {
  const conv = Conversation.createNew(db);
  conv.addUser("list files");

  const messageId = conv.addToolUse([
    {
      type: "tool_use" as const,
      id: "tu_abc",
      name: "bash",
      input: { command: "ls" },
    },
  ]);

  conv.addToolResults(messageId, [
    {
      toolUseId: "tu_abc",
      toolName: "bash",
      input: { command: "ls" },
      output: "file1.txt\nfile2.txt",
      isError: false,
    },
  ]);

  const messages = conv.getMessages();
  expect(messages.length).toBe(3);
  // user -> assistant(tool_use) -> user(tool_result)
  expect(messages[0]!.role).toBe("user");
  expect(messages[1]!.role).toBe("assistant");
  expect(messages[2]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_abc",
        content: "file1.txt\nfile2.txt",
        is_error: false,
      },
    ],
  });

  // Verify tool results in DB
  const dbResults = db.getToolResults(messageId);
  expect(dbResults.length).toBe(1);
  expect(dbResults[0]!.tool_name).toBe("bash");
});

test("loadExisting restores plain text conversation", () => {
  const conv = Conversation.createNew(db);
  const sessionId = conv.getSessionId();

  conv.addUser("Hello");
  conv.addAssistant("Hi there!");
  conv.addUser("How are you?");
  conv.addAssistant("I'm doing great!");

  // Load from DB in a new Conversation instance
  const restored = Conversation.loadExisting(db, sessionId);

  const original = conv.getMessages();
  const loaded = restored.getMessages();

  expect(loaded.length).toBe(original.length);
  expect(loaded).toEqual(original);
  expect(restored.getSystemPrompt()).toBe(conv.getSystemPrompt());
});

test("loadExisting restores tool_use + tool_result sequence", () => {
  const conv = Conversation.createNew(db);
  const sessionId = conv.getSessionId();

  conv.addUser("list files");

  const msgId = conv.addToolUse([
    { type: "text", text: "Let me check." },
    {
      type: "tool_use",
      id: "tu_001",
      name: "bash",
      input: { command: "ls" },
    },
  ]);

  conv.addToolResults(msgId, [
    {
      toolUseId: "tu_001",
      toolName: "bash",
      input: { command: "ls" },
      output: "src/ package.json",
      isError: false,
    },
  ]);

  conv.addAssistant("Here are the files: src/ and package.json");

  // Restore
  const restored = Conversation.loadExisting(db, sessionId);
  const original = conv.getMessages();
  const loaded = restored.getMessages();

  expect(loaded.length).toBe(original.length);
  expect(loaded).toEqual(original);
});

test("loadExisting restores multiple tool calls in one message", () => {
  const conv = Conversation.createNew(db);
  const sessionId = conv.getSessionId();

  conv.addUser("read two files");

  const msgId = conv.addToolUse([
    {
      type: "tool_use",
      id: "tu_a",
      name: "read_file",
      input: { path: "a.txt" },
    },
    {
      type: "tool_use",
      id: "tu_b",
      name: "read_file",
      input: { path: "b.txt" },
    },
  ]);

  conv.addToolResults(msgId, [
    {
      toolUseId: "tu_a",
      toolName: "read_file",
      input: { path: "a.txt" },
      output: "content a",
      isError: false,
    },
    {
      toolUseId: "tu_b",
      toolName: "read_file",
      input: { path: "b.txt" },
      output: "content b",
      isError: false,
    },
  ]);

  conv.addAssistant("Done reading both files.");

  const restored = Conversation.loadExisting(db, sessionId);
  expect(restored.getMessages()).toEqual(conv.getMessages());
});

test("loadExisting restores error tool results", () => {
  const conv = Conversation.createNew(db);
  const sessionId = conv.getSessionId();

  conv.addUser("run bad command");

  const msgId = conv.addToolUse([
    {
      type: "tool_use",
      id: "tu_err",
      name: "bash",
      input: { command: "bad-cmd" },
    },
  ]);

  conv.addToolResults(msgId, [
    {
      toolUseId: "tu_err",
      toolName: "bash",
      input: { command: "bad-cmd" },
      output: "command not found",
      isError: true,
    },
  ]);

  const restored = Conversation.loadExisting(db, sessionId);
  const msgs = restored.getMessages();
  const toolResultMsg = msgs[2]!;
  expect(toolResultMsg.role).toBe("user");
  expect(Array.isArray(toolResultMsg.content)).toBe(true);
  const blocks = toolResultMsg.content as Array<{ type: string; is_error?: boolean }>;
  expect(blocks[0]!.is_error).toBe(true);
});

test("loadExisting throws for non-existent session", () => {
  expect(() => Conversation.loadExisting(db, "non-existent")).toThrow(
    "Session not found"
  );
});

test("clear, getLastNMessages, popLast still work", () => {
  const conv = Conversation.createNew(db);
  conv.addUser("a");
  conv.addAssistant("b");
  conv.addUser("c");

  expect(conv.getLastNMessages(2).length).toBe(2);

  conv.popLast();
  expect(conv.getMessages().length).toBe(2);

  conv.clear();
  expect(conv.getMessages()).toEqual([]);
});

test("getSessionId returns valid session id", () => {
  const conv = Conversation.createNew(db);
  const session = db.getSession(conv.getSessionId());
  expect(session).not.toBeNull();
});

test("loadExisting restores placeholder when tool_result is missing (interrupted execution)", () => {
  const conv = Conversation.createNew(db);
  const sessionId = conv.getSessionId();

  conv.addUser("do something");

  // 模拟：assistant 发出了 tool_use，但执行中断，tool_result 没写入
  conv.addToolUse([
    {
      type: "tool_use",
      id: "tu_interrupted",
      name: "shell",
      input: { command: "long-running-cmd" },
    },
  ]);
  // 注意：没有调用 addToolResults

  // 继续对话（模拟下一轮用户输入，实际场景是 session 恢复后用户继续聊天）
  // 这里不 addUser，只测试 loadExisting 恢复后消息链是否完整

  const restored = Conversation.loadExisting(db, sessionId);
  const msgs = restored.getMessages();

  // 应该是：user("do something") → assistant(tool_use) → user(tool_result placeholder)
  expect(msgs.length).toBe(3);
  expect(msgs[0]!.role).toBe("user");
  expect(msgs[1]!.role).toBe("assistant");
  expect(msgs[2]!.role).toBe("user");

  // 第三条应该是占位的 tool_result
  const toolResultMsg = msgs[2]!;
  expect(Array.isArray(toolResultMsg.content)).toBe(true);
  const blocks = toolResultMsg.content as Array<{ type: string; tool_use_id: string; is_error?: boolean; content: string }>;
  expect(blocks.length).toBe(1);
  expect(blocks[0]!.type).toBe("tool_result");
  expect(blocks[0]!.tool_use_id).toBe("tu_interrupted");
  expect(blocks[0]!.is_error).toBe(true);
  expect(blocks[0]!.content).toContain("interrupted");
});
