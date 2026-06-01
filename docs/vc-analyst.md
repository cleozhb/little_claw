# VC Analyst Agent 实现计划

## Context

新增 `vc-analyst` Agent，模拟顶级科技 VC 分析师，每天扫描 YC、红杉、36氪等来源的融资动态，输出"公司名+赛道+投资逻辑+AI开发者启发"。

核心设计决策：
- URL 列表存放在 `context-hub/3-projects/venture-radar/sources.json`（与 podcast-curator 的 feeds.json 模式一致）
- **工作流以 Skill 形式描述**（自然语言 SKILL.md），Agent 自主规划执行步骤
- 仅一个 cron job 触发 Agent，Agent 根据 skill 指令自行决定采集→分析的节奏
- 同步实现 `web_fetch` 工具，用于读取文章全文
- 输出语言：**中英混排** — 公司名/赛道名保留英文，分析和启发部分用中文
- VC 覆盖：Sequoia、a16z、Bessemer、Greylock、Khosla、Founders Fund、Lightspeed、Accel（共 8 家）

---

## 架构：Skill 驱动的自主工作流

```
cron "0 8 * * *" 触发单个任务 (daily-vc-radar)
        │
        ▼
┌─────────────────────────────────────────────────┐
│  Agent 启动，skill "vc-radar" 被确定性注入      │
│  Agent 读取 SKILL.md 中的工作流指令             │
│  自主规划执行步骤：                              │
│                                                 │
│  1. 读取 sources.json，了解数据源               │
│  2. 按源站组合并 web_search 请求                │
│  3. 对有价值文章用 web_fetch 读全文             │
│  4. 将采集结果写入 raw-{date}.json（过程透明）  │
│  5. 分析 raw 数据，提炼结构化洞察              │
│  6. 输出到 status.md                           │
│                                                 │
│  Agent 可根据实际情况灵活跳过/调整/深入         │
└─────────────────────────────────────────────────┘
```

**与硬编码 DAG 的区别**：
- 只有一个 cron 触发点，Agent 自己决定内部步骤节奏
- 工作流调整只需修改 SKILL.md 自然语言，无需改代码
- Agent 可灵活应对（某组无更新则跳过；发现重大事件则多搜几轮）
- 中间产物 `raw-{date}.json` 依然必须写入，保证过程可追溯

**Skill 注入机制**：agent.yaml 中声明 `skills: [vc-radar]`，系统确定性注入（不走语义检索），每次任务执行时 SKILL.md 的完整指令都在 system prompt 中。

---

## 实现步骤

### Step 1: 新建 `web_fetch` 内置工具

- 新文件：`src/tools/builtin/WebFetchTool.ts`
- 仿照 `WebSearchTool.ts` 的工厂模式
- 参数：`url`（必选）、`timeout_ms`（可选，默认 15000）
- 安全：仅 http/https，阻止私网 IP（10.x/172.16-31.x/192.168.x/127.x/::1/link-local）
- 实现：Bun 原生 `fetch()` + 轻量 HTML→text 转换
- 输出截断：20,000 字符上限
- 返回：`{ url, final_url, status, content_type, text }`
- 注册到 `src/tools/builtin/index.ts`

### Step 2: 创建 `vc-radar` Skill

新目录：`.little_claw/skills/vc-radar/SKILL.md`（repo 内，与已有的 `podcast-translation-skill` 同级）

安装时复制到用户目录 `~/.little_claw/skills/vc-radar/SKILL.md`。

SKILL.md 内容（自然语言工作流）：

```markdown
---
name: vc-radar
description: VC 融资雷达工作流——扫描全球顶级 VC 的投资动态，提炼投资逻辑与 AI 开发者启发
metadata:
  openclaw:
    requires: {}
---

# VC Radar 每日扫描工作流

你是一位顶级科技 VC 分析师。每次被触发时，按以下流程工作：

## 阶段 1：数据采集

1. 用 `read_file` 读取项目目录 `~/.little_claw/context-hub/3-projects/venture-radar/sources.json`，获取所有源站分组。
2. 对每个源站组，根据其 `strategy` 字段决定采集方式：
   - `web_search`：用 `web_search` 工具，设置 `include_domains` 为该组的 domains 列表，`topic` 设为该组的 `search_topic`，搜索过去 24 小时的融资/投资相关内容。
   - `web_search+web_fetch`：先 web_search 发现文章，再对有深度分析价值的文章 URL 用 `web_fetch` 取全文。
3. 将所有采集结果写入 `~/.little_claw/context-hub/3-projects/venture-radar/raw-{YYYY-MM-DD}.json`。每条记录必须包含：
   - `source_url`：原始链接
   - `title`：标题
   - `snippet`：摘要或全文片段
   - `published_date`：发布日期（无法确定则写 "unknown"）
   - `fetch_status`：success / empty / timeout / error
   - `group_name`：所属源站组
4. 文件顶部写入 `fetch_started_at` 和 `fetch_completed_at` 时间戳，底部写入 summary（总条数、各组状态）。
5. 清理 7 天前的旧 raw 文件。

## 阶段 2：分析与输出

1. 读取刚写入的 `raw-{date}.json`。
2. 筛选过去 24 小时内有明确融资事件或投资动态的条目。
3. 对每个事件提炼以下字段（输出中英混排：公司名/赛道英文，分析中文）：
   - **Company**：公司英文名
   - **Sector**：赛道英文标签（如 AI Coding, Embodied AI, Developer Tools, AI Infra）
   - **Funding**：轮次、金额、投资方
   - **投资逻辑**：该 VC 为什么投这家公司？优先引用 VC 原文观点；若只能推断，标注"[推断]"
   - **AI 开发者启发**：约 200 字中文，告诉普通 AI 开发者这件事对找工作或做项目有什么启发
   - **Source**：来源链接
4. 用 `context_write` 将分析结果输出到项目的 status.md。
5. 如果今天无有效事件，输出"今日无更新，已扫描 N 个源站组"。

## 注意事项

- 合并 Tavily 请求：同组多个域名用一次 web_search(include_domains) 覆盖，不要逐个域名搜索。
- 时效性：Tavily 搜索尽量用时间范围过滤；无明确日期的内容仅作为背景参考，不进入正式事件列表。
- 重点关注 `focus_sectors` 中列出的赛道，但不遗漏其他重大事件。
- raw JSON 是完整的采集日志，必须写入，方便排查问题和重试。
- 不是投资建议，只服务于求职、项目方向和技术趋势判断。
```

### Step 3: 创建 Agent 定义

新目录：`src/agents/default-agents/vc-analyst/`

| 文件 | 内容 |
|------|------|
| `agent.yaml` | Agent 配置（单 cron + skill 引用） |
| `SOUL.md` | 人设：专业数据驱动的 VC 分析师，中英双语 |
| `AGENTS.md` | 基本操作规则（反循环、错误处理） |

`agent.yaml`：
```yaml
name: vc-analyst
display_name: VC Analyst
emoji: "📊"
color: "#2563EB"
role: 每日扫描全球顶级 VC 融资动态，提炼投资逻辑与 AI 开发者启发
status: active
aliases:
  - vc
  - analyst
  - venture
direct_message: true
default_project: venture-radar
tools:
  - read_file
  - write_file
  - web_search
  - web_fetch
  - memory_read
  - memory_write
  - context_write
skills:
  - vc-radar
task_tags:
  - vc
  - funding
  - investment
  - radar
cron_jobs:
  - cron: "0 8 * * *"
    key: daily-vc-radar
    name: Daily VC Radar Scan
    prompt: 执行每日 VC Radar 扫描。按照 vc-radar skill 中描述的完整工作流执行：采集数据、写入 raw JSON 日志、分析提炼、输出到 status.md。
    project: venture-radar
    tags: [scheduled, vc, radar]
    priority: 0
    max_retries: 2
    enabled: true
max_concurrent_tasks: 1
max_tokens_per_task: 100000
timeout_minutes: 30
```

### Step 4: Seed 项目数据

所有运行时数据都在 `~/.little_claw/context-hub/3-projects/venture-radar/` 下：

```
~/.little_claw/context-hub/3-projects/venture-radar/
├── .abstract.md          # "每日 VC 融资事件追踪与 AI 开发者洞察"
├── .overview.md          # 文件索引
├── sources.json          # 源站配置（首次安装时从 repo 复制）
├── status.md             # 分析结果（AgentWorker 自动归档）
├── raw-2026-05-31.json   # 采集日志（Agent 每日生成）
├── raw-2026-05-30.json   # 保留 7 天
└── ...
```

`sources.json` 初始内容从 repo 中 `src/agents/default-agents/vc-analyst/sources.seed.json` 复制（仅当不存在时）。

### Step 5: 更新 AgentRegistry 安装逻辑

在 `AgentRegistry.installDefaultAgents()` 中：安装 vc-analyst 时额外：
1. 复制 `src/agents/default-agents/vc-analyst/sources.seed.json` → `~/.little_claw/context-hub/3-projects/venture-radar/sources.json`（仅当不存在时）
2. 复制 `.little_claw/skills/vc-radar/SKILL.md` → `~/.little_claw/skills/vc-radar/SKILL.md`（仅当不存在时）
3. 创建 `.abstract.md` 和 `.overview.md`（仅当不存在时）

### Step 6: `raw-{date}.json` 日志格式（Agent 自主遵循）

所有中间文件和结果都在 `~/.little_claw/context-hub/3-projects/venture-radar/` 下。
这不是代码强制的 schema，而是 SKILL.md 中描述的输出规范。Agent 自行生成：
```json
{
  "date": "2026-05-31",
  "fetch_started_at": "2026-05-31T08:00:12Z",
  "fetch_completed_at": "2026-05-31T08:03:45Z",
  "groups": [
    {
      "name": "中文融资源",
      "status": "success",
      "query_used": "融资 投资 近24小时",
      "results_count": 5,
      "results": [
        {
          "title": "某公司完成A轮融资",
          "source_url": "https://36kr.com/p/...",
          "snippet": "...",
          "published_date": "2026-05-31",
          "fetch_status": "success",
          "group_name": "中文融资源"
        }
      ]
    }
  ],
  "summary": { "total_results": 12, "groups_success": 3, "groups_failed": 0 }
}
```

### Step 7: 测试

- `tests/tools/WebFetchTool.test.ts` — URL 校验、私网阻止、HTML 去标签、截断
- `tests/team/AgentRegistry.test.ts` — vc-analyst 默认安装验证 + skill 安装验证
- `bun test` 全仓回归

---

## 关键文件

| 文件 | 用途 |
|------|------|
| `src/tools/builtin/WebSearchTool.ts` | web_fetch 的实现模板 |
| `src/tools/builtin/index.ts` | 注册新工具 |
| `src/agents/default-agents/podcast-curator/agent.yaml` | agent.yaml 结构模板 |
| `.little_claw/skills/podcast-translation-skill/SKILL.md` | Skill 写法模板 |
| `src/team/AgentRegistry.ts` | 安装逻辑（`installDefaultAgents()`） |
| `src/skills/SkillLoader.ts` | Skill 加载机制 |
| `~/.little_claw/context-hub/3-projects/podcast-translation/feeds.json` | sources.json 的先例 |

---

## 验证方式

1. `bun test` 全部通过
2. 启动 team 模式，确认 `vc-analyst` 出现在 agent 列表
3. 确认 `vc-radar` skill 被正确加载（检查 skill 加载日志）
4. 手动触发 `daily-vc-radar` 任务
5. 检查 `raw-{date}.json` 生成且内容合理
6. 检查 `status.md` 输出包含结构化中英混排分析
7. 验证 `web_fetch` 对一个静态 URL 能正确返回文本

---

## 注意事项

- **Tavily API 配额**：3 个源站组 ≈ 3-5 次 search 请求/天，远低于配额限制
- **时效性判断**：SKILL.md 中已指示优先用时间过滤，无日期标注"推断"
- **Token 预算**：单任务 `max_tokens_per_task: 100000`（采集+分析在一个任务内完成）
- **中文站反爬**：全部走 `web_search(include_domains)` 委托 Tavily
- **清理策略**：SKILL.md 指示 Agent 清理 7 天前的旧 raw 文件
- **后续迭代**：如需调整工作流（如增加源站、改输出格式），只需编辑 SKILL.md 或 sources.json，无需改代码
