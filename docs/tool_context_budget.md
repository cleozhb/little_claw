# 工具输出上下文预算方案

## Summary

单独实现一套工具输出上下文预算机制，解决 web_search、web_fetch、read_file、sub-agent 等工具结果过长，导致 Agent 对话上下文随轮次无限增长、最终触发 LLM TPM 429 的问题。

本方案不解决 API key 限流和请求排队问题；那部分归 `docs/llm_gateway.md`。这里聚焦在：长内容不直接进入 LLM 上下文，而是落到本地内容仓库，返回引用、分层摘要和可分页读取的片段。Agent 需要更多细节时，通过引用 ID 按页或按 section 读取。

## Problem

当前 AgentLoop 会把工具返回的 `result.output` 原样写入 conversation 的 `tool_result`，下一轮继续发给 LLM。工具自身虽有一些限制，但仍会造成上下文膨胀：

- `web_search` 默认 compact，但整体 JSON 仍可到 20k 字符。
- `web_fetch` 默认 article 8k，full 20k，多个 fetch 叠加后很快变大。
- `read_file` 对 1MB 以下文件返回全文。
- 长任务会把搜索结果、网页正文、raw JSON、status.md、重试历史、人工注入一起累积。
- VC Radar 这类任务会多次搜索和抓取网页，收尾阶段 prompt 变大，容易触发 `429 Rate limit reached for TPM`。

因此，429 的一部分根因不是请求频率，而是每次请求的输入 token 越滚越大。

## Goals

- 长工具输出默认不直接进入 LLM 上下文。
- 工具返回短 digest：来源、引用 ID、摘要、关键字段、可读取范围。
- 原始长内容持久化到本地内容仓库，可复查、可分页读取。
- 支持分层内容视图：L0 文档卡片、L1 文档摘要、L2 section 摘要、L3 chunk 摘要。
- 摘要生成不能挤占主 Agent TPM：优先使用 `SUMMARIZER_API_KEY`，没有 summarizer 时使用无 LLM 降级摘要。
- Agent 想看全文时，必须显式按引用分页读取，而不是一次性把全文塞回上下文。
- 在 AgentLoop 层尽早增加工具结果预算兜底，即使具体工具尚未改造，也不能让超长输出直接进入 conversation。
- 对现有工具调用保持兼容，优先改造高风险工具：web_fetch、web_search、read_file、spawn_agent。

## Non-Goals

- 不做 LLM API 限流、多 key 分流、429 cooldown。
- 不改变业务 Agent 的核心任务目标。
- 不保证所有内容都能被完美摘要；摘要只是上下文预算策略，不是事实来源替代。
- 不把网页全文永久塞进 SQLite 的 tool_results；tool_results 只保存 digest 和引用。

## Design

### 1. Content Store

新增本地内容仓库，用于保存长工具输出和元数据。Content Store 本质上不是“只加一张 SQLite 表”，而是 SQLite 元数据索引 + 大文本文件存储的组合：SQLite 负责查找、摘要、section/chunk 索引和生命周期管理；原始正文放在文件中，避免把 `little_claw.db` 撑成大块头。

存储位置约束：

凡是工具调用发生在有 project 上下文的任务里，长内容必须写入该 project 的 context-hub 工作目录，不写入新的全局内容目录。Content Store 是“项目目录中文件的索引层”，不是新的内容归宿。

默认项目级存储位置：

```text
~/.little_claw/context-hub/3-projects/{project}/
  sources.json
  status.md
  raw-2026-06-23.json
  content-refs/
    ctx_20260623_abcd1234.txt
    ctx_20260623_abcd1234.meta.json
```

例如 VC Radar 的网页正文、搜索原始材料、长文摘录都应放在：

```text
~/.little_claw/context-hub/3-projects/venture-radar/content-refs/
```

无 project 上下文的临时会话 fallback 到用户级目录，仍然放在 `~/.little_claw` 下，而不是 workspace `data/` 下：

```text
~/.little_claw/content-refs/
  ctx_20260623_abcd1234.txt
  ctx_20260623_abcd1234.meta.json
```

约束：有 project 的内容优先归属 project context-hub；只有无法确定 project 的临时会话、系统级工具调用或跨项目复用缓存，才写入 `~/.little_claw/content-refs/`。

SQLite 表设计：

```sql
CREATE TABLE IF NOT EXISTS content_refs (
  id TEXT PRIMARY KEY,
  project TEXT,
  source_tool TEXT NOT NULL,
  source_uri TEXT,
  title TEXT,
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT,
  summary_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_refs_hash
  ON content_refs (content_hash);

CREATE INDEX IF NOT EXISTS idx_content_refs_source
  ON content_refs (source_tool, source_uri);

CREATE INDEX IF NOT EXISTS idx_content_refs_project
  ON content_refs (project, created_at);

CREATE INDEX IF NOT EXISTS idx_content_refs_expires
  ON content_refs (expires_at);
```

`content_refs` 只保存引用级元数据：

- `id`: 引用 ID，例如 `ctx_20260623_abcd1234`
- `project`: project 名称，例如 `venture-radar`；无 project 的临时会话可为空
- `source_tool`: `web_fetch` / `web_search` / `read_file` / `spawn_agent`
- `source_uri`: URL、文件路径、sub-agent id 等
- `title`: 页面标题、文件名或 sub-agent 任务标题
- `content_hash`: 原始正文 hash，用于去重和校验
- `content_length`: 原始正文字符数
- `storage_path`: 正文文件路径
- `mime_type`: `text/html`、`text/plain`、`application/json` 等
- `created_at` / `expires_at`: 生命周期管理
- `metadata_json`: URL、final_url、HTTP headers、file mtime、file hash、agent name、last_accessed_at 等来源信息
- `summary_json`: L0/L1 摘要、关键点、标签、风险提示、摘要生成方式等

section 和 chunk 拆表保存，方便分页读取和精确定位：

```sql
CREATE TABLE IF NOT EXISTS content_ref_sections (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_sections_ref_section
  ON content_ref_sections (ref_id, section_id);

CREATE INDEX IF NOT EXISTS idx_content_ref_sections_ref_ordinal
  ON content_ref_sections (ref_id, ordinal);

CREATE TABLE IF NOT EXISTS content_ref_chunks (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  summary TEXT,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  token_estimate INTEGER,
  FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_chunks_ref_index
  ON content_ref_chunks (ref_id, chunk_index);

CREATE TABLE IF NOT EXISTS content_ref_chunk_index (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  project TEXT,
  title TEXT,
  chunk_text TEXT NOT NULL,
  keywords TEXT NOT NULL,
  embedding TEXT,
  embedding_status TEXT NOT NULL,
  embedding_signature TEXT,
  bm25_length INTEGER NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES content_ref_chunks(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_chunk_index_chunk
  ON content_ref_chunk_index (chunk_id);

CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_ref
  ON content_ref_chunk_index (ref_id);

CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_project
  ON content_ref_chunk_index (project, updated_at);

CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_embedding
  ON content_ref_chunk_index (embedding_status, embedding_signature);
```

读取流程：

1. `web_fetch` / `read_file` 等工具拿到长文本。
2. 从任务、channel 或 AgentWorker 上下文读取 `project`。
3. 计算 `content_hash`，如果同一 project 下 hash 已存在，复用旧 `ref_id`。
4. 如果是新内容，有 project 时把正文写入 `~/.little_claw/context-hub/3-projects/{project}/content-refs/{refId}.txt`；无 project 时写入 `~/.little_claw/content-refs/{refId}.txt`。
5. 写入 `content_refs` 元数据，记录 `project` 和 `storage_path`。
6. 同步生成 L0 文档卡片和 L1 轻摘要；section/chunk 边界可以同步生成，但 L2/L3 摘要默认 lazy 生成。
7. 为 chunk 建立 Content Store 专用检索索引：写入 `content_ref_chunk_index`，包含 chunk 文本、BM25 keywords、embedding、embedding_signature 和状态。embedding 可同步处理少量关键 chunk，也可后台补齐；embedding 失败时标记 `embedding_status=failed` 并允许 BM25 fallback。
8. 工具返回 digest，其中包含 `ref_id`、project、L0/L1 摘要、少量已有 section 标题/范围和读取方式。
8. `read_content_ref` 根据 `ref_id` 查 `storage_path`，再按 `page`、`section_id` 或 `offset/limit` 从文件中切片返回。

正文文件命名：

```text
{refId}.txt
```

`refId` 生成规则：

```text
ctx_{yyyyMMdd}_{hashPrefix}
```

其中 `hashPrefix` 取 `sha256(content).slice(0, 12)`。如果同一天同 hash 已存在，直接返回已有 ref；如果不同来源得到相同内容，可以在 `metadata_json` 里追加来源记录，避免重复存储。

清理规则：

- ref 默认代表创建时的内容快照。`read_content_ref` 读取的是 `storage_path` 中保存的旧内容，不自动重新读取原 URL 或源文件。
- `read_file` 来源的 ref 需要保存创建时的 file size、mtime、hash；如果当前源文件已变化，读取结果返回 `source_changed: true`，但仍返回旧快照。Agent 如需新版本，必须重新调用 `read_file` 创建新 ref。
- 过期清理先删 SQLite 行，再删对应正文文件。
- 删除 `content_refs` 时通过外键级联删除 section/chunk。
- 若文件缺失但 SQLite 行存在，`read_content_ref` 返回本地错误，并提示 ref 已损坏或被清理。
- 默认临时网页 ref 保留 7 天；v1 不做每个 agent/skill 的保留策略配置，后续确有项目差异需求再扩展。
- project 目录下的 ref 清理要尊重该 project 的保留策略；不能因为全局 TTL 直接删除项目工作材料。
- GC 按 `expires_at`、project retention、`last_accessed_at` 和总磁盘占用执行；无 project 的临时 ref 在 `~/.little_claw/content-refs/` 下自动清理，project ref 默认只在项目清理命令或显式策略下删除。

这样设计后，`tool_results` 表只保存短 digest 和 `ref_id`，不会保存大段正文；长内容仍可追溯、可分页读取、可清理。

### 2. Tool Result Digest

工具返回给 Agent 的不再是全文，而是短 digest。

示例：

```json
{
  "type": "content_ref",
  "ref_id": "ctx_20260623_abcd1234",
  "source": "https://example.com/article",
  "title": "Article Title",
  "content_length": 48231,
  "digest": "这篇文章主要讨论...",
  "key_points": [
    "General Intuition 获得 3 亿美元融资",
    "投资方包括 Khosla、Bezos Expeditions 等",
    "与 world model / robotics 方向相关"
  ],
  "sections": [
    { "section_id": "s1", "title": "Funding", "summary": "融资金额、估值、投资方", "char_start": 0, "char_end": 6200 },
    { "section_id": "s2", "title": "Product", "summary": "产品与技术路线", "char_start": 6200, "char_end": 14000 }
  ],
  "read_tools": {
    "read_page": "read_content_ref(ref_id, page)",
    "read_section": "read_content_ref(ref_id, section_id)",
    "search_within": "search_content_ref(ref_id, query)"
  }
}
```

这个 digest 可以安全进入上下文，因为它短、结构化、可追溯。

预算不写死为单一常量，而是采用目标值 + 硬上限：

- 单个 digest 目标 1k-2k 字符，硬上限 4k 字符。
- 单轮工具结果合计目标 8k-12k 字符，硬上限通过配置控制。
- `sections` 默认只返回 top 5-8 个摘要或标题，不返回完整 section 列表。
- `read_tools` 说明不在每个 digest 中重复大段描述，尽量依赖工具 schema。

### 3. 分层内容视图与摘要生成

需要做分层内容视图。原因是长内容只做一层摘要会丢细节；而直接分页又会让 Agent 不知道该读哪页。

推荐四级视图：

- L0 文档卡片：标题、来源、时间、作者、内容长度、主题标签、可信度、适用任务。L0 不算 LLM 摘要，优先由规则抽取。
- L1 文档摘要：300-800 字，回答“这是什么，为什么重要”。
- L2 section 摘要：按标题/段落/语义边界切分，每段 100-300 字摘要，带字符范围。
- L3 chunk 摘要：固定 2k-4k 字符 chunk 的一句话摘要，用于精确定位。

摘要生成策略：

- 同步生成：L0 + L1。工具必须尽快返回 ref digest，不能因为完整分层摘要阻塞太久。
- Lazy 生成：L2/L3 默认不在 `web_fetch` 同步阶段全部生成，只在确实需要时生成相关局部摘要。
- Lazy 触发时机：
  - Agent 调用 `read_content_ref(ref_id, section_id)`，且该 section 没有 L2 摘要时，为该 section 生成 L2。
  - Agent 调用 `read_content_ref(ref_id, page)`，且返回页对应 chunk 没有 L3 摘要时，为该页附近 1-2 个 chunk 生成 L3。
  - Agent 调用 `search_content_ref(ref_id, query)`，先用已有向量/关键词索引召回候选 chunk；只有候选 chunk 缺少摘要且需要展示给 Agent 时，才为候选生成 L3。
  - Agent 没有读取到某 section/page 时，不为那部分内容生成 L2/L3。
- 后台预生成：空闲时可以为高价值 ref 预生成 L2/L3，但必须走 summarizer provider 的独立预算，不阻塞当前工具返回。
- Token 策略：lazy 不是“最终都要摘要”，而是只摘要被读取、被检索命中、或被项目策略标记为高价值的局部内容；未被使用的 section/chunk 不消耗摘要 token。
- 优先使用 `SUMMARIZER_API_KEY` / summarizer provider，避免挤占主 Agent 的 TPM。
- 如果没有 summarizer、summarizer 限流或摘要失败，使用无 LLM 降级摘要：标题、前 N 字符、首段、标题层级、关键词、来源元数据。
- 摘要失败不能导致工具失败；最差也要返回 ref + crude digest + 分页读取入口。

Agent 默认只看到 L0 + L1 + 少量 L2。需要细节时先看 section，再按页读取 chunk。

### 4. 分页读取

新增工具：`read_content_ref`。

参数：

```json
{
  "ref_id": "ctx_20260623_abcd1234",
  "page": 1,
  "page_size": 4000,
  "section_id": "s2",
  "offset": 0,
  "limit": 4000
}
```

规则：

- 默认 `page_size=4000` 字符。
- 最大 `page_size=8000`，防止一次性读太多。
- `page`、`offset/limit`、`section_id` 三种定位方式互斥；同一次调用只能使用一种。
- 如果同时传入多种定位方式，工具返回参数错误，不猜测优先级。
- `section_id` 可额外搭配 `page_within_section`，用于读取 section 内第 N 页。
- `page_size` 只对 `page` 或 `section_id` 生效；`offset/limit` 使用显式 `limit`。
- `offset/limit` 是高级接口，默认 Agent 不优先使用。
- 返回当前页内容、总页数、前后页提示、section 摘要。
- 分页读取结果仍然受工具结果预算限制。
- 单轮最多允许读取 3 页；单个任务对同一 ref 连续分页超过阈值时，要求 Agent 先说明需要继续读取的理由。

返回示例：

```json
{
  "ref_id": "ctx_20260623_abcd1234",
  "page": 2,
  "total_pages": 9,
  "char_start": 4000,
  "char_end": 8000,
  "section_id": "s2",
  "section_summary": "本节介绍产品技术路线...",
  "content": "...",
  "next_page": 3,
  "previous_page": 1
}
```

### 5. 引用内搜索

新增工具：`search_content_ref`。

用于 Agent 不知道读哪一页时，在本地长内容里搜索关键词或语义片段。v1 直接支持 BM25 + embedding 混合检索，借鉴现有 `ContextRetriever` / `SkillRetriever` 的召回思路，但检索实现要抽到通用模块，不能继续散落在 `skills/` 或具体业务 retriever 里。Content Store 使用专用索引表 `content_ref_chunk_index`，不复用 `memory_embeddings`。

参数：

```json
{
  "ref_id": "ctx_20260623_abcd1234",
  "query": "valuation investors robotics",
  "max_results": 5
}
```

返回命中片段，每个片段带 `char_start/char_end/page/section_id`，Agent 再用 `read_content_ref` 精读。

v1 搜索策略：

- 使用 BM25 + embedding 混合检索：BM25 负责词面精确匹配，embedding 负责语义召回。
- 默认融合权重沿用现有 `SkillRetriever` / `ContextRetriever` 经验：BM25 0.3、向量 0.7。
- 索引对象：title、L1 摘要、section/chunk 摘要、chunk 正文片段。
- `content_ref_chunk_index.keywords` 存 BM25 关键词/token；`embedding` 存 chunk embedding；`embedding_signature` 记录 embedding 模型签名，模型变更时重建索引。
- 中文、英文和代码片段统一走通用 tokenizer；CJK 优先使用 `Intl.Segmenter` 的 locale-aware word segmentation，运行时不可用时降级为 CJK bigram/trigram；英文使用 Unicode letter/number token；代码片段额外抽取 identifier、snake_case、kebab-case、camelCase、路径片段、dotted names、版本号和常见短缩写。n-gram 只作为 CJK fallback，不作为主检索方案。
- 返回命中片段前后少量上下文，避免 Agent 必须整页读取。
- 如果 embedding provider 限流或失败，工具降级到 BM25-only，不阻塞 Agent。
- 即使有混合检索，也保留分页读取次数限制，防止搜索质量不足时退化成逐页扫描全文。

### 6. 通用 Hybrid Retriever

项目里已经有两处 BM25 + embedding 混合检索实现：context 检索和 skill 检索。Content Store 不应复制第三份业务内实现，而应先抽出通用检索模块。

建议新增：

```text
src/retrieval/
  HybridRetriever.ts
  bm25.ts
  tokenizer.ts
  vector.ts
```

职责划分：

- `tokenizer.ts`: 统一 tokenization，供 context、skill、content-ref 共用；替代当前 `src/skills/tokenize.ts` 的轻量实现。v1 不引入额外分词依赖，优先基于 Bun/JS runtime 内置能力和正则规则：
  - normalization：NFKC、大小写折叠、去掉纯标点 token，但保留代码符号派生出的语义 token。
  - CJK：优先 `Intl.Segmenter("zh", { granularity: "word" })` / locale fallback，并只保留 `isWordLike` 片段；不可用时对连续 CJK 文本生成 bigram/trigram，同时保留 2-8 字的短语窗口。
  - English/alnum：使用 Unicode property escapes 抽取字母数字词，过滤通用停用词；保留 2 字符以上大写缩写、数字混合词和版本词，例如 `AI`、`DB`、`v2`、`gpt4`、`429`。
  - Code-aware tokens：对 `read_content_ref`、`ToolResultBlock`、`web-fetch`、`src/memory/ContextRetriever.ts`、`foo.bar()`、`API_KEY` 同时保留原始归一化 token 和拆分 token，例如 `read_content_ref`、`read`、`content`、`ref`。
  - BM25 使用带频次 token；展示匹配原因时再去重，避免重复词破坏可读性。
- `bm25.ts`: 通用 BM25 计算，输入 query tokens 和文档 tokens，输出 BM25 分数。
- `vector.ts`: cosine similarity、向量归一化、embedding signature 校验等通用逻辑。
- `HybridRetriever.ts`: 负责 BM25 分数归一化、向量分数计算、权重融合、topK 排序。

适配方式：

- `ContextRetriever` 改为调用通用 `HybridRetriever`，保留 context-specific 的目录权重和过滤逻辑。
- `SkillRetriever` 改为调用通用 `HybridRetriever`，保留 skill-specific 的字段拼接和过滤逻辑。
- `ContentRefRetriever` 新增，读取 `content_ref_chunk_index`，调用通用 `HybridRetriever`，再返回 ref/page/section 定位。

这样 BM25 + embedding 的核心实现只有一份，不混在 `skills/` 文件夹里，也不会在 Content Store 里再复制一份。

调研结论：

- 当前仓库的 `src/skills/tokenize.ts` 只抽取英文 3 字符以上词和连续中文片段，会漏掉 `AI`、`DB`、`v2`、`API_KEY`、`read_content_ref`、文件路径和 dotted names 等代码/系统关键词。
- `Intl.Segmenter` 已是 JavaScript 标准内置的 locale-sensitive 分词能力，适合 v1 作为 CJK 主路径；Unicode UAX #29 也把 word boundary 作为通用文本分割基础。它们不替代代码 tokenizer，所以代码片段仍需正则派生 token。
- 因为 Content Store 的检索对象混合了网页正文、Markdown、JSON、日志和 TypeScript 代码，v1 tokenizer 应采用“自然语言分词 + 代码关键词抽取 + CJK fallback n-gram”的组合，而不是只依赖一种分词方式。

### 7. 工具改造策略

#### web_fetch

默认行为改为：

- 抓取全文并保存到 Content Store。
- 返回 digest + ref_id，不返回全文。
- `mode=summary` 返回更短摘要。
- `mode=full` 也不直接返回全文，而是返回 ref + 第一页预览；若确需全文，必须分页读取。

兼容策略：

- 增加参数 `return_mode?: "digest" | "page" | "legacy"`。
- 默认 `digest`。
- `legacy` 仅用于测试或显式兼容，仍受最大字符预算控制。

#### web_search

默认行为改为：

- 搜索结果只返回 title/url/短摘要/score。
- 不把长 content 全部放入结果。
- 对每个搜索结果可选生成轻量 `result_ref`。
- Agent 选中某个 URL 后再用 `web_fetch` 生成正文 ref。

#### read_file

默认行为改为：

- 小文件仍可直接返回全文，但设置较低阈值，例如 32KB。
- 大于阈值时写入 Content Store，返回 ref + 文件摘要 + 分页信息。
- ref 是创建时的文件快照；保存 file size、mtime、hash。
- 如果源文件后续变化，`read_content_ref` 返回旧快照并标记 `source_changed: true`；需要新版本时重新调用 `read_file`。

#### spawn_agent

sub-agent 长结果保存为 ref，上级 Agent 只拿 digest。需要细节时读取对应 ref 的 section/page。

### 8. Tool Output Budget

在 AgentLoop 层增加统一兜底预算，避免单个工具绕过限制。

建议默认值：

- 单个 tool_result 目标 2k 字符，硬上限 4k 字符。
- 单轮所有 tool_result 合计目标 8k-12k 字符，硬上限可配置。
- 超过预算时，优先自动转存 Content Store，并把输出替换为 content_ref digest。
- 如果 Content Store 尚不可用，先使用首尾截断作为临时兜底，并明确标记 `[truncated]`。

这样即使某个工具忘记限长，也不会把超长内容直接塞进 conversation。这个全局安全网应尽早上线，不能等所有工具都完成引用化改造。

### 9. Conversation Compaction

长任务还需要历史压缩，否则即使工具结果变短，多轮对话仍会增长。

策略：

- 每 N 轮或估算输入超过阈值时，生成 task running summary。
- 历史 tool_result digest 可压缩为“已查看 refs + 已采纳事实 + 待查问题”。
- 保留最近 2-3 轮原始消息，旧轮次用 summary 替代。
- content_ref 不丢，必要时可重新分页读取。

这一步可以在 v2 做，但接口设计要提前兼容。

### 10. Frontend / UI

v1 不需要专门改前端。

当前 web 端已经会把 `tool_result` 显示成普通工具结果块，展开工具卡片时也能看到 output；引用化之后进入 UI 的只是短 digest 和 `ref_id`，不会再出现长正文。也就是说，前端不需要先做专门的 ref 浏览器才能让本方案生效。

后续如果需要更好的人工复查体验，可以在 v2 增加可选 UI：

- 在工具结果里把 `content_ref` digest 渲染成专门卡片，展示 title、source、content_length、digest 和 `ref_id`。
- 增加 Mission Control 或调试页的 ref viewer，调用 `read_content_ref` 分页查看正文快照。
- 支持复制 ref_id、打开 source URL、按 query 调用 `search_content_ref`。

这些是观察和调试增强，不是 v1 的上下文预算闭环依赖。

## Behavior

- Agent 调用 `web_fetch(url)`。
- 工具抓取全文，抽正文，写入 Content Store。
- 工具同步生成 L0/L1 和 ref digest；L2/L3 摘要按需 lazy 生成。
- Agent 下一轮只看到 digest，不看到全文。
- Agent 如果需要某个细节，调用 `read_content_ref(ref_id, section_id)` 或 `search_content_ref(ref_id, query)`。
- Agent 最终输出引用事实时，保留 URL/ref/source 信息。
- `tool_results` 表里保存 digest，不保存大段全文。

## VC Radar 应用策略

针对 VC Radar，建议增加更严格的工作流：

- 每次运行先用 `web_search` 得到候选事件列表，只保留结构化摘要。
- 只对 top 3-5 个高价值候选调用 `web_fetch`。
- `web_fetch` 返回 ref digest，不返回正文全文。
- 分析时优先读取 L1/L2 摘要。
- 只有当金额、投资方、产品定义、AI 开发者启发不明确时，才分页读取相关 section。
- 禁止逐页扫描全文；每个候选 ref 默认最多读取 1-2 页，超过需说明具体缺失字段。
- raw JSON 写入本地文件，但不要再通过 `read_file` 全量读回上下文；需要复查时按 ref 或分页读取。
- `status.md` 最终写入完整结果，但收尾阶段不把全文重新读入 LLM；只基于 task summary 和 refs 生成。

## Implementation Order

1. 在 AgentLoop 增加统一 tool_result 预算兜底，超限先截断或转 ref，立即防止上下文爆炸。
2. 新增 Content Store 最小实现：保存长文本、metadata、L0/L1、section/chunk 边界。
3. 新增 `read_content_ref`，支持 page、offset/limit、section_id，并实现参数互斥校验。
4. 改造 `web_fetch`：默认返回 ref digest，全文落 Content Store，同步只做 L0/L1。
5. 改造 `read_file`：大文件返回 ref digest，小文件仍直接返回，并处理源文件变化标记。
6. 抽取通用 `src/retrieval/`：BM25、tokenizer、vector similarity、HybridRetriever；`ContextRetriever` 和 `SkillRetriever` 后续改为复用它。
7. 为 Content Store chunk 建专用 `content_ref_chunk_index`，接入 BM25 keywords + embedding 索引，复用现有 embedding provider；失败时降级 BM25-only。
8. 新增 `search_content_ref` v1：BM25 + embedding 混合检索，返回 page/section 定位。
9. 改造 `web_search`：进一步缩短默认输出，必要时只返回 URL 候选。
10. 引入 summarizer provider：优先使用 `SUMMARIZER_API_KEY`，无 summarizer 时降级为规则摘要。
11. 为 VC Radar 更新 agent/skill 指令，要求引用化读取、先搜索定位、禁止逐页扫描全文。
12. 增加 conversation compaction，压缩旧工具轮次。

## Test Plan

- AgentLoop 预算测试：超长工具输出自动转 ref；Content Store 不可用时首尾截断；conversation 中不出现超预算全文。
- Content Store 单测：写入、读取、hash 去重、过期清理、project 目录存储。
- `read_content_ref` 测试：分页、section、offset/limit、互斥参数校验、越界处理、单轮读取限制。
- 通用检索模块测试：BM25、tokenizer、cosine similarity、BM25 + embedding 融合排序；tokenizer 覆盖中文句子、英文查询、`read_content_ref` / `API_KEY` / `ToolResultBlock` / 文件路径等代码片段。
- `search_content_ref` 测试：混合检索召回、BM25-only fallback、embedding 失败 fallback、返回 page/section 定位。
- `web_fetch` 测试：长网页返回 digest，不把全文放入 tool_result；L2/L3 不阻塞工具返回。
- `read_file` 测试：小文件直返，大文件转 ref；源文件变化时返回旧快照并标记 `source_changed`。
- summarizer fallback 测试：无 `SUMMARIZER_API_KEY` 或摘要失败时仍返回 crude digest。
- VC Radar 回归测试：一次扫描中 tool_result 总长度受控，仍能读取需要的网页细节。
- `bun test` 全量跑通。

## Core Decisions

- Content Store 默认写入 project context-hub 目录；无 project 的全局 fallback 目录为 `~/.little_claw/content-refs/`。
- 临时 ref 默认 7 天过期；v1 不做按 agent/skill 配置的保留策略。
- 摘要优先使用 `SUMMARIZER_API_KEY` / summarizer provider；不得默认挤占主 Agent TPM。
- L0/L1 同步生成；L2/L3 只在读取、检索命中或高价值后台任务中 lazy 生成，不阻塞 `web_fetch` 返回。
- ref 默认是创建时快照；源文件变化不改变旧 ref，需要重新读取生成新 ref。
- AgentLoop tool_result 预算兜底优先实现，作为所有工具的安全网。
- Content Store 使用专用 `content_ref_chunk_index`，不复用 `memory_embeddings`；BM25 + embedding 混合检索核心抽到 `src/retrieval/`，默认权重 BM25 0.3 / embedding 0.7。
- v1 tokenizer 兼顾中文、英文和代码：CJK 用 `Intl.Segmenter` + n-gram fallback，英文用 Unicode token，代码用 identifier/path/dotted-name 派生 token。
- v1 不依赖前端改造；现有工具结果展示 digest 即可，ref viewer 留到 v2。

## Resolved Open Questions

- 默认过期策略：临时 ref 默认 7 天过期；project ref 也先不做 agent/skill 级配置，后续有明确保留差异再加。
- 前端策略：v1 不需要改前端；现有工具结果展示短 digest 足够闭环，ref viewer 留到 v2。
- tokenizer 策略：采用通用 tokenizer，组合 CJK `Intl.Segmenter`、CJK n-gram fallback、英文 Unicode token 和代码关键词抽取。
- 融合权重：Content Store v1 沿用 BM25 0.3 / embedding 0.7，与当前 skill/context 检索保持一致。

## Assumptions

- 长内容仍需要可追溯，不应只保留摘要。
- 大多数 Agent 不需要一次性读取全文；它们需要的是先定位，再精读。
- 分层摘要会消耗额外 LLM 调用，但能显著降低后续每轮上下文和 TPM。
- 即使实现了本方案，LLM Gateway 仍有价值：它负责 API 侧限流，本方案负责上下文侧瘦身。
