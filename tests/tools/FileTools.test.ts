import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createReadFileTool } from "../../src/tools/builtin/ReadFileTool";
import { createWriteFileTool } from "../../src/tools/builtin/WriteFileTool";

const TMP = "/tmp/little_claw_file_tools_test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("read_file rejects missing or non-string paths with a clear error", async () => {
  const tool = createReadFileTool(TMP);

  const result = await tool.execute({});

  expect(result.success).toBe(false);
  expect(result.error).toBe("read_file path must be a non-empty string.");
});

test("write_file rejects invalid arguments with clear errors", async () => {
  const tool = createWriteFileTool(TMP);

  const badPath = await tool.execute({ content: "hello" });
  const badContent = await tool.execute({ path: "note.md", content: { text: "hello" } });

  expect(badPath.success).toBe(false);
  expect(badPath.error).toBe("write_file path must be a non-empty string.");
  expect(badContent.success).toBe(false);
  expect(badContent.error).toBe("write_file content must be a string.");
});
