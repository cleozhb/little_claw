"use client";

import { useCallback } from "react";
import { wsClient } from "@/lib/websocket";

export function useApproval(sessionId: string | null) {
  const respondApproval = useCallback(
    (approvalId: string, approved: boolean, reason?: string) => {
      if (!sessionId) return;
      wsClient.send({
        type: "chat_approval_response",
        sessionId,
        approvalId,
        approved,
        reason,
      });
    },
    [sessionId],
  );

  return { respondApproval };
}
