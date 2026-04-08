"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { Menu, ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { DisplayMessage } from "@/lib/mock-data";

interface ChatAreaProps {
  sessionTitle: string;
  messages: DisplayMessage[];
  isStreaming: boolean;
  onMenuClick: () => void;
  onSend: (content: string) => void;
  onAbort: () => void;
}

export function ChatArea({
  sessionTitle,
  messages,
  isStreaming,
  onMenuClick,
  onSend,
  onAbort,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  }, [input, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border/50 px-4 py-2.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 md:hidden"
          onClick={onMenuClick}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <h1 className="text-sm font-medium truncate">{sessionTitle}</h1>
        {isStreaming && (
          <span className="ml-auto text-[10px] text-muted-foreground animate-pulse">
            生成中…
          </span>
        )}
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full min-h-[200px] text-sm text-muted-foreground/50">
              开始新的对话
            </div>
          )}
          {messages.map((msg, i) => {
            const isLastAssistantText =
              isStreaming &&
              msg.role === "assistant" &&
              msg.type === "text" &&
              i === messages.length - 1;
            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={isLastAssistantText}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      <Separator className="opacity-50" />

      {/* Input */}
      <div className="shrink-0 mx-auto w-full max-w-3xl px-4 py-3">
        <div className="relative">
          <Textarea
            placeholder="发送消息…"
            className="min-h-[44px] max-h-[160px] resize-none pr-12 text-sm rounded-xl border-border/50 bg-muted/30 focus-visible:ring-1"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isStreaming ? (
            <Button
              size="icon"
              variant="destructive"
              className="absolute right-2 bottom-2 h-7 w-7 rounded-lg"
              onClick={onAbort}
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="absolute right-2 bottom-2 h-7 w-7 rounded-lg"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
          Little Claw 可能会出错，请核实重要信息
        </p>
      </div>
    </div>
  );
}
