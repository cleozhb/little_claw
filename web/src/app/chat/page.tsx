"use client";

import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { ChatArea } from "@/components/chat-area";
import { wsClient, useConnectionStatus } from "@/lib/websocket";
import { useSessions } from "@/hooks/useSessions";
import { useChat } from "@/hooks/useChat";

const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:4000/ws";

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const connectionStatus = useConnectionStatus();

  const {
    sessions,
    currentSessionId,
    listSessions,
    createSession,
    loadSession,
    deleteSession,
  } = useSessions();

  const sessionIdKey = sessions.map((s) => s.id).join("\0");
  const sessionIds = useMemo(
    () => new Set(sessionIdKey ? sessionIdKey.split("\0") : []),
    [sessionIdKey],
  );
  const currentSessionExists = Boolean(currentSessionId && sessionIds.has(currentSessionId));

  const { messages, isStreaming, activeSkills, sendMessage, abort } = useChat(
    currentSessionExists ? currentSessionId : null,
  );

  useEffect(() => {
    wsClient.connect(WS_URL);
    return () => wsClient.disconnect();
  }, []);

  useEffect(() => {
    if (connectionStatus === "connected") {
      listSessions();
    }
  }, [connectionStatus, listSessions]);

  useEffect(() => {
    if (currentSessionId && sessionIds.has(currentSessionId) && connectionStatus === "connected") {
      wsClient.send({ type: "load_session", sessionId: currentSessionId });
    }
  }, [currentSessionId, sessionIds, connectionStatus]);

  const activeSession = sessions.find((s) => s.id === currentSessionId);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-40 w-[260px] transform transition-transform duration-200 ease-out
          md:static md:translate-x-0
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <Sidebar
          sessions={sessions}
          activeSessionId={currentSessionId}
          connectionStatus={connectionStatus}
          onSessionSelect={(id) => {
            loadSession(id);
            setSidebarOpen(false);
          }}
          onNewChat={createSession}
          onDeleteSession={deleteSession}
        />
      </aside>

      <main className="flex-1 min-w-0">
        <ChatArea
          sessionTitle={activeSession?.title ?? "新对话"}
          messages={messages}
          isStreaming={isStreaming}
          activeSkills={activeSkills}
          sessionId={currentSessionExists ? currentSessionId : null}
          onMenuClick={() => setSidebarOpen(true)}
          onSend={sendMessage}
          onAbort={abort}
        />
      </main>
    </div>
  );
}
