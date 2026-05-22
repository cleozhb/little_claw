import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database.ts";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DB_PATH = join(import.meta.dir, ".test-session-approval.db");

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }
}

describe("Database session_approvals", () => {
  let db: Database;

  beforeEach(() => {
    cleanupDb();
    db = new Database(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    cleanupDb();
  });

  test("createSessionApproval and getSessionPendingApproval", () => {
    const session = db.createSession("test");
    const id = db.createSessionApproval(session.id, {
      toolName: "shell",
      params: { command: "rm -rf /" },
      rule: { tool: "shell", pattern: "^rm.*$" },
      message: "Dangerous command requires approval",
    });

    expect(id).toBeTruthy();

    const pending = db.getSessionPendingApproval(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(id);
    expect(pending!.tool_name).toBe("shell");
    expect(pending!.status).toBe("pending");
    expect(pending!.message).toBe("Dangerous command requires approval");
    expect(JSON.parse(pending!.params)).toEqual({ command: "rm -rf /" });
  });

  test("approveSessionApproval resolves pending", () => {
    const session = db.createSession("test");
    const id = db.createSessionApproval(session.id, {
      toolName: "shell",
      params: { command: "deploy" },
      rule: null,
      message: "Approve deploy?",
    });

    db.approveSessionApproval(id);

    const pending = db.getSessionPendingApproval(session.id);
    expect(pending).toBeNull();
  });

  test("rejectSessionApproval resolves pending", () => {
    const session = db.createSession("test");
    const id = db.createSessionApproval(session.id, {
      toolName: "write_file",
      params: { file_path: "published/x.md" },
      rule: null,
      message: "Approve write?",
    });

    db.rejectSessionApproval(id);

    const pending = db.getSessionPendingApproval(session.id);
    expect(pending).toBeNull();
  });

  test("getApprovedCallKeys returns approved keys", () => {
    const session = db.createSession("test");

    const id1 = db.createSessionApproval(session.id, {
      toolName: "shell",
      params: { command: "deploy --prod" },
      rule: null,
      message: "msg1",
    });
    const id2 = db.createSessionApproval(session.id, {
      toolName: "write_file",
      params: { file_path: "published/article.md" },
      rule: null,
      message: "msg2",
    });

    db.approveSessionApproval(id1);
    db.rejectSessionApproval(id2);

    const keys = db.getApprovedCallKeys(session.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('shell:{"command":"deploy --prod"}');
  });

  test("getSessionPendingApproval returns latest pending", () => {
    const session = db.createSession("test");

    const id1 = db.createSessionApproval(session.id, {
      toolName: "shell",
      params: { command: "first" },
      rule: null,
      message: "first",
    });
    db.rejectSessionApproval(id1);

    const id2 = db.createSessionApproval(session.id, {
      toolName: "shell",
      params: { command: "second" },
      rule: null,
      message: "second",
    });

    const pending = db.getSessionPendingApproval(session.id);
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(id2);
    expect(pending!.message).toBe("second");
  });
});
