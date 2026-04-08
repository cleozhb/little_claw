"use client";

import { useCallback, useEffect, useState } from "react";
import { wsClient } from "@/lib/websocket";
import type { DisplaySession } from "@/lib/mock-data";
import type { ServerMessage, SessionInfo } from "@/types/protocol";

/**
 * Convert a SessionInfo (protocol type) into a DisplaySession (UI type).
 */
function toDisplaySession(s: SessionInfo): DisplaySession {
  return {
    id: s.id,
    title: s.title,
    lastMessage: "",
    updatedAt: new Date(s.updated_at),
  };
}

export function useSessions() {
  const [sessions, setSessions] = useState<DisplaySession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // ---- Handle server messages ----
  useEffect(() => {
    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "sessions_list": {
          const list = msg.sessions.map(toDisplaySession);
          setSessions(list);
          // Auto-select first session if none selected
          if (list.length > 0) {
            setCurrentSessionId((prev) =>
              prev && list.some((s) => s.id === prev) ? prev : list[0].id,
            );
          }
          break;
        }

        case "session_created": {
          const ds = toDisplaySession(msg.session);
          setSessions((prev) => [ds, ...prev]);
          setCurrentSessionId(ds.id);
          break;
        }

        case "session_renamed": {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.session.id ? { ...s, title: msg.session.title } : s,
            ),
          );
          break;
        }

        case "title_updated": {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.sessionId ? { ...s, title: msg.title } : s,
            ),
          );
          break;
        }

        // Update lastMessage on text_delta for active session preview
        case "text_delta": {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.sessionId
                ? {
                    ...s,
                    lastMessage:
                      (s.lastMessage + msg.text).slice(-60),
                    updatedAt: new Date(),
                  }
                : s,
            ),
          );
          break;
        }
      }
    });

    return unsub;
  }, []);

  // ---- Actions ----

  const listSessions = useCallback(() => {
    wsClient.send({ type: "list_sessions" });
  }, []);

  const createSession = useCallback(() => {
    wsClient.send({ type: "create_session" });
  }, []);

  const loadSession = useCallback((id: string) => {
    setCurrentSessionId(id);
    wsClient.send({ type: "load_session", sessionId: id });
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      wsClient.send({ type: "delete_session", sessionId: id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setCurrentSessionId((prev) => {
        if (prev === id) {
          // Select next available session
          const remaining = sessions.filter((s) => s.id !== id);
          return remaining.length > 0 ? remaining[0].id : null;
        }
        return prev;
      });
    },
    [sessions],
  );

  return {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    listSessions,
    createSession,
    loadSession,
    deleteSession,
  };
}
