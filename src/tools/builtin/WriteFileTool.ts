import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "../types.ts";
import { resolveAndGuard } from "./pathGuard.ts";

export function createWriteFileTool(workspaceRoot: string): Tool {
  return {
    name: "write_file",
    description:
      "Write content to one file at the given path. You must provide both a concrete non-empty file path and string content. Creates the file if it doesn't exist, overwrites if it does. Do not call write_file with empty input, a directory path, or placeholder content. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Required concrete file path to write, relative to workspace root. Never omit this field.",
        },
        content: {
          type: "string",
          description: "Required string content to write. Never omit this field.",
        },
      },
      required: ["path", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = params.path as string;
      const content = params.content as string;
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return {
          success: false,
          output: "",
          error: "write_file path must be a non-empty string.",
        };
      }
      if (typeof content !== "string") {
        return {
          success: false,
          output: "",
          error: "write_file content must be a string.",
        };
      }

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
