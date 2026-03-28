import type { Tool, ToolResult } from "../types.ts";
import { resolveAndGuard } from "./pathGuard.ts";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function createReadFileTool(workspaceRoot: string): Tool {
  return {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Use this when you need to examine existing code or files. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to read (relative to workspace root)" },
      },
      required: ["path"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = params.path as string;

      let safePath: string;
      try {
        safePath = resolveAndGuard(rawPath, workspaceRoot);
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const file = Bun.file(safePath);

      if (!(await file.exists())) {
        return { success: false, output: "", error: `File not found: ${safePath}` };
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
