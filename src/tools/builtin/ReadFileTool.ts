import type { Tool, ToolResult } from "../types.ts";
import { resolveAndGuard } from "./pathGuard.ts";
import { statSync } from "node:fs";
import { ContentStore, contentRefTitleFromPath } from "../../memory/ContentStore.ts";

const INLINE_FILE_SIZE = 32 * 1024;
const MAX_FILE_REF_SIZE = 5 * 1024 * 1024;

export interface ReadFileToolOptions {
  contentStore?: ContentStore;
}

export function createReadFileTool(workspaceRoot: string, options: ReadFileToolOptions = {}): Tool {
  const contentStore = options.contentStore ?? new ContentStore(workspaceRoot);

  return {
    name: "read_file",
    description:
      "Read the contents of one existing file at the given path. Small files are returned directly; larger files are stored as content_ref and can be paged with read_content_ref. You must provide a concrete non-empty file path in the path argument. Do not call read_file with empty input, a directory path, or a guessed placeholder. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Required concrete file path to read, relative to workspace root. Never omit this field.",
        },
        return_mode: {
          type: "string",
          enum: ["auto", "content_ref", "legacy"],
          description:
            "auto (default): inline small files and return content_ref for larger files. content_ref: always store and return a ref. legacy: return file text directly when under the legacy 1MB limit.",
        },
      },
      required: ["path"],
    },

    async execute(params: Record<string, unknown>, executeOptions): Promise<ToolResult> {
      const rawPath = params.path as string;
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return {
          success: false,
          output: "",
          error: "read_file path must be a non-empty string.",
        };
      }

      let safePath: string;
      try {
        safePath = resolveAndGuard(rawPath, workspaceRoot);
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const file = Bun.file(safePath);

      if (!(await file.exists())) {
        return { success: false, output: "", error: `File not found: ${safePath}` };
      }

      const returnMode = readReturnMode(params.return_mode);
      if (returnMode === "legacy" && file.size > 1024 * 1024) {
        return {
          success: false,
          output: "",
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit is 1MB.`,
        };
      }

      if (file.size > MAX_FILE_REF_SIZE) {
        return {
          success: false,
          output: "",
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit is 5MB for content refs.`,
        };
      }

      const content = await file.text();
      if (returnMode === "legacy" || (returnMode === "auto" && file.size <= INLINE_FILE_SIZE)) {
        return { success: true, output: content };
      }

      const stat = statSync(safePath);
      const effectiveContentStore = executeOptions?.contentStoreBaseDir
        ? new ContentStore(executeOptions.contentStoreBaseDir)
        : contentStore;
      const digest = await effectiveContentStore.storeText({
        sourceTool: "read_file",
        sourceUri: safePath,
        title: contentRefTitleFromPath(safePath),
        content,
        mimeType: "text/plain",
        projectContextPath: executeOptions?.projectContextPath,
        metadata: {
          file_path: safePath,
          requested_path: rawPath,
          file_size_bytes: stat.size,
          file_mtime_ms: stat.mtimeMs,
        },
      });

      return { success: true, output: JSON.stringify(digest, null, 2) };
    },
  };
}

function readReturnMode(value: unknown): "auto" | "content_ref" | "legacy" {
  if (value === "content_ref" || value === "legacy") return value;
  return "auto";
}
