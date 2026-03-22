import type { Tool, ToolResult } from "../types.ts";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export const ReadFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. Use this when you need to examine existing code or files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to read" },
    },
    required: ["path"],
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const path = params.path as string;
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return { success: false, output: "", error: `File not found: ${path}` };
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
