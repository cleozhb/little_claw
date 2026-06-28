import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/index.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadConfig", () => {
  test("reads chat main agent from CHAT_MAIN_AGENT", () => {
    process.env.CHAT_MAIN_AGENT = "assistant";

    expect(loadConfig().chat.mainAgentName).toBe("assistant");
  });

  test("falls back to assistant for blank or invalid chat main agent", () => {
    process.env.CHAT_MAIN_AGENT = " ";
    expect(loadConfig().chat.mainAgentName).toBe("assistant");

    process.env.CHAT_MAIN_AGENT = "../bad";
    expect(loadConfig().chat.mainAgentName).toBe("assistant");
  });

  test("reads summarizer provider config from SUMMARIZER_API_KEY", () => {
    process.env.SUMMARIZER_API_KEY = "sum-key";
    process.env.SUMMARIZER_BASE_URL = "https://summarizer.example/v1";
    process.env.SUMMARIZER_MODEL = "summary-model";

    expect(loadConfig().summarizer).toEqual({
      apiKey: "sum-key",
      baseUrl: "https://summarizer.example/v1",
      model: "summary-model",
    });
  });
});
