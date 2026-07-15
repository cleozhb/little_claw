const VALID_PROVIDERS = ["openai", "anthropic"] as const;
type ProviderType = (typeof VALID_PROVIDERS)[number];

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
}

export interface SummarizerConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface Config {
  llmProvider: ProviderType;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl?: string;
  llmThinkingEnabled?: boolean;
  chat: {
    mainAgentName: string;
  };
  feishu?: FeishuChannelConfig;
  summarizer?: SummarizerConfig;
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
    llmThinkingEnabled: readOptionalBoolean(
      "LLM_THINKING_ENABLED",
      process.env.LLM_THINKING_ENABLED,
    ),
    chat: {
      mainAgentName: readAgentName(process.env.CHAT_MAIN_AGENT, "assistant"),
    },
    feishu: process.env.FEISHU_ENABLED === "true"
      ? {
          enabled: true,
          appId: process.env.FEISHU_APP_ID ?? "",
          appSecret: process.env.FEISHU_APP_SECRET ?? "",
          verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "",
          encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? undefined,
        }
      : undefined,
    summarizer: process.env.SUMMARIZER_API_KEY
      ? {
          apiKey: process.env.SUMMARIZER_API_KEY,
          baseUrl: process.env.SUMMARIZER_BASE_URL ?? process.env.LLM_BASE_URL ?? undefined,
          model: process.env.SUMMARIZER_MODEL ?? "deepseek-v3.2",
        }
      : undefined,
  };
}

function readOptionalBoolean(name: string, value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

function readAgentName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : fallback;
}
