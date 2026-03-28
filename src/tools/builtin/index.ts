import type { Tool } from "../types.ts";
import { createReadFileTool } from "./ReadFileTool.ts";
import { createWriteFileTool } from "./WriteFileTool.ts";
import { createShellTool } from "./ShellTool.ts";

export { createReadFileTool, createWriteFileTool, createShellTool };

export function createBuiltinTools(workspaceRoot: string): Tool[] {
  return [
    createReadFileTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    createShellTool(workspaceRoot),
  ];
}
