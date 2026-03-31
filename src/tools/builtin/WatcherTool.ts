import type { Tool, ToolResult } from "../types.ts";
import type { EventWatcher } from "../../scheduler/EventWatcher.ts";

export interface WatcherToolContext {
  watcher: EventWatcher;
  getSessionId: () => string;
}

export function createWatcherTool(context: WatcherToolContext): Tool {
  return {
    name: "manage_watcher",
    description:
      "Create, list, or delete event watchers. Watchers periodically run a shell command to check a condition, and trigger an action when the condition is met.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "delete", "enable", "disable"],
          description: "The action to perform",
        },
        name: {
          type: "string",
          description: "Name for the watcher (required for create)",
        },
        check_command: {
          type: "string",
          description:
            'Shell command to execute for checking the condition (required for create). Exit code 0 means condition is met. For example: "test $(curl -s .../price) -gt 200"',
        },
        condition: {
          type: "string",
          description:
            "Human-readable description of the condition being checked (optional, for documentation)",
        },
        prompt: {
          type: "string",
          description:
            "The prompt/instruction to send to the agent when the condition is met (required for create)",
        },
        interval_minutes: {
          type: "number",
          description:
            "How often to check, in minutes (optional, default 1)",
        },
        watcher_id: {
          type: "string",
          description: "The watcher ID (required for delete/enable/disable)",
        },
      },
      required: ["action"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      switch (action) {
        case "create": {
          const name = params.name as string | undefined;
          const checkCommand = params.check_command as string | undefined;
          const prompt = params.prompt as string | undefined;
          const condition = (params.condition as string) ?? "";
          const intervalMinutes = (params.interval_minutes as number) ?? 1;

          if (!name || !checkCommand || !prompt) {
            return {
              success: false,
              output: "",
              error:
                "Missing required parameters: name, check_command, and prompt are required for create",
            };
          }

          try {
            const watcher = context.watcher.addWatcher({
              name,
              checkCommand,
              condition,
              prompt,
              intervalMs: intervalMinutes * 60_000,
              cooldownMs: 300_000, // 5 minutes default
              sessionId: context.getSessionId(),
              enabled: true,
            });

            return {
              success: true,
              output: [
                `Watcher created successfully.`,
                `  ID: ${watcher.id}`,
                `  Name: ${watcher.name}`,
                `  Command: ${watcher.checkCommand}`,
                condition ? `  Condition: ${condition}` : null,
                `  Prompt: ${watcher.prompt}`,
                `  Interval: ${intervalMinutes} minute(s)`,
                `  Cooldown: 5 minutes`,
              ]
                .filter(Boolean)
                .join("\n"),
            };
          } catch (err) {
            return {
              success: false,
              output: "",
              error: `Failed to create watcher: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        case "list": {
          const watchers = context.watcher.listWatchers();
          if (watchers.length === 0) {
            return { success: true, output: "No watchers configured." };
          }

          const lines = watchers.map((w) =>
            [
              `- [${w.enabled ? "enabled" : "disabled"}] ${w.name} (${w.id})`,
              `  Command: ${w.checkCommand}`,
              w.condition ? `  Condition: ${w.condition}` : null,
              `  Prompt: ${w.prompt}`,
              `  Interval: ${w.intervalMs / 60_000} minute(s)`,
              `  Cooldown: ${w.cooldownMs / 60_000} minute(s)`,
              `  Session: ${w.sessionId}`,
              w.lastCheckAt ? `  Last check: ${w.lastCheckAt}` : null,
              w.lastTriggeredAt ? `  Last triggered: ${w.lastTriggeredAt}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );

          return {
            success: true,
            output: `${watchers.length} watcher(s):\n${lines.join("\n\n")}`,
          };
        }

        case "delete": {
          const watcherId = params.watcher_id as string | undefined;
          if (!watcherId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: watcher_id is required for delete",
            };
          }

          context.watcher.removeWatcher(watcherId);
          return { success: true, output: `Watcher ${watcherId} deleted.` };
        }

        case "enable": {
          const watcherId = params.watcher_id as string | undefined;
          if (!watcherId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: watcher_id is required for enable",
            };
          }

          const updated = context.watcher.updateWatcher(watcherId, { enabled: true });
          if (!updated) {
            return {
              success: false,
              output: "",
              error: `Watcher ${watcherId} not found.`,
            };
          }
          return {
            success: true,
            output: `Watcher "${updated.name}" (${watcherId}) enabled.`,
          };
        }

        case "disable": {
          const watcherId = params.watcher_id as string | undefined;
          if (!watcherId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: watcher_id is required for disable",
            };
          }

          const updated = context.watcher.updateWatcher(watcherId, { enabled: false });
          if (!updated) {
            return {
              success: false,
              output: "",
              error: `Watcher ${watcherId} not found.`,
            };
          }
          return {
            success: true,
            output: `Watcher "${updated.name}" (${watcherId}) disabled.`,
          };
        }

        default:
          return {
            success: false,
            output: "",
            error: `Unknown action: ${action}. Valid actions: create, list, delete, enable, disable`,
          };
      }
    },
  };
}
