import type { Tool, ToolResult } from "../types.ts";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_LEN = 10_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LEN) return text;
  return (
    text.slice(0, MAX_OUTPUT_LEN) +
    `\n... [truncated, ${text.length - MAX_OUTPUT_LEN} chars omitted]`
  );
}

export function createShellTool(workspaceRoot: string): Tool {
  return {
    name: "shell",
    description:
      "Execute a shell command and return its output. The command runs inside the workspace directory. Use this for running scripts, checking system status, installing packages, running tests, etc.",
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

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const command = params.command as string;
      const timeout = (params.timeout_ms as number) || DEFAULT_TIMEOUT;

      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          cwd: workspaceRoot,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timer = setTimeout(() => {
          proc.kill();
        }, timeout);

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        clearTimeout(timer);

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
