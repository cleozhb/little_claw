import type { Tool, ToolResult } from "../types.ts";
import { ContentStore } from "../../memory/ContentStore.ts";

export interface ReadContentRefToolOptions {
  contentStore?: ContentStore;
}

export function createReadContentRefTool(options: ReadContentRefToolOptions = {}): Tool {
  const contentStore = options.contentStore ?? new ContentStore();

  return {
    name: "read_content_ref",
    description:
      "Read a page, section, or offset slice from a long tool output stored as a content_ref. Use this after web_fetch, read_file, or another tool returns a ref_id instead of full content.",
    parameters: {
      type: "object",
      properties: {
        ref_id: {
          type: "string",
          description: "The content ref id returned by a prior tool result, for example ctx_20260623_abcd1234.",
        },
        page: {
          type: "number",
          description: "1-based page number to read. Mutually exclusive with section_id and offset/limit.",
        },
        page_size: {
          type: "number",
          description: "Characters per page. Default 3500, max 8000.",
        },
        section_id: {
          type: "string",
          description: "Section id from the content_ref digest, for example s1. Mutually exclusive with page and offset/limit.",
        },
        page_within_section: {
          type: "number",
          description: "1-based page within the selected section.",
        },
        offset: {
          type: "number",
          description: "Advanced: character offset to read from. Must be used only with limit.",
        },
        limit: {
          type: "number",
          description: "Advanced: character count for offset reads. Max 8000.",
        },
      },
      required: ["ref_id"],
    },

    async execute(params: Record<string, unknown>, executeOptions): Promise<ToolResult> {
      const refId = typeof params.ref_id === "string" ? params.ref_id.trim() : "";
      if (!refId) {
        return { success: false, output: "", error: "Missing required parameter: ref_id" };
      }

      try {
        const effectiveContentStore = executeOptions?.contentStoreBaseDir
          ? new ContentStore(executeOptions.contentStoreBaseDir)
          : contentStore;
        const result = await effectiveContentStore.readRef({
          refId,
          page: readNumber(params.page),
          pageSize: readNumber(params.page_size),
          sectionId: typeof params.section_id === "string" ? params.section_id : undefined,
          pageWithinSection: readNumber(params.page_within_section),
          offset: readNumber(params.offset),
          limit: readNumber(params.limit),
          projectContextPath: executeOptions?.projectContextPath,
        });
        return { success: true, output: JSON.stringify(result, null, 2) };
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
