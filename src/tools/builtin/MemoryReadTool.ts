import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";

// ---------------------------------------------------------------------------
// memory_read — Agent 主动读取记忆文件
// ---------------------------------------------------------------------------

export function createMemoryReadTool(
  fileMemory: FileMemoryManager,
): Tool {
  return {
    name: "memory_read",
    description:
      "Read a persistent memory file. Use this to check existing memories before writing new ones. Available files: SOUL.md (agent identity), USER.md (user preferences), memory/MEMORY.md (long-term knowledge), memory/YYYY-MM-DD.md (daily logs).",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The file to read. Examples: "SOUL.md", "USER.md", "memory/MEMORY.md", "memory/2026-04-04.md".',
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
