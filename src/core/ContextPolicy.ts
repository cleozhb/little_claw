export type AgentRunMode = "chat" | "team_worker" | "coordinator" | "agent_dm";
export type ContextMode = "auto" | "always" | "project" | "off";

export interface ContextPolicyInput {
  userMessage: string;
  runMode: AgentRunMode;
  contextMode: ContextMode;
  hasProjectContext: boolean;
  hasConfiguredSkills: boolean;
}

export interface ContextPolicy {
  runMode: AgentRunMode;
  contextMode: ContextMode;
  loadIdentity: boolean;
  loadInbox: boolean;
  loadContextMap: boolean;
  retrieveContextOverviews: boolean;
  loadProjectOverview: boolean;
  retrieveLongTermMemory: boolean;
  useFullMemoryGuidance: boolean;
  memoryRecallTopK: number;
  contextOverviewTopK: number;
  skillFullLimit: number;
  skillSummaryLimit: number;
  reason: string;
}

const CONTEXT_INTENT_PATTERNS = [
  /context[-\s_]?hub/i,
  /\bmemory\b/i,
  /\binbox\b/i,
  /\bproject(s)?\b/i,
  /\bprevious\b/i,
  /\bearlier\b/i,
  /\bremember\b/i,
  /\brecall\b/i,
  /上下文/,
  /记忆/,
  /项目/,
  /收件箱/,
  /之前/,
  /上次/,
  /记得/,
  /回忆/,
  /资料库/,
];

const LIGHTWEIGHT_KNOWLEDGE_PATTERNS = [
  /^假如你是/,
  /^如果你是/,
  /解释一下/,
  /讲一下/,
  /说明一下/,
  /原理/,
  /\bexplain\b/i,
  /\bhow does\b/i,
  /\bwhat is\b/i,
  /\bpretend\b/i,
  /\bas .* explain\b/i,
];

export function buildContextPolicy(input: ContextPolicyInput): ContextPolicy {
  const message = input.userMessage.trim();
  const hasContextIntent = CONTEXT_INTENT_PATTERNS.some((pattern) => pattern.test(message));
  const looksLikeKnowledgeOrRoleplay = LIGHTWEIGHT_KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(message));

  if (input.contextMode === "off") {
    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: false,
      loadInbox: false,
      loadContextMap: false,
      retrieveContextOverviews: false,
      loadProjectOverview: false,
      retrieveLongTermMemory: false,
      useFullMemoryGuidance: false,
      memoryRecallTopK: 0,
      contextOverviewTopK: 0,
      skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
      skillSummaryLimit: 0,
      reason: "context mode is off",
    };
  }

  if (input.runMode === "team_worker") {
    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: false,
      loadInbox: false,
      loadContextMap: input.contextMode === "always",
      retrieveContextOverviews: false,
      loadProjectOverview: input.hasProjectContext,
      retrieveLongTermMemory: true,
      useFullMemoryGuidance: true,
      memoryRecallTopK: 3,
      contextOverviewTopK: 0,
      skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
      skillSummaryLimit: 0,
      reason: "team worker uses task/project-scoped context",
    };
  }

  if (input.runMode === "coordinator") {
    const loadMap = input.contextMode === "always" || input.contextMode === "auto";
    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: false,
      loadInbox: false,
      loadContextMap: loadMap,
      retrieveContextOverviews: input.contextMode === "always" || hasContextIntent,
      loadProjectOverview: input.hasProjectContext,
      retrieveLongTermMemory: true,
      useFullMemoryGuidance: loadMap || hasContextIntent,
      memoryRecallTopK: 2,
      contextOverviewTopK: hasContextIntent ? 2 : 1,
      skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
      skillSummaryLimit: 0,
      reason: "coordinator needs lightweight routing context",
    };
  }

  if (input.contextMode === "always") {
    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: true,
      loadInbox: true,
      loadContextMap: true,
      retrieveContextOverviews: true,
      loadProjectOverview: input.hasProjectContext,
      retrieveLongTermMemory: true,
      useFullMemoryGuidance: true,
      memoryRecallTopK: 5,
      contextOverviewTopK: 2,
      skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
      skillSummaryLimit: 1,
      reason: "context mode is always",
    };
  }

  if (input.contextMode === "project") {
    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: false,
      loadInbox: false,
      loadContextMap: false,
      retrieveContextOverviews: false,
      loadProjectOverview: input.hasProjectContext,
      retrieveLongTermMemory: true,
      useFullMemoryGuidance: true,
      memoryRecallTopK: 3,
      contextOverviewTopK: 0,
      skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
      skillSummaryLimit: 0,
      reason: "project context mode",
    };
  }

  const loadPersonalContext = hasContextIntent;
  const recallTopK = hasContextIntent ? 5 : looksLikeKnowledgeOrRoleplay ? 1 : 2;

  return {
    runMode: input.runMode,
    contextMode: input.contextMode,
    loadIdentity: loadPersonalContext,
    loadInbox: loadPersonalContext,
    loadContextMap: loadPersonalContext,
    retrieveContextOverviews: loadPersonalContext,
    loadProjectOverview: input.hasProjectContext && loadPersonalContext,
    retrieveLongTermMemory: recallTopK > 0,
    useFullMemoryGuidance: loadPersonalContext,
    memoryRecallTopK: recallTopK,
    contextOverviewTopK: loadPersonalContext ? 2 : 0,
    skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
    skillSummaryLimit: 0,
    reason: loadPersonalContext
      ? "context intent detected"
      : "auto mode kept context lightweight",
  };
}
