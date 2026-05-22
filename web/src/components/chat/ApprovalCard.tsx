"use client";

import { useState } from "react";
import { ShieldAlert, Check, X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApproval } from "@/hooks/useApproval";
import type { DisplayMessage } from "@/lib/mock-data";

interface ApprovalCardProps {
  message: DisplayMessage;
  sessionId: string | null;
}

export function ApprovalCard({ message, sessionId }: ApprovalCardProps) {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">(
    message.meta?.approvalStatus ?? "pending",
  );
  const [showParams, setShowParams] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const { respondApproval } = useApproval(sessionId);

  const approvalId = message.meta?.approvalId;
  const toolName = message.meta?.toolName ?? "unknown";
  const params = message.meta?.toolParams;
  const approvalMessage = message.meta?.approvalMessage ?? message.content;

  const handleApprove = () => {
    if (!approvalId) return;
    respondApproval(approvalId, true);
    setStatus("approved");
  };

  const handleReject = () => {
    if (!approvalId) return;
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    respondApproval(approvalId, false, rejectReason || undefined);
    setStatus("rejected");
  };

  const borderColor =
    status === "approved"
      ? "border-green-500/20 bg-green-500/5"
      : status === "rejected"
        ? "border-red-500/20 bg-red-500/5"
        : "border-amber-500/20 bg-amber-500/5";

  return (
    <div className={`rounded-lg border text-xs transition-colors ${borderColor}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="flex-1 text-sm font-medium text-foreground/90">
          {approvalMessage}
        </span>
        {status !== "pending" && (
          <Badge
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 h-4 ${
              status === "approved"
                ? "bg-green-500/10 text-green-700 dark:text-green-300"
                : "bg-red-500/10 text-red-700 dark:text-red-300"
            }`}
          >
            {status === "approved" ? "已批准" : "已拒绝"}
          </Badge>
        )}
      </div>

      {/* Tool info */}
      <div className="border-t border-border/20 px-3 py-2 flex items-center gap-1.5">
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-mono">
          {toolName}
        </Badge>
        {params && (
          <button
            onClick={() => setShowParams(!showParams)}
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground/80"
          >
            参数
            <ChevronDown className={`h-2.5 w-2.5 transition-transform ${showParams ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {showParams && params && (
        <div className="border-t border-border/20 px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground/70 font-mono bg-muted/30 rounded p-2 max-h-[200px] overflow-y-auto">
            {JSON.stringify(params, null, 2)}
          </pre>
        </div>
      )}

      {/* Action buttons */}
      {status === "pending" && (
        <div className="border-t border-border/20 px-3 py-2.5 space-y-2">
          {showRejectInput && (
            <input
              type="text"
              placeholder="拒绝原因（可选）"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleReject();
              }}
              className="w-full rounded border border-border/50 bg-background px-2 py-1 text-xs outline-none focus:border-border"
              autoFocus
            />
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-6 px-3 text-xs bg-green-600 hover:bg-green-700 text-white"
              onClick={handleApprove}
            >
              <Check className="h-3 w-3 mr-1" />
              批准
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-3 text-xs border-red-500/30 text-red-600 hover:bg-red-500/10"
              onClick={handleReject}
            >
              <X className="h-3 w-3 mr-1" />
              {showRejectInput ? "确认拒绝" : "拒绝"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
