export type ChannelRouteSelection =
  | { type: "all" }
  | { type: "project" }
  | { type: "agent_dm" };

export function shouldUseTeamRouter(text: string, selectedChannel: ChannelRouteSelection): boolean {
  const trimmed = text.trim();

  if (/^\/task\b/.test(trimmed)) return true;
  if (selectedChannel.type === "project") return false;

  return /^(@|#)/.test(trimmed);
}
