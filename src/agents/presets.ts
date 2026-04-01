import { createAgentConfig, type AgentConfig } from "./AgentConfig.ts";

export const MAIN_AGENT = createAgentConfig({
  name: "main",
  systemPrompt:
    "You can delegate complex tasks to specialized sub-agents using the spawn_agent tool. Use this when a task requires focused expertise or when you want parallel work.\n\nIMPORTANT: For simple or straightforward tasks, handle them directly yourself instead of delegating to a sub-agent. Only spawn sub-agents for tasks that genuinely require multiple steps or specialized focus. Be concise — once the task is done, provide the result and stop.",
  allowedTools: [],
  maxTurns: 25,
  canSpawnSubAgent: true,
});

export const CODER_AGENT = createAgentConfig({
  name: "coder",
  systemPrompt:
    "You are a coding specialist. Your job is to implement, modify, or fix code based on the task description. Focus on writing clean, working code. Use the available tools to read existing code, write new code, and run tests.",
  allowedTools: ["read_file", "write_file", "shell"],
  maxTurns: 15,
  canSpawnSubAgent: false,
});

export const PLANNER_AGENT = createAgentConfig({
  name: "planner",
  systemPrompt:
    "You are a planning specialist. Your job is to analyze a task and produce a clear, actionable plan.\nIMPORTANT output rules:\n- Keep your plan under 1500 characters\n- Use numbered steps, one line per step\n- Each step should be a concrete action, not a detailed explanation\n- Do NOT include code examples, implementation details, or lengthy explanations\n- Focus on WHAT to do, not HOW to do it — the coder agent will handle implementation\n- If the task is simple enough to be done in 3 steps, use 3 steps. Do not over-plan.\n\nYou can read files and run commands to understand the current state, but you must NOT modify any files.",
  allowedTools: ["read_file", "shell"],
  maxTurns: 10,
  canSpawnSubAgent: false,
});

export const RESEARCHER_AGENT = createAgentConfig({
  name: "researcher",
  systemPrompt:
    "You are a research specialist. Your job is to gather information about a topic using available tools. Search the web, read files, and compile your findings into a clear summary.",
  allowedTools: ["shell", "read_file"],
  maxTurns: 10,
  canSpawnSubAgent: false,
});

/** 预设配置表 */
const PRESET_MAP: Record<string, AgentConfig> = {
  main: MAIN_AGENT,
  coder: CODER_AGENT,
  planner: PLANNER_AGENT,
  researcher: RESEARCHER_AGENT,
};

/** 获取所有预设 Agent 配置 */
export function getAllAgentConfigs(): AgentConfig[] {
  return Object.values(PRESET_MAP);
}

/**
 * 按名称获取预设 Agent 配置。
 * 未知名称返回一个通用配置（allowedTools 为空即全部可用，maxTurns=10，不可派生子 Agent）。
 */
export function getAgentConfig(name: string): AgentConfig {
  return (
    PRESET_MAP[name] ??
    createAgentConfig({
      name,
      systemPrompt: `You are a helpful assistant named "${name}". Complete the given task using available tools.`,
    })
  );
}
