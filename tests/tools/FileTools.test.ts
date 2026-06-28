import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createReadFileTool } from "../../src/tools/builtin/ReadFileTool";
import { createWriteFileTool } from "../../src/tools/builtin/WriteFileTool";
import { createReadContentRefTool } from "../../src/tools/builtin/ReadContentRefTool";
import { ContentStore } from "../../src/memory/ContentStore";

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

test("read_file stores larger files as content_ref and read_content_ref pages them", async () => {
  const contentStore = new ContentStore(TMP);
  const readTool = createReadFileTool(TMP, { contentStore });
  const refTool = createReadContentRefTool({ contentStore });
  const content = `# Large Note\n\n${"alpha beta gamma ".repeat(3_000)}`;
  await Bun.write(join(TMP, "large.md"), content);

  const result = await readTool.execute({ path: "large.md" });
  expect(result.success).toBe(true);
  const digest = JSON.parse(result.output);
  expect(digest.type).toBe("content_ref");
  expect(digest.ref_id).toMatch(/^ctx_/);
  expect(digest.content_length).toBe(content.length);

  const page = await refTool.execute({ ref_id: digest.ref_id, page: 1, page_size: 1000 });
  expect(page.success).toBe(true);
  const pageOutput = JSON.parse(page.output);
  expect(pageOutput.content).toContain("Large Note");
  expect(pageOutput.next_page).toBe(2);
});

test("read_file and read_content_ref honor execution content store base dir", async () => {
  const workspaceRoot = join(TMP, "workspace");
  const storeRoot = join(TMP, "store");
  mkdirSync(workspaceRoot, { recursive: true });

  const readTool = createReadFileTool(workspaceRoot);
  const refTool = createReadContentRefTool();
  const content = `# Project Note\n\n${"delta epsilon ".repeat(3_000)}`;
  await Bun.write(join(workspaceRoot, "large.md"), content);

  const executeOptions = {
    contentStoreBaseDir: storeRoot,
    projectContextPath: "context-hub/3-projects/demo-project",
  };
  const result = await readTool.execute({ path: "large.md" }, executeOptions);
  expect(result.success).toBe(true);
  const digest = JSON.parse(result.output);
  expect(digest.project).toBe("demo-project");

  const stored = Bun.file(join(
    storeRoot,
    "context-hub",
    "3-projects",
    "demo-project",
    "content-refs",
    `${digest.ref_id}.txt`,
  ));
  expect(await stored.exists()).toBe(true);

  const page = await refTool.execute({ ref_id: digest.ref_id, page: 1 }, executeOptions);
  expect(page.success).toBe(true);
  expect(JSON.parse(page.output).content).toContain("Project Note");
});
