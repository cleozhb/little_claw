import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "../types.ts";

export const WriteFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file at the given path. Creates the file if it doesn't exist, overwrites if it does. Use this to create or modify files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to write to" },
      content: { type: "string", description: "The content to write" },
    },
    required: ["path", "content"],
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const path = params.path as string;
    const content = params.content as string;

    try {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, content);
      const bytes = Buffer.byteLength(content, "utf-8");
      return { success: true, output: `Wrote ${bytes} bytes to ${path}` };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Failed to write ${path}: ${err instanceof Error ? err.message : err}`,
      };
    }
  },
};
