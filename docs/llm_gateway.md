# LLM API 网关防 429 方案

## Summary
在本项目内实现一个内置 LLM 网关包裹层，统一保护 Chat、Embedding、Rerank 调用。网关不假设上游一定公开精确 RPM/TPM，也不假设 token 能精确计算；它通过多 API key 池、保守本地账本、并发控制、429 冷却和 usage 回填，把当前常见的 `429 Rate limit reached for TPM` 从“任务失败后重试”尽量前移成“请求发出前分流或排队”。

从 `data/little_claw.db` 看，429 主要是 TPM 限流，集中在 VC Radar、长文翻译、Prompt Arena 等大上下文/多轮任务；现有代码只会对失败任务延迟重试，不会切换 API key。因此 v1 优先解决主 Chat 链路的多 key 分流和本地限速，再扩展到 Embedding/Rerank。

## Goals
- 支持多个独立 API key：请求优先分配给仍有本地可用额度、未冷却的 key。
- 降低 TPM 429：按 key 维护本地 60 秒滑动窗口，控制 estimated tokens、RPM、并发数。
- 兼容未知配额：配额可显式配置；未配置时使用保守默认值和 429 自适应降速，而不是假装知道真实额度。
- 保留现有 AgentLoop 调用方式：在 `LLMProvider` 外包一层，不要求业务调用点逐个改造。
- 让后台小调用少占预算：健康检查、标题、摘要、meta、identity 等设置较小输出预算。

## Key Changes
- 新增 `MultiKeyRateLimitedLLMProvider`：包装 OpenAI/Anthropic provider 池，对外仍实现 `LLMProvider`。
- 扩展 LLM 配置：
  - 兼容现有 `LLM_API_KEY`。
  - 新增 `LLM_API_KEYS`，逗号分隔多个 key。
  - 可选新增 `LLM_KEY_CONFIGS`，JSON 数组，允许为每个 key 配置 `provider/model/baseURL/rpm/tpm/maxConcurrency/weight`。
- 新增 `LLMKeyPool`：按 key 维护状态，包括 60 秒滑动窗口、inFlight、cooldownUntil、last429、估算/真实 usage、连续失败次数。
- 新增 `LLMGateway`：在请求发出前选择 key；若没有 key 可容纳请求，则按最早可用时间排队；队列超时返回本地错误。
- 新增 token 估算器：序列化 `system + messages + tools`，用字符数/语言比例做保守估算；output tokens 按 `ChatOptions.maxOutputTokens` 或 provider 默认值预占；请求结束后用 `message_end.usage` 回填并校准估算系数。
- 扩展 `ChatOptions`：
  - `maxOutputTokens?: number`
  - `requestClass?: "interactive" | "background" | "health"`
- 更新 provider：OpenAI/Anthropic 都读取 `options.maxOutputTokens`，替代硬编码/全局默认。
- 给后台调用设置较小输出预算：health=1、title=64、summary/meta/identity 按 1024-2048，主 Agent 保持 `LLM_MAX_OUTPUT_TOKENS`。
- 包装 Embedding/Rerank：新增 `RateLimitedEmbeddingProvider` 和 `RateLimitedReranker`，用输入文本估算 token；无 usage 的接口按估算值记账。
- 增加观测：记录 keyId、estimated/actual tokens、queuedMs、status、last429、cooldownUntil、queue length；提供 `/api/llm-gateway/status` 查看各 key 当前窗口和等待时间。

## Config
- `LLM_GATEWAY_ENABLED=true`
- `LLM_API_KEY=...`：单 key 兼容模式。
- `LLM_API_KEYS=key1,key2,key3`：多 key 简单模式，所有 key 共用 `LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL`。
- `LLM_KEY_CONFIGS='[{"id":"qianfan-a","apiKey":"...","provider":"openai","model":"deepseek-v3.2","baseURL":"https://qianfan.baidubce.com/v2","tpm":30000,"rpm":60,"maxConcurrency":2}]'`：多 key 高级模式。
- `LLM_RATE_LIMIT_RPM`, `LLM_RATE_LIMIT_TPM`, `LLM_GATEWAY_MAX_CONCURRENCY`：全局默认限额；key 未单独配置时使用。
- `LLM_GATEWAY_SAFETY_RATIO=0.75`：默认更保守，因为千帆配额和 tokenizer 不一定公开。
- `LLM_GATEWAY_QUEUE_TIMEOUT_MS=300000`
- `LLM_GATEWAY_UNKNOWN_TPM=12000`：未配置 TPM 时的保守启动值，可被 429 自适应下调。
- `EMBEDDING_RATE_LIMIT_RPM/TPM`, `RERANK_RATE_LIMIT_RPM/TPM` 可选；未配置时使用各自保守默认值，不直接复用 Chat 限额。

## Behavior
- 请求进入网关后计算 `estimatedInput + reservedOutput`。
- 网关从 key 池里选择一个未冷却、并发未满、当前窗口可容纳该估算量的 key。
- 如果多个 key 都可用，优先选择剩余额度更多、inFlight 更少、近期 429 更少的 key。
- 如果没有 key 可用，请求进入本地队列，等某个 key 的窗口释放或 cooldown 结束。
- 如果单个请求估算值超过某个 key 的 `TPM * safetyRatio`，该 key 不接这个请求；如果所有 key 都接不下，返回本地错误，提示缩短上下文或降低 `maxOutputTokens`。
- 如果上游仍返回 429，网关解析 retry-after/错误信息；命中的 key 进入 cooldown，并记录 token debt；请求可在有限次数内切换到其他健康 key 重试。
- 如果所有 key 都返回 429，整个池进入短暂退避，避免任务层立即重试继续撞同一个 TPM 窗口。
- 请求结束后，如果 provider 返回 usage，用真实 input/output tokens 调整本地账本；如果无 usage，按估算值记账。

## Token And Quota Notes
- “预留 token”只是本地账本预占，不是向上游申请或锁定额度。
- 千帆等平台如果不公开 key/model 的 RPM/TPM，本项目无法自动知道真实配额；需要用户配置，或从保守默认值开始，通过 429 反馈逐步降速。
- token 估算不追求精确。不同模型 tokenizer 不透明时，使用偏保守估算和 safety ratio，宁可本地多排队，也不要把请求打到上游变成 429。
- 真实 usage 是最可靠的校准来源。OpenAI-compatible streaming 已可在最终 chunk 返回 usage；无 usage 的接口按估算记账。

## Implementation Order
1. 扩展 `ChatOptions.maxOutputTokens/requestClass`，让 provider 使用 per-request `max_tokens`。
2. 实现 token 估算器和 60 秒滑动窗口账本。
3. 实现单 key `RateLimitedLLMProvider`，先保护现有 `LLM_API_KEY`。
4. 实现 `LLM_API_KEYS` / `LLM_KEY_CONFIGS` 多 key 池和 key 选择策略。
5. 接入 429 cooldown、retry-after 解析、跨 key 有限重试。
6. 给 health/title/summary/meta/identity 等后台调用设置较小 `maxOutputTokens`。
7. 扩展到 Embedding/Rerank。
8. 增加 `/api/llm-gateway/status` 和结构化日志。

## Test Plan
- `bun test` 新增网关单测：token 估算、滑动窗口、排队释放、队列超时、AbortSignal 取消。
- key 池测试：多 key 选择、并发限制、某个 key cooldown 后切换到备用 key、所有 key 冷却时排队。
- provider 包裹层测试：mock LLM usage 校准、streaming 事件透传、429 后 cooldown 和跨 key 重试。
- 集成测试：多个 sub-agent 并发调用时只排队/分流，不直冲同一个上游 key。
- Embedding/Rerank 测试：缓存命中不重复记账，未命中按估算记账。
- 回归测试：`bun test` 全量跑通，确保现有 AgentLoop、simulation、gateway tests 行为不变。

## Assumptions
- v1 做内置网关，不做独立 HTTP 代理。
- v1 优先覆盖 Chat，因为现有 429 日志主要来自主 LLM TPM；随后覆盖 Embedding/Rerank。
- 多 API key 只有在上游按 key 分配独立配额时才会显著缓解；如果上游按账号/项目共享限额，多 key 只能提供冷却隔离和观测价值，不能突破总 TPM。
- 默认策略是分流或排队，不主动压缩上下文；只有单请求超过所有 key 的分钟 token 上限时才本地失败。
- 若同一个 API key 还有本项目外流量，网关无法完全保证不触发 429，但会通过安全余量、冷却和真实 usage 校准降低风险。
