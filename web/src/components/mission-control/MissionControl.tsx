"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  FolderPlus,
  Hash,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCcw,
  Send,
  ShieldCheck,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConnectionStatus, wsClient } from "@/lib/websocket";
import type {
  AgentDetailInfo,
  AgentInfo,
  ClientMessage,
  ProjectChannelInfo,
  ServerMessage,
  TaskInfo,
  TaskStatus,
  TeamMessageInfo,
} from "@/types/protocol";

const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:4000/ws";

type ChannelSelection =
  | { type: "all"; id: "all"; label: string }
  | { type: "project"; id: string; label: string; project: string }
  | { type: "agent_dm"; id: string; label: string; agentName: string };

interface MissionControlContextValue {
  agents: AgentInfo[];
  agentDetail: AgentDetailInfo | null;
  channels: ProjectChannelInfo[];
  connectionStatus: ReturnType<typeof useConnectionStatus>;
  createProjectChannel: (input: {
    slug: string;
    title?: string;
    description?: string;
    contextPath?: string;
  }) => void;
  error: string | null;
  lastAction: string | null;
  loadAgentDetail: (name: string) => void;
  refresh: () => void;
  selectedChannel: ChannelSelection;
  selectChannel: (selection: ChannelSelection) => void;
  sendChannelMessage: (content: string) => void;
  tasks: TaskInfo[];
  timelineMessages: TeamMessageInfo[];
  updateTaskApproval: (taskId: string, decision: "approve" | "reject") => void;
}

const MissionControlContext = createContext<MissionControlContextValue | null>(null);

const navItems = [
  { href: "/mission-control/tasks", label: "Tasks", icon: Inbox },
  { href: "/mission-control/channels", label: "Channels", icon: MessageSquare },
  { href: "/mission-control/projects", label: "Projects", icon: Hash },
  { href: "/mission-control/team", label: "Team", icon: Users },
  { href: "/mission-control/calendar", label: "Calendar", icon: Clock3 },
  { href: "/mission-control/memory", label: "Memory", icon: FileText },
  { href: "/mission-control/docs", label: "Docs", icon: FileText },
];

const statusText = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
};

const taskColumns: Array<{
  key: string;
  title: string;
  statuses: TaskStatus[];
}> = [
  { key: "pending", title: "Pending", statuses: ["pending"] },
  { key: "running", title: "Running", statuses: ["assigned", "running", "approved"] },
  { key: "awaiting_approval", title: "Awaiting Approval", statuses: ["awaiting_approval"] },
  {
    key: "completed",
    title: "Completed",
    statuses: ["completed", "failed", "cancelled", "rejected"],
  },
];

function useMissionControl() {
  const value = useContext(MissionControlContext);
  if (!value) {
    throw new Error("useMissionControl must be used inside MissionControlProvider");
  }
  return value;
}

export function MissionControlProvider({ children }: { children: ReactNode }) {
  const connectionStatus = useConnectionStatus();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentDetail, setAgentDetail] = useState<AgentDetailInfo | null>(null);
  const [channels, setChannels] = useState<ProjectChannelInfo[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [timelineMessages, setTimelineMessages] = useState<TeamMessageInfo[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<ChannelSelection>({
    type: "all",
    id: "all",
    label: "All team messages",
  });
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const send = useCallback(
    (message: ClientMessage, failureMessage: string) => {
      if (connectionStatus !== "connected") {
        setError("WebSocket 未连接，无法发送请求。");
        return false;
      }
      wsClient.send(message);
      setError(null);
      setLastAction(failureMessage);
      return true;
    },
    [connectionStatus],
  );

  const refresh = useCallback(() => {
    if (connectionStatus !== "connected") return;
    wsClient.send({ type: "list_tasks", limit: 200 });
    wsClient.send({ type: "list_project_channels", limit: 100 });
    wsClient.send({ type: "get_team_messages", limit: 80 });
    wsClient.send({ type: "list_agents" });
  }, [connectionStatus]);

  const selectChannel = useCallback(
    (selection: ChannelSelection) => {
      setSelectedChannel(selection);
      if (connectionStatus !== "connected") {
        setError("WebSocket 未连接，无法加载频道消息。");
        return;
      }
      if (selection.type === "project") {
        wsClient.send({ type: "get_project_channel", project: selection.project, limit: 80 });
      } else if (selection.type === "agent_dm") {
        wsClient.send({
          type: "get_team_messages",
          channelType: "agent_dm",
          channelId: selection.agentName,
          limit: 80,
        });
      } else {
        wsClient.send({ type: "get_team_messages", limit: 80 });
      }
    },
    [connectionStatus],
  );

  const loadAgentDetail = useCallback(
    (name: string) => {
      if (!send({ type: "get_agent_detail", name }, `正在加载 ${name}`)) return;
    },
    [send],
  );

  const createProjectChannel = useCallback(
    (input: { slug: string; title?: string; description?: string; contextPath?: string }) => {
      const slug = input.slug.trim();
      if (!slug) {
        setError("Project slug 不能为空。");
        return;
      }
      send(
        {
          type: "create_project_channel",
          slug,
          title: input.title?.trim() || undefined,
          description: input.description?.trim() || undefined,
          contextPath: input.contextPath?.trim() || undefined,
          initializeContext: true,
        },
        `已创建 #${slug}`,
      );
    },
    [send],
  );

  const updateTaskApproval = useCallback(
    (taskId: string, decision: "approve" | "reject") => {
      const message =
        decision === "approve"
          ? ({ type: "approve_task", taskId, response: "Approved from Mission Control." } as const)
          : ({ type: "reject_task", taskId, response: "Rejected from Mission Control." } as const);
      send(message, decision === "approve" ? "已发送 approve" : "已发送 reject");
    },
    [send],
  );

  const sendChannelMessage = useCallback(
    (content: string) => {
      const text = content.trim();
      if (!text) return;

      const isCommand = /^(@|#|\/task\b)/.test(text);
      if (isCommand) {
        send(
          { type: "route_human_message", text, externalChannel: "websocket", userId: "mission-control" },
          "已提交路由消息",
        );
        return;
      }

      if (selectedChannel.type === "project") {
        send(
          {
            type: "send_project_message",
            project: selectedChannel.project,
            content: text,
            userId: "mission-control",
          },
          `已发送到 #${selectedChannel.project}`,
        );
        return;
      }

      if (selectedChannel.type === "agent_dm") {
        send(
          {
            type: "send_agent_dm",
            agentName: selectedChannel.agentName,
            content: text,
            userId: "mission-control",
          },
          `已发送到 @${selectedChannel.agentName}`,
        );
        return;
      }

      send(
        { type: "route_human_message", text, externalChannel: "websocket", userId: "mission-control" },
        "已提交团队消息",
      );
    },
    [selectedChannel, send],
  );

  useEffect(() => {
    wsClient.connect(WS_URL);
    return () => wsClient.disconnect();
  }, []);

  useEffect(() => {
    if (connectionStatus === "connected") {
      refresh();
    }
  }, [connectionStatus, refresh]);

  useEffect(() => {
    return wsClient.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case "agents_list":
          setAgents(message.agents);
          break;
        case "agent_detail_loaded":
          setAgentDetail(message.agent);
          setLastAction(`已加载 ${message.agent.name}`);
          break;
        case "project_channels_list":
          setChannels(message.channels);
          break;
        case "project_channel_created":
          setChannels((current) => upsertById(current, message.channel));
          setLastAction(`已创建 #${message.channel.slug}`);
          break;
        case "project_channel_loaded":
          setTimelineMessages(dedupeMessages(message.messages));
          break;
        case "team_messages_loaded":
          setTimelineMessages(dedupeMessages(message.messages));
          break;
        case "team_message_added":
          if (message.message.senderType !== "human") {
            setLastAction(formatTeamActivity(message.message));
          }
          setTimelineMessages((current) =>
            messageMatchesSelection(message.message, selectedChannel)
              ? dedupeMessages([...current, message.message])
              : current,
          );
          break;
        case "human_message_routed":
          setLastAction(message.result.ack);
          setTimelineMessages((current) =>
            messageMatchesSelection(message.message, selectedChannel)
              ? dedupeMessages([...current, message.message])
              : current,
          );
          break;
        case "tasks_list":
          setTasks(message.tasks);
          break;
        case "task_updated":
          setLastAction(`任务 ${message.task.title} 已更新为 ${message.task.status}`);
          setTasks((current) => upsertById(current, message.task));
          break;
        case "approval_needed":
          setLastAction(`任务需要审批：${message.task.title}`);
          setTasks((current) => upsertById(current, message.task));
          break;
        case "error":
          setError(message.message);
          break;
      }
    });
  }, [selectedChannel]);

  const value = useMemo<MissionControlContextValue>(
    () => ({
      agents,
      agentDetail,
      channels,
      connectionStatus,
      createProjectChannel,
      error,
      lastAction,
      loadAgentDetail,
      refresh,
      selectedChannel,
      selectChannel,
      sendChannelMessage,
      tasks,
      timelineMessages,
      updateTaskApproval,
    }),
    [
      agents,
      agentDetail,
      channels,
      connectionStatus,
      createProjectChannel,
      error,
      lastAction,
      loadAgentDetail,
      refresh,
      selectedChannel,
      selectChannel,
      sendChannelMessage,
      tasks,
      timelineMessages,
      updateTaskApproval,
    ],
  );

  return <MissionControlContext.Provider value={value}>{children}</MissionControlContext.Provider>;
}

export function MissionControlFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { connectionStatus, error, lastAction, refresh } = useMissionControl();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="hidden w-[250px] shrink-0 border-r border-border/60 bg-sidebar md:flex md:flex-col">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Mission Control</div>
            <div className="text-[10px] text-muted-foreground">Lovely Octopus</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-2 py-2">
          {navItems.map((item) => {
            const active =
              pathname === item.href || (pathname === "/mission-control" && item.href.endsWith("/tasks"));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <ConnectionPill status={connectionStatus} className="mx-3 mb-3" />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          <div className="flex items-center gap-2 md:hidden">
            <Zap className="h-4 w-4" />
            <span className="text-sm font-semibold">Mission Control</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {error ? (
              <div className="hidden max-w-[420px] items-center gap-1.5 truncate text-xs text-destructive sm:flex">
                <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{error}</span>
              </div>
            ) : lastAction ? (
              <div className="hidden max-w-[320px] truncate text-xs text-muted-foreground sm:block">
                {lastAction}
              </div>
            ) : null}
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <ConnectionPill status={connectionStatus} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}

export function TasksView() {
  const { tasks, updateTaskApproval } = useMissionControl();

  return (
    <section className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/60 px-4 py-3">
        <h1 className="text-base font-semibold">Tasks</h1>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{tasks.length} total</span>
          <span>{tasks.filter((task) => task.status === "awaiting_approval").length} awaiting approval</span>
          <span>{tasks.filter((task) => task.status === "running").length} running</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:grid-cols-4">
        {taskColumns.map((column) => {
          const columnTasks = tasks.filter((task) => column.statuses.includes(task.status));
          return (
            <div key={column.key} className="flex min-h-[240px] min-w-[260px] flex-col rounded-lg border bg-muted/20">
              <div className="flex h-10 items-center justify-between border-b px-3">
                <div className="text-xs font-semibold">{column.title}</div>
                <Badge variant="secondary" className="h-5 rounded-lg px-1.5 text-[10px]">
                  {columnTasks.length}
                </Badge>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {columnTasks.length === 0 ? (
                  <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                    Empty
                  </div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} onApproval={updateTaskApproval} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ChannelsView() {
  const {
    agents,
    channels,
    connectionStatus,
    selectedChannel,
    selectChannel,
    sendChannelMessage,
    timelineMessages,
  } = useMissionControl();
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    sendChannelMessage(draft);
    setDraft("");
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[280px_1fr]">
      <aside className="min-h-0 border-b border-border/60 md:border-b-0 md:border-r">
        <div className="border-b px-3 py-3">
          <h1 className="text-base font-semibold">Channels</h1>
        </div>
        <div className="max-h-[220px] space-y-4 overflow-y-auto p-2 md:max-h-none">
          <ChannelButton
            active={selectedChannel.type === "all"}
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="All team messages"
            meta={`${timelineMessages.length} loaded`}
            onClick={() => selectChannel({ type: "all", id: "all", label: "All team messages" })}
          />
          <ChannelGroup title="Projects">
            {channels.length === 0 ? (
              <EmptyLine text="No project channels" />
            ) : (
              channels.map((channel) => (
                <ChannelButton
                  key={channel.id}
                  active={selectedChannel.type === "project" && selectedChannel.project === channel.slug}
                  icon={<Hash className="h-3.5 w-3.5" />}
                  label={channel.title || channel.slug}
                  meta={channel.slug}
                  onClick={() =>
                    selectChannel({
                      type: "project",
                      id: channel.id,
                      label: channel.title || channel.slug,
                      project: channel.slug,
                    })
                  }
                />
              ))
            )}
          </ChannelGroup>
          <ChannelGroup title="Agent DM">
            {agents.length === 0 ? (
              <EmptyLine text="No agents" />
            ) : (
              agents
                .filter((agent) => agent.directMessage !== false)
                .map((agent) => (
                  <ChannelButton
                    key={agent.name}
                    active={selectedChannel.type === "agent_dm" && selectedChannel.agentName === agent.name}
                    icon={<Bot className="h-3.5 w-3.5" />}
                    label={agent.displayName || agent.name}
                    meta={`@${agent.name}`}
                    onClick={() =>
                      selectChannel({
                        type: "agent_dm",
                        id: agent.name,
                        label: agent.displayName || agent.name,
                        agentName: agent.name,
                      })
                    }
                  />
                ))
            )}
          </ChannelGroup>
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{selectedChannel.label}</div>
            <div className="text-[10px] text-muted-foreground">{timelineMessages.length} messages</div>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {timelineMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
              No messages
            </div>
          ) : (
            timelineMessages.map((message) => <TimelineMessage key={message.id} message={message} />)
          )}
        </div>
        <form onSubmit={handleSubmit} className="shrink-0 border-t p-3">
          <div className="flex gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="@coder review this, #lovely-octopus update, /task ..."
              className="max-h-32 min-h-12 resize-none text-sm"
              disabled={connectionStatus !== "connected"}
            />
            <Button type="submit" className="h-12 w-12" disabled={connectionStatus !== "connected" || !draft.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

export function ProjectsView() {
  const { channels, createProjectChannel, selectChannel } = useMissionControl();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const defaultContextPath = slug.trim() ? `context-hub/3-projects/${slug.trim()}` : "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const cleanSlug = slug.trim();
    if (!cleanSlug) return;
    createProjectChannel({
      slug: cleanSlug,
      title,
      description,
      contextPath: defaultContextPath,
    });
    setSlug("");
    setTitle("");
    setDescription("");
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[360px_1fr]">
      <aside className="min-h-0 border-b md:border-b-0 md:border-r">
        <div className="border-b px-3 py-3">
          <h1 className="text-base font-semibold">Projects</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 border-b p-3">
          <div>
            <label className="text-[10px] font-semibold uppercase text-muted-foreground">Slug</label>
            <Input
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/\s+/g, "-"))}
              placeholder="my-new-project"
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-muted-foreground">Title</label>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="My New Project"
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-muted-foreground">Description</label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Project scope, owner, or goal"
              className="mt-1 min-h-16 resize-none text-xs"
            />
          </div>
          <div className="rounded-lg border bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
            {defaultContextPath || "context-hub/3-projects/{slug}"}
          </div>
          <Button type="submit" className="w-full" disabled={!slug.trim()}>
            <FolderPlus className="h-3.5 w-3.5" />
            New Project
          </Button>
        </form>
      </aside>

      <div className="min-h-0 overflow-y-auto p-3">
        <div className="grid gap-3 lg:grid-cols-2">
          {channels.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              No projects
            </div>
          ) : (
            channels.map((channel) => (
              <article key={channel.id} className="rounded-lg border bg-background p-4">
                <div className="flex items-start gap-3">
                  <Hash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{channel.title}</h2>
                    <div className="mt-1 text-xs text-muted-foreground">#{channel.slug}</div>
                  </div>
                  <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                    {channel.status}
                  </Badge>
                </div>
                {channel.description ? (
                  <p className="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                    {channel.description}
                  </p>
                ) : null}
                <div className="mt-3 rounded-lg border bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                  {channel.contextPath ?? "No context path"}
                </div>
                <Link
                  href="/mission-control/channels"
                  onClick={() =>
                    selectChannel({
                      type: "project",
                      id: channel.id,
                      label: channel.title || channel.slug,
                      project: channel.slug,
                    })
                  }
                  className="mt-3 inline-flex h-7 items-center gap-1 rounded-lg bg-secondary px-2.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Open Channel
                </Link>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function TeamView() {
  const { agents, agentDetail, loadAgentDetail } = useMissionControl();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<"agent.yaml" | "SOUL.md" | "AGENTS.md">("agent.yaml");
  const activeAgentName = selectedAgent ?? agents[0]?.name ?? null;

  useEffect(() => {
    if (!activeAgentName) return;
    queueMicrotask(() => loadAgentDetail(activeAgentName));
  }, [activeAgentName, loadAgentDetail]);

  const fileContent =
    selectedFile === "agent.yaml"
      ? agentDetail?.agentYaml
      : selectedFile === "SOUL.md"
        ? agentDetail?.soul
        : agentDetail?.agentsMd;

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_1fr]">
      <aside className="min-h-0 border-b md:border-b-0 md:border-r">
        <div className="border-b px-3 py-3">
          <h1 className="text-base font-semibold">Team</h1>
        </div>
        <div className="max-h-[240px] space-y-2 overflow-y-auto p-2 md:max-h-none">
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No agents</div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.name}
                type="button"
                onClick={() => {
                  setSelectedAgent(agent.name);
                  setSelectedFile("agent.yaml");
                  loadAgentDetail(agent.name);
                }}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                    activeAgentName === agent.name ? "bg-accent" : "hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {agent.displayName || agent.name}
                  </span>
                  <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                    {agent.status ?? "preset"}
                  </Badge>
                </div>
                <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  {agent.role || agent.description}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(agent.taskTags ?? agent.allowedTools).slice(0, 4).map((tag) => (
                    <Badge key={tag} variant="secondary" className="h-5 rounded-lg text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="flex min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{agentDetail?.displayName ?? activeAgentName ?? "Agent"}</div>
            <div className="truncate text-xs text-muted-foreground">{agentDetail?.role ?? "Select an agent"}</div>
          </div>
          {(["agent.yaml", "SOUL.md", "AGENTS.md"] as const).map((file) => (
            <Button
              key={file}
              variant={selectedFile === file ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSelectedFile(file)}
            >
              <FileText className="h-3.5 w-3.5" />
              {file}
            </Button>
          ))}
        </div>
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5 text-foreground">
          {fileContent ?? "No file loaded"}
        </pre>
      </div>
    </section>
  );
}

export function PlaceholderView({ title }: { title: string }) {
  return (
    <section className="flex h-full items-center justify-center p-4">
      <div className="rounded-lg border border-dashed p-6 text-center">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">Coming later</div>
      </div>
    </section>
  );
}

function TaskCard({
  task,
  onApproval,
}: {
  task: TaskInfo;
  onApproval: (taskId: string, decision: "approve" | "reject") => void;
}) {
  return (
    <article className="rounded-lg border bg-background p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-medium">{task.title}</h2>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
              {task.status}
            </Badge>
            {task.assignedTo ? (
              <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                @{task.assignedTo}
              </Badge>
            ) : null}
            {task.project ? (
              <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                #{task.project}
              </Badge>
            ) : null}
          </div>
        </div>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">P{task.priority}</span>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{task.description}</p>
      {task.approvalPrompt ? (
        <div className="mt-2 rounded-lg border bg-muted/30 p-2 text-xs leading-5">{task.approvalPrompt}</div>
      ) : null}
      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{formatDate(task.updatedAt)}</span>
        <span className="truncate pl-2">{task.id.slice(0, 8)}</span>
      </div>
      {task.status === "awaiting_approval" ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" variant="secondary" onClick={() => onApproval(task.id, "approve")}>
            <Check className="h-3.5 w-3.5" />
            Approve
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onApproval(task.id, "reject")}>
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ChannelGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div>
      <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ChannelButton({
  active,
  icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
      <span className="max-w-24 truncate text-[10px] opacity-70">{meta}</span>
    </button>
  );
}

function TimelineMessage({ message }: { message: TeamMessageInfo }) {
  return (
    <article className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
          {message.senderType}
        </Badge>
        <span className="text-xs font-medium">{message.senderId}</span>
        {message.project ? <span className="text-[10px] text-muted-foreground">#{message.project}</span> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{formatDate(message.createdAt)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{message.content}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
          {message.channelType}
        </Badge>
        <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
          {message.status}
        </Badge>
        {message.taskId ? (
          <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
            task {message.taskId.slice(0, 8)}
          </Badge>
        ) : null}
      </div>
    </article>
  );
}

function ConnectionPill({
  className,
  status,
}: {
  className?: string;
  status: ReturnType<typeof useConnectionStatus>;
}) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-lg border bg-background px-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {status === "connecting" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : status === "connected" ? (
        <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <CircleAlert className="h-3.5 w-3.5 text-destructive" />
      )}
      {statusText[status]}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{text}</div>;
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const found = items.some((entry) => entry.id === item.id);
  if (!found) return [item, ...items];
  return items.map((entry) => (entry.id === item.id ? item : entry));
}

function dedupeMessages(messages: TeamMessageInfo[]) {
  return Array.from(new Map(messages.map((message) => [message.id, message])).values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function messageMatchesSelection(message: TeamMessageInfo, selection: ChannelSelection) {
  if (selection.type === "all") return true;
  if (selection.type === "agent_dm") {
    return message.channelType === "agent_dm" && message.channelId === selection.agentName;
  }
  if (message.channelType !== "project") return false;

  const projectKey = messageProjectKey(message);
  return projectKey === selection.project || message.channelId === selection.id;
}

function messageProjectKey(message: TeamMessageInfo) {
  return message.project ?? message.channelId;
}

function formatTeamActivity(message: TeamMessageInfo) {
  const sender =
    message.senderType === "coordinator"
      ? "coordinator"
      : message.senderType === "agent"
        ? `@${message.senderId}`
        : message.senderType;
  const target =
    message.channelType === "project"
      ? `#${messageProjectKey(message)}`
      : message.channelType === "agent_dm"
        ? `@${message.channelId}`
        : message.channelId;
  return `${sender} 在 ${target} 回复：${messagePreview(message.content)}`;
}

function messagePreview(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 60)}...` : compact;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
