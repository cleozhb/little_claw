"use client";

import { Plus, MessageSquare, Sun, Moon, Zap, Trash2, MessageCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "next-themes";
import type { DisplaySession } from "@/lib/mock-data";
import type { ConnectionStatus } from "@/lib/websocket";

function timeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  return `${d} 天前`;
}

const statusConfig: Record<
  ConnectionStatus,
  { color: string; ping: string; label: string }
> = {
  connected: { color: "bg-green-500", ping: "bg-green-400", label: "已连接" },
  connecting: {
    color: "bg-yellow-500",
    ping: "bg-yellow-400",
    label: "连接中…",
  },
  disconnected: { color: "bg-red-500", ping: "bg-red-400", label: "未连接" },
};

export type AppMode = "chat" | "simulation";

interface SidebarProps {
  sessions: DisplaySession[];
  activeSessionId: string | null;
  connectionStatus: ConnectionStatus;
  appMode: AppMode;
  onSessionSelect: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onModeChange: (mode: AppMode) => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  connectionStatus,
  appMode,
  onSessionSelect,
  onNewChat,
  onDeleteSession,
  onModeChange,
}: SidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const status = statusConfig[connectionStatus];

  return (
    <div className="flex h-full flex-col border-r border-border/50 bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Little Claw</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 text-xs h-8 border-border/50"
          onClick={onNewChat}
        >
          <Plus className="h-3.5 w-3.5" />
          新对话
        </Button>
      </div>

      {/* Mode switcher */}
      <div className="px-3 pb-2">
        <div className="flex rounded-lg bg-muted/50 p-0.5">
          <button
            onClick={() => onModeChange("chat")}
            className={`
              flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors
              ${appMode === "chat"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
              }
            `}
          >
            <MessageCircle className="h-3 w-3" />
            Chat
          </button>
          <button
            onClick={() => onModeChange("simulation")}
            className={`
              flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors
              ${appMode === "simulation"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
              }
            `}
          >
            <Users className="h-3 w-3" />
            Simulation
          </button>
        </div>
      </div>

      <Separator className="opacity-50" />

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSessionSelect(s.id)}
              className={`
                group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left
                transition-colors duration-100
                ${
                  s.id === activeSessionId
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }
              `}
            >
              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium leading-tight">{s.title}</div>
                <div className="mt-0.5 truncate text-[10px] opacity-60">{s.lastMessage}</div>
              </div>
              <span className="shrink-0 text-[10px] opacity-40 mt-0.5">{timeAgo(s.updatedAt)}</span>
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(s.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    onDeleteSession(s.id);
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Footer status */}
      <Separator className="opacity-50" />
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="relative flex h-2 w-2">
          {connectionStatus === "connected" && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full ${status.ping} opacity-75`}
            />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${status.color}`}
          />
        </span>
        <span className="text-[10px] text-muted-foreground">{status.label}</span>
        <Badge variant="secondary" className="ml-auto text-[9px] px-1.5 py-0 h-4">
          {sessions.length} sessions
        </Badge>
      </div>
    </div>
  );
}
