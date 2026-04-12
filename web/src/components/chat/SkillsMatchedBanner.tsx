"use client";

import { Sparkles, ChevronDown } from "lucide-react";
import { useState } from "react";

interface SkillsMatchedBannerProps {
  skills: Array<{ name: string; score: number; matchReason: string }>;
}

export function SkillsMatchedBanner({ skills }: SkillsMatchedBannerProps) {
  const [open, setOpen] = useState(false);

  if (skills.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-muted-foreground font-medium">
          Activated {skills.length} skill{skills.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-1.5 ml-1">
          {skills.map((s) => (
            <span
              key={s.name}
              className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            >
              {s.name}
            </span>
          ))}
        </div>
        <ChevronDown
          className={`ml-auto h-3 w-3 text-muted-foreground/60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-amber-500/10 px-3 py-2 space-y-1.5">
          {skills.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="shrink-0 text-[10px] text-amber-600/70 dark:text-amber-400/70 font-mono w-10 text-right">
                {Math.round(s.score * 100)}%
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-amber-500/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-amber-500/50"
                  style={{ width: `${Math.round(s.score * 100)}%` }}
                />
              </div>
              <span className="font-medium text-muted-foreground min-w-0 truncate">
                {s.name}
              </span>
            </div>
          ))}
          {skills[0]?.matchReason && (
            <p className="text-[10px] text-muted-foreground/60 mt-1 pt-1 border-t border-amber-500/10">
              {skills[0].matchReason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
