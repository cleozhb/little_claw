"use client";

import { useState } from "react";
import { Terminal, CheckCircle2, XCircle, Loader2, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DisplayMessage } from "@/lib/mock-data";

interface ToolCallCardProps {
  message: DisplayMessage;
  /** The matching tool_result message, if available */
  result?: DisplayMessage;
}

export function ToolCallCard({ message, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);

  const name = message.meta?.toolName ?? "unknown";
  const params = message.meta?.toolParams;

  // Determine status from paired result or own meta
  const hasResult = !!result || message.meta?.success !== undefined;
  const success = result ? result.meta?.success : message.meta?.success;
  const running = !hasResult;
  const durationMs = message.meta?.toolDurationMs;
  const output = result?.meta?.result ?? message.meta?.toolResult;

  // Summarize params into a short string
  const paramSummary = params ? summarizeParams(params) : "";

  return (
    <div
      className={`rounded-lg border text-xs transition-colors ${
        running
          ? "border-yellow-500/20 bg-yellow-500/5"
          : success
            ? "border-border/50 bg-white dark:bg-white/5"
            : "border-red-500/20 bg-red-500/5"
      }`}
    >
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
      >
        <Terminal className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-mono shrink-0">
          {name}
        </Badge>
        {paramSummary && (
          <span className="truncate text-muted-foreground/60 flex-1">{paramSummary}</span>
        )}
        {durationMs != null && (
          <span className="shrink-0 text-[10px] text-muted-foreground/40 font-mono">
            {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {/* Status dot */}
        <StatusDot running={running} success={success} />
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2">
          {params && (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                Parameters
              </span>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground/80 font-mono bg-muted/30 rounded p-2 max-h-[200px] overflow-y-auto">
                {JSON.stringify(params, null, 2)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                Output
              </span>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground/80 font-mono bg-muted/30 rounded p-2 max-h-[300px] overflow-y-auto">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ running, success }: { running: boolean; success?: boolean }) {
  if (running) {
    return <Loader2 className="h-3 w-3 shrink-0 text-yellow-500 animate-spin" />;
  }
  if (success) {
    return <CheckCircle2 className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />;
  }
  return <XCircle className="h-3 w-3 shrink-0 text-red-600 dark:text-red-400" />;
}

function summarizeParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "";

  // For common tools, pick the most meaningful param
  const priorityKeys = ["command", "path", "file_path", "query", "content", "url"];
  for (const key of priorityKeys) {
    if (key in params) {
      const val = String(params[key]);
      return val.length > 60 ? val.slice(0, 57) + "..." : val;
    }
  }

  // Fallback: first string-like value
  for (const [, v] of entries) {
    if (typeof v === "string") {
      return v.length > 60 ? v.slice(0, 57) + "..." : v;
    }
  }

  return `${entries.length} params`;
}
