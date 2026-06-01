# Little Claw — AI Agent 全栈平台

> 跳出上层框架限制，从 0 到 1 深入探索并构建 AI Agent Runtime

<!-- TODO: 替换为演示视频
<p align="center">
  <a href="https://your-demo-video-url">
    <img src="https://your-thumbnail-url" alt="演示视频" width="720" />
  </a>
</p>
-->

<p align="center">
  <strong>📹 演示视频即将上线</strong>
</p>

---

## 项目亮点

| | 亮点 | 说明 |
|---|---|---|
| 1 | **零框架依赖** | 不依赖框架，从 LLM 流式调用到 ReAct 循环全部手写，理解每一层在做什么 |
| 2 | **多 Agent 协调系统 (Lovely Octopus)** | 完整的团队运行时：确定性路由 + LLM 决策、任务队列状态机、HITL 审批门控、跨 Agent 通信 |
| 3 | **多 Agent 圆桌模拟引擎** | Parallel / Roundtable / Free 三种模式，支持 Persona 角色扮演、论点提取、用户作为 Moderator 参与 |
| 4 | **语义skills检索** | BM25 + 向量混合检索 → Rerank 二次确认，运行时动态匹配最相关 Skill 注入 System Prompt |

---

## 功能概览

- **核心 Agent 循环** — ReAct (Think → Act → Observe → Loop)，支持流式输出、Abort/Inject 中断注入
- **多模型支持** — Provider 抽象层统一 OpenAI / Anthropic / 任意兼容 API
- **三层工具体系** — Built-in Tools + SKILL.md 技能 + MCP 协议工具，统一注册调用
- **Sub-Agent 委托** — 主 Agent 可派生子 Agent 处理子任务，结果自动摘要压缩
- **持久化会话** — SQLite 存储对话历史，Session CRUD，自动标题生成
- **Gateway 架构** — WebSocket Server + JSON 协议，CLI / Web 作为瘦客户端
- **Skill 生态兼容** — 兼容 OpenClaw SKILL.md 格式（13000+ 现成 Skills）
- **MCP 客户端** — JSON-RPC 2.0 over stdio，config 驱动连接管理
- **定时调度** — Cron 定时任务 + Event Watcher 条件监控
- **三层上下文记忆** — Context Hub (PARA 目录结构) + 向量检索 + 每日日志
- **团队模式** — 多 Agent 长驻运行，TaskQueue 任务分发，Coordinator 调度决策
- **HITL 审批** — 软审批（Agent 主动请求）+ 硬门控（规则拦截），自然语言批复
- **模拟引擎** — 预置 11 个 Persona（Musk、Feynman、苏格拉底等），3 种执行模式
- **Web UI** — Next.js + React + Tailwind + shadcn/ui，实时流式渲染
- **飞书集成** — Webhook 适配器，支持 IM 场景接入

---

## 系统架构

<img width="1199" height="1312" alt="image" src="https://github.com/user-attachments/assets/14c13c28-7caf-4022-8b3e-69c4760b443b" />


---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Bun (TypeScript) |
| 后端通信 | WebSocket (Bun.serve 原生) |
| 数据库 | SQLite (bun:sqlite, WAL 模式) |
| LLM | OpenAI SDK / Anthropic SDK，Provider 抽象 |
| 向量检索 | Embedding API + SQLite 存储 + 余弦相似度 |
| 前端 | Next.js + React + Tailwind CSS + shadcn/ui |
| 外部依赖 | 仅 4 个：`openai`、`@anthropic-ai/sdk`、`cron-parser`、`yaml` |

---

## 模块设计

### Core — Agent 核心

[AgentLoop.ts](src/core/AgentLoop.ts) 实现完整的 ReAct 循环。LLM 生成 text 或 tool_use block → 工具执行 → 结果反馈 → 循环直至最终回复。支持 Abort（AbortController 取消 fetch + kill 子进程）和 Inject（运行中注入用户指令）。

[Conversation.ts](src/core/Conversation.ts) / [EphemeralConversation.ts](src/core/EphemeralConversation.ts) 分别用于持久化对话和 Sub-Agent 临时对话。

[ContextPolicy.ts](src/core/ContextPolicy.ts) 根据运行模式和用户意图动态决定上下文加载策略，避免不必要的 token 消耗。

### Gateway — 网关服务

[GatewayServer.ts](src/gateway/GatewayServer.ts) 基于 Bun.serve 的 WebSocket 服务器，处理所有客户端消息、Session 管理、工具/技能/记忆/模拟/团队命令。

[SessionRouter.ts](src/gateway/SessionRouter.ts) per-session 的 AgentLoop 管理，串行请求排队、空闲超时清理、消息注入。

[protocol.ts](src/gateway/protocol.ts) 定义完整的 JSON-over-WebSocket 通信协议（50+ 消息类型）。

### Tools — 三层工具体系

| 层级 | 说明 | 示例 |
|------|------|------|
| Built-in | 核心内置工具 | read_file, write_file, shell, spawn_agent, web_search |
| SKILL.md | Markdown 技能（注入 System Prompt） | 任何兼容 OpenClaw 的 Skill |
| MCP | 外部 MCP Server 工具 | JSON-RPC 2.0 over stdio |

[ToolRegistry.ts](src/tools/ToolRegistry.ts) 统一注册表，[pathGuard.ts](src/tools/builtin/pathGuard.ts) 实现工作区沙箱。

### Skills — 语义技能系统

**检索管线**：用户输入 → Embedding → BM25 + 向量混合检索 → 阈值过滤 + Gap 判断 → Rerank 二次确认 → Top-K 注入 System Prompt

- [SkillRetriever.ts](src/skills/SkillRetriever.ts) — 混合检索（30% BM25 + 70% 向量）
- [SkillFilter.ts](src/skills/SkillFilter.ts) — A+B+C 三阶段过滤
- [SkillReranker.ts](src/skills/SkillReranker.ts) — 外部 Rerank 模型二次确认
- [SkillLoader.ts](src/skills/SkillLoader.ts) — 扫描加载 SKILL.md，支持项目级 + 全局级优先级

### Memory — 三层上下文记忆

```
Context Hub (~/.little_claw/context-hub/)
├── 0-identity/     # L0: 身份（.abstract.md 摘要）
├── 1-inbox/        # L1: 收件箱（.overview.md 概览）
├── 2-areas/        # L2: 持续关注领域（完整文件）
├── 3-projects/     # 活跃项目
├── 4-knowledge/    # 可复用知识
└── 5-archive/      # 归档
```

- [ContextHub.ts](src/memory/ContextHub.ts) — 三层渐进加载（L0 摘要 → L1 概览 → L2 全文）
- [ContextRetriever.ts](src/memory/ContextRetriever.ts) — 语义检索 .overview.md
- [VectorStore.ts](src/memory/VectorStore.ts) — SQLite 存储 + 余弦相似度搜索
- [MemoryManager.ts](src/memory/MemoryManager.ts) — 增量摘要、每日日志、跨会话回忆
- [TokenBudget.ts](src/memory/TokenBudget.ts) — Token 预算分配与裁剪

### Team — 多 Agent 协调 (Lovely Octopus)

多个 Agent 长驻运行，通过 TaskQueue 协调工作：

- [CoordinatorLoop.ts](src/team/CoordinatorLoop.ts) — 调度中枢，确定性逻辑优先 + LLM 兜底决策
- [AgentWorker.ts](src/team/AgentWorker.ts) — 每个 Agent 的运行时，轮询任务/DM
- [TaskQueue.ts](src/team/TaskQueue.ts) — SQLite 任务队列，完整状态机 (pending → assigned → running → completed/failed)
- [TeamRouter.ts](src/team/TeamRouter.ts) — 确定性消息路由（@mentions、#project、/commands）
- [ApprovalGate.ts](src/team/ApprovalGate.ts) — 工具执行前的审批拦截（正则匹配 + 人工审批）

**HITL 双路径审批**：
1. 软审批 — Agent 主动调用 `request_approval` 工具请求人工确认
2. 硬门控 — `approval_rules` 配置规则自动拦截匹配的工具调用

### Simulation — 多 Agent 模拟

[SimulationRunner.ts](src/simulation/SimulationRunner.ts) 支持三种执行模式：

| 模式 | 说明 |
|------|------|
| Parallel | 各 Agent 独立反应（真并行），互不可见 |
| Roundtable | 顺序发言，通过 transcript 看到之前所有人的发言 |
| Free | 自由互动，维护 worldState，每轮看到环境+所有人行动 |

预置 11 个 Persona（Elon Musk、Sam Altman、Feynman、苏格拉底等），用户可作为 Moderator 参与控制轮次。

[ArgumentExtractor.ts](src/simulation/ArgumentExtractor.ts) 每轮自动提取论点结构（topic、supporters、opposers、consensusLevel）。

### Web UI

Next.js 前端应用，功能包括：
- 实时流式对话渲染（ToolCallCard、SubAgentCard、SkillsMatchedBanner）
- 模拟模式三栏 UI（Argument Map + Discussion + Control Panel）
- Mission Control 面板（Team、Tasks、Channels、Projects、Memory）
- 审批交互（ApprovalCard）

---

## 快速开始

```bash
# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 LLM_API_KEY, LLM_BASE_URL 等

# 启动（开发模式，Server + CLI 一起启动）
bun run dev

# 或者分别启动
bun run server   # 启动 Gateway Server (默认 :4000)
bun run cli      # 启动 CLI 客户端

# 运行测试
bun test
```

---
## 稳定运行
在项目根目录跑后端：

```bash
mkdir -p log
nohup bun run server > log/server.log 2>&1 &
echo $! > log/server.pid
```

在 `web/` 目录跑前端：

```bash
cd web
nohup bun run dev > ../log/web-dev.log 2>&1 &
echo $! > ../log/web-dev.pid
```

看日志：

```bash
tail -f log/server.log
tail -f log/web-dev.log
```

停止：

```bash
kill $(cat log/server.pid)
kill $(cat log/web-dev.pid)
```

确认还在不在：

```bash
ps -p $(cat log/server.pid)
ps -p $(cat log/web-dev.pid)
```


要更稳定一点，前端可以不用 `bun run dev`，而是：

```bash
cd web
bun run build
nohup bun run start > ../log/web.log 2>&1 &
echo $! > ../log/web.pid
```

`dev` 适合开发热更新，`build + start` 用于正式环境

---

## 项目结构

```
little_claw/
├── src/
│   ├── main.ts / server.ts / cli.ts   # 入口文件
│   ├── core/                           # AgentLoop, Conversation, ContextPolicy, Repl
│   ├── llm/                            # LLM Provider 抽象（OpenAI / Anthropic）
│   ├── tools/builtin/                  # 内置工具（read_file, write_file, shell, spawn_agent...）
│   ├── gateway/                        # WebSocket Gateway, SessionRouter, Protocol
│   ├── skills/                         # Skill 解析、检索、过滤、Rerank
│   ├── mcp/                            # MCP 客户端（JSON-RPC over stdio）
│   ├── memory/                         # ContextHub, VectorStore, MemoryManager
│   ├── team/                           # Lovely Octopus 团队运行时
│   ├── simulation/                     # 多 Agent 模拟引擎
│   ├── scheduler/                      # Cron + EventWatcher
│   ├── agents/                         # Agent 预设配置（YAML + SOUL.md）
│   ├── db/                             # SQLite 数据库层
│   ├── config/                         # 配置管理
│   └── types/                          # 共享类型定义
├── web/                                # Next.js 前端
├── tests/                              # 测试（按模块组织）
├── docs/                               # 设计文档
└── scripts/                            # 工具脚本
```

运行时数据目录（`~/.little_claw/`）：
```
~/.little_claw/
├── config.json          # MCP Server 配置、Skill 配置
├── data.db              # SQLite 数据库
├── agents/              # Agent 定义（agent.yaml + SOUL.md）
├── skills/              # 已安装 Skills
├── context-hub/         # 三层上下文文件
├── memory/              # 每日日志
├── personas/            # 模拟 Persona
└── scenarios/           # 模拟 Scenario
```

---

## 设计决策

### 为什么选 TypeScript 而非 Python？

AI 应用本质是 I/O 编排（LLM 调用、WebSocket 通信、子进程管理），Node.js 事件循环天然适合。TypeScript 的类型系统在协议定义（50+ 消息类型）和多模块协作中提供了关键的安全保障。Bun 提供原生 SQLite、WebSocket、TypeScript 支持，零配置即可运行。

### 为什么不用 LangChain ？

- 理解每一层的实现细节，调试和定制无障碍
- Inject（运行中注入指令）、模拟引擎、团队运行时等需求超出框架预设
- 框架抽象层厚，出问题难排查

---

## License

MIT
