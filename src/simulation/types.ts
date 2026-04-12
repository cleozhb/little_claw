// --- Persona ---

export interface PersonaFrontmatter {
  name: string;
  role: string;
  emoji: string;
  tags: string[];
  /** 关联的 Skill 名称（对应 ~/.little_claw/skills/<skill>/SKILL.md） */
  skill?: string;
}

export interface ParsedPersona {
  name: string;
  role: string;
  emoji: string;
  tags: string[];
  /** 该 Persona 可用的工具名列表（如 ["read_file", "write_file", "shell"]），为空表示纯对话 */
  tools: string[];
  /** 关联的 Skill 名称（对应 ~/.little_claw/skills/<skill>/SKILL.md） */
  skill?: string;
  /** Markdown body（Identity, Values, Knowledge, Behavioral tendencies, Communication style 等章节） */
  body: string;
  /** 原始 .md 文件完整内容（含 frontmatter），用于编辑回显 */
  rawContent: string;
  /** .md 文件的绝对路径 */
  sourcePath: string;
}

// --- Scenario ---

export type SimulationMode =
  | "roundtable"
  | "parallel"
  | "parallel_then_roundtable"
  | "free";

export type ResponseStyle = "conversational" | "formal" | "rapid";

export interface ScenarioPersonas {
  /** 必选的 persona 文件名（不含 .md 后缀） */
  required: string[];
  /** 推荐的 persona 文件名（不含 .md 后缀） */
  optional: string[];
  /** 最大参与人数 */
  max?: number;
}

export interface ScenarioFrontmatter {
  name: string;
  description: string;
  mode: SimulationMode;
  rounds?: number;
  personas?: ScenarioPersonas;
  parallel_prompt: string;
  roundtable_prompt: string;
  language: string;
  world_update_prompt?: string;
  completion_hint?: string;
  response_style?: ResponseStyle;
}

export interface ParsedScenario {
  name: string;
  description: string;
  mode: SimulationMode;
  /** 建议轮数（可选）。不设则为无限轮，由用户手动结束 */
  rounds?: number;
  /** persona 配置：required / optional / max */
  personas?: ScenarioPersonas;
  parallelPrompt: string;
  roundtablePrompt: string;
  /** 输出语言，如 "zh-CN"、"en" 等，为空则不限制 */
  language: string;
  /** 每轮结束后 World LLM 更新世界状态的 prompt（free 模式使用） */
  worldUpdatePrompt?: string;
  /** 完成条件提示，追加到 SIMULATION RULES 末尾，指导 Agent 何时可以标记 [DONE] */
  completionHint?: string;
  /** 发言风格：conversational（默认）、formal、rapid */
  responseStyle?: ResponseStyle;
  /** Markdown body（Environment, Constraints, Trigger event 等章节） */
  body: string;
  /** 原始 .md 文件完整内容（含 frontmatter），用于编辑回显 */
  rawContent: string;
  /** .md 文件的绝对路径 */
  sourcePath: string;
}

// --- ArgumentNode ---

export interface ArgumentNode {
  topic: string;
  description: string;
  supporters: string[];
  opposers: string[];
  consensusLevel: number;
  status: "consensus" | "conflict" | "open";
}

// --- SimulationEvent ---

export type SimulationEvent =
  | SimStartEvent
  | RoundStartEvent
  | PersonaStartEvent
  | PersonaTextDeltaEvent
  | PersonaThinkingEvent
  | PersonaDoneEvent
  | PersonaToolCallEvent
  | PersonaToolResultEvent
  | RoundEndEvent
  | RoundEndWaitingEvent
  | UserSpokeEvent
  | ArgumentUpdateEvent
  | WorldStateUpdateEvent
  | SpeakerSelectedEvent
  | SimEndEvent;

export interface SimStartEvent {
  type: "sim_start";
  simId: string;
  scenario: string;
  personas: string[];
}

export interface RoundStartEvent {
  type: "round_start";
  simId: string;
  round: number;
  mode: "parallel" | "roundtable" | "free";
}

export interface PersonaStartEvent {
  type: "persona_start";
  simId: string;
  persona: string;
  emoji: string;
}

export interface PersonaTextDeltaEvent {
  type: "persona_text_delta";
  simId: string;
  persona: string;
  text: string;
}

export interface PersonaThinkingEvent {
  type: "persona_thinking";
  simId: string;
  persona: string;
  thinking: string;
}

export interface PersonaDoneEvent {
  type: "persona_done";
  simId: string;
  persona: string;
  fullResponse: string;
}

export interface RoundEndEvent {
  type: "round_end";
  simId: string;
  round: number;
}

export interface RoundEndWaitingEvent {
  type: "round_end_waiting";
  simId: string;
  round: number;
}

export interface UserSpokeEvent {
  type: "user_spoke";
  simId: string;
  content: string;
}

export interface ArgumentUpdateEvent {
  type: "argument_update";
  simId: string;
  arguments: ArgumentNode[];
}

export interface PersonaToolCallEvent {
  type: "persona_tool_call";
  simId: string;
  persona: string;
  toolName: string;
  params: Record<string, unknown>;
}

export interface PersonaToolResultEvent {
  type: "persona_tool_result";
  simId: string;
  persona: string;
  toolName: string;
  result: string;
}

export interface WorldStateUpdateEvent {
  type: "world_state_update";
  simId: string;
  worldState: string;
  changes?: string;
}

export interface SpeakerSelectedEvent {
  type: "speaker_selected";
  simId: string;
  persona: string;
  reason: string;
}

export interface SimEndEvent {
  type: "sim_end";
  simId: string;
  summary: string;
}
