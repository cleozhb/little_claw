export type AgentRunMode = "chat" | "team_worker" | "coordinator" | "agent_dm";
export type ContextMode = "auto" | "always" | "project" | "off";
export type MemoryLoadMode = "none" | "full_budgeted" | "retrieved_only";

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
  memoryLoadMode: MemoryLoadMode;
  memoryFileTokenBudget: number;
  inboxTokenBudget: number;
}

type BaseContextPolicy = Omit<
  ContextPolicy,
  "memoryLoadMode" | "memoryFileTokenBudget" | "inboxTokenBudget"
>;

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

const CONTEXT_HUB_INTENT_PATTERNS = [
  /context[-\s_]?hub/i,
  /\bproject(s)?\b/i,
  /上下文/,
  /项目/,
  /资料库/,
  /知识库/,
];

const MEMORY_RECALL_INTENT_PATTERNS = [
  /\bmemory\b/i,
  /\binbox\b/i,
  /\bprevious\b/i,
  /\bearlier\b/i,
  /\bremember\b/i,
  /\brecall\b/i,
  /记忆/,
  /收件箱/,
  /之前/,
  /上次/,
  /记得/,
  /回忆/,
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
  const base = buildBaseContextPolicy(input);
  if (input.contextMode === "off") {
    return { ...base, memoryLoadMode: "none", memoryFileTokenBudget: 0, inboxTokenBudget: 0 };
  }
  const projectScoped = input.hasProjectContext || input.runMode === "team_worker" ||
    input.contextMode === "project";
  return {
    ...base,
    memoryLoadMode: projectScoped ? "retrieved_only" : "full_budgeted",
    memoryFileTokenBudget: projectScoped ? 1_500 : 4_000,
    inboxTokenBudget: base.loadInbox ? 1_000 : 0,
  };
}

function buildBaseContextPolicy(input: ContextPolicyInput): BaseContextPolicy {
  const message = input.userMessage.trim();
  const hasContextIntent = CONTEXT_INTENT_PATTERNS.some((pattern) => pattern.test(message));
  const hasContextHubIntent = CONTEXT_HUB_INTENT_PATTERNS.some((pattern) => pattern.test(message));
  const hasMemoryRecallIntent = MEMORY_RECALL_INTENT_PATTERNS.some((pattern) => pattern.test(message));
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
    if (input.contextMode === "always" && !input.hasProjectContext) {
      return {
        runMode: input.runMode,
        contextMode: input.contextMode,
        loadIdentity: true,
        loadInbox: true,
        loadContextMap: true,
        retrieveContextOverviews: true,
        loadProjectOverview: false,
        retrieveLongTermMemory: true,
        useFullMemoryGuidance: true,
        memoryRecallTopK: 5,
        contextOverviewTopK: 3,
        skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
        skillSummaryLimit: 0,
        reason: "projectless team worker uses broad context",
      };
    }

    return {
      runMode: input.runMode,
      contextMode: input.contextMode,
      loadIdentity: input.hasProjectContext,
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
      loadIdentity: input.hasProjectContext,
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
      loadIdentity: true,
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

  const recallTopK = hasMemoryRecallIntent || hasContextHubIntent ? 5 : looksLikeKnowledgeOrRoleplay ? 1 : 2;

  return {
    runMode: input.runMode,
    contextMode: input.contextMode,
    loadIdentity: true,
    loadInbox: hasMemoryRecallIntent,
    loadContextMap: hasContextHubIntent,
    retrieveContextOverviews: hasContextHubIntent,
    loadProjectOverview: input.hasProjectContext,
    retrieveLongTermMemory: recallTopK > 0,
    useFullMemoryGuidance: hasMemoryRecallIntent || hasContextHubIntent,
    memoryRecallTopK: recallTopK,
    contextOverviewTopK: hasContextHubIntent ? 2 : 0,
    skillFullLimit: input.hasConfiguredSkills ? Number.POSITIVE_INFINITY : 1,
    skillSummaryLimit: 0,
    reason: hasContextHubIntent
      ? "context hub intent detected"
      : hasMemoryRecallIntent
        ? "memory recall intent detected"
      : "auto mode kept context lightweight",
  };
}
