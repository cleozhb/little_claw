import { test, expect, describe } from "bun:test";
import { checkApprovalGate, type ApprovalRule } from "../../src/team/ApprovalGate.ts";

describe("checkApprovalGate", () => {
  test("returns allow when no rules match", () => {
    const rules: ApprovalRule[] = [{ tool: "shell", pattern: "^rm.*$" }];
    const result = checkApprovalGate(rules, "write_file", { file_path: "/tmp/x" });
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
    const result = checkApprovalGate(rules, "write_file", { file_path: "published/article.md" });
    expect(result.action).toBe("pause");
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
