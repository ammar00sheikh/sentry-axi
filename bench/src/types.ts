/** Shared interfaces for the Sentry triage benchmark harness. */

export type ConditionId = "sentry-axi" | "sentry-mcp";
export type TaskCategory =
  | "single_step"
  | "multi_step"
  | "investigation"
  | "mutating"
  | "refs";

export interface GradingSpec {
  /** Optional hint for the judge about what to look for. */
  grading_hint?: string;
}

export interface TaskDef {
  id: string;
  category: TaskCategory;
  prompt: string;
  grading: GradingSpec;
  /**
   * True when the task writes back to Sentry (resolve/ignore/assign). The
   * runner snapshots the bench project's issue state before the run and
   * restores it afterwards, so repeats of a mutating task all start from the
   * same state instead of the second repeat finding the work already done.
   */
  mutating?: boolean;
  /**
   * Conditions this task can run under. Unset = all. Ref-layer tasks
   * (generation-stamped `@g1:N` handles, pinned session scope) have no
   * equivalent in the stateless Sentry MCP - they are recorded as
   * not_applicable for excluded conditions rather than failed, so headline
   * numbers stay honest.
   */
  applicable_conditions?: ConditionId[];
}

export interface ConditionDef {
  id: ConditionId;
  name: string;
  tool: string;
  agents_md: string;
  /** Daemon management mode: "explicit" (start/stop commands) or "none" (MCP-managed). */
  daemon: "explicit" | "none";
  /** Explicit daemon start command. */
  daemon_start?: string;
  /** Explicit daemon stop command. */
  daemon_stop?: string;
  /** MCP server config for MCP conditions. */
  mcp_config?: { mcpServers: Record<string, unknown> };
  /** Optional Bash command policy for validating that the intended tool was used. */
  command_policy?: {
    require_any_prefix?: string[];
    forbid_any_prefix?: string[];
    forbid_substrings?: string[];
  };
}

/** Org/project the benchmark runs against — always the throwaway bench project. */
export interface BenchTarget {
  org: string;
  project: string;
}

export interface RunSpec {
  condition: ConditionId;
  task: string;
  run: number;
  model: string;
}

export interface UsageMetrics {
  input_tokens: number;
  input_tokens_cached: number;
  input_tokens_uncached: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  wall_clock_seconds: number;
  turn_count: number;
  command_count: number;
  error_count: number;
  command_log: string[];
}

export interface GradeResult {
  task_success: boolean;
  details: string;
  /** Classification of failure cause. */
  failure_reason?:
    | "judge_error"
    | "judge_parse_error"
    | "policy_violation"
    | "task_failure"
    | "not_applicable";
  /** Which model was used to grade this run. */
  judge_model?: string;
}

export interface RunResult {
  condition: ConditionId;
  task: string;
  run: number;
  model: string;
  timestamp: string;
  usage: UsageMetrics;
  grade: GradeResult;
  agent_output: string;
}

export interface ConditionSummary {
  condition: ConditionId;
  name: string;
  total_tasks: number;
  /** Runs excluded from rates because the task does not apply to this condition. */
  not_applicable: number;
  success_rate: number;
  avg_input_tokens: number;
  avg_cached_pct: number;
  avg_output_tokens: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  avg_duration_seconds: number;
  avg_turns: number;
}
