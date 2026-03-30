import type { Tool, ToolResult } from "../tools/types.ts";
import type { McpClient } from "./McpClient.ts";

export async function createToolsFromMcp(
  client: McpClient,
  serverName: string
): Promise<Tool[]> {
  const mcpTools = await client.listTools();

  return mcpTools.map((t) => ({
    name: `mcp.${serverName}.${t.name}`,
    description: t.description,
    parameters: t.inputSchema,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const output = await client.callTool(t.name, params);
        return { success: true, output };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }));
}
