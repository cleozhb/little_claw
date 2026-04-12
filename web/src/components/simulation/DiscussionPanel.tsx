"use client";

import { useRef, useEffect, useCallback } from "react";
import { StreamingCursor } from "@/components/chat/StreamingCursor";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import type { TranscriptEntry } from "@/hooks/useSimulation";

interface DiscussionPanelProps {
  transcript: TranscriptEntry[];
  /** ID ref map: topic -> entryId for scroll-to-argument linking */
  entryRefMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
  highlightEntryId: string | null;
  /** Scenario name to display as title */
  scenarioName?: string;
}

/** Color palette for persona names */
const PERSONA_COLORS = [
  "text-blue-600 dark:text-blue-400",
  "text-purple-600 dark:text-purple-400",
  "text-amber-600 dark:text-amber-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-rose-600 dark:text-rose-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-orange-600 dark:text-orange-400",
  "text-indigo-600 dark:text-indigo-400",
];

const personaColorMap = new Map<string, string>();
let colorIdx = 0;

function getPersonaColor(name: string): string {
  if (!personaColorMap.has(name)) {
    personaColorMap.set(name, PERSONA_COLORS[colorIdx % PERSONA_COLORS.length]);
    colorIdx++;
  }
  return personaColorMap.get(name)!;
}

export function DiscussionPanel({
  transcript,
  entryRefMap,
  highlightEntryId,
  scenarioName,
}: DiscussionPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  // Scroll to a specific entry when highlighted
  useEffect(() => {
    if (highlightEntryId && entryRefMap.current) {
      const el = entryRefMap.current.get(highlightEntryId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightEntryId, entryRefMap]);

  const setEntryRef = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) {
        entryRefMap.current.set(id, el);
      }
    },
    [entryRefMap],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight">{scenarioName || "讨论记录"}</h2>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-4 space-y-3">
          {transcript.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[11px] text-muted-foreground/50">
              等待模拟开始…
            </div>
          )}

          {transcript.map((entry) => {
            const isHighlighted = highlightEntryId === entry.id;

            // Round banner
            if (entry.persona === "__round__") {
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 py-2"
                >
                  <div className="h-px flex-1 bg-border" />
                  <Badge variant="secondary" className="text-[10px] px-2.5 py-0.5 font-medium">
                    {entry.text}
                  </Badge>
                  <div className="h-px flex-1 bg-border" />
                </div>
              );
            }

            // Waiting divider
            if (entry.isWaiting) {
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 py-3"
                >
                  <div className="h-px flex-1 bg-blue-300 dark:bg-blue-700" />
                  <span className="text-[10px] text-blue-500 dark:text-blue-400 font-medium whitespace-nowrap">
                    {entry.text}
                  </span>
                  <div className="h-px flex-1 bg-blue-300 dark:bg-blue-700" />
                </div>
              );
            }

            // Speaker selected notification (Free mode)
            if (entry.isSpeakerSelected) {
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 py-1.5"
                >
                  <div className="h-px flex-1 bg-amber-300 dark:bg-amber-700" />
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">
                    🎤 下一位发言人: {entry.persona}
                  </span>
                  <div className="h-px flex-1 bg-amber-300 dark:bg-amber-700" />
                </div>
              );
            }

            // Moderator inject message
            if (entry.isModerator) {
              return (
                <div
                  key={entry.id}
                  ref={(el) => setEntryRef(entry.id, el)}
                  className="rounded-lg border-l-[3px] border-blue-500 bg-blue-50/50 dark:bg-blue-900/10 p-3"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm">{entry.emoji}</span>
                    <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                      Moderator
                    </span>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
                      注入
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-foreground/80">{entry.text}</p>
                </div>
              );
            }

            // User (You) message — blue styling
            if (entry.isUser) {
              return (
                <div
                  key={entry.id}
                  ref={(el) => setEntryRef(entry.id, el)}
                  className="rounded-lg border-l-[3px] border-blue-500 bg-blue-50/50 dark:bg-blue-900/10 p-3"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm">{entry.emoji}</span>
                    <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                      You
                    </span>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
                      发言
                    </Badge>
                  </div>
                  <div className="text-xs leading-relaxed">
                    <Markdown content={entry.text} />
                  </div>
                </div>
              );
            }

            // Normal persona message
            const nameColor = getPersonaColor(entry.persona);

            return (
              <div
                key={entry.id}
                ref={(el) => setEntryRef(entry.id, el)}
                className={`
                  rounded-lg bg-card p-3 transition-all duration-300
                  ${isHighlighted ? "ring-2 ring-yellow-400 bg-yellow-50/50 dark:bg-yellow-900/10" : ""}
                `}
              >
                {/* Avatar + Name + Role */}
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-sm">{entry.emoji}</span>
                  <span className={`text-[11px] font-semibold ${nameColor}`}>
                    {entry.persona}
                  </span>
                </div>

                {/* Content */}
                <div className="text-xs leading-relaxed">
                  {entry.text ? (
                    <Markdown content={entry.text} />
                  ) : (
                    <span className="text-muted-foreground/50 italic">思考中…</span>
                  )}
                  {entry.isStreaming && <StreamingCursor />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
