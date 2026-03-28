import type { LLMProvider } from "../llm/types.ts";

const TITLE_SYSTEM_PROMPT =
  "Generate a concise title (max 6 words) for this conversation. Return only the title, nothing else.";

export async function generateTitle(
  llmClient: LLMProvider,
  userMessage: string,
  assistantReply: string,
): Promise<string> {
  const truncatedReply = assistantReply.slice(0, 200);
  const prompt = `User said: ${userMessage}\nAssistant replied: ${truncatedReply}`;

  let title = "";
  for await (const event of llmClient.chat(
    [{ role: "user", content: prompt }],
    { system: TITLE_SYSTEM_PROMPT },
  )) {
    if (event.type === "text_delta") {
      title += event.text;
    }
  }

  return title.trim();
}
