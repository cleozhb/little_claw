import type { Tool } from "../types.ts";
import type { ShellTool } from "../types.ts";
import type { LLMProvider } from "../../llm/types.ts";
import { createReadFileTool } from "./ReadFileTool.ts";
import { createWriteFileTool } from "./WriteFileTool.ts";
import { createShellTool } from "./ShellTool.ts";
import { createCronTool } from "./CronTool.ts";
import type { CronToolContext } from "./CronTool.ts";
import { createWatcherTool } from "./WatcherTool.ts";
import type { WatcherToolContext } from "./WatcherTool.ts";
import { createWebSearchTool } from "./WebSearchTool.ts";
import { createWebFetchTool } from "./WebFetchTool.ts";
import { createReadContentRefTool } from "./ReadContentRefTool.ts";
import { createSearchContentRefTool } from "./SearchContentRefTool.ts";
import { ContentStore } from "../../memory/ContentStore.ts";
import type { EmbeddingProvider } from "../../memory/EmbeddingProvider.ts";

export { createReadFileTool, createWriteFileTool, createShellTool, createCronTool, createWatcherTool, createWebSearchTool, createWebFetchTool, createReadContentRefTool, createSearchContentRefTool };
export { createMemoryWriteTool } from "./MemoryWriteTool.ts";
export { createMemoryReadTool } from "./MemoryReadTool.ts";
export { createContextReadTool } from "./ContextReadTool.ts";
export { createContextWriteTool } from "./ContextWriteTool.ts";
export type { CronToolContext, WatcherToolContext };

export interface BuiltinTools {
  all: Tool[];
  shellTool: ShellTool;
}

export interface SchedulerToolsOptions {
  cronContext?: CronToolContext;
  watcherContext?: WatcherToolContext;
}

export interface BuiltinToolsOptions {
  workspaceRoot: string;
  schedulerOptions?: SchedulerToolsOptions;
  summarizerProvider?: LLMProvider;
  embeddingProvider?: EmbeddingProvider;
  contentStore?: ContentStore;
}

export function createBuiltinTools(workspaceRoot: string, schedulerOptions?: SchedulerToolsOptions): BuiltinTools;
export function createBuiltinTools(options: BuiltinToolsOptions): BuiltinTools;
export function createBuiltinTools(
  arg: string | BuiltinToolsOptions,
  schedulerOptions?: SchedulerToolsOptions,
): BuiltinTools {
  const opts: BuiltinToolsOptions = typeof arg === "string"
    ? { workspaceRoot: arg, schedulerOptions }
    : arg;

  const shellTool = createShellTool(opts.workspaceRoot);
  const contentStore = opts.contentStore ?? new ContentStore(opts.workspaceRoot, {
    embeddingProvider: opts.embeddingProvider,
  });
  const tools: Tool[] = [
    createReadFileTool(opts.workspaceRoot, { contentStore }),
    createWriteFileTool(opts.workspaceRoot),
    shellTool,
    createWebSearchTool({ llmProvider: opts.summarizerProvider }),
    createWebFetchTool({ llmProvider: opts.summarizerProvider, contentStore }),
    createReadContentRefTool({ contentStore }),
    createSearchContentRefTool({ contentStore, embeddingProvider: opts.embeddingProvider }),
  ];

  if (opts.schedulerOptions?.cronContext) {
    tools.push(createCronTool(opts.schedulerOptions.cronContext));
  }
  if (opts.schedulerOptions?.watcherContext) {
    tools.push(createWatcherTool(opts.schedulerOptions.watcherContext));
  }

  return {
    all: tools,
    shellTool,
  };
}
