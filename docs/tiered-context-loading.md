# 需求：升级 context 系统 — 三层上下文加载 + context-hub

将现有的 SOUL.md + USER.md 升级为分层 context-hub 目录 + 三层加载系统（Tiered Context Loading）。核心原则：Load only what you need. Scan first, understand second, work third.

---

## 第一部分：目录结构

将 ~/.little_claw/ 下的 context 改为以下结构。SOUL.md 保留在原位不动（它是 Agent 身份，不是用户数据）。新增 context-hub/ 作为用户的一切信息。

```
~/.little_claw/
├── SOUL.md                          # Agent 身份定义（不动，只读）
├── memory/                          # 每日日志（不动，和 context-hub 并列）
│   └── YYYY-MM-DD.md
└── context-hub/                     # 用户的一切
    ├── .abstract.md                 # L0: "User's personal context hub"
    ├── .overview.md                 # L1: 列出所有顶层目录及简述
    │
    ├── 0-identity/                  # 我是谁
    │   ├── .abstract.md             # "Who the user is — profile, preferences, background"
    │   ├── .overview.md             # 列出 profile.md 等文件及简述
    │   └── profile.md              # 个人信息、偏好、背景（替代原 USER.md）
    │
    ├── 1-inbox/                     # 临时想法、待办、畅所欲言的暂存区
    │   ├── .abstract.md             # "Capture zone — unsorted ideas, todos, fleeting thoughts"
    │   ├── .overview.md             # 当前 inbox 的状态摘要（多少条待办、多少条想法）
    │   └── inbox.md                # 实际内容
    │
    ├── 2-areas/                     # 持续关注的大方向（无截止日期）
    │   ├── .abstract.md             # "Ongoing life areas with no end date"
    │   ├── .overview.md             # 列出所有 area 子目录、状态
    │   ├── content/                 # 示例：内容创作
    │   │   ├── .abstract.md         # "YouTube and LinkedIn content strategy"
    │   │   ├── .overview.md         # 文件列表、当前状态、关键指标
    │   │   ├── strategy.md
    │   │   └── metrics.md
    │   └── health/                  # 示例：健康
    │       ├── .abstract.md         # "Fitness tracking and health goals"
    │       ├── .overview.md
    │       └── tracking.md
    │
    ├── 3-projects/                  # 具体项目（有截止日期，成熟后可归入 area）
    │   ├── .abstract.md             # "Active time-bound projects"
    │   ├── .overview.md             # 列出所有项目、状态、截止日期
    │   └── little-claw/             # 示例项目
    │       ├── .abstract.md         # "AI Agent platform built with TypeScript"
    │       ├── .overview.md         # 架构概览、当前阶段、待办
    │       ├── design.md
    │       └── todo.md
    │
    ├── 4-knowledge/                 # 个人知识库
    │   ├── .abstract.md             # "Personal knowledge base — SOPs, research, collections"
    │   ├── .overview.md             # 列出所有知识分类
    │   ├── sops/                    # 标准操作流程
    │   │   ├── .abstract.md
    │   │   ├── .overview.md
    │   │   └── deployment.md
    │   ├── research/                # 过去的研究资料
    │   │   ├── .abstract.md
    │   │   ├── .overview.md
    │   │   └── ai-agents-survey.md
    │   └── collections/             # 收集的文件
    │       ├── .abstract.md
    │       ├── .overview.md
    │       └── useful-links.md
    │
    └── 5-archive/                   # 不再需要的归档
        ├── .abstract.md             # "Completed or deprecated items"
        ├── .overview.md             # 列出归档内容
        └── .../
```

---

## 第二部分：三层加载机制

### L0 — .abstract.md
- **格式**：严格一行，不超过 100 字符
- **作用**：Agent 以最快速度了解全局，所有 .abstract.md 拼在一起不超过 2000 tokens
- **示例**：
  ```
  Ongoing life areas — content creation, health, clients, products
  ```

### L1 — .overview.md
- **格式**：50-200 行，结构化索引
- **作用**：Agent 找上下文时来看 overview，知道结构、状态、文件列表，从而决定该读哪个 L2 文件
- **示例**（2-areas/.overview.md）：
  ```markdown
  # Areas Overview

  ## content/
  YouTube and LinkedIn content creation.
  Status: Active, posting 3x/week
  Key files:
  - strategy.md — content pillars, tone, target audience
  - metrics.md — monthly performance data, growth tracking
  - calendar.md — upcoming content schedule

  ## health/
  Fitness goals and daily tracking.
  Status: Active
  Key files:
  - tracking.md — workout logs, weight, sleep data
  - goals.md — quarterly fitness targets

  ## clients/
  Client relationship management.
  Status: 3 active clients
  Key files:
  - relationships.md — client profiles, preferences, history
  ```

### L2 — Full files
- 实际内容：脚本、研究笔记、具体数据
- **只在 Agent 确定需要时才加载**

---

## 第三部分：Context Assembler 改造

### 每次对话自动加载（不走检索，不走工具调用）：

```
1. SOUL.md（Agent 身份）
2. 0-identity/profile.md（用户身份，内容不多，全量加载）
3. 1-inbox/inbox.md（待办和临时想法，全量加载）
4. 所有 .abstract.md 文件拼接成全局地图（~500 tokens）
   格式：
   context-hub/0-identity/ — Who the user is — profile, preferences, background
   context-hub/1-inbox/ — Capture zone — unsorted ideas, todos, fleeting thoughts
   context-hub/2-areas/ — Ongoing life areas with no end date
   context-hub/2-areas/content/ — YouTube and LinkedIn content strategy
   context-hub/2-areas/health/ — Fitness tracking and health goals
   context-hub/3-projects/ — Active time-bound projects
   context-hub/3-projects/little-claw/ — AI Agent platform built with TypeScript
   context-hub/4-knowledge/ — Personal knowledge base — SOPs, research, collections
   context-hub/5-archive/ — Completed or deprecated items
```

### 向量检索自动触发（对 .overview.md 文件检索）：

```
5. 用户消息到达时，跑一次混合检索（BM25 + Vector）
   但检索范围只搜 .overview.md 文件，不搜 L2 全文件
   命中的 overview 自动加载到 context 中（topK=2）
   Agent 看到 overview 后自己决定要不要进一步读 L2 文件
```

### Agent 按需加载（通过 read_file 工具调用）：

```
6. Agent 从 overview 中确定需要哪个具体文件
   调用 read_file 读取该 L2 文件
   这一步是 Agent 自主决策，不是系统自动加载
```

### 其余不变：

```
7. memory/ 每日日志的向量检索结果
8. 动态匹配的 Skill 指令
9. 当前 session 对话历史
10. 用户新消息
```

### 检索权重配置：

- 0-identity/：不走检索（必定加载）
- 1-inbox/：不走检索（必定加载）
- 2-areas/ 的 .overview.md：检索权重 * 1.2
- 3-projects/ 的 .overview.md：检索权重 * 1.3（活跃项目最重要）
- 4-knowledge/ 的 .overview.md：检索权重 * 1.0
- 5-archive/ 的 .overview.md：检索权重 * 0.3（大幅降权）

---

## 第四部分：Agent 导航指令

在 SOUL.md 中追加以下导航说明（或在 system prompt 中自动注入）：

```
## How to navigate context-hub

You have access to the user's context-hub through a three-layer system.
Load only what you need. Scan first, understand second, work third.

L0 — .abstract.md (one line per folder)
  Already loaded in your context as "Context Map".
  Use this to know WHAT EXISTS across all areas and projects.

L1 — .overview.md (structure + status + file index)
  Read this BEFORE opening any full file.
  Use this to know WHERE to look and WHAT each file contains.
  Command: read_file("context-hub/2-areas/content/.overview.md")

L2 — Full files (actual content)
  Only load when you are actually working with that content.
  Read the specific file you need, not everything in the folder.
  Command: read_file("context-hub/2-areas/content/strategy.md")

Your workflow for any user request:
1. Check L0 abstracts (already in your context) — which area is relevant?
2. Read the L1 overview of that area — which specific file do I need?
3. Read only that L2 file — now work with it.

NEVER load all L2 files in a directory at once.
NEVER skip L1 and guess which file to read.
Always go L0 → L1 → L2 in order.
```

---

## 第五部分：Agent 写入规则

改造 memory_write 工具（或新建 context_write 工具），描述如下：

```
Write information to the user's context hub. Choose the correct location:

- 0-identity/profile.md: User preferences and personal info
  (name, timezone, coding style, dietary preferences).
  APPEND only, never overwrite.

- 1-inbox/inbox.md: Temporary ideas, todos, and fleeting thoughts.
  User said "remind me to..." or "I should..." or any unstructured thought.
  Format: "- [ ] {content} ({date})" for todos, "- {content} ({date})" for ideas.
  This is the safe catch-all — when unsure where something goes, put it here.

- 2-areas/{area}/: Updates to ongoing areas of focus.
  Only write to EXISTING area directories.
  Example: user shares content metrics → append to content/metrics.md

- 3-projects/{project}/: Project updates, decisions, progress.
  Only write to EXISTING project directories.
  Can create new files within existing project directories.
  Example: meeting notes → create little-claw/meeting-2026-04-26.md

- 4-knowledge/: Reference information, SOPs, research notes.
  Can create new files here when user shares reusable knowledge.
  Example: user explains deployment process → create sops/deployment.md

NEVER write to:
- SOUL.md (Agent identity, user-managed)
- 5-archive/ (user moves things here manually)

NEVER create new top-level directories under 2-areas/ or 3-projects/.
User creates these to define their life structure. You only fill in content.

After writing to any L2 file, check if the directory's .abstract.md and
.overview.md need updating. If the file you wrote is new (not in overview),
update the .overview.md to include it.
```

---

## 第六部分：自动生成和维护 .abstract.md / .overview.md

用户不需要手动维护这些元文件。Agent 自动生成和更新。

### 首次启动扫描：

- 扫描 context-hub/ 所有目录
- 对没有 .abstract.md 的目录：基于目录名和包含的文件名，调用 LLM 生成一行摘要
  - prompt："Generate a single line (under 100 characters) describing what this folder contains. Folder name: {name}, files: {file list}"
  - max_tokens: 30
- 对没有 .overview.md 的目录：基于文件列表和各文件前 200 字符，调用 LLM 生成索引
  - prompt："Generate a structured overview of this folder for AI navigation. List each file with a one-line description, current status if applicable. Keep under 200 lines."
  - max_tokens: 500
- 生成后写入对应目录

### Agent 写入触发更新：

- 当 Agent 通过 context_write 工具写入或修改 L2 文件后：
  - 检查该目录的 .overview.md 是否列出了该文件
  - 如果没有（新文件），追加一行文件描述到 .overview.md
  - 如果 .abstract.md 内容明显不再准确（比如目录功能变了），重新生成
  - 不是每次写入都全量重建——只做增量更新

### 定期整理（可选，通过 Cron Job）：

- 每天一次，扫描所有 .overview.md
- 检查列出的文件是否仍然存在，删除已不存在的引用
- 检查是否有新文件未被列出，补充进去
- 更新各目录的状态信息

---

## 第七部分：自动归档建议

Agent 不自动移动文件（避免搞乱用户结构），但主动建议整理。

在 system prompt 中加入：

```
Periodically review 1-inbox/inbox.md. If items have been there for more than
a few conversations:
- Suggest moving completed todos to archive
- Suggest which area or project an idea belongs to
- Say: "I noticed you have 5 items in inbox from last week.
  Want me to help organize them into your areas/projects?"

If a project in 3-projects/ seems complete based on conversation context,
suggest: "It looks like {project} might be done. Want to move it to archive?"

Never move files between top-level directories yourself. Always ask first.
You CAN move files within a directory (e.g. reorganize files within a project).
```

---

## 第八部分：迁移逻辑

首次启动时检测是否需要迁移：

- 如果旧的 USER.md 存在但 context-hub/ 不存在：
  - 创建 context-hub/ 完整目录结构
  - USER.md 内容迁移到 context-hub/0-identity/profile.md
  - MEMORY.md 内容迁移到 context-hub/4-knowledge/memory-archive.md
  - 旧文件重命名为 USER.md.bak 和 MEMORY.md.bak，不删除
- SOUL.md 不动，保留在 ~/.little_claw/SOUL.md
- memory/ 每日日志目录不动，保留在 ~/.little_claw/memory/

如果什么都没有（全新安装），创建模板：

- context-hub/.abstract.md："User's personal context hub"
- context-hub/.overview.md：列出 0-identity 到 5-archive 的简述
- 0-identity/.abstract.md："Who the user is — profile, preferences, background"
- 0-identity/profile.md："# Profile\n\nTell me about yourself and I'll remember.\n"
- 1-inbox/.abstract.md："Capture zone — unsorted ideas, todos, fleeting thoughts"
- 1-inbox/inbox.md："# Inbox\n\nCapture ideas, todos, and fleeting thoughts here.\n"
- 2-areas/.abstract.md："Ongoing life areas with no end date"
- 3-projects/.abstract.md："Active time-bound projects"
- 4-knowledge/.abstract.md："Personal knowledge base — SOPs, research, collections"
- 5-archive/.abstract.md："Completed or deprecated items"
- 其余子目录创建 .gitkeep 占位

---

## 第九部分：CLI 和 Web UI

### CLI 新增命令：

- /context map：打印所有 .abstract.md 拼成的全局地图（L0 全景视图）
- /context overview \<path\>：打印指定目录的 .overview.md（比如 /context overview 2-areas/content）
- /context search \<query\>：手动测试检索，显示匹配到哪些 .overview.md 及分数
- /context rebuild：手动触发重建所有 .abstract.md 和 .overview.md
- /inbox：快捷查看 1-inbox/inbox.md 的内容
- /inbox add \<text\>：快速添加一条到 inbox（格式为 "- [ ] {text} ({今天日期})"）

### Web UI：

- 设置页面新增 Context Hub 面板
- 显示目录树（可折叠展开）
- 点击 .abstract.md 或 .overview.md 可以内联查看
- 点击 L2 文件可以编辑内容
- 支持创建新的 area 和 project 子目录

---

## Token 消耗对比

之前（全量加载）：
- 所有 Skill 指令 + 所有记忆 + 对话历史 → 轻松超过 10,000 tokens context 占用
- 很多信息和当前对话无关，浪费 token

现在（三层加载）：
- L0 abstracts：~500 tokens（全局地图，每次必定加载）
- 0-identity + 1-inbox：~1000 tokens（必定加载但内容精简）
- L1 overview（检索命中的 1-2 个）：~500 tokens
- L2 文件（Agent 按需读取的 1-2 个）：按需
- 总固定开销：~2000 tokens，其余按需
- 预计减少 ~70-90% 的 context token 消耗
