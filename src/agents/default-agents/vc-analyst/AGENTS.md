# Agent 操作指南

你按照 `vc-radar` skill 中描述的工作流执行每日 VC Radar 扫描。

## 关键：防循环与限速规则
- **每次运行最多 5 次 web_search 调用。** 将域名合并到 `include_domains` 数组中——绝不逐个域名搜索。
- **每次运行最多 5 次 web_fetch 调用。** 只获取具有明确分析深度的文章（VC 投资论文、详细融资公告）。
- **每次运行最多 12 次 search_content_ref 调用。** 用它定位候选记录和关键字段，不要为同一问题反复换 query。
- **每次运行最多 10 次 read_content_ref 调用。** 只读取命中的 page/section，不逐页翻完整篇文章。
- **先搜索 ref 再读取正文：** `web_fetch` / 大文件 `read_file` 返回 `content_ref` 时，先用 `search_content_ref` 定位金额、投资方、产品和投资逻辑；只读取命中的 page/section。
- **禁止全文回读：** 不使用 legacy 模式拉取网页全文，不逐页扫描整篇文章。每个候选 ref 默认最多读取 1-2 页；超过时先说明缺失字段。
- **不无限重试：** 如果工具调用失败，尝试一种替代方案。如果再次失败，将错误记录到原始 JSON 中并继续。
- **始终写入原始 JSON：** 即使所有搜索返回为空，也要为每个组写入状态为 "empty" 的原始文件。

## 规则
- 所有文件（原始 JSON、sources.json、vc-radar-{YYYY-MM-DD}.md、status.md）存放在 `~/.little_claw/context-hub/3-projects/venture-radar/` 下。绝不写入此目录之外。
- raw JSON 中记录 URL、digest、`content_ref` 和必要结构化字段，不写入网页全文。
- 未找到事件时，输出"今日无更新，已扫描 N 个源站组"到 status.md 并停止。
- 保持源中找到的英文公司名称和行业标签原样，不翻译。
- 保持原始 JSON 可机器解析——无尾逗号，有效 UTF-8。
- 每次运行开始时清理超过 7 天的原始文件。

## 完成标准
- `raw-{YYYY-MM-DD}.json` 是可机器解析的采集日志。
- `vc-radar-{YYYY-MM-DD}.md` 是完整详细报告，包含每个事件的全部字段和「今日开发者行动建议」。
- `status.md` 是简洁状态摘要，包含扫描时间、记录数、有效事件清单、详细报告路径和 raw JSON 路径。
- 三个产物写入成功后，立即用中文返回最终结果并停止；不要再调用读取、搜索或抓取工具做二次确认。
