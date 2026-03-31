import type { Tool, ToolResult } from "../types.ts";
import type { CronScheduler } from "../../scheduler/CronScheduler.ts";

export interface CronToolContext {
  scheduler: CronScheduler;
  getSessionId: () => string;
}

export function createCronTool(context: CronToolContext): Tool {
  return {
    name: "manage_cron",
    description:
      "Create, list, update, or delete scheduled cron jobs. Cron jobs automatically send a prompt to the agent at specified times.",
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
          description: "Name for the cron job (required for create)",
        },
        cron_expr: {
          type: "string",
          description:
            'Standard cron expression with 5 fields: minute hour day month weekday. For example: "0 8 * * *" (every day at 8am), "*/5 * * * *" (every 5 minutes)',
        },
        prompt: {
          type: "string",
          description:
            "The prompt/instruction to send to the agent when the job triggers (required for create)",
        },
        job_id: {
          type: "string",
          description: "The job ID (required for delete/enable/disable)",
        },
      },
      required: ["action"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      switch (action) {
        case "create": {
          const name = params.name as string | undefined;
          const cronExpr = params.cron_expr as string | undefined;
          const prompt = params.prompt as string | undefined;

          if (!name || !cronExpr || !prompt) {
            return {
              success: false,
              output: "",
              error:
                "Missing required parameters: name, cron_expr, and prompt are required for create",
            };
          }

          try {
            const job = context.scheduler.addJob({
              name,
              cronExpr,
              prompt,
              sessionId: context.getSessionId(),
              enabled: true,
            });

            return {
              success: true,
              output: [
                `Cron job created successfully.`,
                `  ID: ${job.id}`,
                `  Name: ${job.name}`,
                `  Schedule: ${job.cronExpr}`,
                `  Prompt: ${job.prompt}`,
                `  Next run: ${job.nextRunAt}`,
              ].join("\n"),
            };
          } catch (err) {
            return {
              success: false,
              output: "",
              error: `Failed to create cron job: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        case "list": {
          const jobs = context.scheduler.listJobs();
          if (jobs.length === 0) {
            return { success: true, output: "No cron jobs configured." };
          }

          const lines = jobs.map((job) =>
            [
              `- [${job.enabled ? "enabled" : "disabled"}] ${job.name} (${job.id})`,
              `  Schedule: ${job.cronExpr}`,
              `  Prompt: ${job.prompt}`,
              `  Session: ${job.sessionId}`,
              job.nextRunAt ? `  Next run: ${job.nextRunAt}` : null,
              job.lastRunAt ? `  Last run: ${job.lastRunAt}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );

          return {
            success: true,
            output: `${jobs.length} cron job(s):\n${lines.join("\n\n")}`,
          };
        }

        case "delete": {
          const jobId = params.job_id as string | undefined;
          if (!jobId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: job_id is required for delete",
            };
          }

          context.scheduler.removeJob(jobId);
          return { success: true, output: `Cron job ${jobId} deleted.` };
        }

        case "enable": {
          const jobId = params.job_id as string | undefined;
          if (!jobId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: job_id is required for enable",
            };
          }

          const updated = context.scheduler.updateJob(jobId, { enabled: true });
          if (!updated) {
            return {
              success: false,
              output: "",
              error: `Cron job ${jobId} not found.`,
            };
          }
          return {
            success: true,
            output: `Cron job "${updated.name}" (${jobId}) enabled. Next run: ${updated.nextRunAt}`,
          };
        }

        case "disable": {
          const jobId = params.job_id as string | undefined;
          if (!jobId) {
            return {
              success: false,
              output: "",
              error: "Missing required parameter: job_id is required for disable",
            };
          }

          const updated = context.scheduler.updateJob(jobId, { enabled: false });
          if (!updated) {
            return {
              success: false,
              output: "",
              error: `Cron job ${jobId} not found.`,
            };
          }
          return {
            success: true,
            output: `Cron job "${updated.name}" (${jobId}) disabled.`,
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
