import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { ContextMetaGenerator } from "../../src/memory/ContextMetaGenerator";
import { FileMemoryManager } from "../../src/memory/FileMemoryManager";
import { createContextWriteTool } from "../../src/tools/builtin/ContextWriteTool";
import type { ChatOptions, LLMProvider } from "../../src/llm/types";
import type { Message, StreamEvent } from "../../src/types/message";

const TMP = "/tmp/little_claw_context_write_tool_test";

class FakeLLMProvider implements LLMProvider {
  async *chat(messages: Message[], _options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const prompt = String(messages[0]?.content ?? "");
    const text = prompt.includes("single line")
      ? "Podcast translation feeds, status, and curation workspace."
      : "# Podcast Translation\n\n## Key files\n- status.md — project status.\n- feeds.json — subscribed podcast RSS feeds.\n";
    yield { type: "text_delta", text };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  getModel(): string {
    return "fake";
  }

  setModel(_model: string): void {}
}

let fileMemory: FileMemoryManager;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  fileMemory = new FileMemoryManager(TMP);
  await fileMemory.initialize();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("context_write refreshes project overview after writing a project file", async () => {
  const hub = fileMemory.getContextHub();
  await hub.writeFile(
    "3-projects/podcast-translation/.abstract.md",
    "Podcast translation project.",
    "overwrite",
  );
  await hub.writeFile(
    "3-projects/podcast-translation/.overview.md",
    "# Podcast Translation\n\n## Key files\n- status.md — project status.\n",
    "overwrite",
  );
  await hub.writeFile(
    "3-projects/podcast-translation/status.md",
    "# Status\n\nActive.\n",
    "overwrite",
  );

  const metaGenerator = new ContextMetaGenerator(hub, new FakeLLMProvider());
  const tool = createContextWriteTool(fileMemory, undefined, metaGenerator);

  const result = await tool.execute({
    path: "3-projects/podcast-translation/feeds.json",
    content: JSON.stringify([{ title: "Example Show", url: "https://example.com/feed.xml" }]),
    mode: "overwrite",
  });

  expect(result.success).toBe(true);
  expect(await hub.readOverview("3-projects/podcast-translation")).toContain("feeds.json");
  expect(await hub.readFile("3-projects/podcast-translation/.abstract.md")).toContain(
    "Podcast translation feeds",
  );
});
