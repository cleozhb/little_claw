/**
 * Agent 角色配置体系
 * 定义 Agent 的角色类型和配置结构，支持 Main Agent 与 Sub-Agent 的差异化配置。
 */

export interface AgentConfig {
  /** 角色标识，如 "main"、"coder"、"planner"、"researcher" */
  name: string;
  /** 角色专属的 system prompt */
  systemPrompt: string;
  /** 允许使用的工具名列表。空数组表示可以用所有工具（main agent 的默认行为） */
  allowedTools: string[];
  /** 最大 ReAct 循环次数，Sub-Agent 一般比 Main Agent 小，默认 10 */
  maxTurns: number;
  /** 是否可以再派生 Sub-Agent，防止无限递归。Sub-Agent 默认 false */
  canSpawnSubAgent: boolean;
}

/** 创建 AgentConfig 的便捷函数，提供合理默认值 */
export function createAgentConfig(
  partial: Partial<AgentConfig> & Pick<AgentConfig, "name" | "systemPrompt">,
): AgentConfig {
  return {
    allowedTools: [],
    maxTurns: 10,
    canSpawnSubAgent: false,
    ...partial,
  };
}
