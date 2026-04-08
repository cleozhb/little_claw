"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { Bot, User, Terminal, CheckCircle2, Workflow } from "lucide-react";
import type { DisplayMessage } from "@/lib/mock-data";

interface MessageBubbleProps {
  message: DisplayMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground leading-relaxed">
          <p className="whitespace-pre-wrap">{message.content}</p>
          <TimeStamp date={message.timestamp} className="text-primary-foreground/50" />
        </div>
        <Avatar className="h-7 w-7 shrink-0 mt-0.5">
          <AvatarFallback className="bg-secondary text-secondary-foreground text-xs">
            <User className="h-3.5 w-3.5" />
          </AvatarFallback>
        </Avatar>
      </div>
    );
  }

  // Assistant messages
  return (
    <div className="flex gap-3">
      <Avatar className="h-7 w-7 shrink-0 mt-0.5">
        <AvatarFallback className="bg-primary text-primary-foreground text-xs">
          <Bot className="h-3.5 w-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1.5">
        {message.type === "tool_call" && <ToolCallBlock message={message} />}
        {message.type === "tool_result" && <ToolResultBlock message={message} />}
        {message.type === "sub_agent_start" && <SubAgentStartBlock message={message} />}
        {message.type === "sub_agent_done" && <SubAgentDoneBlock message={message} />}
        {message.type === "text" && (
          <div className="text-sm leading-relaxed">
            <Markdown content={message.content} />
            <TimeStamp date={message.timestamp} className="text-muted-foreground/50" />
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallBlock({ message }: { message: DisplayMessage }) {
  const name = message.meta?.toolName ?? "unknown";
  const params = message.meta?.toolParams;
  return (
    <div className="rounded-lg border border-border/50 bg-white dark:bg-white/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Terminal className="h-3 w-3" />
        <span className="font-medium">Tool Call</span>
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 ml-1">{name}</Badge>
      </div>
      {params && (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground/80 font-mono">
          {JSON.stringify(params, null, 2)}
        </pre>
      )}
      <TimeStamp date={message.timestamp} className="text-muted-foreground/40" />
    </div>
  );
}

function ToolResultBlock({ message }: { message: DisplayMessage }) {
  const success = message.meta?.success ?? true;
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${success ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}>
      <div className="flex items-center gap-1.5">
        <CheckCircle2 className={`h-3 w-3 ${success ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`} />
        <span className="font-medium text-muted-foreground">{message.content}</span>
      </div>
      {message.meta?.result && (
        <p className="mt-1 text-[11px] text-muted-foreground/70 font-mono">{message.meta.result}</p>
      )}
      <TimeStamp date={message.timestamp} className="text-muted-foreground/40" />
    </div>
  );
}

function SubAgentStartBlock({ message }: { message: DisplayMessage }) {
  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <Workflow className="h-3 w-3 text-blue-600 dark:text-blue-400" />
        <span className="font-medium text-muted-foreground">Sub-Agent</span>
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 ml-1">
          {message.meta?.agentName}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/80">{message.meta?.task}</p>
      <TimeStamp date={message.timestamp} className="text-muted-foreground/40" />
    </div>
  );
}

function SubAgentDoneBlock({ message }: { message: DisplayMessage }) {
  return (
    <div className="rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
        <span className="font-medium text-muted-foreground">Sub-Agent 完成</span>
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 ml-1">
          {message.meta?.agentName}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/80">{message.meta?.result}</p>
      <TimeStamp date={message.timestamp} className="text-muted-foreground/40" />
    </div>
  );
}

function TimeStamp({ date, className }: { date: Date; className?: string }) {
  return (
    <time className={`block mt-1 text-[10px] ${className ?? ""}`}>
      {date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}
