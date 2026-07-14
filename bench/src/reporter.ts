/**
 * Aggregate per-condition results jsonl into summary tables (markdown + CSV).
 *
 * Adapted from flutter-axi's bench reporter: runs graded `not_applicable`
 * (ref-layer tasks under sentry-mcp) are excluded from success rates and
 * averages, and reported as N/A — so the headline comparison is never padded
 * by tasks a condition structurally cannot attempt.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult, ConditionId, ConditionSummary } from "./types.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function loadResults(): RunResult[] {
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const results: RunResult[] = [];
  for (const file of files) {
    const raw = readFileSync(join(RESULTS_DIR, file), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      results.push(JSON.parse(line) as RunResult);
    }
  }
  return results;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function isNa(r: RunResult): boolean {
  return r.grade.failure_reason === "not_applicable";
}

export function summarize(results?: RunResult[]): ConditionSummary[] {
  const all = results ?? loadResults();
  if (all.length === 0) return [];

  const byCondition = groupBy(all, (r) => r.condition);
  const summaries: ConditionSummary[] = [];

  for (const [condId, allRuns] of byCondition) {
    const naCount = allRuns.filter(isNa).length;
    const runs = allRuns.filter((r) => !isNa(r));
    const successes = runs.filter((r) => r.grade.task_success).length;
    summaries.push({
      condition: condId as ConditionId,
      name: condId,
      total_tasks: runs.length,
      not_applicable: naCount,
      success_rate: runs.length > 0 ? successes / runs.length : 0,
      avg_input_tokens: Math.round(mean(runs.map((r) => r.usage.input_tokens))),
      avg_cached_pct: mean(
        runs.map((r) =>
          r.usage.input_tokens > 0
            ? r.usage.input_tokens_cached / r.usage.input_tokens
            : 0,
        ),
      ),
      avg_output_tokens: Math.round(mean(runs.map((r) => r.usage.output_tokens))),
      avg_cost_usd: mean(runs.map((r) => r.usage.total_cost_usd)),
      total_cost_usd: sum(runs.map((r) => r.usage.total_cost_usd)),
      avg_duration_seconds: mean(runs.map((r) => r.usage.wall_clock_seconds)),
      avg_turns: parseFloat(mean(runs.map((r) => r.usage.turn_count)).toFixed(1)),
    });
  }

  return summaries;
}

export function markdownReport(results?: RunResult[]): string {
  const all = results ?? loadResults();
  if (all.length === 0) return "No results found.\n";

  const summaries = summarize(all);
  const lines: string[] = [];

  lines.push("# Sentry Triage Benchmark Results\n");
  lines.push("## Summary\n");
  lines.push(
    "| Condition | Tasks | N/A | Avg Input Tokens | Cache% | Avg Output Tokens | Avg Cost | Total Cost | Avg Duration | Avg Turns | Success% |",
  );
  lines.push(
    "|-----------|-------|-----|-----------------|--------|-------------------|----------|------------|-------------|-----------|----------|",
  );
  for (const s of summaries) {
    lines.push(
      `| ${s.condition} | ${s.total_tasks} | ${s.not_applicable} | ${s.avg_input_tokens} | ${(s.avg_cached_pct * 100).toFixed(0)}% | ${s.avg_output_tokens} | $${s.avg_cost_usd.toFixed(4)} | $${s.total_cost_usd.toFixed(2)} | ${s.avg_duration_seconds.toFixed(1)}s | ${s.avg_turns} | ${(s.success_rate * 100).toFixed(0)}% |`,
    );
  }

  // Methodology
  lines.push("\n## Methodology\n");
  const graded = all.filter((r) => !isNa(r));
  const models = [...new Set(graded.map((r) => r.model))];
  const judgeModels = [...new Set(graded.map((r) => r.grade.judge_model).filter(Boolean))];
  const runsPerTask = graded.length > 0
    ? Math.round(graded.length / (new Set(graded.map((r) => `${r.condition}:${r.task}`)).size))
    : 0;
  lines.push(`- **Agent model**: ${models.join(", ") || "unknown"}`);
  lines.push(`- **Judge model**: ${judgeModels.join(", ") || "claude-sonnet-4-6"}`);
  lines.push(`- **Repeats per task**: ${runsPerTask}`);
  lines.push("- **Execution**: Sequential with randomized condition/task order");
  lines.push("- **Isolation**: Fresh sentry-axi session per run (pinned scope, generation counter and refs reaped after each run); the Sentry MCP server is a remote endpoint the agent process connects to per run");
  lines.push("- **Fixture**: A dedicated throwaway Sentry project seeded with a deterministic set of errors (`bench/scripts/setup-fixture.sh`)");
  lines.push("");
  lines.push("### Known Limitations\n");
  lines.push("- Mutating tasks (`resolve`, `assign`) write to real Sentry. The runner snapshots issue status/assignee before each mutating run and restores it afterwards, so every repeat starts from the same state - but the restore is an API write, not a database rollback, and Sentry records the activity");
  lines.push("- Ref-layer tasks (generation-stamped `@g1:N` handles, pinned session scope) have no equivalent in the stateless Sentry MCP and are reported N/A, not failed - success rates exclude them");
  lines.push("- The Sentry MCP server is remote (mcp.sentry.dev): its latency includes network round-trips to Sentry's hosted MCP, while sentry-axi calls the Sentry REST API directly. Duration comparisons include this difference");
  lines.push("- MCP tool schemas consume input tokens up front - cost comparisons reflect total API cost including schema overhead");
  lines.push("- Event counts in the fixture project drift as Sentry ages out data; re-seed before a matrix run for the grading hints to stay exact");
  lines.push("");

  // Failure analysis
  const failures = graded.filter((r) => !r.grade.task_success);
  if (failures.length > 0) {
    lines.push("### Failure Analysis\n");
    const byReason = groupBy(
      failures,
      (r) => (r.grade.failure_reason as string) ?? "unknown",
    );
    lines.push("| Failure Type | Count |");
    lines.push("|-------------|-------|");
    for (const [reason, runs] of byReason) {
      lines.push(`| ${reason} | ${runs.length} |`);
    }
    lines.push("");
  }

  // Per-task breakdown
  lines.push("\n## Per-Task Breakdown\n");
  const byTask = groupBy(all, (r) => r.task);

  for (const [taskId, taskRuns] of byTask) {
    lines.push(`### ${taskId}\n`);
    lines.push("| Condition | Avg Input Tokens | Cache% | Avg Output Tokens | Avg Cost | Total Cost | Avg Duration | Avg Turns | Success |");
    lines.push("|-----------|-----------------|--------|-------------------|----------|------------|-------------|-----------|---------|");

    const byCondInTask = groupBy(taskRuns, (r) => r.condition);
    for (const [cond, allCondRuns] of byCondInTask) {
      const condRuns = allCondRuns.filter((r) => !isNa(r));
      if (condRuns.length === 0) {
        lines.push(`| ${cond} | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |`);
        continue;
      }
      const suc = condRuns.filter((r) => r.grade.task_success).length;
      const avgCachePct = mean(
        condRuns.map((r) =>
          r.usage.input_tokens > 0
            ? r.usage.input_tokens_cached / r.usage.input_tokens
            : 0,
        ),
      );
      lines.push(
        `| ${cond} | ${Math.round(mean(condRuns.map((r) => r.usage.input_tokens)))} | ${(avgCachePct * 100).toFixed(0)}% | ${Math.round(mean(condRuns.map((r) => r.usage.output_tokens)))} | $${mean(condRuns.map((r) => r.usage.total_cost_usd)).toFixed(4)} | $${sum(condRuns.map((r) => r.usage.total_cost_usd)).toFixed(4)} | ${mean(condRuns.map((r) => r.usage.wall_clock_seconds)).toFixed(1)}s | ${mean(condRuns.map((r) => r.usage.turn_count)).toFixed(1)} | ${suc}/${condRuns.length} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

export function csvReport(results?: RunResult[]): string {
  const all = results ?? loadResults();
  if (all.length === 0) return "";

  const headers = [
    "condition", "task", "run", "model", "timestamp",
    "success", "not_applicable", "input_tokens", "input_tokens_cached", "output_tokens",
    "reasoning_tokens", "total_cost_usd", "wall_clock_seconds",
    "turn_count", "command_count", "error_count",
  ];
  const lines = [headers.join(",")];

  for (const r of all) {
    lines.push(
      [
        r.condition, r.task, r.run, r.model, r.timestamp,
        r.grade.task_success, isNa(r), r.usage.input_tokens, r.usage.input_tokens_cached,
        r.usage.output_tokens, r.usage.reasoning_tokens, r.usage.total_cost_usd,
        r.usage.wall_clock_seconds, r.usage.turn_count, r.usage.command_count,
        r.usage.error_count,
      ].join(","),
    );
  }

  return lines.join("\n") + "\n";
}

export function writeReports(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const md = markdownReport();
  const csv = csvReport();
  writeFileSync(join(RESULTS_DIR, "report.md"), md);
  writeFileSync(join(RESULTS_DIR, "report.csv"), csv);
  console.log(md);
  console.log(`Reports written to results/report.md and results/report.csv`);
}
