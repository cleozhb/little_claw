import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { LocalEmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { ContentStore } from "../../src/memory/ContentStore.ts";
import { createReadContentRefTool } from "../../src/tools/builtin/ReadContentRefTool.ts";
import { createSearchContentRefTool } from "../../src/tools/builtin/SearchContentRefTool.ts";

const TMP = "/tmp/little_claw_search_content_ref_test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("search_content_ref returns page and section hints for relevant chunks", async () => {
  const embeddingProvider = new LocalEmbeddingProvider();
  const contentStore = new ContentStore(TMP, { embeddingProvider });
  const digest = await contentStore.storeText({
    sourceTool: "test",
    sourceUri: "https://example.com/funding",
    title: "Funding Note",
    content: [
      "# Intro",
      "weather lunch notes ".repeat(250),
      "# Funding",
      "General Intuition raised $300M from Khosla and Bezos Expeditions for robotics world models.",
      "robotics valuation investors ".repeat(160),
      "# Appendix",
      "coffee garden unrelated ".repeat(500),
    ].join("\n"),
  });
  const searchTool = createSearchContentRefTool({ contentStore, embeddingProvider });

  const result = await searchTool.execute({
    ref_id: digest.ref_id,
    query: "robotics valuation investors",
    max_results: 3,
  });

  expect(result.success).toBe(true);
  const output = JSON.parse(result.output);
  expect(output.mode).toBe("hybrid");
  expect(output.results.length).toBeGreaterThan(0);
  expect(output.results[0].snippet).toContain("robotics");
  expect(output.results[0].page).toBeGreaterThanOrEqual(1);
  expect(output.results[0].read_page).toContain("read_content_ref");
  expect(await Bun.file(join(TMP, "content-store.sqlite")).exists()).toBe(true);

  const readTool = createReadContentRefTool({ contentStore });
  const page = await readTool.execute({ ref_id: digest.ref_id, page: output.results[0].page });
  expect(page.success).toBe(true);
  expect(JSON.parse(page.output).content).toContain("robotics");
});

test("search_content_ref falls back to BM25 without embeddings", async () => {
  const contentStore = new ContentStore(TMP);
  const digest = await contentStore.storeText({
    sourceTool: "test",
    title: "API Notes",
    content: "read_content_ref and API_KEY handling should be easy to find. ".repeat(300),
  });
  const searchTool = createSearchContentRefTool({ contentStore });

  const result = await searchTool.execute({
    ref_id: digest.ref_id,
    query: "API_KEY read_content_ref",
  });

  expect(result.success).toBe(true);
  const output = JSON.parse(result.output);
  expect(output.mode).toBe("bm25");
  expect(output.results[0].match_reason).toContain("api_key");
});

test("search_content_ref reports embedding errors but still returns BM25 results", async () => {
  const embeddingProvider: EmbeddingProvider = {
    getSignature: () => "failing-test",
    embed: async () => {
      throw new Error("embedding offline");
    },
  };
  const contentStore = new ContentStore(TMP, { embeddingProvider });
  const digest = await contentStore.storeText({
    sourceTool: "test",
    title: "Fallback Note",
    content: "funding robotics investors ".repeat(300),
  });
  const searchTool = createSearchContentRefTool({ contentStore, embeddingProvider });

  const result = await searchTool.execute({
    ref_id: digest.ref_id,
    query: "funding robotics",
  });

  expect(result.success).toBe(true);
  const output = JSON.parse(result.output);
  expect(output.mode).toBe("bm25");
  expect(output.embedding_error).toContain("embedding offline");
  expect(output.results.length).toBeGreaterThan(0);
});

