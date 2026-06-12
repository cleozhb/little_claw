import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";
import type { VectorStore } from "../../memory/VectorStore.ts";

// ---------------------------------------------------------------------------
// memory_write — Agent 主动写入记忆文件
// ---------------------------------------------------------------------------
//
// 支持写入以下文件：
//   memory/YYYY-MM-DD.md — 当天日志
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
      "- memory/YYYY-MM-DD.md (daily log): Write at these moments:\n" +
      "  1. User makes a DECISION (chose X over Y)\n" +
      "  2. A task is COMPLETED (created file X, fixed bug Z)\n" +
      "  3. User shares a FACT needed later (API key location, deadline)\n" +
      "  4. An important PROBLEM was discussed (error X caused by Y)\n\n" +
      "CRITICAL RULES:\n" +
      "- Use context_write for durable user profile, project, area, or knowledge updates.\n" +
      "- Daily logs use format: '## HH:MM - Category\\nContent'\n" +
      "- Do NOT save: greetings, casual chat, questions without answers.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            'The daily log file to write to. Format: "memory/YYYY-MM-DD.md". Always use today\'s date for daily logs.',
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
            "passing the path WITHOUT the context-hub/ prefix (e.g. \"0-identity/profile.md\", " +
            "\"1-inbox/inbox.md\", \"3-projects/{project}/notes.md\"). It enforces the directory " +
            "rules and updates the overview index automatically.",
        };
      }

      if (isLegacyMemoryFile(file)) {
        return {
          success: false,
          output: "",
          error:
            "USER.md and memory/MEMORY.md are no longer used. Use context_write for durable context, or memory/YYYY-MM-DD.md for daily logs.",
        };
      }

      try {
        if (mode === "overwrite") {
          await fileMemory.writeFile(file, content);
        } else {
          await fileMemory.appendToFile(file, content);
        }

        // 日志文件写入后同步更新向量索引
        if (vectorStore && isDailyLogFile(file)) {
          const sessionId = `file:${file}`;
          const metadata: Record<string, unknown> = {
            source: "file_memory",
            file,
            createdAt: new Date().toISOString(),
          };
          await vectorStore.store(sessionId, content, metadata);
        }

        return {
          success: true,
          output: `Successfully ${mode === "overwrite" ? "wrote" : "appended"} to ${file}`,
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

function isLegacyMemoryFile(file: string): boolean {
  return file === "USER.md" || file === "MEMORY.md" || file.endsWith("/MEMORY.md");
}

function isDailyLogFile(file: string): boolean {
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(file);
}
