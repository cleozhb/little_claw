/**
 * scripts/backfill-identity.ts — 把历史 JSONL 对话日志回填进 0-identity/profile.md
 *
 * 自动通道只覆盖今后的对话；本脚本一次性补提取已存在的历史对话。
 * 因为每轮都是「当前 profile + 新片段 → 重写」，重复运行天然幂等。
 *
 * 用法：bun scripts/backfill-identity.ts
 */

import { FileMemoryManager } from "../src/memory/FileMemoryManager.ts";
import { IdentityExtractor } from "../src/memory/IdentityExtractor.ts";
import { loadConfig } from "../src/config/index.ts";
import { createProvider } from "../src/llm/index.ts";
import type { Message } from "../src/types/message.ts";

const config = loadConfig();
const llmProvider = createProvider({
  provider: config.llmProvider,
  apiKey: config.llmApiKey,
  model: config.llmModel,
  baseURL: config.llmBaseUrl,
});

const fileMemory = new FileMemoryManager();
await fileMemory.initialize();
const extractor = new IdentityExtractor(fileMemory.getContextHub(), llmProvider);

const logFiles = (await fileMemory.listLogFiles()).filter((p) => p.endsWith(".jsonl"));
if (logFiles.length === 0) {
  console.log("没有找到 JSONL 历史日志，无需回填。");
  process.exit(0);
}

let totalDays = 0;
const allMessages: Message[] = [];
for (const filePath of logFiles) {
  const text = await Bun.file(filePath).text();
  let dayCount = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { role: string; content: unknown };
      if (record.role === "user" && typeof record.content === "string") {
        allMessages.push({ role: "user", content: record.content });
        dayCount++;
      }
    } catch {
      // 跳过损坏行
    }
  }
  if (dayCount > 0) totalDays++;
}

if (allMessages.length === 0) {
  console.log("历史日志中没有 user 消息，无需回填。");
  process.exit(0);
}

// 分批处理：单请求文本过大会超 TPM 限流（默认 150k tokens/min）。
// 按字符预算切块，逐块喂入；profile 在块之间滚动累积，
// 跨天反复出现的话题通过累积的 profile 被识别为持续兴趣。
const CHUNK_CHARS = 30000; // ~20k tokens/请求，留足 TPM 余量
const THROTTLE_MS = 20000; // 块间等待，避免短时间打满 TPM

const chunks: Message[][] = [];
let current: Message[] = [];
let currentChars = 0;
for (const msg of allMessages) {
  const len = (msg.content as string).length;
  if (currentChars + len > CHUNK_CHARS && current.length > 0) {
    chunks.push(current);
    current = [];
    currentChars = 0;
  }
  current.push(msg);
  currentChars += len;
}
if (current.length > 0) chunks.push(current);

console.log(`共 ${totalDays} 天、${allMessages.length} 条 user 消息，分 ${chunks.length} 批处理（块间等待 ${THROTTLE_MS / 1000}s 以规避 TPM 限流）...`);

let updatedCount = 0;
for (let i = 0; i < chunks.length; i++) {
  const { updated } = await extractor.extractAndUpdate(chunks[i]!);
  if (updated) updatedCount++;
  console.log(`  批 ${i + 1}/${chunks.length}（${chunks[i]!.length} 条）→ ${updated ? "已更新" : "无变化"}`);
  if (i < chunks.length - 1) await Bun.sleep(THROTTLE_MS);
}

console.log(`\n完成，${updatedCount}/${chunks.length} 批更新了 profile。`);
console.log(`profile 路径：${fileMemory.getBaseDir()}/context-hub/0-identity/profile.md`);
