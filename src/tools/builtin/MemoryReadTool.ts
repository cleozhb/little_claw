import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";

// ---------------------------------------------------------------------------
// memory_read — Agent 主动读取 memory/ 文件
// ---------------------------------------------------------------------------

export function createMemoryReadTool(
  fileMemory: FileMemoryManager,
): Tool {
  return {
    name: "memory_read",
    description:
      "Read a persistent memory file. Use this to check existing content before writing new memory entries.\n\n" +
      "Memory files:\n" +
      "- memory/MEMORY.md — durable personal memory and collaboration preferences\n" +
      "- memory/inbox.md — unsorted memory candidates\n" +
      "- memory/daily/YYYY-MM-DD.md — daily work notes\n\n" +
      "Use context_read for context-hub paths.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The memory file to read. Examples: "memory/MEMORY.md", "memory/inbox.md", "memory/daily/2026-07-11.md".',
        },
      },
      required: ["file"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const file = params.file as string;

      try {
        const content = await fileMemory.readFile(file);
        if (content === null) {
          return {
            success: false,
            output: "",
            error: `File not found: ${file}`,
          };
        }
        return { success: true, output: content };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
