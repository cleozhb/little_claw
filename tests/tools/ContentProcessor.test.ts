import { describe, expect, test } from "bun:test";
import { truncateAtSentence, extractArticleContent, summarizeContent } from "../../src/tools/builtin/ContentProcessor.ts";

describe("ContentProcessor", () => {
  describe("truncateAtSentence", () => {
    test("returns full text when under limit", () => {
      const result = truncateAtSentence("Hello world.", 100);
      expect(result).toEqual({ text: "Hello world.", truncated: false });
    });

    test("truncates at sentence boundary", () => {
      const text = "First sentence. Second sentence. Third sentence is longer.";
      const result = truncateAtSentence(text, 35);
      expect(result.truncated).toBe(true);
      expect(result.text).toBe("First sentence. Second sentence.");
    });

    test("falls back to word boundary when no sentence end in range", () => {
      const text = "one two three four five six seven eight nine ten eleven twelve";
      const result = truncateAtSentence(text, 30);
      expect(result.truncated).toBe(true);
      expect(result.text.endsWith(" ")).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(30);
    });

    test("hard cuts when no whitespace available", () => {
      const text = "a".repeat(100);
      const result = truncateAtSentence(text, 50);
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(50);
    });

    test("handles Chinese sentence endings", () => {
      const text = "第一句话。第二句话。第三句话很长很长很长。";
      const result = truncateAtSentence(text, 12);
      expect(result.truncated).toBe(true);
    });
  });

  describe("extractArticleContent", () => {
    test("extracts title from <title> tag", () => {
      const html = "<html><head><title>Test Title</title></head><body><p>Content</p></body></html>";
      const result = extractArticleContent(html);
      expect(result.title).toBe("Test Title");
    });

    test("prefers <article> content", () => {
      const html = `<html><body>
        <nav>Navigation</nav>
        <article><p>Article content here</p></article>
        <footer>Footer text</footer>
      </body></html>`;
      const result = extractArticleContent(html);
      expect(result.content).toContain("Article content here");
      expect(result.content).not.toContain("Navigation");
      expect(result.content).not.toContain("Footer text");
    });

    test("prefers <main> when no <article>", () => {
      const html = `<html><body>
        <nav>Nav</nav>
        <main><p>Main content</p></main>
        <aside>Sidebar</aside>
      </body></html>`;
      const result = extractArticleContent(html);
      expect(result.content).toContain("Main content");
    });

    test("strips script and style tags", () => {
      const html = `<html><body>
        <script>alert('xss')</script>
        <style>.foo { color: red }</style>
        <article><p>Clean content</p></article>
      </body></html>`;
      const result = extractArticleContent(html);
      expect(result.content).not.toContain("alert");
      expect(result.content).not.toContain("color");
      expect(result.content).toContain("Clean content");
    });

    test("removes noise blocks by class/id patterns", () => {
      const html = `<html><body><article>
        <p>Real content</p>
        <div class="share-buttons">Share this</div>
        <div id="comments">Comments section</div>
      </article></body></html>`;
      const result = extractArticleContent(html);
      expect(result.content).toContain("Real content");
    });

    test("counts words", () => {
      const html = "<html><body><article><p>one two three four five</p></article></body></html>";
      const result = extractArticleContent(html);
      expect(result.wordCount).toBe(5);
    });

    test("decodes HTML entities", () => {
      const html = "<html><body><article><p>A &amp; B &lt; C</p></article></body></html>";
      const result = extractArticleContent(html);
      expect(result.content).toContain("A & B < C");
    });
  });

  describe("summarizeContent", () => {
    test("calls LLM provider and returns summary", async () => {
      const mockProvider = {
        async *chat() {
          yield { type: "text_delta" as const, text: "Summary of " };
          yield { type: "text_delta" as const, text: "the content." };
        },
        getModel: () => "test-model",
        setModel: () => {},
      };

      const result = await summarizeContent("Long content here...", mockProvider as any);
      expect(result).toBe("Summary of the content.");
    });

    test("falls back to truncation on LLM failure", async () => {
      const mockProvider = {
        async *chat() {
          throw new Error("API error");
        },
        getModel: () => "test-model",
        setModel: () => {},
      };

      const content = "First sentence. Second sentence. Third sentence.";
      const result = await summarizeContent(content, mockProvider as any, { maxOutputChars: 20 });
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });
});