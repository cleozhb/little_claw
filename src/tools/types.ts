export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

/** ShellTool 扩展接口，支持注入额外环境变量 */
export interface ShellTool extends Tool {
  setExtraEnv(env: Record<string, string>): void;
}
