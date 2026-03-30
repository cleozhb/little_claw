import type { Tool } from "../types.ts";
import type { ShellTool } from "../types.ts";
import { createReadFileTool } from "./ReadFileTool.ts";
import { createWriteFileTool } from "./WriteFileTool.ts";
import { createShellTool } from "./ShellTool.ts";

export { createReadFileTool, createWriteFileTool, createShellTool };

export interface BuiltinTools {
  all: Tool[];
  shellTool: ShellTool;
}

export function createBuiltinTools(workspaceRoot: string): BuiltinTools {
  const shellTool = createShellTool(workspaceRoot);
  return {
    all: [
      createReadFileTool(workspaceRoot),
      createWriteFileTool(workspaceRoot),
      shellTool,
    ],
    shellTool,
  };
}
