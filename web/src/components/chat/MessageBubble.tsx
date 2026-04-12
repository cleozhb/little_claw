"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Markdown } from "@/components/markdown";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { SubAgentCard } from "@/components/chat/SubAgentCard";
import { MemoryRecallBanner } from "@/components/chat/MemoryRecallBanner";
import { ModeratorMessage } from "@/components/chat/ModeratorMessage";
import { StreamingCursor } from "@/components/chat/StreamingCursor";
import { Bot, User, Sparkles } from "lucide-react";
import type { DisplayMessage } from "@/lib/mock-data";

interface MessageBubbleProps {
  message: DisplayMessage;
  /** Whether this is the last assistant message and currently streaming */
  isStreaming?: boolean;
  /** Active skills for the current turn (only passed to the streaming assistant message) */
  activeSkills?: Array<{ name: string; score: number; matchReason: string }>;
}

export function MessageBubble({ message, isStreaming, activeSkills }: MessageBubbleProps) {
  // ---- Memory recall banner ----
  if (message.type === "memory_recall") {
    return <MemoryRecallBanner memories={message.meta?.memories ?? []} />;
  }

  // ---- Moderator / inject message ----
  if (message.type === "inject") {
    return <ModeratorMessage content={message.content} timestamp={message.timestamp} />;
  }

  // ---- User message ----
  if (message.role === "user") {
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

  // ---- System error message ----
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-600 dark:text-red-400">
          {message.content}
        </div>
      </div>
    );
  }

  // ---- Assistant messages ----
  return (
    <div className="flex gap-3">
      <Avatar className="h-7 w-7 shrink-0 mt-0.5">
        <AvatarFallback className="bg-primary text-primary-foreground text-xs">
          <Bot className="h-3.5 w-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1.5">
        {message.type === "tool_call" && <ToolCallCard message={message} />}
        {message.type === "tool_result" && <ToolResultBlock message={message} />}
        {(message.type === "sub_agent_start" || message.type === "sub_agent_progress") && (
          <SubAgentCard message={message} isRunning />
        )}
        {message.type === "sub_agent_done" && <SubAgentCard message={message} />}
        {message.type === "text" && (
          <div className="text-sm leading-relaxed">
            {(() => {
              const skills = activeSkills ?? message.meta?.skills;
              return skills && skills.length > 0 ? <ActiveSkillTag skills={skills} /> : null;
            })()}
            <Markdown content={message.content} />
            {isStreaming && <StreamingCursor />}
            {!isStreaming && (
              <TimeStamp date={message.timestamp} className="text-muted-foreground/50" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolResultBlock({ message }: { message: DisplayMessage }) {
  const success = message.meta?.success ?? true;
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        success
          ? "border-green-500/20 bg-green-500/5"
          : "border-red-500/20 bg-red-500/5"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${success ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className="font-medium text-muted-foreground">{message.content}</span>
      </div>
      {message.meta?.result && (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground/70 font-mono max-h-[200px] overflow-y-auto">
          {message.meta.result}
        </pre>
      )}
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

function ActiveSkillTag({ skills }: { skills: Array<{ name: string; score: number; matchReason: string }> }) {
  // Show the highest-scoring skill as the primary active skill
  const sorted = [...skills].sort((a, b) => b.score - a.score);
  const primary = sorted[0];
  if (!primary) return null;

  return (
    <div className="flex items-center gap-1.5 mb-2">
      <Sparkles className="h-3 w-3 text-amber-500" />
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
        {primary.name}
      </span>
      {sorted.length > 1 && (
        <span className="text-[10px] text-muted-foreground/50">
          +{sorted.length - 1}
        </span>
      )}
    </div>
  );
}
