import type { Tool, ToolResult } from "../types.ts";
import type { FileMemoryManager } from "../../memory/FileMemoryManager.ts";
import type { ContextIndexer } from "../../memory/ContextIndexer.ts";
import type { ContextMetaGenerator } from "../../memory/ContextMetaGenerator.ts";

// ---------------------------------------------------------------------------
// context_write — Agent 写入 context-hub 的工具
// ---------------------------------------------------------------------------
//
// 写入规则（按目录）：
//   2-areas/{area}/: 只写已有目录
//   3-projects/{project}/: 只写已有目录，可在目录内创建新文件
//   4-knowledge/: 可创建新文件
//   NEVER: 0-identity/ 或 1-inbox/（已迁移到 memory/）
//   NEVER: 5-archive/
//   NEVER: 创建 2-areas/ 或 3-projects/ 下的新顶层子目录
// ---------------------------------------------------------------------------

export function createContextWriteTool(
  fileMemory: FileMemoryManager,
  contextIndexer?: ContextIndexer,
  contextMetaGenerator?: ContextMetaGenerator,
): Tool {
  return {
    name: "context_write",
    description:
      "Write project, area, or knowledge information to the user's context hub. Choose the correct location:\n\n" +
      "- 2-areas/{area}/{file}: Updates to ongoing areas of focus. " +
      "Only write to EXISTING area directories.\n\n" +
      "- 3-projects/{project}/{file}: Project updates, decisions, progress. " +
      "Only write to EXISTING project directories. Can create new files within.\n\n" +
      "- 4-knowledge/{file}: Reference information, SOPs, research notes. " +
      "Can create new files here when user shares reusable knowledge.\n\n" +
      "NEVER write to: 0-identity/, 1-inbox/, or 5-archive/\n" +
      "Use memory_write for memory/MEMORY.md, memory/inbox.md, and memory/daily/YYYY-MM-DD.md.\n" +
      "NEVER create new top-level directories under 2-areas/ or 3-projects/.\n\n" +
      "After writing, the overview index is automatically updated.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Path relative to context-hub/. Examples: "3-projects/little-claw/todo.md", ' +
            '"4-knowledge/sops/deployment.md".',
        },
        content: {
          type: "string",
          description: "The content to write or append.",
        },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description:
            '"append" adds to end of file (default), "overwrite" replaces.',
        },
      },
      required: ["path", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const path = stripContextHubPrefix(params.path as string);
      const content = params.content as string;
      const mode = (params.mode as string) ?? "append";

      // --- 验证规则 ---

      if (path.startsWith("0-identity") || path.startsWith("1-inbox")) {
        return {
          success: false,
          output: "",
          error:
            "context-hub/0-identity and context-hub/1-inbox are deprecated. " +
            "Use memory_write for memory/MEMORY.md or memory/inbox.md.",
        };
      }

      // 5-archive 保护
      if (path.startsWith("5-archive")) {
        return {
          success: false,
          output: "",
          error: "Cannot write to 5-archive/. Users move items to archive manually.",
        };
      }

      if (
        !path.startsWith("2-areas/") &&
        !path.startsWith("3-projects/") &&
        !path.startsWith("4-knowledge/")
      ) {
        return {
          success: false,
          output: "",
          error:
            "context_write only supports context-hub/2-areas, context-hub/3-projects, and context-hub/4-knowledge paths.",
        };
      }

      // 2-areas/ 和 3-projects/ — 不允许创建新的顶层子目录
      if (path.startsWith("2-areas/") || path.startsWith("3-projects/")) {
        const parts = path.split("/");
        // parts[0] = "2-areas", parts[1] = area名, parts[2+] = 文件
        if (parts.length >= 2) {
          const topDir = `${parts[0]}/${parts[1]}`;
          const contextHub = fileMemory.getContextHub();
          const dirs = await contextHub.listDirectories();
          const exists = dirs.some(
            (d) => d === `context-hub/${topDir}` || d.startsWith(`context-hub/${topDir}/`),
          );
          if (!exists) {
            return {
              success: false,
              output: "",
              error:
                `Directory ${topDir}/ does not exist. ` +
                "You cannot create new top-level directories under 2-areas/ or 3-projects/. " +
                "The user defines their life structure; you only fill in content.",
            };
          }
        }
      }

      try {
        const contextHub = fileMemory.getContextHub();

        if (mode === "overwrite") {
          await contextHub.writeFile(path, content, "overwrite");
        } else {
          await contextHub.writeFile(path, content, "append");
        }

        // 写入后刷新派生元文件，确保 L0/L1 能发现新内容。
        const reindexDirs = await refreshMetaAfterWrite(
          contextHub,
          path,
          contextMetaGenerator,
        );

        // 触发检索索引增量更新
        if (contextIndexer) {
          for (const dirPath of reindexDirs) {
            try {
              await contextIndexer.reindexDir(dirPath);
            } catch {
              // 索引更新失败不阻塞写入
            }
          }
        }

        return {
          success: true,
          output: `Successfully ${mode === "overwrite" ? "wrote" : "appended"} to context-hub/${path}`,
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

/**
 * 写入后刷新对应目录的元文件。优先使用 LLM 驱动的 ContextMetaGenerator；
 * 没有 generator 时退化为“确保 overview 至少列出文件名”。
 */
async function refreshMetaAfterWrite(
  contextHub: import("../../memory/ContextHub.ts").ContextHub,
  filePath: string,
  contextMetaGenerator?: ContextMetaGenerator,
): Promise<string[]> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) return [];

  const dirPath = filePath.substring(0, lastSlash);
  const fileName = filePath.substring(lastSlash + 1);
  const isMetaFile = fileName === ".abstract.md" || fileName === ".overview.md";
  const affectedDirs = affectedMetadataDirs(filePath, dirPath);

  if (!isMetaFile && contextMetaGenerator) {
    for (const dir of affectedDirs) {
      await contextMetaGenerator.refreshDirectory(dir);
    }
    return affectedDirs;
  }

  if (!isMetaFile) {
    for (const dir of affectedDirs) {
      await updateOverviewIfNeeded(contextHub, dir, fileName);
    }
  }

  return affectedDirs;
}

async function updateOverviewIfNeeded(
  contextHub: import("../../memory/ContextHub.ts").ContextHub,
  dirPath: string,
  fileName: string,
): Promise<void> {
  const overview = await contextHub.readOverview(dirPath);
  if (!overview) return;
  if (overview.includes(fileName)) return;

  const line = `\n- ${fileName} — (auto-added ${new Date().toISOString().slice(0, 10)})`;
  await contextHub.writeFile(
    `${dirPath}/.overview.md`,
    overview + line,
    "overwrite",
  );
}

function affectedMetadataDirs(filePath: string, directDir: string): string[] {
  const dirs = new Set<string>();
  if (directDir) dirs.add(directDir);

  const parts = filePath.split("/");
  if ((parts[0] === "3-projects" || parts[0] === "2-areas") && parts[1]) {
    dirs.add(parts[0]);
    dirs.add(`${parts[0]}/${parts[1]}`);
  }

  return [...dirs];
}

function stripContextHubPrefix(path: string): string {
  return path.startsWith("context-hub/") ? path.slice("context-hub/".length) : path;
}
