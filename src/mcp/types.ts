// ============================================================
// JSON-RPC 2.0 基础类型
// ============================================================

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ============================================================
// MCP 协议核心方法 — 参数 & 返回类型
// ============================================================

// --- initialize ---

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: Record<string, unknown>;
}

// --- tools/list ---

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolsListResult {
  tools: McpToolInfo[];
}

// --- tools/call ---

export interface ToolsCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolsCallResult {
  content: TextContent[];
}

// ============================================================
// MCP Server 配置
// ============================================================

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
