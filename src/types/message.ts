// --- Content Blocks ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// --- Messages ---

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
}

export interface ToolResultMessage {
  role: "user";
  content: Array<ToolResultBlock>;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

// --- Stream Events ---

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
}

export interface ToolUseDeltaEvent {
  type: "tool_use_delta";
  input_json: string;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
}

export interface MessageEndEvent {
  type: "message_end";
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseEndEvent
  | MessageEndEvent;

// --- Agent Events ---

import type { ToolResult } from "../tools/types.ts";

export interface AgentTextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface AgentToolCallEvent {
  type: "tool_call";
  name: string;
  params: Record<string, unknown>;
}

export interface AgentToolResultEvent {
  type: "tool_result";
  name: string;
  result: ToolResult;
}

export interface AgentDoneEvent {
  type: "done";
  usage: { totalInputTokens: number; totalOutputTokens: number };
}

export interface AgentErrorEvent {
  type: "error";
  message: string;
}

export interface SubAgentStartEvent {
  type: "sub_agent_start";
  agentName: string;
  task: string;
}

export interface SubAgentProgressEvent {
  type: "sub_agent_progress";
  agentName: string;
  event: AgentEvent;
}

export interface SubAgentDoneEvent {
  type: "sub_agent_done";
  agentName: string;
  result: string;
}

export type AgentEvent =
  | AgentTextDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | SubAgentStartEvent
  | SubAgentProgressEvent
  | SubAgentDoneEvent;
