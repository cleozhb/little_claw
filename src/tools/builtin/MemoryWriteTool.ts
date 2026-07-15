import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";
import type { MemoryIndexer } from "../../memory/MemoryIndexer.ts";
import { normalizeMemorySourcePath } from "../../memory/MemoryIndexer.ts";

// ---------------------------------------------------------------------------
// memory_write — Agent 主动写入记忆文件
// ---------------------------------------------------------------------------
//
// 支持写入以下文件：
//   memory/MEMORY.md — 长期个人记忆
//   memory/inbox.md — 待整理记忆候选
//   memory/daily/YYYY-MM-DD.md — 每日工作笔记
// ---------------------------------------------------------------------------

export function createMemoryWriteTool(
  fileMemory: FileMemoryManager,
  memoryIndexer?: MemoryIndexer,
): Tool {
  return {
    name: "memory_write",
    description:
      "Write or append to persistent memory files.\n\n" +
      "Target files and when to use them:\n\n" +
      "- memory/MEMORY.md: Durable personal memory and collaboration preferences. Read it first before overwriting.\n" +
      "- memory/inbox.md: Unsorted memory candidates or reminders that need later review.\n" +
      "- memory/daily/YYYY-MM-DD.md: Daily work notes. Write at these moments:\n" +
      "  1. User makes a DECISION (chose X over Y)\n" +
      "  2. A task is COMPLETED (created file X, fixed bug Z)\n" +
      "  3. User shares a FACT needed later (API key location, deadline)\n" +
      "  4. An important PROBLEM was discussed (error X caused by Y)\n\n" +
      "CRITICAL RULES:\n" +
      "- Use context_write for project, area, or knowledge updates.\n" +
      "- Daily notes use format: '## HH:MM - Category\\nContent'\n" +
      "- Do NOT save: greetings, casual chat, questions without answers.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The memory file to write. Examples: "memory/MEMORY.md", "memory/inbox.md", "memory/daily/2026-07-11.md".',
        },
        content: {
          type: "string",
          description: "The content to write or append.",
        },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description:
            'Write mode: "append" adds to the end of the file (default for daily logs), "overwrite" replaces the file content.',
        },
      },
      required: ["file", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const file = params.file as string;
      const content = params.content as string;
      const mode = (params.mode as string) ?? "append";

      // context-hub/ 路径必须走 context_write 工具
      if (file.startsWith("context-hub/")) {
        return {
          success: false,
          output: "",
          error:
            "memory_write does not handle context-hub/ paths. Call the context_write tool instead, " +
            "passing the path WITHOUT the context-hub/ prefix (e.g. \"3-projects/{project}/notes.md\" " +
            "or \"4-knowledge/{topic}.md\"). It enforces the directory " +
            "rules and updates the overview index automatically.",
        };
      }

      if (!isAllowedMemoryFile(file)) {
        return {
          success: false,
          output: "",
          error:
            "memory_write only supports memory/MEMORY.md, memory/inbox.md, and memory/daily/YYYY-MM-DD.md. " +
            "Use context_write for context-hub project, area, or knowledge files.",
        };
      }

      try {
        let changed: boolean;
        if (mode === "overwrite") {
          changed = await fileMemory.writeFile(file, content);
        } else {
          changed = await fileMemory.appendToFile(file, content);
        }

        if (changed && memoryIndexer) {
          await memoryIndexer.reindexFile(normalizeMemorySourcePath(file));
        }

        return {
          success: true,
          output: changed
            ? `Successfully ${mode === "overwrite" ? "wrote" : "appended"} to ${file}`
            : `No changes made to ${file}`,
        };
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

function isAllowedMemoryFile(file: string): boolean {
  const normalized = normalizeMemorySourcePath(file);
  return normalized === "MEMORY.md" ||
    normalized === "inbox.md" ||
    /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(normalized);
}
