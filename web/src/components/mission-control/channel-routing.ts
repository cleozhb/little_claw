export type ChannelRouteSelection =
  | { type: "all" }
  | { type: "project" }
  | { type: "agent_dm" };

export type ChannelMessageSelection =
  | { type: "all" }
  | { type: "project"; id?: string; project: string }
  | { type: "agent_dm"; agentName: string };

export interface ChannelRoutableMessage {
  channelType: "project" | "agent_dm" | "coordinator" | "system";
  channelId: string;
  project?: string;
}

export function shouldUseTeamRouter(text: string, selectedChannel: ChannelRouteSelection): boolean {
  const trimmed = text.trim();

  if (/^\/task\b/.test(trimmed)) return true;
  if (selectedChannel.type === "project") return false;

  return /^(@|#)/.test(trimmed);
}

export function messageMatchesChannelSelection(
  message: ChannelRoutableMessage,
  selection: ChannelMessageSelection,
): boolean {
  if (selection.type === "all") return true;

  if (selection.type === "agent_dm") {
    return message.channelType === "agent_dm" && message.channelId === selection.agentName;
  }

  if (message.project === selection.project) return true;
  if (message.channelType !== "project") return false;

  return message.channelId === selection.project || message.channelId === selection.id;
}
