/**
 * 为模拟中的 Persona 创建沙盒化工具。
 *
 * 路径约定：
 *   - 默认路径（如 "src/server.ts"）→ 解析到 shared/ 目录（团队协作工作区）
 *   - "private/..." 前缀 → 解析到该 Persona 的私有目录
 *
 * 这样 Agent 自然地写 "src/server.ts" 时，所有人都能看到。
 * 只有明确写 "private/notes.md" 才是私有的。
 */

import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Tool, ToolResult, ToolExecuteOptions, ShellTool } from "../tools/types";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_LEN = 10_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LEN) return text;
  return (
    text.slice(0, MAX_OUTPUT_LEN) +
    `\n... [truncated, ${text.length - MAX_OUTPUT_LEN} chars omitted]`
  );
}

/**
 * 检查路径是否在允许的目录内。
 */
function isInsideDir(filePath: string, dir: string): boolean {
  const resolved = resolve(filePath);
  const root = resolve(dir);
  return resolved.startsWith(root + "/") || resolved === root;
}

/**
 * 将用户路径解析为实际文件系统路径。
 * - "private/..." → personaDir 下
 * - 其他路径      → sharedDir 下（团队工作区）
 */
function resolvePersonaPath(
  rawPath: string,
  personaDir: string,
  sharedDir: string,
): { safePath: string; isPrivate: boolean; error?: string } {
  if (rawPath.startsWith("private/") || rawPath === "private") {
    const relativePart = rawPath.slice("private/".length) || "";
    const safePath = resolve(personaDir, relativePart);
    if (!isInsideDir(safePath, personaDir)) {
      return { safePath: "", isPrivate: true, error: "Access denied: path escapes your private directory." };
    }
    return { safePath, isPrivate: true };
  }

  // 兼容旧的 "shared/" 前缀写法 — 剥掉前缀后解析到 sharedDir
  let effectivePath = rawPath;
  if (rawPath.startsWith("shared/")) {
    effectivePath = rawPath.slice("shared/".length);
  } else if (rawPath === "shared") {
    effectivePath = "";
  }

  const safePath = resolve(sharedDir, effectivePath);
  if (!isInsideDir(safePath, sharedDir)) {
    return { safePath: "", isPrivate: false, error: "Access denied: path escapes the workspace." };
  }
  return { safePath, isPrivate: false };
}

/**
 * 创建沙盒 read_file 工具。
 * 默认读 shared/（团队工作区），private/ 前缀读私有目录。
 */
export function createSandboxReadFileTool(
  personaDir: string,
  sharedDir: string,
): Tool {
  return {
    name: "read_file",
    description:
      "Read a file. Paths like 'src/server.ts' read from the team workspace (visible to all). Use 'private/...' prefix to read your private files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to team workspace, or 'private/...' for your private directory)",
        },
      },
      required: ["path"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = params.path as string;
      const { safePath, error } = resolvePersonaPath(rawPath, personaDir, sharedDir);
      if (error) {
        return { success: false, output: "", error };
      }

      const file = Bun.file(safePath);
      if (!(await file.exists())) {
        return { success: false, output: "", error: `File not found: ${rawPath}` };
      }
      if (file.size > MAX_FILE_SIZE) {
        return {
          success: false,
          output: "",
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit is 1MB.`,
        };
      }

      const content = await file.text();
      return { success: true, output: content };
    },
  };
}

/**
 * 创建沙盒 write_file 工具。
 * 默认写 shared/（团队工作区），private/ 前缀写私有目录。
 */
export function createSandboxWriteFileTool(
  personaDir: string,
  sharedDir: string,
): Tool {
  return {
    name: "write_file",
    description:
      "Write a file. Paths like 'src/server.ts' write to the team workspace (visible to all). Use 'private/...' prefix to write to your private directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to team workspace, or 'private/...' for your private directory)",
        },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = params.path as string;
      const content = params.content as string;

      const { safePath, error } = resolvePersonaPath(rawPath, personaDir, sharedDir);
      if (error) {
        return { success: false, output: "", error };
      }

      try {
        await mkdir(dirname(safePath), { recursive: true });
        await Bun.write(safePath, content);
        const bytes = Buffer.byteLength(content, "utf-8");
        return { success: true, output: `Wrote ${bytes} bytes to ${rawPath}` };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `Failed to write ${rawPath}: ${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

/**
 * 创建沙盒 shell 工具。
 * cwd 设为 sharedDir（团队工作区），这样 ls / bun run 等命令自然操作共享文件。
 */
export function createSandboxShellTool(personaDir: string, sharedDir: string): ShellTool {
  let extraEnv: Record<string, string> = {};

  return {
    name: "shell",
    description:
      "Execute a shell command in the team workspace directory. Use this for running scripts, tests, installing packages, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 30000)",
        },
      },
      required: ["command"],
    },

    setExtraEnv(env: Record<string, string>): void {
      extraEnv = env;
    },

    async execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
      const command = params.command as string;
      const timeout = (params.timeout_ms as number) || DEFAULT_TIMEOUT;

      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          cwd: sharedDir,
          env: { ...process.env, ...extraEnv, HOME: personaDir },
          stdout: "pipe",
          stderr: "pipe",
        });

        const timer = setTimeout(() => {
          proc.kill();
        }, timeout);

        let abortHandler: (() => void) | undefined;
        if (options?.signal) {
          if (options.signal.aborted) {
            proc.kill();
          } else {
            abortHandler = () => proc.kill();
            options.signal.addEventListener("abort", abortHandler, { once: true });
          }
        }

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        clearTimeout(timer);
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }

        if (options?.signal?.aborted) {
          return {
            success: false,
            output: truncate(stdout),
            error: "Command aborted",
          };
        }

        if (exitCode === null || exitCode === 137 || exitCode === 143) {
          return {
            success: false,
            output: truncate(stdout),
            error: `Command timed out after ${timeout}ms`,
          };
        }

        let output = "";
        if (stdout) output += truncate(stdout);
        if (stderr) output += (output ? "\n" : "") + "[stderr]\n" + truncate(stderr);

        return {
          success: exitCode === 0,
          output: output || "(no output)",
          error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
        };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `Failed to execute command: ${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

/**
 * 为一个 Persona 创建完整的沙盒工具集。
 * 根据 persona 配置的 tools 列表，筛选并创建对应的沙盒工具。
 */
export function createPersonaSandboxTools(
  personaDir: string,
  sharedDir: string,
  allowedTools: string[],
): Tool[] {
  const toolFactories: Record<string, () => Tool> = {
    read_file: () => createSandboxReadFileTool(personaDir, sharedDir),
    write_file: () => createSandboxWriteFileTool(personaDir, sharedDir),
    shell: () => createSandboxShellTool(personaDir, sharedDir),
  };

  const tools: Tool[] = [];
  for (const name of allowedTools) {
    const factory = toolFactories[name];
    if (factory) {
      tools.push(factory());
    } else {
      console.warn(`[SandboxTools] Unknown tool "${name}" requested by persona, skipping.`);
    }
  }
  return tools;
}
