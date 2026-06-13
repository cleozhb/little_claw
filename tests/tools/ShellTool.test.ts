import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createShellTool } from "../../src/tools/builtin/ShellTool";

const TMP = "/tmp/little_claw_shell_tool_test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("shell rejects absolute paths outside the workspace", async () => {
  const tool = createShellTool(TMP);

  const result = await tool.execute({
    command: "cd /home/zhanghuibin02/code/podcast_translation && cat .env",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("outside the allowed roots");
});

test("shell rejects relative paths that may escape the workspace", async () => {
  const tool = createShellTool(TMP);

  const result = await tool.execute({ command: "cat ../secret.txt" });

  expect(result.success).toBe(false);
  expect(result.error).toContain("may leave the allowed roots");
});

test("shell does not inherit arbitrary process secrets", async () => {
  const original = process.env.LITTLE_CLAW_SECRET_TEST;
  process.env.LITTLE_CLAW_SECRET_TEST = "secret-value";
  const tool = createShellTool(TMP);

  try {
    const result = await tool.execute({ command: "printf \"$LITTLE_CLAW_SECRET_TEST\"" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("(no output)");
  } finally {
    if (original === undefined) {
      delete process.env.LITTLE_CLAW_SECRET_TEST;
    } else {
      process.env.LITTLE_CLAW_SECRET_TEST = original;
    }
  }
});

test("shell allows URLs without treating them as filesystem paths", async () => {
  const tool = createShellTool(TMP);

  const result = await tool.execute({ command: "printf https://example.com/health" });

  expect(result.success).toBe(true);
  expect(result.output).toBe("https://example.com/health");
});

test("shell allows safe /dev/null redirection", async () => {
  const tool = createShellTool(TMP);

  const result = await tool.execute({ command: "printf ok 2>/dev/null" });

  expect(result.success).toBe(true);
  expect(result.output).toBe("ok");
});

test("shell can run from a narrowed project workspace", async () => {
  const projectDir = join(TMP, "context-hub", "3-projects", "technology-blog");
  mkdirSync(projectDir, { recursive: true });
  const tool = createShellTool(TMP);

  const result = await tool.execute(
    { command: "pwd && printf ok > extract_urls.py" },
    { cwd: projectDir },
  );

  expect(result.success).toBe(true);
  expect(result.output.split("\n")[0]).toBe(realpathSync(projectDir));
  expect(readFileSync(join(projectDir, "extract_urls.py"), "utf8")).toBe("ok");
  expect(existsSync(join(TMP, "extract_urls.py"))).toBe(false);
});

test("shell narrowed to a project workspace rejects parent workspace writes", async () => {
  const projectDir = join(TMP, "context-hub", "3-projects", "technology-blog");
  mkdirSync(projectDir, { recursive: true });
  const tool = createShellTool(TMP);

  const result = await tool.execute(
    { command: `printf bad > ${TMP}/loose.txt` },
    { cwd: projectDir },
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain("outside the allowed roots");
  expect(existsSync(join(TMP, "loose.txt"))).toBe(false);
});

test("shell allows explicitly configured external skill roots", async () => {
  const externalRoot = "/tmp/little_claw_shell_external_tool";
  rmSync(externalRoot, { recursive: true, force: true });
  mkdirSync(externalRoot, { recursive: true });
  const tool = createShellTool(TMP);
  tool.setExtraEnv({
    LITTLE_CLAW_SHELL_ALLOWED_ROOTS: externalRoot,
    PODCAST_TOOL_DIR: externalRoot,
  });

  try {
    const result = await tool.execute({ command: "cd \"$PODCAST_TOOL_DIR\" && pwd" });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe(externalRoot);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("shell rejects env paths outside configured allowed roots", async () => {
  const tool = createShellTool(TMP);
  tool.setExtraEnv({
    PODCAST_TOOL_DIR: "/home/zhanghuibin02/code/podcast_translation",
  });

  const result = await tool.execute({ command: "cd \"$PODCAST_TOOL_DIR\" && pwd" });

  expect(result.success).toBe(false);
  expect(result.error).toContain("env path");
});
