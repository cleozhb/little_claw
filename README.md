# little_claw

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

# FOUNDATION — Agent core
## 1 Minimal agent
Bun + TS setup, LLM streaming client, multi-turn conversation REPL

## 2 Tool calling (ReAct loop)
Tool interface & registry, built-in tools, AgentLoop, LLM Provider abstraction

## 3 Persistence & sessions
SQLite, conversation save/restore, session CRUD, auto title generation

# INFRASTRUCTURE — Client-server & resilience
## 4 Gateway
WebSocket server, protocol, SessionRouter, CLI as client, server/client split

## 5 Heartbeat & health monitoring
Periodic health checks (WS, MCP, LLM API), auto-reconnect, status reporting

# EXTENSIBILITY — Plugin & scheduling
## 6 Local skill plugin system
Skill interface with lifecycle, SkillLoader, SkillManager, example WeatherSkill

## 7 MCP client support
MCP client (JSON-RPC over stdio), McpToolAdapter, config-driven connections

## 8 Cron scheduler & event watcher
Cron jobs, event watchers, implemented as built-in skills, push through Gateway

# INTELLIGENCE — Agent capabilities
## 9 Sub-agent mechanism
AgentConfig, SpawnAgentTool, recursive delegation, progress streaming

## 10 Memory system
Short-term window, long-term vector search, context assembler, token budgeting

# INTERFACE — User-facing
## 11 Web UI
Next.js + React + Tailwind, chat interface, real-time streaming, tool & sub-agent rendering

---

# Known Limitations & Future Work

## Sub-Agent 不支持并行执行

**现状：** Main Agent 在一轮对话中即使同时发出多个 `spawn_agent` 工具调用，它们也会被串行执行（第一个跑完才轮到第二个）。

**根因：**

1. **AgentLoop 工具串行执行** — `AgentLoop.run()` 中工具执行使用 `for...of` + `await`，逐个等待完成（`src/core/AgentLoop.ts:216`）。
2. **事件回调无法区分来源** — `SpawnAgentTool` 的 `currentCallback` 是单一引用（`src/tools/builtin/SpawnAgentTool.ts:31`），多个 Sub-Agent 并行时事件会混在一起，客户端无法区分。

**改进方向：**

1. **工具并行执行** — 将工具执行从串行 `for` 改为 `Promise.all` / `Promise.allSettled` 并发。需注意部分工具（如 shell）可能有依赖关系，应按工具类型决定是否并行。
2. **事件路由** — 每个 Sub-Agent 实例分配独立 ID，事件携带该 ID，客户端据此区分渲染。
3. **客户端渲染** — CLI / Web UI 需支持同时展示多个 Sub-Agent 的进度（分栏或交替带标签显示）。

