"use client";

import { useEffect, useState } from "react";
import { Sidebar, type AppMode } from "@/components/sidebar";
import { ChatArea } from "@/components/chat-area";
import { SimulationView } from "@/components/simulation/SimulationView";
import { wsClient, useConnectionStatus } from "@/lib/websocket";
import { useSessions } from "@/hooks/useSessions";
import { useChat } from "@/hooks/useChat";

const WS_URL = "ws://localhost:4000/ws";

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const connectionStatus = useConnectionStatus();

  const {
    sessions,
    currentSessionId,
    listSessions,
    createSession,
    loadSession,
    deleteSession,
  } = useSessions();

  const { messages, isStreaming, activeSkills, sendMessage, abort } = useChat(currentSessionId);

  // Connect on mount, fetch session list when connected
  useEffect(() => {
    wsClient.connect(WS_URL);
    return () => wsClient.disconnect();
  }, []);

  useEffect(() => {
    if (connectionStatus === "connected") {
      listSessions();
    }
  }, [connectionStatus, listSessions]);

  // Load session messages when switching sessions
  useEffect(() => {
    if (currentSessionId && connectionStatus === "connected") {
      wsClient.send({ type: "load_session", sessionId: currentSessionId });
    }
  }, [currentSessionId, connectionStatus]);

  const activeSession = sessions.find((s) => s.id === currentSessionId);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && appMode === "chat" && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar – hidden in simulation mode */}
      {appMode === "chat" && (
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
            appMode={appMode}
            onSessionSelect={(id) => {
              loadSession(id);
              setSidebarOpen(false);
            }}
            onNewChat={createSession}
            onDeleteSession={deleteSession}
            onModeChange={setAppMode}
          />
        </aside>
      )}

      {/* Main content area */}
      <main className="flex-1 min-w-0">
        {appMode === "chat" ? (
          <ChatArea
            sessionTitle={activeSession?.title ?? "新对话"}
            messages={messages}
            isStreaming={isStreaming}
            activeSkills={activeSkills}
            onMenuClick={() => setSidebarOpen(true)}
            onSend={sendMessage}
            onAbort={abort}
          />
        ) : (
          <SimulationView onBackToChat={() => setAppMode("chat")} />
        )}
      </main>
    </div>
  );
}
