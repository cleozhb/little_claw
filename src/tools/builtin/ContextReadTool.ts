import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";

// ---------------------------------------------------------------------------
// context_read — Agent 主动读取 context-hub 文件
// ---------------------------------------------------------------------------

export function createContextReadTool(
  fileMemory: FileMemoryManager,
): Tool {
  return {
    name: "context_read",
    description:
      "Read a context-hub file. Use this for project, area, knowledge, and archive material.\n\n" +
      "Context Hub paths:\n" +
      "- context-hub/.overview.md — global context hub overview\n" +
      "- context-hub/{path}/.overview.md — L1 directory index\n" +
      "- context-hub/2-areas/{area}/{file} — ongoing areas\n" +
      "- context-hub/3-projects/{project}/{file} — active projects\n" +
      "- context-hub/4-knowledge/{file} — reusable knowledge / SOPs\n" +
      "- context-hub/5-archive/{...} — archived items\n\n" +
      "Use memory_read for memory/MEMORY.md, memory/inbox.md, and memory/daily/YYYY-MM-DD.md.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The context-hub file to read. Examples: "context-hub/3-projects/little-claw/.overview.md", "3-projects/little-claw/status.md", "4-knowledge/sops/deployment.md".',
        },
      },
      required: ["file"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const file = params.file as string;
      if (file.startsWith("memory/") || file === "MEMORY.md" || file === "inbox.md" || file.startsWith("daily/")) {
        return {
          success: false,
          output: "",
          error: "context_read only supports context-hub files. Use memory_read for memory/ paths.",
        };
      }

      try {
        const content = await fileMemory.getContextHub().readFile(file);
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
