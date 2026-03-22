import type { Tool } from "../types.ts";
import { ReadFileTool } from "./ReadFileTool.ts";
import { WriteFileTool } from "./WriteFileTool.ts";
import { ShellTool } from "./ShellTool.ts";

export { ReadFileTool, WriteFileTool, ShellTool };

export function createBuiltinTools(): Tool[] {
  return [ReadFileTool, WriteFileTool, ShellTool];
}
