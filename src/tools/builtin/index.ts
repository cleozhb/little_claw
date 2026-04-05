import type { Tool } from "../types.ts";
import type { ShellTool } from "../types.ts";
import { createReadFileTool } from "./ReadFileTool.ts";
import { createWriteFileTool } from "./WriteFileTool.ts";
import { createShellTool } from "./ShellTool.ts";
import { createCronTool } from "./CronTool.ts";
import type { CronToolContext } from "./CronTool.ts";
import { createWatcherTool } from "./WatcherTool.ts";
import type { WatcherToolContext } from "./WatcherTool.ts";

export { createReadFileTool, createWriteFileTool, createShellTool, createCronTool, createWatcherTool };
export { createMemoryWriteTool } from "./MemoryWriteTool.ts";
export { createMemoryReadTool } from "./MemoryReadTool.ts";
export type { CronToolContext, WatcherToolContext };

export interface BuiltinTools {
  all: Tool[];
  shellTool: ShellTool;
}

export interface SchedulerToolsOptions {
  cronContext?: CronToolContext;
  watcherContext?: WatcherToolContext;
}

export function createBuiltinTools(workspaceRoot: string, schedulerOptions?: SchedulerToolsOptions): BuiltinTools {
  const shellTool = createShellTool(workspaceRoot);
  const tools: Tool[] = [
    createReadFileTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    shellTool,
  ];

  if (schedulerOptions?.cronContext) {
    tools.push(createCronTool(schedulerOptions.cronContext));
  }
  if (schedulerOptions?.watcherContext) {
    tools.push(createWatcherTool(schedulerOptions.watcherContext));
  }

  return {
    all: tools,
    shellTool,
  };
}
