import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ClientMessage, ServerMessage } from "@/types/protocol";

// ============================================================
// Connection State
// ============================================================

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

type MessageHandler = (msg: ServerMessage) => void;

// ============================================================
// WebSocket Client (singleton)
// ============================================================

class WebSocketClient {
  private ws: WebSocket | null = null;
  private url = "";
  private handlers = new Set<MessageHandler>();
  private status: ConnectionStatus = "disconnected";
  private statusListeners = new Set<() => void>();

  // Reconnect
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectInterval = 3_000;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatInterval = 15_000;
  private readonly pongTimeout = 10_000;

  // Intentional close flag
  private intentionalClose = false;

  // ---- Status management ----

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  // ---- Connection ----

  connect(url: string) {
    this.url = url;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  disconnect() {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  private doConnect() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    }

    this.setStatus("connecting");

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.startHeartbeat();
    };

    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        return;
      }

      // Handle pong internally
      if (msg.type === "pong") {
        this.clearPongTimer();
        return;
      }

      for (const handler of this.handlers) {
        handler(msg);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, handle reconnect there
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.setStatus("disconnected");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  // ---- Reconnect ----

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, this.reconnectInterval);
  }

  // ---- Heartbeat ----

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
        this.pongTimer = setTimeout(() => {
          // No pong received — force reconnect
          this.ws?.close();
        }, this.pongTimeout);
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearTimers() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---- Messaging ----

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();

// ============================================================
// React hook: useConnectionStatus
// ============================================================

export function useConnectionStatus(): ConnectionStatus {
  const getSnapshot = useCallback(() => wsClient.getStatus(), []);
  const subscribe = useCallback(
    (listener: () => void) => wsClient.subscribeStatus(listener),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
