export interface Config {
  qianfanBaseUrl: string;
  qianfanApiKey: string;
  qianfanBaseModel: string;
}

export function loadConfig(): Config {
  return {
    qianfanBaseUrl: process.env.QIANFAN_BASE_URL ?? "",
    qianfanApiKey: process.env.QIANFAN_API_KEY ?? "",
    qianfanBaseModel: process.env.QIANFAN_BASE_MODEL ?? "deepseek-v3.2",
  };
}
