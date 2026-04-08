"use client";

import { useRef, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { ArgumentNode } from "@/types/protocol";

interface ArgumentMapProps {
  arguments: ArgumentNode[];
  newTopics: Set<string>;
  onArgumentClick: (topic: string) => void;
}

const statusColors: Record<ArgumentNode["status"], { border: string; bg: string; label: string }> = {
  consensus: { border: "border-green-500", bg: "bg-green-500/10", label: "共识" },
  conflict: { border: "border-red-500", bg: "bg-red-500/10", label: "冲突" },
  open: { border: "border-muted-foreground/40", bg: "bg-muted/30", label: "开放" },
};

export function ArgumentMap({ arguments: args, newTopics, onArgumentClick }: ArgumentMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new arguments appear
  useEffect(() => {
    if (containerRef.current && newTopics.size > 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [newTopics, args.length]);

  // Overall consensus strength: average of all consensusLevel values
  const avgConsensus = args.length > 0
    ? args.reduce((sum, a) => sum + a.consensusLevel, 0) / args.length
    : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-3 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight">Argument Map</h2>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {args.length} 个论点
        </p>
      </div>

      {/* Argument cards */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {args.length === 0 && (
          <div className="flex items-center justify-center h-32 text-[11px] text-muted-foreground/50">
            等待论点提取…
          </div>
        )}
        {args.map((arg, idx) => {
          const config = statusColors[arg.status];
          const isNew = newTopics.has(arg.topic);

          return (
            <div
              key={`${arg.topic}-${idx}`}
              role="button"
              tabIndex={0}
              onClick={() => onArgumentClick(arg.topic)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onArgumentClick(arg.topic); }}
              className={`
                w-full text-left rounded-lg border-l-[3px] p-2.5 transition-all duration-300
                ${config.border} ${config.bg}
                ${isNew ? "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/20" : ""}
                hover:bg-accent/50 cursor-pointer
              `}
            >
              {/* Title + Status badge */}
              <div className="flex items-start justify-between gap-1.5">
                <h3 className="text-[11px] font-medium leading-tight flex-1">
                  {arg.topic}
                </h3>
                <Badge
                  variant="secondary"
                  className={`text-[9px] px-1.5 py-0 h-4 shrink-0 ${
                    arg.status === "consensus"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                      : arg.status === "conflict"
                        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                        : ""
                  }`}
                >
                  {config.label}
                </Badge>
              </div>

              {/* Description */}
              <p className="mt-1 text-[10px] text-muted-foreground leading-relaxed line-clamp-2">
                {arg.description}
              </p>

              {/* Supporters */}
              <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                {arg.supporters.map((s) => (
                  <Tooltip key={`s-${s}`}>
                    <TooltipTrigger className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 text-[10px] ring-1 ring-green-300/50">
                      {s.charAt(0)}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">
                      {s} (支持)
                    </TooltipContent>
                  </Tooltip>
                ))}
                {arg.opposers.map((o) => (
                  <Tooltip key={`o-${o}`}>
                    <TooltipTrigger className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30 text-[10px] ring-1 ring-red-300/50">
                      {o.charAt(0)}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">
                      {o} (反对)
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>

              {/* Consensus bar */}
              <div className="mt-1.5">
                <div className="h-1 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all duration-500"
                    style={{ width: `${Math.round(arg.consensusLevel * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom consensus strength bar */}
      <div className="shrink-0 border-t border-border/50 px-3 py-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-muted-foreground">Consensus Strength</span>
          <span className="text-[10px] font-medium">{Math.round(avgConsensus * 100)}%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.round(avgConsensus * 100)}%`,
              background: `linear-gradient(90deg, oklch(0.65 0.2 145) 0%, oklch(0.75 0.15 145) 100%)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
