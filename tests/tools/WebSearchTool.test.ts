import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "../../src/tools/builtin/WebSearchTool.ts";

describe("WebSearchTool", () => {
  test("calls Tavily search API and normalizes output", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          query: "best ai podcasts",
          answer: "A short answer",
          results: [
            {
              title: "Result one",
              url: "https://example.com/one",
              content: "Useful result",
              score: 0.91,
              raw_content: "raw content should not be returned",
            },
          ],
          response_time: 0.12,
          request_id: "req_123",
        }), { status: 200 });
      },
    });

    const result = await tool.execute({
      query: "best ai podcasts",
      max_results: 3,
      search_depth: "advanced",
      topic: "news",
      include_answer: true,
      include_domains: ["example.com"],
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://tavily.test/search");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");

    const output = JSON.parse(result.output);
    expect(output.answer).toBe("A short answer");
    expect(output.results[0].title).toBe("Result one");
    expect(output.results[0].content).toBe("Useful result");
    expect(output.results[0].content_truncated_chars).toBe(0);
    expect(output.results[0].raw_content).toBeUndefined();
  });

  test("defaults to compact output with semantic truncation", async () => {
    const longContent = "First sentence here. Second sentence follows. " + "x".repeat(1_000);
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({
          query: "ai funding",
          results: [
            { title: "Long result", url: "https://example.com/long", content: longContent, score: 0.8 },
          ],
        }), { status: 200 }),
    });

    const result = await tool.execute({ query: "ai funding" });
    const output = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(output.results[0].content.length).toBeLessThanOrEqual(360);
    expect(output.results[0].content_truncated_chars).toBeGreaterThan(0);
  });

  test("supports full output mode", async () => {
    const longContent = "y".repeat(1_000);
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({
          query: "ai funding",
          results: [
            { title: "Long result", url: "https://example.com/long", content: longContent, score: 0.9 },
          ],
        }), { status: 200 }),
    });

    const result = await tool.execute({ query: "ai funding", mode: "full" });
    const output = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(output.results[0].content).toBe(longContent);
    expect(output.results[0].content_truncated_chars).toBeUndefined();
  });

  test("limitOutputSize removes low-score results when output exceeds limit", async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: "x".repeat(2000),
      score: i * 0.05,
    }));
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({ query: "test", results }), { status: 200 }),
    });

    const result = await tool.execute({ query: "test", mode: "full" });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(20_100);
    const output = JSON.parse(result.output);
    expect(output.results_omitted).toBeGreaterThan(0);
  });

  test("clamps compact content_max_chars to upper bound", async () => {
    const longContent = "z".repeat(4_500);
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({
          query: "ai funding",
          results: [
            { title: "Long result", url: "https://example.com/long", content: longContent, score: 0.5 },
          ],
        }), { status: 200 }),
    });

    const result = await tool.execute({ query: "ai funding", content_max_chars: 10_000 });
    const output = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(output.results[0].content.length).toBeLessThanOrEqual(4_000);
    expect(output.results[0].content_truncated_chars).toBeGreaterThan(0);
  });

  test("fails clearly when API key is missing", async () => {
    const oldKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      const tool = createWebSearchTool();
      const result = await tool.execute({ query: "podcast" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("TAVILY_API_KEY");
    } finally {
      if (oldKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = oldKey;
    }
  });

  test("returns Tavily error details", async () => {
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: "bad request" }), { status: 400 }),
    });

    const result = await tool.execute({ query: "podcast" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tavily search failed (400): bad request");
  });

  test("summary mode falls back to compact when no llmProvider", async () => {
    const longContent = "First sentence. " + "x".repeat(1_000);
    const tool = createWebSearchTool({
      apiKey: "test-key",
      endpoint: "https://tavily.test/search",
      fetchImpl: async () =>
        new Response(JSON.stringify({
          query: "test",
          results: [{ title: "R", url: "https://example.com", content: longContent, score: 0.9 }],
        }), { status: 200 }),
    });

    const result = await tool.execute({ query: "test", mode: "summary" });
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.results[0].content.length).toBeLessThanOrEqual(360);
  });
});