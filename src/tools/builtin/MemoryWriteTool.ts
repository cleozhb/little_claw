import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";
import type { VectorStore } from "../../memory/VectorStore.ts";

// ---------------------------------------------------------------------------
// memory_write — Agent 主动写入记忆文件
// ---------------------------------------------------------------------------
//
// 支持写入以下文件：
//   USER.md              — 用户偏好
//   memory/MEMORY.md     — 长期知识
//   memory/YYYY-MM-DD.md — 当天日志
//
// SOUL.md 是只读的（由用户手动编辑），不允许 Agent 写入。
// ---------------------------------------------------------------------------

export function createMemoryWriteTool(
  fileMemory: FileMemoryManager,
  vectorStore?: VectorStore,
): Tool {
  return {
    name: "memory_write",
    description:
      "Write or append to persistent memory files.\n\n" +
      "Target files and when to use them:\n\n" +
      "- USER.md: User preferences and personal info. Append new preferences, update changed ones.\n\n" +
      "- memory/YYYY-MM-DD.md (daily log): Write at these moments:\n" +
      "  1. User makes a DECISION (chose X over Y)\n" +
      "  2. A task is COMPLETED (created file X, fixed bug Z)\n" +
      "  3. User shares a FACT needed later (API key location, deadline)\n" +
      "  4. An important PROBLEM was discussed (error X caused by Y)\n\n" +
      "- MEMORY.md: Curated long-term knowledge. Write here when:\n" +
      "  1. User explicitly says 'remember this' or 'update memory'\n" +
      "  2. A decision or preference has been confirmed multiple times\n" +
      "  3. A lesson was learned from a mistake\n" +
      "  4. Important project context that will be needed across many sessions\n\n" +
      "- SOUL.md: READ-ONLY. Never write to this file.\n\n" +
      "CRITICAL RULES:\n" +
      "- ALWAYS APPEND to MEMORY.md, never overwrite. Use '\\n## [topic]\\n' to add new sections.\n" +
      "- Remove outdated entries from MEMORY.md when information changes.\n" +
      "- Daily logs use format: '## HH:MM - Category\\nContent'\n" +
      "- Do NOT save: greetings, casual chat, questions without answers.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The file to write to. Examples: "USER.md", "memory/MEMORY.md", "memory/2026-04-04.md". Use today\'s date for daily logs.',
        },
        content: {
          type: "string",
          description: "The content to write or append.",
        },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description:
            'Write mode: "append" adds to the end of the file (default for daily logs), "overwrite" replaces the file content (use for USER.md and MEMORY.md updates).',
        },
      },
      required: ["file", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const file = params.file as string;
      const content = params.content as string;
      const mode = (params.mode as string) ?? "append";

      // SOUL.md 只读保护
      if (file === "SOUL.md" || file.endsWith("/SOUL.md")) {
        return {
          success: false,
          output: "",
          error:
            "SOUL.md is read-only. It can only be edited by the user manually.",
        };
      }

      // MEMORY.md 覆盖保护：强制改为追加，并先备份
      const isMemoryMd = file === "memory/MEMORY.md" || file === "MEMORY.md" || file.endsWith("/MEMORY.md");
      if (isMemoryMd && mode === "overwrite") {
        const current = await fileMemory.readFile(file);
        if (current) {
          await fileMemory.writeFile("memory/MEMORY.md.bak", current);
        }
      }
      const effectiveMode = isMemoryMd && mode === "overwrite" ? "append" : mode;

      try {
        if (effectiveMode === "overwrite") {
          await fileMemory.writeFile(file, content);
        } else {
          await fileMemory.appendToFile(file, content);
        }

        // 日志文件写入后同步更新向量索引
        if (vectorStore && file.startsWith("memory/") && file !== "memory/MEMORY.md") {
          const sessionId = `file:${file}`;
          const metadata: Record<string, unknown> = {
            source: "file_memory",
            file,
            createdAt: new Date().toISOString(),
          };
          await vectorStore.store(sessionId, content, metadata);
        }

        const modeNote = isMemoryMd && mode === "overwrite"
          ? " (overwrite downgraded to append; backup saved to memory/MEMORY.md.bak)"
          : "";
        return {
          success: true,
          output: `Successfully ${effectiveMode === "overwrite" ? "wrote" : "appended"} to ${file}${modeNote}`,
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
