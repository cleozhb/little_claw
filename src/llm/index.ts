export type { LLMProvider, ChatOptions, ToolDefinition } from "./types.ts";
export { OpenAIProvider } from "./OpenAIProvider.ts";
export { AnthropicProvider } from "./AnthropicProvider.ts";

import type { LLMProvider } from "./types.ts";
import { OpenAIProvider } from "./OpenAIProvider.ts";
import { AnthropicProvider } from "./AnthropicProvider.ts";

export interface ProviderConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Explicit provider thinking-mode switch; undefined leaves provider defaults untouched. */
  thinkingEnabled?: boolean;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(
        config.apiKey,
        config.model,
        config.baseURL,
        config.thinkingEnabled,
      );
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.model, config.baseURL);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
