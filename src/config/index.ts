const VALID_PROVIDERS = ["openai", "anthropic"] as const;
type ProviderType = (typeof VALID_PROVIDERS)[number];

export interface Config {
  llmProvider: ProviderType;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl?: string;
}

export function loadConfig(): Config {
  const raw = process.env.LLM_PROVIDER ?? "openai";
  if (!VALID_PROVIDERS.includes(raw as ProviderType)) {
    throw new Error(
      `Invalid LLM_PROVIDER "${raw}". Must be one of: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
  const provider = raw as ProviderType;

  return {
    llmProvider: provider,
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "deepseek-v3.2",
    llmBaseUrl: process.env.LLM_BASE_URL ?? undefined,
  };
}
