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
      "Read a persistent memory or context-hub file. Use this to check existing content before writing new entries.\n\n" +
      "Memory files:\n" +
      "- SOUL.md (agent identity)\n" +
      "- memory/YYYY-MM-DD.md (daily logs)\n\n" +
      "Context Hub (three-layer system, navigate L0 → L1 → L2):\n" +
      '- context-hub/{path}/.overview.md — L1 directory index, "WHERE to look + WHAT each file contains"\n' +
      "- context-hub/0-identity/profile.md — user profile (always preloaded)\n" +
      "- context-hub/1-inbox/inbox.md — todos / fleeting ideas (always preloaded)\n" +
      "- context-hub/2-areas/{area}/{file} — ongoing focus areas\n" +
      "- context-hub/3-projects/{project}/{file} — active projects\n" +
      "- context-hub/4-knowledge/{file} — reusable knowledge / SOPs\n" +
      "- context-hub/5-archive/{...} — archived items (read-only via this tool)",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The file to read. Examples: "SOUL.md", "memory/2026-04-04.md", "context-hub/3-projects/little-claw/.overview.md", "context-hub/4-knowledge/sops/deployment.md".',
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
