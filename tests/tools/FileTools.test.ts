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

  expect(tool.description).toContain("concrete non-empty file path");
  expect(tool.parameters.properties?.path?.description).toContain("Never omit this field");
  expect(result.success).toBe(false);
  expect(result.error).toBe("read_file path must be a non-empty string.");
});

test("write_file rejects invalid arguments with clear errors", async () => {
  const tool = createWriteFileTool(TMP);

  const badPath = await tool.execute({ content: "hello" });
  const badContent = await tool.execute({ path: "note.md", content: { text: "hello" } });

  expect(tool.description).toContain("concrete non-empty file path");
  expect(tool.parameters.properties?.path?.description).toContain("Never omit this field");
  expect(tool.parameters.properties?.content?.description).toContain("Never omit this field");
  expect(badPath.success).toBe(false);
  expect(badPath.error).toBe("write_file path must be a non-empty string.");
  expect(badContent.success).toBe(false);
  expect(badContent.error).toBe("write_file content must be a string.");
});

test("file tools reject shell-style home paths", async () => {
  const readTool = createReadFileTool(TMP);
  const writeTool = createWriteFileTool(TMP);

  const read = await readTool.execute({ path: "~/.little_claw/tinker/latest.md" });
  const write = await writeTool.execute({
    path: "~/.little_claw/tinker/latest.md",
    content: "hello",
  });

  expect(read.success).toBe(false);
  expect(read.error).toContain('uses "~"');
  expect(write.success).toBe(false);
  expect(write.error).toContain('uses "~"');
});

test("write_file rejects embedded workspace roots in relative paths", async () => {
  const tool = createWriteFileTool(TMP);
  const embeddedRootPath = `s/${TMP.slice(1)}/tinker/runs/2026-06-01/attempts.md`;

  const result = await tool.execute({
    path: embeddedRootPath,
    content: "hello",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("embeds the workspace root inside a relative path");
});
