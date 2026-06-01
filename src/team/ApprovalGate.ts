/**
 * Pre-execute approval gate — checks tool calls against configured rules
 * before execution. Pure functions, no side effects.
 */

export interface ApprovalRule {
  /** 要拦截的工具名 */
  tool: string;
  /** 匹配模式（正则字符串）。一行式时由 glob 转换而来，object 式直接为正则 */
  pattern?: string;
  /** 匹配 params 中的哪个字段。默认: shell→"command", write_file→"file_path" */
  field?: string;
  /** 审批提示信息，展示给人类 */
  message?: string;
  /** 拦截行为，当前只支持 pause */
  action?: "pause" | "deny";
}

export interface ApprovalGateResult {
  action: "allow" | "pause";
  rule?: ApprovalRule;
  matchedValue?: string;
}

const FIELD_DEFAULTS: Record<string, string> = {
  shell: "command",
  write_file: "path",
  read_file: "path",
  context_write: "path",
};

/**
 * 检查一次工具调用是否命中审批规则。
 */
export function checkApprovalGate(
  rules: ApprovalRule[],
  toolName: string,
  params: Record<string, unknown>,
): ApprovalGateResult {
  for (const rule of rules) {
    if (rule.tool !== toolName) continue;

    // 无 pattern → 该工具所有调用都拦截
    if (!rule.pattern) {
      return { action: "pause", rule };
    }

    const target = resolveMatchTarget(toolName, params, rule.field);
    if (!target) continue;

    if (new RegExp(rule.pattern).test(target)) {
      return { action: "pause", rule, matchedValue: target };
    }
  }
  return { action: "allow" };
}

function resolveMatchTarget(
  toolName: string,
  params: Record<string, unknown>,
  field?: string,
): string | null {
  const key = field ?? FIELD_DEFAULTS[toolName];
  if (key) {
    const val = params[key];
    return typeof val === "string" ? val : null;
  }
  // 兜底：序列化整个 params
  return JSON.stringify(params);
}
