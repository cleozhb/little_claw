import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { MemoryStore } from "../../src/memory/MemoryStore";
import { LongTermMemoryExtractor } from "../../src/memory/LongTermMemoryExtractor";
import type { LLMProvider } from "../../src/llm/types";
import type { Message, StreamEvent } from "../../src/types/message";

const TMP = "/tmp/little_claw_identity_test";

/** Mock LLMProvider，按调用顺序返回预设文本 */
class MockLLM implements LLMProvider {
  public calls: Message[][] = [];
  constructor(private responses: string[]) {}

  async *chat(messages: Message[]): AsyncGenerator<StreamEvent> {
    this.calls.push(messages);
    const text = this.responses.shift() ?? "NONE";
    yield { type: "text_delta", text };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

/** 抛错的 Mock，模拟 LLM 调用失败 */
class ThrowingLLM implements LLMProvider {
  // eslint-disable-next-line require-yield
  async *chat(): AsyncGenerator<StreamEvent> {
    throw new Error("LLM down");
  }
}

let memoryStore: MemoryStore;

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  memoryStore = new MemoryStore(TMP);
  await memoryStore.initialize();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function userMsg(text: string): Message {
  return { role: "user", content: text };
}

describe("LongTermMemoryExtractor.extractAndUpdate", () => {
  test("writes merged MEMORY.md from new conversation", async () => {
    const llm = new MockLLM(["## 基本信息\n- 姓名：张三 (2026-06-12)"]);
    const extractor = new LongTermMemoryExtractor(memoryStore, llm);

    const result = await extractor.extractAndUpdate([userMsg("我叫张三")]);

    expect(result.status).toBe("updated");
    const memory = await memoryStore.readMemory("MEMORY.md");
    expect(memory).toContain("张三");
  });

  test("conflicting info replaces old value (new wins)", async () => {
    await memoryStore.writeMemory("MEMORY.md", "## 工作与兴趣\n- 在学钢琴 (2026-06-01)", "overwrite");

    const llm = new MockLLM(["## 工作与兴趣\n- 在学吉他 (2026-06-12)"]);
    const extractor = new LongTermMemoryExtractor(memoryStore, llm);

    await extractor.extractAndUpdate([userMsg("钢琴不学了，改学吉他")]);

    const memory = await memoryStore.readMemory("MEMORY.md");
    expect(memory).toContain("吉他");
    expect(memory).not.toContain("钢琴");
  });

  test("NONE response leaves file untouched", async () => {
    await memoryStore.writeMemory("MEMORY.md", "## 基本信息\n- 姓名：李四", "overwrite");

    const llm = new MockLLM(["NONE"]);
    const extractor = new LongTermMemoryExtractor(memoryStore, llm);

    const result = await extractor.extractAndUpdate([userMsg("今天天气不错")]);

    expect(result.status).toBe("no_candidate");
    const memory = await memoryStore.readMemory("MEMORY.md");
    expect(memory).toBe("## 基本信息\n- 姓名：李四");
  });

  test("LLM error preserves original file", async () => {
    await memoryStore.writeMemory("MEMORY.md", "## 基本信息\n- 姓名：王五", "overwrite");

    const extractor = new LongTermMemoryExtractor(memoryStore, new ThrowingLLM());
    const result = await extractor.extractAndUpdate([userMsg("我喜欢爬山")]);

    expect(result.status).toBe("failed");
    const memory = await memoryStore.readMemory("MEMORY.md");
    expect(memory).toBe("## 基本信息\n- 姓名：王五");
  });

  test("suspiciously short output is rejected to avoid data loss", async () => {
    const original = "## 基本信息\n- 姓名：赵六\n## 工作与兴趣\n- 软件工程师\n- 喜欢摄影和登山\n## 健康\n- 对花生过敏";
    await memoryStore.writeMemory("MEMORY.md", original, "overwrite");

    const llm = new MockLLM(["x"]); // 明显过短
    const extractor = new LongTermMemoryExtractor(memoryStore, llm);

    const result = await extractor.extractAndUpdate([userMsg("随便说点什么")]);

    expect(result.status).toBe("failed");
    const memory = await memoryStore.readMemory("MEMORY.md");
    expect(memory).toBe(original);
  });

  test("no user messages skips LLM entirely", async () => {
    const llm = new MockLLM(["should not be used"]);
    const extractor = new LongTermMemoryExtractor(memoryStore, llm);

    const result = await extractor.extractAndUpdate([]);

    expect(result.status).toBe("no_candidate");
    expect(llm.calls.length).toBe(0);
  });
});
