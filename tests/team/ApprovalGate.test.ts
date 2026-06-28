import { test, expect, describe } from "bun:test";
import { checkApprovalGate, type ApprovalRule } from "../../src/team/ApprovalGate.ts";

describe("checkApprovalGate", () => {
  test("returns allow when no rules match", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", pattern: "^rm.*$" }];
    const result = checkApprovalGate(rules, "write_file", { path: "/tmp/x" });
    expect(result.action).toBe("allow");
  });

  test("matches tool without pattern (blocks all calls)", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", message: "No shell allowed" }];
    const result = checkApprovalGate(rules, "shell", { command: "ls" });
    expect(result.action).toBe("pause");
    expect(result.rule?.message).toBe("No shell allowed");
  });

  test("matches shell command with regex pattern", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", pattern: "^translate\\s+start.*$" }];
    const result = checkApprovalGate(rules, "shell", { command: "translate start episode-42" });
    expect(result.action).toBe("pause");
    expect(result.matchedValue).toBe("translate start episode-42");
  });

  test("does not match when pattern does not match", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", pattern: "^rm -rf.*$" }];
    const result = checkApprovalGate(rules, "shell", { command: "ls -la" });
    expect(result.action).toBe("allow");
  });

  test("uses default field mapping for write_file", () => {
    const rules: ApprovalRule[] = [{ tool: "write_file", pattern: "^published/.*$" }];
    const result = checkApprovalGate(rules, "write_file", { path: "published/article.md" });
    expect(result.action).toBe("pause");
  });

  test("uses default field mapping for read_file", () => {
    const rules: ApprovalRule[] = [{ tool: "read_file", pattern: "^private/.*$" }];
    const result = checkApprovalGate(rules, "read_file", { path: "private/note.md" });
    expect(result.action).toBe("pause");
  });

  test("can allow a relative directory tree with optional dot prefix", () => {
    const rules: ApprovalRule[] = [{ tool: "write_file", field: "path", pattern: "^(?!(\\./)?tinker/).*" }];

    expect(checkApprovalGate(rules, "write_file", { path: "tinker/runs/day/result.md" }).action).toBe("allow");
    expect(checkApprovalGate(rules, "write_file", { path: "./tinker/runs/day/result.md" }).action).toBe("allow");
    expect(checkApprovalGate(rules, "write_file", { path: "context-hub/notes.md" }).action).toBe("pause");
  });

  test("matches absolute workspace paths as relative paths", () => {
    const rules: ApprovalRule[] = [{ tool: "write_file", field: "path", pattern: "^(?!(\\./)?tinker/).*" }];
    const workspaceRoot = "/tmp/little_claw_approval_workspace";

    expect(checkApprovalGate(
      rules,
      "write_file",
      { path: "/tmp/little_claw_approval_workspace/tinker/runs/day/result.md" },
      { workspaceRoot },
    ).action).toBe("allow");
    expect(checkApprovalGate(
      rules,
      "write_file",
      { path: "/tmp/little_claw_approval_workspace/context-hub/notes.md" },
      { workspaceRoot },
    ).action).toBe("pause");
  });

  test("supports hard deny rules", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", action: "deny", message: "Shell is disabled." }];
    const result = checkApprovalGate(rules, "shell", { command: "mkdir -p tinker/runs/day" });

    expect(result.action).toBe("deny");
    expect(result.rule?.message).toBe("Shell is disabled.");
  });

  test("uses custom field override", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", field: "args", pattern: "^--force$" }];
    const result = checkApprovalGate(rules, "shell", { command: "deploy", args: "--force" });
    expect(result.action).toBe("pause");
    expect(result.matchedValue).toBe("--force");
  });

  test("falls back to JSON.stringify for unknown tools", () => {
    const rules: ApprovalRule[] = [{ tool: "custom_tool", pattern: "dangerous" }];
    const result = checkApprovalGate(rules, "custom_tool", { foo: "dangerous-op" });
    expect(result.action).toBe("pause");
  });

  test("skips rule when target field is missing", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", field: "nonexistent", pattern: ".*" }];
    const result = checkApprovalGate(rules, "shell", { command: "ls" });
    expect(result.action).toBe("allow");
  });

  test("first matching rule wins", () => {
    const rules: ApprovalRule[] = [
      { tool: "shell", pattern: "^rm.*$", message: "first" },
      { tool: "shell", pattern: "^rm -rf.*$", message: "second" },
    ];
    const result = checkApprovalGate(rules, "shell", { command: "rm -rf /" });
    expect(result.rule?.message).toBe("first");
  });
});
