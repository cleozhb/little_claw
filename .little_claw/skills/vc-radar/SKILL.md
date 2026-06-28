---
name: vc-radar
description: VC 融资雷达工作流——扫描全球顶级 VC 的投资动态，提炼投资逻辑与 AI 开发者启发。当 Agent 需要执行每日 VC 融资扫描任务时使用此 skill。
metadata:
  openclaw:
    requires: {}
---

# VC Radar 每日扫描工作流

你是一位顶级科技 VC 分析师。每次被触发时，按以下流程工作：

## 阶段 1：数据采集

1. 用 `read_file` 读取 `~/.little_claw/context-hub/3-projects/venture-radar/sources.json`，获取所有源站分组。
2. 对每个源站组，根据其 `strategy` 字段决定采集方式：
   - `web_search`：用 `web_search` 工具，设置 `include_domains` 为该组的 domains 列表，`topic` 设为该组的 `search_topic`，搜索过去 24 小时的融资/投资相关内容。
   - `web_search+web_fetch`：先 web_search 发现文章，再对有深度分析价值的文章 URL 用 `web_fetch` 取正文引用。`web_fetch` 默认返回 `content_ref` digest，不要切换到 legacy 全文模式。
3. 将所有采集结果写入 `~/.little_claw/context-hub/3-projects/venture-radar/raw-{YYYY-MM-DD}.json`。每条记录必须包含：
   - `source_url`：原始链接
   - `title`：标题
   - `snippet`：摘要或短片段；如果有 `content_ref`，记录 digest，不记录全文
   - `content_ref`：`web_fetch` 返回的 ref_id；没有抓取正文时可为空
   - `published_date`：发布日期（无法确定则写 "unknown"）
   - `fetch_status`：success / empty / timeout / error
   - `group_name`：所属源站组
4. 文件顶部写入 `fetch_started_at` 和 `fetch_completed_at` 时间戳，底部写入 summary（总条数、各组状态）。
5. 清理 7 天前的旧 raw 文件。

## 阶段 2：分析与输出

1. 读取刚写入的 `raw-{date}.json`。如果文件较大，`read_file` 会返回 `content_ref`；先用 `search_content_ref` 定位候选记录，不要全文分页扫描。
2. 筛选过去 24 小时内有明确融资事件或投资动态的条目。
3. 对每个事件提炼以下字段（输出中英混排：公司名/赛道英文，分析中文）。如果某条记录带有文章 `content_ref`，优先用 `search_content_ref(ref_id, query)` 搜索金额、投资方、产品定义、投资逻辑等关键词；只有命中片段不够时，再用 `read_content_ref` 读取对应 page 或 section。
   - **Company**：公司英文名
   - **Sector**：赛道英文标签（如 AI Coding, Embodied AI, Developer Tools, AI Infra）
   - **Funding**：轮次、金额、投资方
   - **投资逻辑**：该 VC 为什么投这家公司？优先引用 VC 原文观点；若只能推断，标注"[推断]"
   - **AI 开发者启发**：约 200 字中文，告诉普通 AI 开发者这件事对找工作或做项目有什么启发
   - **Source**：来源链接
4. 用 `context_write` 将分析结果输出到项目的 `vc-radar-{YYYY-MM-DD}.md`（例如 `vc-radar-2026-06-14.md`），不要覆盖历史日期的结果。格式要求：
   - 每个事件必须包含上述所有字段的完整内容，不得省略或缩写
   - **AI 开发者启发**字段必须≥200字，具体覆盖：该赛道的求职方向、值得关注的技术栈、可模仿的项目思路
   - 最终追加一个 `## 今日开发者行动建议` 板块，综合所有事件给出 3-5 条具体的求职/项目建议
5. 更新项目的 `status.md` 为简洁状态摘要：扫描时间、源站组数量、采集记录数、有效事件清单、主题趋势、详细报告路径、raw JSON 路径。`status.md` 不承载完整分析正文，完整字段以 `vc-radar-{YYYY-MM-DD}.md` 为准。
6. 如果今天无有效事件，输出"今日无更新，已扫描 N 个源站组"到 `status.md`。

## 注意事项

- 合并 Tavily 请求：同组多个域名用一次 `web_search(include_domains: [...])` 覆盖，不要逐个域名搜索。
- 长内容预算：不要把网页正文或 raw JSON 全文放回上下文。默认保留 `content_ref`、URL、短 digest 和必要字段；分析时先 `search_content_ref`，再按 page/section 精读。
- 分页限制：每个候选文章默认最多读取 1-2 页；超过时必须先说明缺失的具体字段。禁止逐页扫描整篇文章。
- 完成后停止：`raw-{date}.json`、`vc-radar-{date}.md`、`status.md` 三类产物写入成功后，立即给出中文最终回复并停止，不要再读取文件、搜索 ref、抓取网页或做二次确认。
- 时效性：Tavily 搜索尽量用时间范围过滤；无明确日期的内容仅作为背景参考，不进入正式事件列表。
- 重点关注 `focus_sectors` 中列出的赛道，但不遗漏其他重大事件。
- `raw-{date}.json` 是完整的采集日志，必须写入，方便排查问题和重试。
- 不是投资建议，只服务于求职、项目方向和技术趋势判断。
