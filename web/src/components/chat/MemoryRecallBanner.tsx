"use client";

import { Brain, ChevronDown } from "lucide-react";
import { useState } from "react";

interface MemoryRecallBannerProps {
  memories: Array<{ content: string; similarity: number }>;
}

export function MemoryRecallBanner({ memories }: MemoryRecallBannerProps) {
  const [open, setOpen] = useState(false);

  if (memories.length === 0) return null;

  return (
    <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Brain className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
        <span className="text-muted-foreground font-medium">
          Recalled {memories.length} memor{memories.length === 1 ? "y" : "ies"} from previous sessions
        </span>
        <ChevronDown
          className={`ml-auto h-3 w-3 text-muted-foreground/60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-purple-500/10 px-3 py-2 space-y-2">
          {memories.map((m, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-[10px] text-purple-500/60 font-mono mt-0.5">
                {Math.round(m.similarity * 100)}%
              </span>
              <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                {m.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
