// Chat-specific display types (not protocol types — those are in types/protocol.ts)

export interface DisplaySession {
  id: string;
  title: string;
  lastMessage: string;
  updatedAt: Date;
}

export type DisplayMessageType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "sub_agent_start"
  | "sub_agent_progress"
  | "sub_agent_done"
  | "inject"
  | "memory_recall";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  type: DisplayMessageType;
  content: string;
  /** extra metadata for tool_call / sub_agent / memory */
  meta?: {
    toolName?: string;
    toolParams?: Record<string, unknown>;
    toolResult?: string;
    toolSuccess?: boolean;
    toolDurationMs?: number;
    agentName?: string;
    task?: string;
    result?: string;
    success?: boolean;
    /** Nested events for sub_agent_progress */
    nestedEvents?: DisplayMessage[];
    /** Memory recall entries */
    memories?: Array<{ content: string; similarity: number }>;
  };
  timestamp: Date;
}

// Use a fixed reference time to avoid SSR/client hydration mismatch.
// In production this would come from the server.
const REF = new Date("2026-04-06T10:00:00").getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const mockSessions: DisplaySession[] = [
  {
    id: "s1",
    title: "Next.js 项目搭建",
    lastMessage: "项目结构已生成，接下来配置 Tailwind…",
    updatedAt: new Date(REF - 3 * MIN),
  },
  {
    id: "s2",
    title: "WebSocket 实时通信",
    lastMessage: "建议使用 Bun.serve 的 websocket…",
    updatedAt: new Date(REF - 4 * HOUR),
  },
  {
    id: "s3",
    title: "数据库 Schema 设计",
    lastMessage: "SQLite 对于这个场景够用了",
    updatedAt: new Date(REF - 2 * DAY),
  },
];

export const mockMessagesBySession: Record<string, DisplayMessage[]> = {
  s1: [
    {
      id: "m1",
      role: "user",
      type: "text",
      content: "帮我搭建一个 Next.js 项目，需要 TypeScript + Tailwind CSS + App Router。",
      timestamp: new Date(REF - 20 * MIN),
    },
    {
      id: "m2",
      role: "assistant",
      type: "text",
      content:
        "好的，我来初始化项目。推荐使用 App Router + shadcn/ui 组件库，可以快速搭建出美观的界面。",
      timestamp: new Date(REF - 19 * MIN),
    },
    {
      id: "m3",
      role: "assistant",
      type: "tool_call",
      content: "正在创建项目目录…",
      meta: {
        toolName: "bash",
        toolParams: { command: "bunx create-next-app@latest web --ts --tailwind --app --src-dir" },
      },
      timestamp: new Date(REF - 18 * MIN),
    },
    {
      id: "m4",
      role: "assistant",
      type: "tool_result",
      content: "项目创建成功 ✓",
      meta: { toolName: "bash", success: true, result: "Success! Created web at /project/web" },
      timestamp: new Date(REF - 17 * MIN),
    },
    {
      id: "m5",
      role: "assistant",
      type: "sub_agent_start",
      content: "启动子 Agent 安装 shadcn/ui 组件…",
      meta: { agentName: "package-installer", task: "安装 shadcn/ui 并添加 button, input, card 等组件" },
      timestamp: new Date(REF - 16 * MIN),
    },
    {
      id: "m6",
      role: "assistant",
      type: "sub_agent_done",
      content: "子 Agent 完成：已安装 7 个 shadcn/ui 组件",
      meta: { agentName: "package-installer", result: "安装完成：button, input, card, badge, avatar, separator, scroll-area" },
      timestamp: new Date(REF - 12 * MIN),
    },
    {
      id: "m7",
      role: "assistant",
      type: "text",
      content:
        "项目结构已生成，接下来配置 Tailwind 和深色模式支持。你需要我继续吗？",
      timestamp: new Date(REF - 3 * MIN),
    },
  ],
  s2: [
    {
      id: "m8",
      role: "user",
      type: "text",
      content: "WebSocket 和 SSE 选哪个做实时聊天？",
      timestamp: new Date(REF - 5 * HOUR),
    },
    {
      id: "m9",
      role: "assistant",
      type: "text",
      content:
        "聊天场景推荐 WebSocket——双向通信、低延迟。SSE 是单向的，更适合通知推送。\n\nBun 原生支持 WebSocket，用 `Bun.serve()` 就能直接处理，不需要额外依赖。",
      timestamp: new Date(REF - 5 * HOUR + 30_000),
    },
    {
      id: "m10",
      role: "user",
      type: "text",
      content: "给个 Bun WebSocket 的简单示例？",
      timestamp: new Date(REF - 4 * HOUR - 10 * MIN),
    },
    {
      id: "m11",
      role: "assistant",
      type: "text",
      content:
        '```ts\nBun.serve({\n  fetch(req, server) {\n    if (server.upgrade(req)) return;\n    return new Response("Not found", { status: 404 });\n  },\n  websocket: {\n    open(ws) { console.log("connected"); },\n    message(ws, msg) { ws.send(msg); },\n    close(ws) { console.log("disconnected"); },\n  },\n});\n```\n\n这是一个最简 echo server，收到什么就回什么。',
      timestamp: new Date(REF - 4 * HOUR),
    },
  ],
  s3: [
    {
      id: "m12",
      role: "user",
      type: "text",
      content: "聊天记录用什么数据库存比较好？量不大。",
      timestamp: new Date(REF - 2 * DAY - 1 * HOUR),
    },
    {
      id: "m13",
      role: "assistant",
      type: "text",
      content:
        "SQLite 完全够用。Bun 内置 `bun:sqlite`，零依赖、性能优秀。\n\n建议两张表：\n- **sessions**: id, title, created_at, updated_at\n- **messages**: id, session_id, role, content, created_at",
      timestamp: new Date(REF - 2 * DAY - 1 * HOUR + 30_000),
    },
    {
      id: "m14",
      role: "assistant",
      type: "tool_call",
      content: "创建数据库初始化脚本…",
      meta: {
        toolName: "write_file",
        toolParams: { path: "src/db/init.ts", content: "CREATE TABLE IF NOT EXISTS sessions..." },
      },
      timestamp: new Date(REF - 2 * DAY - 50 * MIN),
    },
    {
      id: "m15",
      role: "assistant",
      type: "tool_result",
      content: "文件写入成功 ✓",
      meta: { toolName: "write_file", success: true, result: "src/db/init.ts 已创建" },
      timestamp: new Date(REF - 2 * DAY - 49 * MIN),
    },
    {
      id: "m16",
      role: "assistant",
      type: "text",
      content: "初始化脚本已写好。应用启动时会自动建表，后期频繁改表再引入迁移工具。",
      timestamp: new Date(REF - 2 * DAY),
    },
  ],
};
