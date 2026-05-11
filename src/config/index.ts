const VALID_PROVIDERS = ["openai", "anthropic"] as const;
type ProviderType = (typeof VALID_PROVIDERS)[number];

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
}

export interface Config {
  llmProvider: ProviderType;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl?: string;
  chat: {
    mainAgentName: string;
  };
  feishu?: FeishuChannelConfig;
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
  };
}

function readAgentName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : fallback;
}
