import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "../types.ts";
import { resolveAndGuard } from "./pathGuard.ts";

export function createWriteFileTool(workspaceRoot: string): Tool {
  return {
    name: "write_file",
    description:
      "Write content to a file at the given path. Creates the file if it doesn't exist, overwrites if it does. Use this to create or modify files. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write to (relative to workspace root)" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = params.path as string;
      const content = params.content as string;

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

      try {
        await mkdir(dirname(safePath), { recursive: true });
        await Bun.write(safePath, content);
        const bytes = Buffer.byteLength(content, "utf-8");
        return { success: true, output: `Wrote ${bytes} bytes to ${safePath}` };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `Failed to write ${safePath}: ${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}
