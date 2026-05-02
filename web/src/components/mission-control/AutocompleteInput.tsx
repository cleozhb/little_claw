"use client";

import { Bot, Hash, Terminal } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AgentInfo, ProjectChannelInfo } from "@/types/protocol";

// ─── Static command definitions ──────────────────────────────────────────────

interface CommandDef {
  name: string;
  syntax: string;
  description: string;
}

const SLASH_COMMANDS: CommandDef[] = [
  {
    name: "task",
    syntax: "<id> approve|reject|cancel [response]",
    description: "审批任务",
  },
  {
    name: "pause",
    syntax: "@?<agent>",
    description: "暂停 Agent",
  },
  {
    name: "resume",
    syntax: "@?<agent>",
    description: "恢复 Agent",
  },
  {
    name: "project",
    syntax: "#?<slug>",
    description: "绑定项目频道",
  },
  {
    name: "status",
    syntax: "[@agent|#project]",
    description: "查看团队状态",
  },
];

// ─── Suggestion item types ───────────────────────────────────────────────────

type TriggerType = "@" | "#" | "/";

interface SuggestionItem {
  key: string;
  icon: React.ReactNode;
  primary: string;
  secondary: string;
  insertText: string;
}

// ─── AutocompleteInput props ─────────────────────────────────────────────────

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  agents: AgentInfo[];
  channels: ProjectChannelInfo[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

// ─── Helper: detect trigger prefix ──────────────────────────────────────────

function detectTrigger(text: string): { type: TriggerType; query: string } | null {
  if (text.startsWith("/")) {
    const match = text.match(/^\/(\w*)$/);
    if (match) return { type: "/", query: match[1] ?? "" };
  }
  if (text.startsWith("@")) {
    const match = text.match(/^@(\w*)$/);
    if (match) return { type: "@", query: match[1] ?? "" };
  }
  if (text.startsWith("#")) {
    const match = text.match(/^#([a-z0-9_-]*)$/);
    if (match) return { type: "#", query: match[1] ?? "" };
  }
  return null;
}

// ─── Helper: build suggestion items ─────────────────────────────────────────

function buildSuggestions(
  trigger: { type: TriggerType; query: string },
  agents: AgentInfo[],
  channels: ProjectChannelInfo[],
): SuggestionItem[] {
  const q = trigger.query.toLowerCase();

  if (trigger.type === "@") {
    return agents
      .filter((a) => a.directMessage !== false)
      .filter((a) => {
        if (!q) return true;
        if (a.name.toLowerCase().startsWith(q)) return true;
        return a.aliases?.some((alias) => alias.toLowerCase().startsWith(q)) ?? false;
      })
      .map((a) => ({
        key: `@${a.name}`,
        icon: <Bot className="h-3.5 w-3.5 shrink-0" />,
        primary: a.displayName || a.name,
        secondary: `@${a.name}`,
        insertText: `@${a.name} `,
      }));
  }

  if (trigger.type === "#") {
    return channels
      .filter((c) => !q || c.slug.toLowerCase().startsWith(q))
      .map((c) => ({
        key: `#${c.slug}`,
        icon: <Hash className="h-3.5 w-3.5 shrink-0" />,
        primary: c.title || c.slug,
        secondary: `#${c.slug}`,
        insertText: `#${c.slug} `,
      }));
  }

  // "/"
  return SLASH_COMMANDS.filter((cmd) => !q || cmd.name.toLowerCase().startsWith(q)).map((cmd) => ({
    key: `/${cmd.name}`,
    icon: <Terminal className="h-3.5 w-3.5 shrink-0" />,
    primary: `/${cmd.name}`,
    secondary: cmd.syntax,
    insertText: `/${cmd.name} `,
  }));
}

// ─── AutocompletePopup ───────────────────────────────────────────────────────

function AutocompletePopup({
  items,
  selectedIndex,
  onSelect,
  emptyText,
}: {
  items: SuggestionItem[];
  selectedIndex: number;
  onSelect: (item: SuggestionItem) => void;
  emptyText: string;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
      {items.length === 0 ? (
        <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none",
              i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
            onMouseDown={(e) => {
              e.preventDefault(); // prevent textarea blur
              onSelect(item);
            }}
          >
            <span className="shrink-0 text-muted-foreground">{item.icon}</span>
            <span className="truncate font-medium">{item.primary}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.secondary}</span>
          </button>
        ))
      )}
    </div>
  );
}

// ─── AutocompleteInput ───────────────────────────────────────────────────────

export function AutocompleteInput({
  value,
  onChange,
  onSubmit,
  agents,
  channels,
  disabled,
  placeholder,
  className,
}: AutocompleteInputProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupVisible, setPopupVisible] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useMemo(() => detectTrigger(value), [value]);

  const suggestions = useMemo(
    () => (trigger ? buildSuggestions(trigger, agents, channels) : []),
    [trigger, agents, channels],
  );

  const emptyText =
    trigger?.type === "@"
      ? "暂无 Agent"
      : trigger?.type === "#"
        ? "暂无频道"
        : "无匹配命令";

  // Sync popup visibility with trigger state
  useEffect(() => {
    if (trigger && suggestions.length > 0 && !disabled) {
      setPopupVisible(true);
      setSelectedIndex(0);
    } else if (trigger && !disabled) {
      // Show popup even with 0 items to display empty text
      setPopupVisible(true);
      setSelectedIndex(0);
    } else {
      setPopupVisible(false);
    }
  }, [trigger, suggestions.length, disabled]);

  const applySuggestion = useCallback(
    (item: SuggestionItem) => {
      // Replace the trigger prefix + query with the insert text
      const prefixLen = trigger ? value.indexOf(trigger.query, 1) + trigger.query.length : 0;
      const rest = value.slice(prefixLen > 0 ? prefixLen : value.length);
      onChange(item.insertText + rest);
      setPopupVisible(false);
    },
    [trigger, value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete popup navigation
      if (popupVisible) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % Math.max(suggestions.length, 1));
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) =>
            i <= 0 ? Math.max(suggestions.length - 1, 0) : i - 1,
          );
          return;
        }

        if (e.key === "Tab") {
          if (suggestions.length > 0 && selectedIndex < suggestions.length) {
            e.preventDefault();
            applySuggestion(suggestions[selectedIndex]!);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          if (suggestions.length > 0 && selectedIndex < suggestions.length) {
            e.preventDefault();
            applySuggestion(suggestions[selectedIndex]!);
            return;
          }
        }

        if (e.key === "Escape") {
          e.preventDefault();
          setPopupVisible(false);
          return;
        }
      }

      // Shift/Cmd/Ctrl + Enter → insert newline manually
      if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newValue = value.slice(0, start) + "\n" + value.slice(end);
        onChange(newValue);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
        });
        return;
      }

      // Enter → send message
      if (e.key === "Enter") {
        e.preventDefault();
        if (value.trim()) {
          onSubmit();
        }
      }
    },
    [popupVisible, suggestions, selectedIndex, applySuggestion, value, onSubmit],
  );

  const handleBlur = useCallback(() => {
    // Delay to allow click on popup item
    blurTimerRef.current = setTimeout(() => setPopupVisible(false), 150);
  }, []);

  const handleFocus = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
    }
    // Re-evaluate popup on focus
    if (trigger && !disabled) {
      setPopupVisible(true);
    }
  }, [trigger, disabled]);

  return (
    <div className="relative flex-1">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
      />
      {popupVisible && trigger && (
        <AutocompletePopup
          items={suggestions}
          selectedIndex={selectedIndex}
          onSelect={applySuggestion}
          emptyText={emptyText}
        />
      )}
    </div>
  );
}
