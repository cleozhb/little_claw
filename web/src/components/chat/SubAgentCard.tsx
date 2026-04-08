"use client";

import { useState } from "react";
import { Workflow, CheckCircle2, Loader2, ChevronDown, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import type { DisplayMessage } from "@/lib/mock-data";

interface SubAgentCardProps {
  message: DisplayMessage;
  /** Whether this agent is still running */
  isRunning?: boolean;
}

export function SubAgentCard({ message, isRunning }: SubAgentCardProps) {
  const done = message.type === "sub_agent_done";
  const running = isRunning ?? !done;
  const [open, setOpen] = useState(running);

  const agentName = message.meta?.agentName ?? "sub-agent";
  const task = message.meta?.task;
  const result = message.meta?.result;
  const nestedEvents = message.meta?.nestedEvents ?? [];

  return (
    <div
      className={`rounded-lg border text-xs ${
        running
          ? "border-blue-500/20 bg-blue-500/5"
          : "border-green-500/20 bg-green-500/5"
      }`}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
      >
        {running ? (
          <span className="relative flex h-3.5 w-3.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-40" />
            <Loader2 className="relative h-3.5 w-3.5 text-yellow-500 animate-spin" />
          </span>
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        )}
        <Workflow className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <span className="font-medium text-muted-foreground">Sub-Agent</span>
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
          {agentName}
        </Badge>
        {!running && result && (
          <span className="truncate text-muted-foreground/60 flex-1 ml-1">
            {result.length > 80 ? result.slice(0, 77) + "..." : result}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expanded body */}
      {open && (
        <div className="border-t border-border/20 px-3 py-2 space-y-2">
          {task && (
            <p className="text-[11px] text-muted-foreground/80">
              <span className="font-medium text-muted-foreground/60">Task: </span>
              {task}
            </p>
          )}

          {/* Nested events (tool calls / text from the sub-agent) */}
          {nestedEvents.length > 0 && (
            <div className="space-y-1.5 pl-2 border-l border-border/30">
              {nestedEvents.map((evt) => (
                <NestedEvent key={evt.id} event={evt} />
              ))}
            </div>
          )}

          {/* Final result */}
          {done && result && (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                Result
              </span>
              <div className="mt-1 text-[11px] text-muted-foreground/80 leading-relaxed">
                <Markdown content={result} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NestedEvent({ event }: { event: DisplayMessage }) {
  if (event.type === "tool_call") {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
        <Terminal className="h-2.5 w-2.5" />
        <span className="font-mono">{event.meta?.toolName}</span>
        {event.meta?.success !== undefined && (
          event.meta.success
            ? <CheckCircle2 className="h-2.5 w-2.5 text-green-500" />
            : <span className="text-red-500">failed</span>
        )}
      </div>
    );
  }

  if (event.type === "text" && event.content) {
    return (
      <p className="text-[10px] text-muted-foreground/60 truncate">
        {event.content.length > 120 ? event.content.slice(0, 117) + "..." : event.content}
      </p>
    );
  }

  return null;
}
