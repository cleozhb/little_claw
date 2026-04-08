"use client";

import { Shield } from "lucide-react";
import { Markdown } from "@/components/markdown";

interface ModeratorMessageProps {
  content: string;
  timestamp: Date;
}

export function ModeratorMessage({ content, timestamp }: ModeratorMessageProps) {
  return (
    <div className="flex gap-3">
      <div className="min-w-0 flex-1 rounded-lg border-l-2 border-blue-500 bg-blue-500/5 px-4 py-2.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Shield className="h-3 w-3 text-blue-600 dark:text-blue-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
            Moderator (you)
          </span>
        </div>
        <div className="text-sm leading-relaxed">
          <Markdown content={content} />
        </div>
        <time className="block mt-1 text-[10px] text-muted-foreground/40">
          {timestamp.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
    </div>
  );
}
