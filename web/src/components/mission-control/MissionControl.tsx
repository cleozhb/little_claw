"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  BrainCircuit,
  Check,
  CircleAlert,
  Clock3,
  Eye,
  FileText,
  FolderPlus,
  Hash,
  Inbox,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AutocompleteInput } from "@/components/mission-control/AutocompleteInput";
import { Markdown } from "@/components/markdown";
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
  TeamScheduleInfo,
  TeamScheduleRunInfo,
  TaskInfo,
  TaskStatus,
  TeamMessageInfo,
} from "@/types/protocol";
import { messageMatchesChannelSelection, shouldUseTeamRouter } from "./channel-routing";

const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:4000/ws";
const CHANNEL_UNREAD_STORAGE_KEY = "little-claw:mission-control:channel-unread-counts:v1";

type ChannelSelection =
  | { type: "all"; id: "all"; label: string }
  | { type: "project"; id: string; label: string; project: string }
  | { type: "agent_dm"; id: string; label: string; agentName: string };

type ChannelUnreadCounts = Record<string, number>;

type OctopusState = "idle" | "working" | "departing" | "walking" | "arriving" | "talking" | "returning";

interface AgentActivity {
  state: OctopusState;
  targetAgent?: string;
  message?: string;
  taskCount: number;
  lastActivity: number;
}

const RETRO_COLORS = [
  "#e85d75", // coral red
  "#5bc0be", // teal
  "#d4a843", // warm gold
  "#9b5de5", // purple
  "#f15bb5", // pink
  "#00bbf9", // sky blue
  "#8ac926", // lime green
  "#ff6b35", // orange
];

const AGENT_COLOR_OVERRIDES: Record<string, string> = {
  "podcast-curator": "#9b5de5", // purple
  "vc-analyst": "#f59e0b", // amber
};

function retroColor(name: string) {
  if (AGENT_COLOR_OVERRIDES[name]) return AGENT_COLOR_OVERRIDES[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return RETRO_COLORS[Math.abs(hash) % RETRO_COLORS.length];
}

function isCommunicating(state: OctopusState) {
  return state === "departing" || state === "walking" || state === "arriving" || state === "talking" || state === "returning";
}

function isDockedAtTarget(state: OctopusState) {
  return state === "walking" || state === "arriving" || state === "talking";
}

// Visual-only animation sequence derived from gateway events.
const DEPARTURE_DURATION_MS = 180;
const TRAVEL_DURATION_MS = 1300;
const ARRIVAL_DURATION_MS = 240;
const TALK_DURATION_MS = 4000;
const RETURN_DURATION_MS = 900;

interface TaskStreamingState {
  agentName: string;
  text: string;
}

interface MissionControlContextValue {
  agents: AgentInfo[];
  agentActivities: Record<string, AgentActivity>;
  agentDetail: AgentDetailInfo | null;
  channelUnreadCounts: ChannelUnreadCounts;
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
  loadTeamScheduleRuns: (scheduleId?: string, limit?: number) => void;
  markChannelRead: (selection: ChannelSelection) => void;
  refresh: () => void;
  runTeamScheduleNow: (scheduleId: string) => void;
  selectedChannel: ChannelSelection;
  selectChannel: (selection: ChannelSelection) => void;
  sendChannelMessage: (content: string) => void;
  taskStreaming: Record<string, TaskStreamingState>;
  teamScheduleRuns: TeamScheduleRunInfo[];
  teamSchedules: TeamScheduleInfo[];
  tasks: TaskInfo[];
  timelineMessages: TeamMessageInfo[];
  updateTeamSchedule: (
    scheduleId: string,
    updates: Extract<ClientMessage, { type: "update_team_schedule" }>["updates"],
  ) => void;
  updateTaskApproval: (taskId: string, decision: "approve" | "reject") => void;
}

const MissionControlContext = createContext<MissionControlContextValue | null>(null);

const navItems = [
  { href: "/mission-control/tasks", label: "Tasks", icon: Inbox },
  { href: "/mission-control/channels", label: "Channels", icon: MessageSquare },
  { href: "/mission-control/projects", label: "Projects", icon: Hash },
  { href: "/mission-control/team",     label: "Team",     icon: Users },
  { href: "/mission-control/calendar", label: "Calendar", icon: Clock3 },
  { href: "/mission-control/memory",   label: "Memory",   icon: BrainCircuit },
  { href: "/mission-control/docs",     label: "Docs",     icon: FileText },
  { href: "/mission-control/visual",   label: "Visual",   icon: Eye },
];

const CHANNEL_COLORS = [
  { dot: "bg-blue-500", border: "border-l-blue-500", text: "text-blue-700", bg: "bg-blue-50" },
  { dot: "bg-emerald-500", border: "border-l-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
  { dot: "bg-violet-500", border: "border-l-violet-500", text: "text-violet-700", bg: "bg-violet-50" },
  // { dot: "bg-amber-500", border: "border-l-amber-500", text: "text-amber-700", bg: "bg-amber-50" },
  { dot: "bg-cyan-500", border: "border-l-cyan-500", text: "text-cyan-700", bg: "bg-cyan-50" },
  { dot: "bg-indigo-500", border: "border-l-indigo-500", text: "text-indigo-700", bg: "bg-indigo-50" },
  // { dot: "bg-orange-500", border: "border-l-orange-500", text: "text-orange-700", bg: "bg-orange-50" },
  { dot: "bg-teal-500", border: "border-l-teal-500", text: "text-teal-700", bg: "bg-teal-50" },
];

const CHANNEL_COLOR_OVERRIDES: Record<string, (typeof CHANNEL_COLORS)[number]> = {
  "venture-radar": { dot: "bg-teal-500", border: "border-l-teal-500", text: "text-teal-700", bg: "bg-teal-50" },
  "health-management": { dot: "bg-emerald-500", border: "border-l-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
};

const TIMELINE_PREVIEW_CHARS = 1600;

function channelColor(key: string) {
  const override = CHANNEL_COLOR_OVERRIDES[key.toLowerCase()];
  if (override) return override;

  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  return CHANNEL_COLORS[Math.abs(hash) % CHANNEL_COLORS.length];
}

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
  const pathname = usePathname();
  const connectionStatus = useConnectionStatus();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentActivities, setAgentActivities] = useState<Record<string, AgentActivity>>({});
  const [agentDetail, setAgentDetail] = useState<AgentDetailInfo | null>(null);
  const [channelUnreadCounts, setChannelUnreadCounts] = useState<ChannelUnreadCounts>({});
  const [channels, setChannels] = useState<ProjectChannelInfo[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [taskStreaming, setTaskStreaming] = useState<Record<string, TaskStreamingState>>({});
  const [teamSchedules, setTeamSchedules] = useState<TeamScheduleInfo[]>([]);
  const [teamScheduleRuns, setTeamScheduleRuns] = useState<TeamScheduleRunInfo[]>([]);
  const [timelineMessages, setTimelineMessages] = useState<TeamMessageInfo[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<ChannelSelection>({
    type: "all",
    id: "all",
    label: "Command Center",
  });
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const skipInitialUnreadPersistRef = useRef(true);
  const unreadMessageIdsRef = useRef(new Set<string>());

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

  useEffect(() => {
    setChannelUnreadCounts(readStoredChannelUnreadCounts());
  }, []);

  useEffect(() => {
    if (skipInitialUnreadPersistRef.current) {
      skipInitialUnreadPersistRef.current = false;
      return;
    }
    writeStoredChannelUnreadCounts(channelUnreadCounts);
  }, [channelUnreadCounts]);

  const markChannelRead = useCallback((selection: ChannelSelection) => {
    setChannelUnreadCounts((current) => clearUnreadCountsForSelection(current, selection));
  }, []);

  const refresh = useCallback(() => {
    if (connectionStatus !== "connected") return;
    wsClient.send({ type: "list_tasks", limit: 200 });
    wsClient.send({ type: "list_project_channels", limit: 100 });
    wsClient.send({ type: "get_team_messages", limit: 80 });
    wsClient.send({ type: "list_agents" });
    wsClient.send({ type: "list_team_schedules", limit: 200 });
    wsClient.send({ type: "get_team_schedule_runs", limit: 80 });
  }, [connectionStatus]);

  const selectChannel = useCallback(
    (selection: ChannelSelection) => {
      setSelectedChannel(selection);
      markChannelRead(selection);
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
    [connectionStatus, markChannelRead],
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
      setTasks((current) =>
        current.map((t) =>
          t.id === taskId
            ? { ...t, status: decision === "approve" ? "approved" : "rejected" }
            : t,
        ),
      );
    },
    [send],
  );

  const loadTeamScheduleRuns = useCallback(
    (scheduleId?: string, limit = 80) => {
      send(
        { type: "get_team_schedule_runs", scheduleId, limit },
        scheduleId ? "正在加载定时任务运行记录" : "正在加载最近运行记录",
      );
    },
    [send],
  );

  const updateTeamSchedule = useCallback(
    (
      scheduleId: string,
      updates: Extract<ClientMessage, { type: "update_team_schedule" }>["updates"],
    ) => {
      send({ type: "update_team_schedule", scheduleId, updates }, "已更新定时任务");
    },
    [send],
  );

  const runTeamScheduleNow = useCallback(
    (scheduleId: string) => {
      send({ type: "run_team_schedule_now", scheduleId }, "已请求立即执行");
    },
    [send],
  );

  const sendChannelMessage = useCallback(
    (content: string) => {
      const text = content.trim();
      if (!text) return;

      const mentionedAgent = selectedChannel.type === "project" ? findLeadingAgentMention(text, agents) : undefined;
      if (selectedChannel.type === "project" && mentionedAgent) {
        send(
          {
            type: "send_agent_dm",
            agentName: mentionedAgent.name,
            project: selectedChannel.project,
            content: text,
            userId: "mission-control",
          },
          `已发送到 @${mentionedAgent.name}，并归入 #${selectedChannel.project}`,
        );
        return;
      }

      if (shouldUseTeamRouter(text, selectedChannel)) {
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
    [selectedChannel, agents, send],
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
          // Initialize activities for new agents
          setAgentActivities((prev) => {
            const next = { ...prev };
            for (const agent of message.agents) {
              if (!next[agent.name]) {
                next[agent.name] = { state: "idle", taskCount: 0, lastActivity: Date.now() };
              }
            }
            return next;
          });
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
          if (!unreadMessageIdsRef.current.has(message.message.id)) {
            unreadMessageIdsRef.current.add(message.message.id);
            if (
              shouldCountUnreadMessage(message.message) &&
              !(isChannelsPath(pathname) && messageMatchesSelection(message.message, selectedChannel))
            ) {
              setChannelUnreadCounts((current) => incrementUnreadCountForMessage(current, message.message));
            }
          }
          // Trigger octopus walking animation for ANY agent/coordinator communication
          if (message.message.senderType === "agent" || message.message.senderType === "coordinator") {
            const senderId = message.message.senderId;
            const targetAgent = inferTargetAgent(message.message);
            if (targetAgent && targetAgent !== senderId) {
              setAgentActivities((prev) => {
                const base = prev[senderId] ?? { state: "idle" as OctopusState, taskCount: 0, lastActivity: Date.now() };
                return {
                  ...prev,
                  [senderId]: {
                    ...base,
                    state: "departing",
                    targetAgent,
                    message: message.message.content,
                    lastActivity: Date.now(),
                  },
                };
              });
            }
          }
          setTimelineMessages((current) =>
            messageMatchesSelection(message.message, selectedChannel)
              ? dedupeMessages([...current, message.message])
              : current,
          );
          break;
        case "human_message_routed":
          unreadMessageIdsRef.current.add(message.message.id);
          setLastAction(message.result.ack);
          setTimelineMessages((current) =>
            messageMatchesSelection(message.message, selectedChannel)
              ? dedupeMessages([...current, message.message])
              : current,
          );
          break;
        case "tasks_list":
          setTasks((current) => {
            const currentMap = new Map(current.map((t) => [t.id, t]));
            return message.tasks.map((serverTask: any) => {
              const local = currentMap.get(serverTask.id);
              if (local && local.status !== "awaiting_approval" && serverTask.status === "awaiting_approval") {
                return local;
              }
              return serverTask;
            });
          });
          break;
        case "task_progress":
          setTaskStreaming((prev) => {
            const existing = prev[message.taskId];
            return {
              ...prev,
              [message.taskId]: {
                agentName: message.agentName,
                text: (existing?.text ?? "") + message.delta,
              },
            };
          });
          break;
        case "team_schedules_list":
          setTeamSchedules(sortSchedules(message.schedules));
          break;
        case "team_schedule_updated":
          setTeamSchedules((current) => sortSchedules(upsertById(current, message.schedule)));
          setLastAction(`定时任务已更新：${message.schedule.name}`);
          break;
        case "team_schedule_triggered":
          setTeamSchedules((current) => sortSchedules(upsertById(current, message.schedule)));
          setTeamScheduleRuns((current) => upsertRun(current, message.run));
          if (message.task) {
            setTasks((current) => upsertById(current, message.task!));
          }
          setLastAction(formatScheduleRunActivity(message.schedule, message.run));
          break;
        case "team_schedule_runs":
          setTeamScheduleRuns(message.runs);
          break;
        case "task_updated":
          setLastAction(`任务 ${message.task.title} 已更新为 ${message.task.status}`);
          setTasks((current) => upsertById(current, message.task));
          // Clear streaming state when task reaches a terminal or waiting state
          if (message.task.status !== "running" && message.task.status !== "assigned"
            && message.task.status !== "approved" && message.task.status !== "rejected") {
            setTaskStreaming((prev) => {
              if (!prev[message.task.id]) return prev;
              const { [message.task.id]: _, ...rest } = prev;
              return rest;
            });
          }
          // Animate: coordinator walks to agent when assigning a task
          if (message.task.assignedTo && message.task.status === "assigned") {
            setAgentActivities((prev) => {
              // The "coordinator" might be named differently; use createdBy or "coordinator"
              const coordinatorName = message.task.createdBy || "coordinator";
              const base = prev[coordinatorName] ?? { state: "idle" as OctopusState, taskCount: 0, lastActivity: Date.now() };
              return {
                ...prev,
                [coordinatorName]: {
                  ...base,
                  state: "departing",
                  targetAgent: message.task.assignedTo,
                  message: `分配中：${message.task.title}`,
                  lastActivity: Date.now(),
                },
              };
            });
          }
          // Animate: agent walks to coordinator when completing/failing a task
          if (message.task.assignedTo && (message.task.status === "completed" || message.task.status === "failed")) {
            setAgentActivities((prev) => {
              const agentName = message.task.assignedTo!;
              const base = prev[agentName] ?? { state: "idle" as OctopusState, taskCount: 0, lastActivity: Date.now() };
              const coordinatorName = message.task.createdBy || "coordinator";
              return {
                ...prev,
                [agentName]: {
                  ...base,
                  state: "departing",
                  targetAgent: coordinatorName,
                  message: message.task.status === "completed" ? `已完成：${message.task.title}` : `失败：${message.task.title}`,
                  lastActivity: Date.now(),
                },
              };
            });
          }
          // Update agent working state from task assignments
          if (message.task.assignedTo) {
            setAgentActivities((prev) => {
              const name = message.task.assignedTo!;
              const base = prev[name] ?? { state: "idle" as OctopusState, taskCount: 0, lastActivity: Date.now() };
              const isRunning = message.task.status === "running" || message.task.status === "assigned";
              // Don't override an active communication animation.
              if (isCommunicating(base.state)) {
                return {
                  ...prev,
                  [name]: { ...base, taskCount: isRunning ? base.taskCount + 1 : base.taskCount },
                };
              }
              return {
                ...prev,
                [name]: {
                  ...base,
                  state: isRunning ? "working" : "idle",
                  lastActivity: Date.now(),
                },
              };
            });
          }
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
  }, [pathname, selectedChannel]);

  // Animation sequence timers:
  // departing → walking → arriving → talking → returning → idle/working
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [name, activity] of Object.entries(agentActivities)) {
      if (activity.state === "departing") {
        timers.push(
          setTimeout(() => {
            setAgentActivities((prev) => {
              const current = prev[name];
              if (!current || current.state !== "departing") return prev;
              return {
                ...prev,
                [name]: { ...current, state: "walking" },
              };
            });
          }, DEPARTURE_DURATION_MS),
        );
      } else if (activity.state === "walking") {
        timers.push(
          setTimeout(() => {
            setAgentActivities((prev) => {
              const current = prev[name];
              if (!current || current.state !== "walking") return prev;
              return {
                ...prev,
                [name]: { ...current, state: "arriving" },
              };
            });
          }, TRAVEL_DURATION_MS),
        );
      } else if (activity.state === "arriving") {
        timers.push(
          setTimeout(() => {
            setAgentActivities((prev) => {
              const current = prev[name];
              if (!current || current.state !== "arriving") return prev;
              return {
                ...prev,
                [name]: { ...current, state: "talking" },
              };
            });
          }, ARRIVAL_DURATION_MS),
        );
      } else if (activity.state === "talking") {
        timers.push(
          setTimeout(() => {
            setAgentActivities((prev) => {
              const current = prev[name];
              if (!current || current.state !== "talking") return prev;
              return {
                ...prev,
                [name]: { ...current, state: "returning" },
              };
            });
          }, TALK_DURATION_MS),
        );
      } else if (activity.state === "returning") {
        timers.push(
          setTimeout(() => {
            setAgentActivities((prev) => {
              const current = prev[name];
              if (!current || current.state !== "returning") return prev;
              return {
                ...prev,
                [name]: {
                  ...current,
                  state: current.taskCount > 0 ? "working" : "idle",
                  targetAgent: undefined,
                  message: undefined,
                },
              };
            });
          }, RETURN_DURATION_MS),
        );
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [agentActivities]);

  // Sync taskCount into agentActivities from tasks
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      if (task.assignedTo && (task.status === "running" || task.status === "assigned")) {
        counts[task.assignedTo] = (counts[task.assignedTo] ?? 0) + 1;
      }
    }
    setAgentActivities((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const name of Object.keys(next)) {
        const newCount = counts[name] ?? 0;
        if (next[name].taskCount !== newCount) {
          next[name] = { ...next[name], taskCount: newCount };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const value = useMemo<MissionControlContextValue>(
    () => ({
      agents,
      agentActivities,
      agentDetail,
      channelUnreadCounts,
      channels,
      connectionStatus,
      createProjectChannel,
      error,
      lastAction,
      loadAgentDetail,
      loadTeamScheduleRuns,
      markChannelRead,
      refresh,
      runTeamScheduleNow,
      selectedChannel,
      selectChannel,
      sendChannelMessage,
      taskStreaming,
      teamScheduleRuns,
      teamSchedules,
      tasks,
      timelineMessages,
      updateTeamSchedule,
      updateTaskApproval,
    }),
    [
      agents,
      agentActivities,
      agentDetail,
      channelUnreadCounts,
      channels,
      connectionStatus,
      createProjectChannel,
      error,
      lastAction,
      loadAgentDetail,
      loadTeamScheduleRuns,
      markChannelRead,
      refresh,
      runTeamScheduleNow,
      selectedChannel,
      selectChannel,
      sendChannelMessage,
      taskStreaming,
      teamScheduleRuns,
      teamSchedules,
      tasks,
      timelineMessages,
      updateTeamSchedule,
      updateTaskApproval,
    ],
  );

  return <MissionControlContext.Provider value={value}>{children}</MissionControlContext.Provider>;
}

export function MissionControlFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connectionStatus, error, lastAction, refresh } = useMissionControl();
  const [collapsed, setCollapsed] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    for (const item of navItems) {
      router.prefetch(item.href);
    }
  }, [router]);

  useEffect(() => {
    if (!pendingHref) return;
    if (pathname === pendingHref || (pathname === "/mission-control" && pendingHref === "/mission-control/tasks")) {
      setPendingHref(null);
    }
  }, [pathname, pendingHref]);

  return (
    <div className="mc-theme flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        className={cn(
          "hidden shrink-0 border-r border-border/60 bg-sidebar md:flex md:flex-col transition-all duration-200",
          collapsed ? "w-14" : "w-[250px]",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center gap-2 px-3 py-3 text-left transition-colors hover:bg-accent/50"
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">Mission Control</div>
              <div className="text-[10px] text-muted-foreground">Lovely Octopus</div>
            </div>
          )}
        </button>

        <nav className="flex-1 space-y-1 px-2 py-2">
          {navItems.map((item) => {
            const displayPathname = pendingHref ?? pathname;
            const active =
              displayPathname === item.href || (displayPathname === "/mission-control" && item.href.endsWith("/tasks"));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                onClick={() => setPendingHref(item.href)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors",
                  collapsed && "justify-center px-0",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && item.label}
              </Link>
            );
          })}
        </nav>
        <ConnectionPill status={connectionStatus} collapsed={collapsed} className="mx-3 mb-3" />
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
  const { tasks, taskStreaming, updateTaskApproval } = useMissionControl();

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
                    <TaskCard key={task.id} task={task} streaming={taskStreaming[task.id]} onApproval={updateTaskApproval} />
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
    channelUnreadCounts,
    channels,
    connectionStatus,
    markChannelRead,
    selectedChannel,
    selectChannel,
    sendChannelMessage,
    taskStreaming,
    tasks,
    timelineMessages,
    updateTaskApproval,
  } = useMissionControl();
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelSwitchedRef = useRef(false);
  const userSentMessageRef = useRef(false);
  const commandCenterUnreadCount = totalUnreadCount(channelUnreadCounts);

  // Mark channel switch so next message load forces instant scroll
  useEffect(() => {
    channelSwitchedRef.current = true;
    markChannelRead(selectedChannel);
  }, [markChannelRead, selectedChannel]);

  useEffect(() => {
    markChannelRead(selectedChannel);
  }, [channelUnreadCounts, markChannelRead, selectedChannel]);

  const projectUnreadCount = useCallback(
    (channel: ProjectChannelInfo) =>
      (channelUnreadCounts[channelUnreadKey("project", channel.slug)] ?? 0) +
      (channelUnreadCounts[channelUnreadKey("project", channel.id)] ?? 0),
    [channelUnreadCounts],
  );

  const agentUnreadCount = useCallback(
    (agentName: string) => channelUnreadCounts[channelUnreadKey("agent_dm", agentName)] ?? 0,
    [channelUnreadCounts],
  );

  // Auto-scroll: always scroll to bottom on channel switch, new message, or user-sent message
  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: channelSwitchedRef.current ? "instant" : "smooth",
    });
    channelSwitchedRef.current = false;
    userSentMessageRef.current = false;
  }, [timelineMessages]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    sendChannelMessage(draft);
    setDraft("");
    userSentMessageRef.current = true;
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="min-h-0 border-b border-border/60 md:border-b-0 md:border-r">
        <div className="border-b px-3 py-3">
          <h1 className="text-base font-semibold">Channels</h1>
        </div>
        <div className="max-h-[220px] space-y-4 overflow-y-auto p-2 md:max-h-none">
          <ChannelButton
            active={selectedChannel.type === "all"}
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="Command Center"
            meta="Global entry"
            unreadCount={commandCenterUnreadCount}
            onClick={() => selectChannel({ type: "all", id: "all", label: "Command Center" })}
          />
          <ChannelGroup title="Projects">
            {channels.length === 0 ? (
              <EmptyLine text="No project channels" />
            ) : (
              channels.map((channel) => (
                <ChannelButton
                  key={channel.id}
                  active={selectedChannel.type === "project" && selectedChannel.project === channel.slug}
                  colorKey={channel.slug}
                  icon={<Hash className="h-3.5 w-3.5" />}
                  label={channel.title || channel.slug}
                  meta={channel.slug}
                  unreadCount={projectUnreadCount(channel)}
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
          <ChannelGroup title="Agent Threads">
            {agents.length === 0 ? (
              <EmptyLine text="No agents" />
            ) : (
              agents
                .filter((agent) => agent.directMessage !== false)
                .map((agent) => (
                  <ChannelButton
                    key={agent.name}
                    active={selectedChannel.type === "agent_dm" && selectedChannel.agentName === agent.name}
                    colorKey={agent.name}
                    icon={<Bot className="h-3.5 w-3.5" />}
                    label={agent.displayName || agent.name}
                    meta={`@${agent.name}`}
                    unreadCount={agentUnreadCount(agent.name)}
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

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{selectedChannel.label}</div>
            <div className="text-[10px] text-muted-foreground">
              {selectedChannel.type === "all"
                ? `${timelineMessages.length} messages · default to Coordinator`
                : `${timelineMessages.length} messages`}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {timelineMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
              No messages
            </div>
          ) : (
            <>
              {timelineMessages.map((message) => {
                if (message.senderId === "approval-gate" && message.taskId) {
                  const task = tasks.find((t) => t.id === message.taskId);
                  return (
                    <TimelineApprovalCard
                      key={message.id}
                      message={message}
                      task={task}
                      onApproval={updateTaskApproval}
                    />
                  );
                }
                return <TimelineMessage key={message.id} message={message} />;
              })}
              {Object.entries(taskStreaming).map(([taskId, stream]) => {
                const task = tasks.find((t) => t.id === taskId);
                // In project channel, only show streaming for matching project tasks
                if (selectedChannel.type === "project" && task?.project !== selectedChannel.project) return null;
                // In agent_dm channel, only show streaming for matching agent
                if (selectedChannel.type === "agent_dm" && stream.agentName !== selectedChannel.agentName) return null;
                return (
                  <article key={`stream-${taskId}`} className="rounded-lg border border-dashed border-blue-200 bg-blue-50/30 p-3">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                      <span className="text-xs font-medium text-blue-700">@{stream.agentName}</span>
                      {task ? <span className="text-[10px] text-muted-foreground">{task.title}</span> : null}
                    </div>
                    {stream.text ? (
                      <div className="mt-2 max-h-32 overflow-y-auto text-sm leading-6 text-muted-foreground">
                        <Markdown content={stream.text.slice(-800)} />
                      </div>
                    ) : (
                      <div className="mt-2 flex gap-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
                      </div>
                    )}
                  </article>
                );
              })}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
        <form onSubmit={handleSubmit} className="shrink-0 border-t p-3">
          <div className="flex gap-2">
            <AutocompleteInput
              value={draft}
              onChange={setDraft}
              onSubmit={() => {
                if (!draft.trim()) return;
                sendChannelMessage(draft);
                setDraft("");
                userSentMessageRef.current = true;
              }}
              agents={agents}
              channels={channels}
              placeholder={
                selectedChannel.type === "all"
                  ? "Message Coordinator, @agent, #project, or /task ..."
                  : "@agent, #project update, /task ..."
              }
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
      <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="shrink-0 border-b px-3 py-3">
          <h1 className="text-base font-semibold">Team</h1>
        </div>
        <div className="min-h-0 max-h-[240px] space-y-2 overflow-y-auto p-2 md:max-h-none md:flex-1">
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
                    {agent.status ?? "unknown"}
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
      <div className="flex min-h-0 min-w-0 flex-col">
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
        {selectedFile === "agent.yaml" ? (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-foreground">
            {fileContent ?? "No file loaded"}
          </pre>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4 text-xs leading-5">
            {fileContent ? <Markdown content={fileContent} /> : "No file loaded"}
          </div>
        )}
      </div>
    </section>
  );
}

export function CalendarView() {
  const {
    agents,
    connectionStatus,
    loadTeamScheduleRuns,
    runTeamScheduleNow,
    teamScheduleRuns,
    teamSchedules,
    updateTeamSchedule,
  } = useMissionControl();
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "cron" | "watcher">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!selectedScheduleId) return;
    if (!teamSchedules.some((schedule) => schedule.id === selectedScheduleId)) {
      setSelectedScheduleId(null);
    }
  }, [selectedScheduleId, teamSchedules]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    loadTeamScheduleRuns(selectedScheduleId ?? undefined, selectedScheduleId ? 60 : 80);
  }, [connectionStatus, loadTeamScheduleRuns, selectedScheduleId]);

  const filteredSchedules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return teamSchedules.filter((schedule) => {
      if (typeFilter !== "all" && schedule.type !== typeFilter) return false;
      if (!normalizedQuery) return true;
      const searchText = [
        schedule.name,
        schedule.agentName,
        schedule.project,
        schedule.prompt,
        schedule.cronExpr,
        schedule.condition,
        schedule.checkCommand,
        ...schedule.tags,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchText.includes(normalizedQuery);
    });
  }, [query, teamSchedules, typeFilter]);

  const selectedSchedule = selectedScheduleId
    ? teamSchedules.find((schedule) => schedule.id === selectedScheduleId) ?? null
    : null;
  const visibleRuns = selectedSchedule
    ? teamScheduleRuns.filter((run) => run.scheduleId === selectedSchedule.id)
    : teamScheduleRuns;
  const enabledCount = teamSchedules.filter((schedule) => schedule.enabled).length;
  const dueSoonCount = teamSchedules.filter((schedule) => schedule.enabled && isDueSoon(schedule.nextRunAt)).length;
  const failedRunCount = teamScheduleRuns.filter((run) => run.status === "failed_to_create").length;
  const selectedAgent = selectedSchedule
    ? agents.find((agent) => agent.name === selectedSchedule.agentName)
    : null;

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[360px_1fr]">
      <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="shrink-0 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Calendar</h1>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{teamSchedules.length} total</span>
                <span>{enabledCount} enabled</span>
                <span>{dueSoonCount} due soon</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                loadTeamScheduleRuns(undefined, 80);
                setSelectedScheduleId(null);
              }}
              disabled={connectionStatus !== "connected"}
              title="刷新运行记录"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search schedules"
              className="h-8 text-xs"
            />
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(["all", "cron", "watcher"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setTypeFilter(filter)}
                  className={cn(
                    "h-7 rounded-md px-2 text-xs font-medium transition-colors",
                    typeFilter === filter
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {filter === "all" ? "All" : filter}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {filteredSchedules.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              No team schedules
            </div>
          ) : (
            filteredSchedules.map((schedule) => (
              <ScheduleListItem
                key={schedule.id}
                active={selectedSchedule?.id === schedule.id}
                schedule={schedule}
                onSelect={() => setSelectedScheduleId(schedule.id)}
              />
            ))
          )}
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b px-4 py-3">
          {selectedSchedule ? (
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 truncate text-sm font-semibold">{selectedSchedule.name}</h2>
                  <ScheduleStatusBadge schedule={selectedSchedule} />
                  <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                    {selectedSchedule.type}
                  </Badge>
                  <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                    @{selectedSchedule.agentName}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{formatScheduleTiming(selectedSchedule)}</span>
                  <span>last {formatDate(selectedSchedule.lastRunAt) || "never"}</span>
                  <span>next {formatDate(selectedSchedule.nextRunAt) || "not scheduled"}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {selectedSchedule.lastTaskId ? (
                  <Link
                    href="/mission-control/tasks"
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
                  >
                    <Inbox className="h-3.5 w-3.5" />
                    Latest Task
                  </Link>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => runTeamScheduleNow(selectedSchedule.id)}
                  disabled={connectionStatus !== "connected"}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Run Now
                </Button>
                <Button
                  size="sm"
                  variant={selectedSchedule.enabled ? "outline" : "secondary"}
                  onClick={() =>
                    updateTeamSchedule(selectedSchedule.id, { enabled: !selectedSchedule.enabled })
                  }
                  disabled={connectionStatus !== "connected"}
                >
                  {selectedSchedule.enabled ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  {selectedSchedule.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-sm font-semibold">Recent Runs</h2>
              <div className="mt-1 text-xs text-muted-foreground">
                {teamScheduleRuns.length} loaded &middot; {failedRunCount} failed
              </div>
            </div>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-h-0 overflow-y-auto p-4">
            {selectedSchedule ? (
              <div className="space-y-3">
                <section className="rounded-lg border bg-background p-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <ScheduleMetric label="Agent" value={selectedAgent?.displayName || selectedSchedule.agentName} />
                    <ScheduleMetric label="Project" value={selectedSchedule.project || "No project"} />
                    <ScheduleMetric label="Priority" value={`P${selectedSchedule.priority}`} />
                    <ScheduleMetric label="Retries" value={String(selectedSchedule.maxRetries)} />
                  </div>
                  <div className="mt-4 rounded-lg border bg-muted/30 p-3">
                    <div className="text-[10px] font-semibold uppercase text-muted-foreground">Prompt</div>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5">{selectedSchedule.prompt}</p>
                  </div>
                  {selectedSchedule.type === "watcher" ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <CodeField label="Check Command" value={selectedSchedule.checkCommand} />
                      <CodeField label="Condition" value={selectedSchedule.condition} />
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-1">
                    <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                      {formatScheduleSource(selectedSchedule.source)}
                    </Badge>
                    {selectedSchedule.channelId ? (
                      <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                        {selectedSchedule.channelId}
                      </Badge>
                    ) : null}
                    {selectedSchedule.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="h-5 rounded-lg text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </section>

                <RunTimeline runs={visibleRuns} schedules={teamSchedules} />
              </div>
            ) : (
              <RunTimeline runs={visibleRuns} schedules={teamSchedules} />
            )}
          </div>

          <aside className="min-h-0 overflow-y-auto border-t p-3 lg:border-l lg:border-t-0">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold">Upcoming</div>
              <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                {teamSchedules.filter((schedule) => schedule.enabled && schedule.nextRunAt).length}
              </Badge>
            </div>
            <div className="space-y-2">
              {teamSchedules.filter((schedule) => schedule.enabled && schedule.nextRunAt).length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  No upcoming runs
                </div>
              ) : (
                teamSchedules
                  .filter((schedule) => schedule.enabled && schedule.nextRunAt)
                  .slice(0, 12)
                  .map((schedule) => (
                    <button
                      key={schedule.id}
                      type="button"
                      onClick={() => setSelectedScheduleId(schedule.id)}
                      className={cn(
                        "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
                        selectedSchedule?.id === schedule.id && "bg-accent",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Clock3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{schedule.name}</span>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {formatFullDate(schedule.nextRunAt)} &middot; @{schedule.agentName}
                      </div>
                    </button>
                  ))
              )}
            </div>
          </aside>
        </div>
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

// ── Visual Page: Retro Octopus Territory ──

function RetroOctopus({ color, state }: { color: string; state: OctopusState }) {
  const darkerColor = color + "cc";
  return (
    <svg viewBox="0 0 60 60" className={cn("retro-octopus w-16 h-16", state)}>
      {/* Head */}
      <ellipse cx="30" cy="20" rx="16" ry="14" fill={color} />
      {/* Head highlight */}
      <ellipse cx="30" cy="15" rx="10" ry="6" fill={darkerColor} opacity="0.3" />
      {/* Eyes */}
      <circle cx="23" cy="18" r="5" fill="white" />
      <circle cx="37" cy="18" r="5" fill="white" />
      <circle cx="24" cy="18" r="2.5" fill="#1a1a2e" />
      <circle cx="38" cy="18" r="2.5" fill="#1a1a2e" />
      {/* Eye shine */}
      <circle cx="22" cy="16.5" r="1" fill="white" opacity="0.8" />
      <circle cx="36" cy="16.5" r="1" fill="white" opacity="0.8" />
      {/* Mouth */}
      <ellipse cx="30" cy="25" rx="3" ry="1.5" fill={darkerColor} />
      {/* Short floating tentacles */}
      {[
        "M15,36 Q13,39 14,42",
        "M21,37 Q20,40 20,43",
        "M27,37 Q27,40 27,43",
        "M33,37 Q33,40 34,43",
        "M39,37 Q40,40 40,43",
        "M45,36 Q47,39 46,42",
      ].map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={color}
          strokeWidth="3.2"
          fill="none"
          strokeLinecap="round"
          className="retro-tentacle"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
      {/* Suction cups hint */}
      {[14, 20, 27, 34, 40, 46].map((cx, i) => (
        <circle key={i} cx={cx} cy={41 + (i % 2)} r="0.85" fill={darkerColor} opacity="0.5" />
      ))}
      {state === "working" && (
        <g className="octopus-work-chip" transform="translate(36 35)">
          <rect width="14" height="10" rx="2" fill="#101820" stroke="#6ff7e8" strokeWidth="1" />
          <path d="M3,4 h7 M3,7 h4" stroke="#f1b84b" strokeWidth="1.1" strokeLinecap="round" />
        </g>
      )}
      {isCommunicating(state) && (
        <g className="octopus-radio-wave" fill="none" stroke="#f1b84b" strokeLinecap="round" strokeWidth="1.3">
          <path d="M43,13 Q49,18 43,23" />
          <path d="M46,10 Q55,18 46,26" opacity="0.55" />
        </g>
      )}
    </svg>
  );
}

function SpeechBubble({ content }: { content: string }) {
  const preview = content.length > 50 ? content.slice(0, 50) + "..." : content;
  return (
    <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full z-20 speech-bubble-enter">
      <div
        className="rounded-lg px-2.5 py-1.5 text-[10px] leading-4 max-w-[180px] whitespace-normal"
        style={{ background: "#15120f", color: "#efe3c7", border: "1px solid #6ff7e8" }}
      >
        {preview}
      </div>
      <div
        className="mx-auto h-0 w-0"
        style={{ borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "5px solid #15120f" }}
      />
    </div>
  );
}

function LonelyOctopus() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20">
      <RetroOctopus color="#5bc0be" state="idle" />
      <div className="text-center">
        <div className="text-sm font-mono" style={{ color: "#8b806f" }}>No agents registered</div>
        <div className="text-[10px] font-mono mt-1" style={{ color: "#5feddc" }}>Waiting for agents to come alive...</div>
      </div>
    </div>
  );
}

function ActivityLog({ agents, activities }: { agents: AgentInfo[]; activities: Record<string, AgentActivity> }) {
  const recentEvents = agents
    .filter((a) => activities[a.name] && activities[a.name].state !== "idle")
    .slice(0, 5);
  if (recentEvents.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 rounded-lg p-2 text-[10px] font-mono max-w-[260px] z-30" style={{ background: "rgb(21 18 15 / 86%)", border: "1px solid rgb(111 247 232 / 24%)", color: "#8b806f" }}>
      {recentEvents.map((agent) => {
        const activity = activities[agent.name];
        const label = visualActivityLabel(activity);
        return (
          <div key={agent.name} className="flex items-center gap-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: retroColor(agent.name) }} />
            <span style={{ color: retroColor(agent.name) }}>{agent.displayName ?? agent.name}</span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function visualActivityLabel(activity: AgentActivity) {
  if (activity.state === "departing" && activity.targetAgent) return `leaving for @${activity.targetAgent}`;
  if (activity.state === "walking" && activity.targetAgent) return `walking to @${activity.targetAgent}`;
  if (activity.state === "arriving" && activity.targetAgent) return `arrived at @${activity.targetAgent}`;
  if (activity.state === "talking" && activity.targetAgent) return `talking to @${activity.targetAgent}`;
  if (activity.state === "returning") return "returning home";
  if (activity.state === "working") return "is working";
  return activity.state;
}

const IDLE_VISUAL_ACTIVITY: AgentActivity = { state: "idle", taskCount: 0, lastActivity: 0 };

export function VisualView() {
  const { agents, agentActivities, tasks } = useMissionControl();
  const gridRef = useRef<HTMLDivElement>(null);
  const territoryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Animated offsets are set after a rAF so CSS transitions can fire
  const [animatedOffsets, setAnimatedOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [activeLinks, setActiveLinks] = useState<Record<string, { x1: number; y1: number; x2: number; y2: number }>>({});

  // Compute grid columns based on agent count
  const gridCols = agents.length <= 2 ? 2 : agents.length <= 4 ? 2 : agents.length <= 9 ? 3 : 4;

  const runningTasksByAgent = useMemo(() => {
    const map: Record<string, TaskInfo[]> = {};
    for (const task of tasks) {
      if (!task.assignedTo || (task.status !== "assigned" && task.status !== "running" && task.status !== "approved")) {
        continue;
      }
      map[task.assignedTo] = [...(map[task.assignedTo] ?? []), task];
    }
    return map;
  }, [tasks]);

  // Two-phase animation: first render at home position, then in next frame apply the offset.
  // This lets CSS transition see the "from" state and animate smoothly.
  useEffect(() => {
    const agentsWithTarget = agents.filter((a) => {
      const activity = agentActivities[a.name];
      return activity?.targetAgent && isCommunicating(activity.state);
    });

    if (agentsWithTarget.length === 0) {
      setAnimatedOffsets({});
      setActiveLinks({});
      return;
    }

    // Schedule offset computation for next animation frame
    const rafId = requestAnimationFrame(() => {
      const newOffsets: Record<string, { x: number; y: number }> = {};
      const newLinks: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {};
      const gridRect = gridRef.current?.getBoundingClientRect();
      for (const agent of agentsWithTarget) {
        const activity = agentActivities[agent.name];
        if (!activity?.targetAgent) continue;
        const sourceEl = territoryRefs.current[agent.name];
        const targetEl = territoryRefs.current[activity.targetAgent];
        if (!sourceEl || !targetEl) continue;
        const sourceRect = sourceEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const sourceCenterX = sourceRect.left + sourceRect.width / 2;
        const sourceCenterY = sourceRect.top + sourceRect.height / 2;
        const targetCenterX = targetRect.left + targetRect.width / 2;
        const targetCenterY = targetRect.top + targetRect.height / 2;
        const side = sourceCenterX <= targetCenterX ? -1 : 1;
        const dockX = side * Math.min(76, Math.max(44, targetRect.width * 0.2));
        const dockY = 8;

        if (isDockedAtTarget(activity.state)) {
          newOffsets[agent.name] = {
            x: targetCenterX - sourceCenterX + dockX,
            y: targetCenterY - sourceCenterY + dockY,
          };
        }
        if (gridRect) {
          newLinks[agent.name] = {
            x1: sourceCenterX - gridRect.left,
            y1: sourceCenterY - gridRect.top,
            x2: targetCenterX + dockX - gridRect.left,
            y2: targetCenterY + dockY - gridRect.top,
          };
        }
      }
      setAnimatedOffsets((prev) => {
        // Only update if values actually changed
        const same = Object.keys(prev).length === Object.keys(newOffsets).length
          && Object.entries(prev).every(([k, v]) => newOffsets[k]?.x === v.x && newOffsets[k]?.y === v.y);
        return same ? prev : newOffsets;
      });
      setActiveLinks((prev) => {
        const same = Object.keys(prev).length === Object.keys(newLinks).length
          && Object.entries(prev).every(([k, v]) => {
            const next = newLinks[k];
            return next?.x1 === v.x1 && next.y1 === v.y1 && next.x2 === v.x2 && next.y2 === v.y2;
          });
        return same ? prev : newLinks;
      });
    });

    return () => cancelAnimationFrame(rafId);
  }, [agents, agentActivities]);

  // Determine which territories are being visited
  const targetedAgents = useMemo(() => {
    const set = new Set<string>();
    for (const activity of Object.values(agentActivities)) {
      if (activity.targetAgent && isCommunicating(activity.state)) {
        set.add(activity.targetAgent);
      }
    }
    return set;
  }, [agentActivities]);

  return (
    <section className="visual-page flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b px-4 py-3 flex items-center justify-between" style={{ borderColor: "rgb(239 227 199 / 16%)" }}>
        <div>
          <h1 className="text-base font-semibold font-mono" style={{ color: "#efe3c7" }}>Visual</h1>
          <div className="mt-0.5 text-[10px] font-mono" style={{ color: "#8b806f" }}>
            {agents.length} agents &middot; {tasks.filter((t) => t.status === "running").length} running tasks
          </div>
        </div>
        <div className="text-[10px] font-mono" style={{ color: "#5feddc" }}>
          Signal Octopus Deck
        </div>
      </div>

      <div className="flex-1 overflow-visible p-4">
        {agents.length === 0 ? (
          <LonelyOctopus />
        ) : (
          <div
            ref={gridRef}
            className="visual-grid relative grid gap-4"
            style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          >
            <svg className="communication-layer absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
              {Object.entries(activeLinks).map(([name, link]) => {
                const activity = agentActivities[name];
                const color = retroColor(name);
                const curve = Math.max(42, Math.abs(link.x2 - link.x1) * 0.32);
                const d = `M ${link.x1} ${link.y1} C ${link.x1 + curve} ${link.y1 - 28}, ${link.x2 - curve} ${link.y2 - 28}, ${link.x2} ${link.y2}`;
                return (
                  <g key={name} className={cn("communication-link", activity?.state && `is-${activity.state}`)} style={{ color }}>
                    <path d={d} stroke={color} />
                    <circle cx={link.x2} cy={link.y2} r="3" fill={color} />
                  </g>
                );
              })}
            </svg>
            {agents.map((agent) => {
              const activity = agentActivities[agent.name] ?? IDLE_VISUAL_ACTIVITY;
              const color = retroColor(agent.name);
              const isTraveling = activity.state === "departing" || activity.state === "walking" || activity.state === "arriving";
              const isTalking = activity.state === "talking";
              const isWorking = activity.state === "working";
              const isReturning = activity.state === "returning";
              const isAway = isCommunicating(activity.state);
              const offset = animatedOffsets[agent.name];
              const activeTasks = runningTasksByAgent[agent.name] ?? [];
              const primaryTask = activeTasks[0];

              return (
                <div
                  key={agent.name}
                  ref={(el) => { territoryRefs.current[agent.name] = el; }}
                  className={cn(
                    "territory-zone relative z-[2] flex min-h-[184px] flex-col items-center justify-between overflow-visible p-3",
                    targetedAgents.has(agent.name) && "active",
                    isAway && "has-visitor-motion",
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[10px] font-mono uppercase tracking-wider" style={{ color }}>
                        {agent.displayName ?? agent.name}
                      </div>
                      <div className="truncate text-[9px] font-mono" style={{ color: "#8b806f" }}>
                        {agent.role || agent.status || "agent"}
                      </div>
                    </div>
                    <span className="agent-status-pill" style={{ borderColor: color, color }}>
                      {visualActivityLabel(activity)}
                    </span>
                  </div>
                  <div className="relative my-2">
                    <div
                      className={cn("octopus-stage", isReturning && "is-returning")}
                      style={{
                        // Always keep transition active so returning animation works too
                        transition: `transform ${TRAVEL_DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                        transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : "translate(0px, 0px)",
                        zIndex: isAway ? 15 : 1,
                        position: "relative",
                      }}
                    >
                      <RetroOctopus color={color} state={activity.state} />
                      {isTalking && activity.message && <SpeechBubble content={activity.message} />}
                    </div>
                    {/* Ghost outline when octopus is away */}
                    {isAway && (
                      <div className="absolute inset-0 flex items-center justify-center opacity-20 pointer-events-none">
                        <RetroOctopus color={color} state="idle" />
                      </div>
                    )}
                  </div>
                  <div className="agent-task-strip">
                    {primaryTask ? (
                      <>
                        <Terminal className="h-3 w-3 shrink-0" style={{ color }} />
                        <span className="min-w-0 flex-1 truncate">{primaryTask.title}</span>
                        {activeTasks.length > 1 && <span className="shrink-0" style={{ color }}>+{activeTasks.length - 1}</span>}
                      </>
                    ) : isAway ? (
                      <>
                        <Radio className="h-3 w-3 shrink-0" style={{ color }} />
                        <span className="min-w-0 flex-1 truncate">{activity.targetAgent ? `syncing with @${activity.targetAgent}` : "moving"}</span>
                      </>
                    ) : (
                      <>
                        <Zap className="h-3 w-3 shrink-0 opacity-50" />
                        <span className="min-w-0 flex-1 truncate">standing by</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1 flex min-h-4 items-center gap-1.5 text-[10px] font-mono" style={{ color: "#8a7f6b" }}>
                    {isTraveling && activity.targetAgent && (
                      <span style={{ color }}>walking to @{activity.targetAgent}</span>
                    )}
                    {isTalking && activity.targetAgent && (
                      <span style={{ color }}>face to face with @{activity.targetAgent}</span>
                    )}
                    {isReturning && (
                      <span style={{ color }}>returning home</span>
                    )}
                    {isWorking && !isAway && (
                      <span style={{ color }}>working {activity.taskCount > 0 ? `on ${activity.taskCount}` : ""}</span>
                    )}
                    {!isWorking && !isAway && (
                      <span style={{ color: "#5a5548" }}>idle</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ActivityLog agents={agents} activities={agentActivities} />
    </section>
  );
}

function ScheduleListItem({
  active,
  onSelect,
  schedule,
}: {
  active: boolean;
  onSelect: () => void;
  schedule: TeamScheduleInfo;
}) {
  const projectColor = schedule.project ? channelColor(schedule.project) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/60",
        active && "bg-accent",
        !schedule.enabled && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{schedule.name}</div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">
            @{schedule.agentName} &middot; {formatScheduleTiming(schedule)}
          </div>
        </div>
        <ScheduleStatusBadge schedule={schedule} />
      </div>
      <div className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{schedule.prompt}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
          {schedule.type}
        </Badge>
        {schedule.project ? (
          <Badge variant="secondary" className={cn("h-5 gap-1 rounded-lg text-[10px]", projectColor?.bg, projectColor?.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", projectColor?.dot)} />
            #{schedule.project}
          </Badge>
        ) : null}
        {schedule.lastTaskId ? (
          <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
            task {schedule.lastTaskId.slice(0, 8)}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

function ScheduleStatusBadge({ schedule }: { schedule: TeamScheduleInfo }) {
  const status = !schedule.enabled ? "disabled" : schedule.lastStatus ?? "enabled";
  const className =
    status === "created" || status === "enabled"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "skipped"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : status === "failed_to_create"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-border bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("h-5 rounded-lg text-[10px]", className)}>
      {status}
    </Badge>
  );
}

function ScheduleMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function CodeField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5">
        {value || "Not configured"}
      </div>
    </div>
  );
}

function RunTimeline({
  runs,
  schedules,
}: {
  runs: TeamScheduleRunInfo[];
  schedules: TeamScheduleInfo[];
}) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <div className="text-xs font-semibold">Runs</div>
        <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
          {runs.length}
        </Badge>
      </div>
      <div className="divide-y">
        {runs.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No runs</div>
        ) : (
          runs.map((run) => (
            <RunTimelineItem key={run.id} run={run} schedule={schedules.find((item) => item.id === run.scheduleId)} />
          ))
        )}
      </div>
    </section>
  );
}

function RunTimelineItem({
  run,
  schedule,
}: {
  run: TeamScheduleRunInfo;
  schedule?: TeamScheduleInfo;
}) {
  const isSuccess = run.status === "created";
  const isSkipped = run.status === "skipped";
  return (
    <article className="p-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
            isSuccess
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : isSkipped
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-rose-200 bg-rose-50 text-rose-700",
          )}
        >
          {isSuccess ? <Check className="h-3.5 w-3.5" /> : isSkipped ? <Clock3 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-xs font-semibold">{schedule?.name ?? run.scheduleId}</span>
            <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
              {run.triggerType}
            </Badge>
            <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
              @{run.agentName}
            </Badge>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {formatFullDate(run.createdAt)}
            {run.taskId ? (
              <>
                {" · "}
                <Link href="/mission-control/tasks" className="font-medium text-foreground hover:underline">
                  task {run.taskId.slice(0, 8)}
                </Link>
              </>
            ) : null}
          </div>
          {run.error ? (
            <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-xs leading-5 text-destructive">
              {run.error}
            </div>
          ) : null}
        </div>
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-lg text-[10px]",
            isSuccess
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : isSkipped
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-rose-200 bg-rose-50 text-rose-700",
          )}
        >
          {run.status}
        </Badge>
      </div>
    </article>
  );
}

function TaskCard({
  task,
  streaming,
  onApproval,
}: {
  task: TaskInfo;
  streaming?: TaskStreamingState;
  onApproval: (taskId: string, decision: "approve" | "reject") => void;
}) {
  const projectColor = task.project ? channelColor(task.project) : null;
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
              <Badge variant="secondary" className={cn("h-5 gap-1 rounded-lg text-[10px]", projectColor?.bg, projectColor?.text)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", projectColor?.dot)} />
                #{task.project}
              </Badge>
            ) : null}
            {task.tags.includes("scheduled") ? (
              <Badge variant="outline" className="h-5 gap-1 rounded-lg border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                <Clock3 className="h-3 w-3" />
                scheduled
              </Badge>
            ) : null}
          </div>
        </div>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">P{task.priority}</span>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{task.description}</p>
      {streaming ? (
        <div className="mt-2 rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-blue-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            {streaming.agentName} is working...
          </div>
          <div className="mt-1.5 max-h-24 overflow-y-auto text-xs leading-5 text-muted-foreground">
            <Markdown content={streaming.text.slice(-500)} />
          </div>
        </div>
      ) : null}
      {task.approvalPrompt ? (
        <div className="mt-2 rounded-lg border bg-muted/30 p-2 text-xs leading-5">{task.approvalPrompt}</div>
      ) : null}
      {task.approvalData && typeof task.approvalData === "object" && "tool" in task.approvalData ? (
        <div className="mt-2 rounded-lg border bg-muted/20 p-2 font-mono text-[11px] leading-5">
          <span className="font-semibold">{(task.approvalData as { tool: string }).tool}</span>
          {"params" in task.approvalData && (task.approvalData as { params?: unknown }).params ? (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify((task.approvalData as unknown as { params: unknown }).params, null, 2)}
            </pre>
          ) : null}
        </div>
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
  colorKey,
  icon,
  label,
  meta,
  onClick,
  unreadCount = 0,
}: {
  active: boolean;
  colorKey?: string;
  icon: ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
  unreadCount?: number;
}) {
  const color = colorKey ? channelColor(colorKey) : null;
  const displayUnreadCount = unreadCount > 99 ? "99+" : String(unreadCount);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors border-l-2",
        color ? color.border : "border-l-transparent",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {color ? <span className={cn("h-2 w-2 shrink-0 rounded-full", color.dot)} /> : icon}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
      <span className="max-w-24 truncate text-[10px] opacity-70">{meta}</span>
      {unreadCount > 0 ? (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-none text-white">
          {displayUnreadCount}
        </span>
      ) : null}
    </button>
  );
}

function TimelineMessage({ message }: { message: TeamMessageInfo }) {
  const colorKey = message.channelType === "project" ? message.project ?? message.channelId : message.channelId;
  const color = channelColor(colorKey);
  const evalArtifact = parseLlmEvalArtifact(message.content);
  return (
    <article className={cn("rounded-lg border bg-background p-3 border-l-2 animate-in fade-in-0 slide-in-from-bottom-2 duration-300", color.border)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", color.dot)} />
        <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
          {message.senderType}
        </Badge>
        <span className="text-xs font-medium">{message.senderId}</span>
        {message.project ? <span className="text-[10px] text-muted-foreground">#{message.project}</span> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{formatDate(message.createdAt)}</span>
      </div>
      <div className="mt-2 text-sm leading-6">
        {evalArtifact ? <LlmEvalArtifactCard artifact={evalArtifact} /> : <ExpandableMarkdown content={message.content} />}
      </div>
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

function ExpandableMarkdown({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > TIMELINE_PREVIEW_CHARS;
  const visibleContent = isLong && !expanded
    ? `${content.slice(0, TIMELINE_PREVIEW_CHARS).trimEnd()}\n\n...`
    : content;

  return (
    <>
      <Markdown content={visibleContent} />
      {isLong ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-2 text-[11px] text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开全文 (${content.length.toLocaleString()} 字符)`}
        </Button>
      ) : null}
    </>
  );
}

interface LlmEvalArtifact {
  title: string;
  verdict: string;
  model: string;
  summary: string;
  bluePrompt: string;
  redPrompt: string;
  modelOutput: string;
}

function LlmEvalArtifactCard({ artifact }: { artifact: LlmEvalArtifact }) {
  return (
    <div className="space-y-3">
      {artifact.summary ? <Markdown content={artifact.summary} /> : null}
      <div className="rounded-md bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Terminal className="h-4 w-4 text-slate-600" />
          <span className="text-sm font-semibold text-slate-900">{artifact.title}</span>
          {artifact.verdict ? (
            <Badge variant="secondary" className="rounded-md text-[10px]">
              {artifact.verdict}
            </Badge>
          ) : null}
          {artifact.model ? <span className="ml-auto text-[10px] text-muted-foreground">{artifact.model}</span> : null}
        </div>
        <div className="mt-3 grid gap-3 xl:grid-cols-3">
          <PromptPane title="蓝方 Prompt" tone="blue" content={artifact.bluePrompt} />
          <PromptPane title="红方 Prompt" tone="red" content={artifact.redPrompt} />
          <PromptPane title="大模型输出" tone="green" content={artifact.modelOutput} />
        </div>
      </div>
    </div>
  );
}

function PromptPane({
  title,
  tone,
  content,
}: {
  title: string;
  tone: "blue" | "red" | "green";
  content: string;
}) {
  const toneClass =
    tone === "blue"
      ? "border-l-blue-500 bg-blue-50/70 text-blue-950"
      : tone === "red"
        ? "border-l-rose-500 bg-rose-50/70 text-rose-950"
        : "border-l-emerald-500 bg-emerald-50/70 text-emerald-950";
  return (
    <section className={cn("min-w-0 rounded-md border-l-4 p-2.5", toneClass)}>
      <div className="mb-2 text-xs font-semibold">{title}</div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-white/70 p-2 text-[11px] leading-5 text-slate-800">{content || "未提供"}</pre>
    </section>
  );
}

function parseLlmEvalArtifact(content: string): LlmEvalArtifact | null {
  const marker = "<!-- llm-eval-artifact -->";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return null;

  const artifactBody = content.slice(markerIndex + marker.length).trim();
  const title = artifactBody.match(/###\s*([^\n]+)/)?.[1]?.trim() ?? "LLM 评估展示";
  const verdict = readArtifactMeta(artifactBody, "判定");
  const model = readArtifactMeta(artifactBody, "模型");
  const bluePrompt = readArtifactSection(artifactBody, "蓝方 Prompt");
  const redPrompt = readArtifactSection(artifactBody, "红方 Prompt");
  const modelOutput = readArtifactSection(artifactBody, "大模型输出");
  if (!bluePrompt && !redPrompt && !modelOutput) return null;

  return {
    title,
    verdict,
    model,
    summary: content.slice(0, markerIndex).trim(),
    bluePrompt,
    redPrompt,
    modelOutput,
  };
}

function readArtifactMeta(content: string, label: string): string {
  const match = content.match(new RegExp(`\\*\\*${escapeRegExp(label)}\\*\\*\\s*[:：]\\s*([^\\n]+)`));
  return match?.[1]?.trim() ?? "";
}

function readArtifactSection(content: string, heading: string): string {
  const fencePattern = "(?:```|~~~)";
  const pattern = `####\\s*${escapeRegExp(heading)}\\s*\\n\\s*${fencePattern}(?:[a-zA-Z0-9_-]+)?\\n([\\s\\S]*?)\\n\\s*${fencePattern}`;
  const match = content.match(new RegExp(pattern));
  return match?.[1]?.trim() ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function TimelineApprovalCard({
  message,
  task,
  onApproval,
}: {
  message: TeamMessageInfo;
  task?: TaskInfo;
  onApproval: (taskId: string, decision: "approve" | "reject") => void;
}) {
  const isResolved = task ? task.status !== "awaiting_approval" : false;
  return (
    <article className="rounded-lg border-2 border-amber-300 bg-amber-50/50 p-4 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600" />
        <span className="text-sm font-semibold text-amber-900">需要审批</span>
        {task ? (
          <Badge variant="outline" className="ml-auto h-5 rounded-lg border-amber-300 text-[10px] text-amber-700">
            {task.status}
          </Badge>
        ) : null}
      </div>
      {task ? (
        <h3 className="mt-2 text-sm font-medium">{task.title}</h3>
      ) : null}
      <div className="mt-2 text-sm leading-6 text-muted-foreground">
        <ExpandableMarkdown content={message.content.replace(/^🔒 \*\*(?:Approval Required|需要审批)\*\*.*?\n\n/, "")} />
      </div>
      {message.taskId ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>task {message.taskId.slice(0, 8)}</span>
          <span className="ml-auto">{formatDate(message.createdAt)}</span>
        </div>
      ) : null}
      {!isResolved && message.taskId ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" variant="outline" className="border-green-300 text-green-700 hover:bg-green-50" onClick={() => onApproval(message.taskId!, "approve")}>
            <Check className="mr-1 h-3.5 w-3.5" />
            批准
          </Button>
          <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => onApproval(message.taskId!, "reject")}>
            <X className="mr-1 h-3.5 w-3.5" />
            拒绝
          </Button>
        </div>
      ) : isResolved ? (
        <div className="mt-3 rounded-lg bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {task?.status === "approved" || task?.status === "running" || task?.status === "completed"
            ? "✓ 已批准"
            : task?.status === "rejected"
              ? "✗ 已拒绝"
              : `已处理 (${task?.status})`}
        </div>
      ) : null}
    </article>
  );
}

function ConnectionPill({
  className,
  collapsed,
  status,
}: {
  className?: string;
  collapsed?: boolean;
  status: ReturnType<typeof useConnectionStatus>;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-background text-xs text-muted-foreground",
        collapsed ? "mx-auto h-8 w-8 justify-center px-0" : "h-8 px-2",
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
      {!collapsed && statusText[status]}
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

function upsertRun(items: TeamScheduleRunInfo[], item: TeamScheduleRunInfo) {
  return upsertById(items, item)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 120);
}

function sortSchedules(schedules: TeamScheduleInfo[]) {
  return [...schedules].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aNext = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
    const bNext = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext - bNext;
    return a.name.localeCompare(b.name);
  });
}

function dedupeMessages(messages: TeamMessageInfo[]) {
  return Array.from(new Map(messages.map((message) => [message.id, message])).values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function readStoredChannelUnreadCounts(): ChannelUnreadCounts {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CHANNEL_UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const counts: ChannelUnreadCounts = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      counts[key] = Math.floor(value);
    }
    return counts;
  } catch {
    return {};
  }
}

function writeStoredChannelUnreadCounts(counts: ChannelUnreadCounts): void {
  if (typeof window === "undefined") return;
  const compact = compactUnreadCounts(counts);
  try {
    if (Object.keys(compact).length === 0) {
      window.localStorage.removeItem(CHANNEL_UNREAD_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CHANNEL_UNREAD_STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Browser storage can be disabled or full; unread badges can still work in memory.
  }
}

function compactUnreadCounts(counts: ChannelUnreadCounts): ChannelUnreadCounts {
  const compact: ChannelUnreadCounts = {};
  for (const [key, value] of Object.entries(counts)) {
    if (value > 0) compact[key] = value;
  }
  return compact;
}

function channelUnreadKey(channelType: TeamMessageInfo["channelType"], channelId: string) {
  return `${channelType}:${channelId}`;
}

function totalUnreadCount(counts: ChannelUnreadCounts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function clearUnreadCountsForSelection(counts: ChannelUnreadCounts, selection: ChannelSelection) {
  if (selection.type === "all") {
    return Object.keys(counts).length === 0 ? counts : {};
  }

  const keys =
    selection.type === "project"
      ? [channelUnreadKey("project", selection.project), channelUnreadKey("project", selection.id)]
      : [channelUnreadKey("agent_dm", selection.agentName)];

  if (!keys.some((key) => counts[key])) return counts;

  const next = { ...counts };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function incrementUnreadCountForMessage(counts: ChannelUnreadCounts, message: TeamMessageInfo) {
  const key = unreadKeyForMessage(message);
  if (!key) return counts;
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

function unreadKeyForMessage(message: TeamMessageInfo) {
  if (message.channelType === "project") {
    return channelUnreadKey("project", message.project ?? message.channelId);
  }
  if (message.channelType === "agent_dm") {
    return channelUnreadKey("agent_dm", message.channelId);
  }
  if (message.channelType === "coordinator" || message.channelType === "system") {
    return channelUnreadKey(message.channelType, message.channelId);
  }
  return null;
}

function shouldCountUnreadMessage(message: TeamMessageInfo) {
  return !(message.senderType === "human" && message.senderId === "mission-control");
}

function isChannelsPath(pathname: string | null) {
  return pathname === "/mission-control/channels";
}

function messageMatchesSelection(message: TeamMessageInfo, selection: ChannelSelection) {
  return messageMatchesChannelSelection(message, selection);
}

function messageProjectKey(message: TeamMessageInfo) {
  return message.project ?? message.channelId;
}

function findLeadingAgentMention(text: string, agents: AgentInfo[]): AgentInfo | undefined {
  const match = text.trim().match(/^@([\w-]+)/);
  const rawMention = match?.[1];
  if (!rawMention) return undefined;

  const mention = rawMention.toLowerCase();
  return agents.find((agent) => {
    if (agent.name.toLowerCase() === mention) return true;
    return agent.aliases?.some((alias: string) => alias.toLowerCase() === mention);
  });
}

/**
 * Infer which agent is the target of a team message, so the Visual page
 * can animate the sender octopus walking to the target.
 *
 * Priority:
 * 1. agent_dm channel → channelId is the target agent name
 * 2. coordinator channel → channelId might be the agent name
 * 3. handledBy field → the agent that handled/processed this message
 * 4. @mention in content → first @agent-name found in message text
 */
function inferTargetAgent(message: TeamMessageInfo): string | undefined {
  // Direct DM — channelId IS the target agent
  if (message.channelType === "agent_dm") return message.channelId;

  // Coordinator channel — channelId might be the target agent name
  if (message.channelType === "coordinator" && message.channelId && message.channelId !== "coordinator") {
    return message.channelId;
  }

  // handledBy tells us which agent processed this message
  if (message.handledBy && message.handledBy !== message.senderId) {
    return message.handledBy;
  }

  // Scan for @mentions in content
  const mentionMatch = message.content.match(/@(\w[\w-]*)/);
  if (mentionMatch) return mentionMatch[1];

  return undefined;
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

function formatScheduleRunActivity(schedule: TeamScheduleInfo, run: TeamScheduleRunInfo) {
  if (run.status === "created") {
    return `定时任务已创建任务：${schedule.name}`;
  }
  if (run.status === "skipped") {
    return `定时任务已跳过：${schedule.name}`;
  }
  return `定时任务执行失败：${schedule.name}`;
}

function messagePreview(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 60)}...` : compact;
}

function formatScheduleTiming(schedule: TeamScheduleInfo) {
  if (schedule.type === "cron") return schedule.cronExpr ?? "No cron";
  const interval = schedule.intervalMs ? formatDuration(schedule.intervalMs) : "no interval";
  const cooldown = schedule.cooldownMs ? `cooldown ${formatDuration(schedule.cooldownMs)}` : "no cooldown";
  return `${interval} · ${cooldown}`;
}

function formatScheduleSource(source: TeamScheduleInfo["source"]) {
  if (source === "agent_yaml") return "agent.yaml";
  return source;
}

function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function isDueSoon(value?: string) {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  const now = Date.now();
  return time >= now && time - now <= 24 * 60 * 60 * 1000;
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

function formatFullDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
