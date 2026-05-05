import type { ShellTool, ToolResult, ToolExecuteOptions } from "../types.ts";
import { resolve } from "node:path";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_LEN = 10_000;
const ABSOLUTE_PATH_PATTERN = /(^|[^\w:/])\/(?!\/)([^ \t\n"'`;$|&<>()]+)/g;
const ALLOWED_ROOTS_ENV = "LITTLE_CLAW_SHELL_ALLOWED_ROOTS";
const SAFE_ABSOLUTE_PATHS = new Set(["/dev/null"]);
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
];

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LEN) return text;
  return (
    text.slice(0, MAX_OUTPUT_LEN) +
    `\n... [truncated, ${text.length - MAX_OUTPUT_LEN} chars omitted]`
  );
}

export function createShellTool(workspaceRoot: string): ShellTool {
  let extraEnv: Record<string, string> = {};
  const root = resolve(workspaceRoot);

  return {
    name: "shell",
    description:
      "Execute a shell command and return its output. The command is restricted to the workspace directory. Use this for running scripts, checking system status, installing packages, running tests, etc.",
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

      const guardError = validateShellCommand(command, root, extraEnv);
      if (guardError) {
        return {
          success: false,
          output: "",
          error: guardError,
        };
      }

      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          cwd: root,
          env: buildShellEnv(root, extraEnv),
          stdout: "pipe",
          stderr: "pipe",
        });

        // 超时 kill
        const timer = setTimeout(() => {
          proc.kill();
        }, timeout);

        // abort 信号 kill
        let abortHandler: (() => void) | undefined;
        if (options?.signal) {
          if (options.signal.aborted) {
            // 已经 abort 了，立即 kill
            console.log(`[abort] ShellTool: signal already aborted, killing process immediately, cmd="${command.slice(0, 80)}"`);
            proc.kill();
          } else {
            abortHandler = () => {
              console.log(`[abort] ShellTool: abort signal received, killing process, cmd="${command.slice(0, 80)}"`);
              proc.kill();
            };
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

        // 被 abort 信号 kill
        if (options?.signal?.aborted) {
          console.log(`[abort] ShellTool: command aborted, exitCode=${exitCode}, cmd="${command.slice(0, 80)}"`);
          return {
            success: false,
            output: truncate(stdout),
            error: "Command aborted by user",
          };
        }

        // Check if killed by timeout (exit code null or signal-based)
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

function buildShellEnv(workspaceRoot: string, extraEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = workspaceRoot;
  env.LC_ALL = "C";
  return { ...env, ...extraEnv };
}

function validateShellCommand(
  command: string,
  workspaceRoot: string,
  extraEnv: Record<string, string>,
): string | null {
  if (typeof command !== "string" || command.trim() === "") {
    return "Command must be a non-empty string.";
  }

  const allowedRoots = getAllowedRoots(workspaceRoot, extraEnv);
  const tokens = shellLikeTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "cd") {
      const target = tokens[i + 1];
      if (!target) {
        return "Shell command denied: cd without a target would leave the workspace.";
      }
      const denied = deniedPathToken(target, workspaceRoot, allowedRoots, extraEnv);
      if (denied) return denied;
    }

    const denied = deniedPathToken(token, workspaceRoot, allowedRoots, extraEnv);
    if (denied) return denied;
  }

  for (const absolutePath of extractAbsolutePaths(command)) {
    if (!isAllowedAbsolutePath(absolutePath, allowedRoots)) {
      return `Shell command denied: path "${absolutePath}" is outside the allowed roots ${formatAllowedRoots(allowedRoots)}.`;
    }
  }

  return null;
}

function deniedPathToken(
  token: string,
  workspaceRoot: string,
  allowedRoots: string[],
  extraEnv: Record<string, string>,
): string | null {
  if (token.startsWith("~")) {
    return `Shell command denied: path "${token}" may leave the allowed roots ${formatAllowedRoots(allowedRoots)}.`;
  }
  if (token === ".." || token.startsWith("../") || token.includes("/../")) {
    return `Shell command denied: path "${token}" may leave the allowed roots ${formatAllowedRoots(allowedRoots)}.`;
  }
  const envPath = resolveEnvPathToken(token, extraEnv);
  if (envPath && !isAllowedAbsolutePath(envPath, allowedRoots)) {
    return `Shell command denied: env path "${token}" resolves outside the allowed roots ${formatAllowedRoots(allowedRoots)}.`;
  }
  if (token.startsWith("/") && !isAllowedAbsolutePath(token, allowedRoots)) {
    return `Shell command denied: path "${token}" is outside the allowed roots ${formatAllowedRoots(allowedRoots)}.`;
  }
  return null;
}

function extractAbsolutePaths(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(ABSOLUTE_PATH_PATTERN)) {
    const prefix = match[1] ?? "";
    const raw = `/${match[2] ?? ""}`;
    if (prefix === ":" || raw === "/") continue;
    paths.push(raw);
  }
  return paths;
}

function getAllowedRoots(workspaceRoot: string, extraEnv: Record<string, string>): string[] {
  const roots = new Set<string>([workspaceRoot]);
  const raw = extraEnv[ALLOWED_ROOTS_ENV];
  if (raw) {
    for (const item of raw.split(/[:,\n]/)) {
      const trimmed = item.trim();
      if (trimmed.startsWith("/")) {
        roots.add(resolve(trimmed));
      }
    }
  }
  return [...roots];
}

function isAllowedAbsolutePath(path: string, allowedRoots: string[]): boolean {
  if (SAFE_ABSOLUTE_PATHS.has(path)) return true;
  return allowedRoots.some((root) => isInsideRoot(path, root));
}

function isInsideRoot(path: string, root: string): boolean {
  const resolved = resolve(path);
  return resolved === root || resolved.startsWith(`${root}/`);
}

function resolveEnvPathToken(token: string, extraEnv: Record<string, string>): string | null {
  const match =
    /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(token) ??
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
  if (!match) return null;

  const value = extraEnv[match[1]!];
  return value?.startsWith("/") ? resolve(value) : null;
}

function formatAllowedRoots(allowedRoots: string[]): string {
  return `[${allowedRoots.map((root) => `"${root}"`).join(", ")}]`;
}

function shellLikeTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ";|&<>()".includes(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}
