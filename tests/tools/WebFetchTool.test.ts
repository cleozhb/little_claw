import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createWebFetchTool } from "../../src/tools/builtin/WebFetchTool.ts";
import { ContentStore } from "../../src/memory/ContentStore.ts";

const TMP = "/tmp/little_claw_web_fetch_test";

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("WebFetchTool", () => {
  test("fetches URL and returns content_ref digest with article mode by default", async () => {
    const html = "<html><head><title>Test Page</title></head><body><article><p>Hello World</p></article></body></html>";
    const tool = createWebFetchTool({
      contentStore: new ContentStore(TMP),
      fetchImpl: async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    const result = await tool.execute({ url: "https://example.com/page" });
    expect(result.success).toBe(true);

    const output = JSON.parse(result.output);
    expect(output.type).toBe("content_ref");
    expect(output.source).toBe("https://example.com/page");
    expect(output.title).toBe("Test Page");
    expect(output.digest).toContain("Hello World");
    expect(output.ref_id).toMatch(/^ctx_/);
  });

  test("legacy full mode uses basic HTML stripping", async () => {
    const html = `<html><body>
      <script>alert('xss')</script>
      <nav><a href="/">Home</a></nav>
      <article><h1>Title</h1><p>Content here</p></article>
      <footer>Footer text</footer>
    </body></html>`;

    const tool = createWebFetchTool({
      contentStore: new ContentStore(TMP),
      fetchImpl: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });

    const result = await tool.execute({ url: "https://example.com", mode: "full", return_mode: "legacy" });
    const output = JSON.parse(result.output);
    expect(output.mode).toBe("full");
    expect(output.content).toContain("Title");
    expect(output.content).toContain("Content here");
    expect(output.content).not.toContain("alert");
    expect(output.content).not.toContain("<script");
  });

  test("rejects missing url parameter", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required parameter: url");
  });

  test("rejects invalid URL", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "not-a-url" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  test("rejects non-http/https protocols", async () => {
    const tool = createWebFetchTool();
    const ftp = await tool.execute({ url: "ftp://files.example.com/data" });
    expect(ftp.success).toBe(false);
    expect(ftp.error).toContain("Only http/https");
  });

  test("blocks localhost and private network addresses", async () => {
    const tool = createWebFetchTool();
    const cases = [
      "http://localhost/secret",
      "http://127.0.0.1/admin",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/router",
    ];
    for (const url of cases) {
      const result = await tool.execute({ url });
      expect(result.success).toBe(false);
      expect(result.error).toContain("private/local network");
    }
  });

  test("handles HTTP error responses", async () => {
    const tool = createWebFetchTool({
      fetchImpl: async () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
    });
    const result = await tool.execute({ url: "https://example.com/missing" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  test("handles fetch network errors", async () => {
    const tool = createWebFetchTool({
      fetchImpl: async () => { throw new Error("DNS resolution failed"); },
    });
    const result = await tool.execute({ url: "https://nonexistent.example.com" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("DNS resolution failed");
  });

  test("respects max_chars with semantic truncation", async () => {
    const content = "A. B. C. D. E. F. G. " + "x".repeat(500);
    const html = `<html><body><article><p>${content}</p></article></body></html>`;
    const tool = createWebFetchTool({
      contentStore: new ContentStore(TMP),
      fetchImpl: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });

    const result = await tool.execute({ url: "https://example.com", max_chars: 200, return_mode: "legacy" });
    const output = JSON.parse(result.output);
    expect(output.content.length).toBeLessThanOrEqual(200);
    expect(output.content.length).toBeGreaterThan(0);
  });

  test("returns plain text without HTML processing for non-HTML content", async () => {
    const jsonContent = JSON.stringify({ key: "value" });
    const tool = createWebFetchTool({
      contentStore: new ContentStore(TMP),
      fetchImpl: async () =>
        new Response(jsonContent, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const result = await tool.execute({ url: "https://api.example.com/data", return_mode: "legacy" });
    const output = JSON.parse(result.output);
    expect(output.content).toContain(jsonContent);
  });

  test("digest mode honors execution content store base dir", async () => {
    const storeRoot = join(TMP, "store");
    const html = "<html><head><title>Project Page</title></head><body><article><p>Project scoped content.</p></article></body></html>";
    const tool = createWebFetchTool({
      contentStore: new ContentStore(join(TMP, "fallback")),
      fetchImpl: async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    const result = await tool.execute(
      { url: "https://example.com/project" },
      {
        contentStoreBaseDir: storeRoot,
        projectContextPath: "context-hub/3-projects/web-project",
      },
    );
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.project).toBe("web-project");
    expect(await Bun.file(join(
      storeRoot,
      "context-hub",
      "3-projects",
      "web-project",
      "content-refs",
      `${output.ref_id}.txt`,
    )).exists()).toBe(true);
  });

  test("respects timeout parameter", async () => {
    const tool = createWebFetchTool({
      fetchImpl: async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        return new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    });
    const result = await tool.execute({ url: "https://slow.example.com", timeout_ms: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
