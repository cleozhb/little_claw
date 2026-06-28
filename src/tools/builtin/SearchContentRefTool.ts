import type { EmbeddingProvider } from "../../memory/EmbeddingProvider.ts";
import { ContentStore } from "../../memory/ContentStore.ts";
import type { Tool, ToolResult } from "../types.ts";

export interface SearchContentRefToolOptions {
  contentStore?: ContentStore;
  embeddingProvider?: EmbeddingProvider;
}

export function createSearchContentRefTool(options: SearchContentRefToolOptions = {}): Tool {
  const contentStore = options.contentStore ?? new ContentStore(undefined, {
    embeddingProvider: options.embeddingProvider,
  });

  return {
    name: "search_content_ref",
    description:
      "Search within a content_ref using local BM25 and optional embeddings. Use this to locate likely pages or sections before reading long stored tool output.",
    parameters: {
      type: "object",
      properties: {
        ref_id: {
          type: "string",
          description: "The content ref id returned by a prior tool result, for example ctx_20260623_abcd1234.",
        },
        query: {
          type: "string",
          description: "Keywords or a short natural-language query to locate relevant chunks inside the ref.",
        },
        max_results: {
          type: "number",
          description: "Maximum chunks to return. Default 5, max 10.",
        },
        page_size: {
          type: "number",
          description: "Page size used to compute read_content_ref page hints. Default 3500, max 8000.",
        },
      },
      required: ["ref_id", "query"],
    },

    async execute(params: Record<string, unknown>, executeOptions): Promise<ToolResult> {
      const refId = typeof params.ref_id === "string" ? params.ref_id.trim() : "";
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!refId) {
        return { success: false, output: "", error: "Missing required parameter: ref_id" };
      }
      if (!query) {
        return { success: false, output: "", error: "Missing required parameter: query" };
      }

      try {
        const effectiveContentStore = executeOptions?.contentStoreBaseDir
          ? new ContentStore(executeOptions.contentStoreBaseDir, {
            embeddingProvider: options.embeddingProvider,
          })
          : contentStore;
        const result = await effectiveContentStore.searchRef({
          refId,
          query,
          maxResults: readNumber(params.max_results),
          pageSize: readNumber(params.page_size),
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

