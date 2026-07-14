/**
 * Benchmark runner — executes Sentry triage tasks and grades results.
 *
 * Per RunSpec:
 * 1. Create artifact dir: results/{condition}/{task}/{runN}/
 * 2. Create workspace with condition-specific CLAUDE.md content
 * 3. Snapshot Sentry issue state if the task mutates it
 * 4. Run Claude agent with MCP isolation (--strict-mcp-config)
 * 5. Restore Sentry issue state (mutating tasks only)
 * 6. Parse JSONL output -> usage metrics
 * 7. Run grader -> grade.json
 * 8. Append to per-condition results jsonl
 *
 * Adapted from flutter-axi's bench runner. sentry-axi runs get an isolated
 * SENTRY_AXI_SESSION per run (its scope + generation counter + refs are reaped
 * afterwards) so no run inherits another's pinned scope or `@g1:N` handles;
 * tasks whose applicable_conditions exclude the condition are recorded as
 * not_applicable without spending an agent run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { BenchTarget, RunSpec, RunResult, ConditionDef, TaskDef } from "./types.js";
import { parseClaudeJsonl } from "./usage.js";
import { grade } from "./grader.js";
import { restoreIssueState, snapshotIssueState } from "./lifecycle.js";
import { validateCommandPolicy } from "./validation.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");

/** Seer analysis is the slow path (minutes); everything else is seconds. */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Everything a run needs to know about the Sentry side of the world. */
export interface RunContext {
  target: BenchTarget;
  /** Sentry username/email the assignment task assigns to. */
  assignee: string;
}

function makeSessionName(spec: Pick<RunSpec, "condition" | "task" | "run">): string {
  const raw = `bench-${spec.condition}-${spec.task}-run${spec.run}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/** Substitute task placeholders: bench org/project and the assignment target. */
export function renderPrompt(prompt: string, ctx: RunContext): string {
  return prompt
    .replaceAll("__ORG__", ctx.target.org)
    .replaceAll("__PROJECT__", ctx.target.project)
    .replaceAll("__ASSIGNEE__", ctx.assignee);
}

export function isApplicable(task: TaskDef, conditionId: string): boolean {
  return (
    !task.applicable_conditions ||
    task.applicable_conditions.includes(conditionId as TaskDef["applicable_conditions"] extends (infer T)[] | undefined ? T : never)
  );
}

/** Record a not-applicable cell without running the agent. */
export function recordNotApplicable(spec: RunSpec, task: TaskDef): RunResult {
  const result: RunResult = {
    condition: spec.condition,
    task: spec.task,
    run: spec.run,
    model: spec.model,
    timestamp: new Date().toISOString(),
    usage: {
      input_tokens: 0,
      input_tokens_cached: 0,
      input_tokens_uncached: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_cost_usd: 0,
      wall_clock_seconds: 0,
      turn_count: 0,
      command_count: 0,
      error_count: 0,
      command_log: [],
    },
    grade: {
      task_success: false,
      details: `Task ${task.id} does not apply to condition ${spec.condition} (ref-layer capability).`,
      failure_reason: "not_applicable",
    },
    agent_output: "",
  };
  upsertResult(result);
  return result;
}

export async function runOne(
  spec: RunSpec,
  condition: ConditionDef,
  task: TaskDef,
  ctx: RunContext,
): Promise<RunResult> {
  if (!isApplicable(task, spec.condition)) {
    return recordNotApplicable(spec, task);
  }

  // 1. Create artifact dir
  const artifactDir = join(RESULTS_DIR, spec.condition, spec.task, `run${spec.run}`);
  mkdirSync(artifactDir, { recursive: true });

  // 2. Set up workspace: a directory with CLAUDE.md (auditability only)
  const workspaceDir = join(artifactDir, "workspace");

  try {
    mkdirSync(workspaceDir, { recursive: true });
    const agentsMd = condition.agents_md;
    // Written for workspace auditability only — not read by Claude
    // (--setting-sources "" disables auto-discovery). Agent receives this
    // content via --append-system-prompt instead.
    writeFileSync(join(workspaceDir, "CLAUDE.md"), agentsMd);

    if (condition.mcp_config) {
      writeFileSync(
        join(artifactDir, ".mcp-config.json"),
        JSON.stringify(condition.mcp_config),
      );
    }

    // Empty MCP config for CLI conditions (used with --strict-mcp-config to
    // prevent the user's local MCP servers from leaking in)
    const emptyMcpConfigPath = join(artifactDir, ".empty-mcp-config.json");
    writeFileSync(emptyMcpConfigPath, JSON.stringify({ mcpServers: {} }));

    const prompt = renderPrompt(task.prompt, ctx);

    // 3. Snapshot the issue state a mutating task is about to change, so this
    //    run's repeats and every later task all start from the same fixture.
    const before = task.mutating ? await snapshotIssueState(ctx.target) : null;

    // 4. Run agent
    let agentOutput: string;
    let wallClockSeconds: number;
    try {
      ({ agentOutput, wallClockSeconds } = runAgent(
        spec,
        condition,
        prompt,
        artifactDir,
        workspaceDir,
        agentsMd,
      ));
    } finally {
      // Reap the run's sentry-axi session state (pinned scope, generation
      // counter, uid->issue refs). No-op for the MCP condition.
      if (condition.id === "sentry-axi") {
        reapSentryAxiSession(makeSessionName(spec));
      }
      // 5. Undo whatever the agent wrote back to Sentry. In `finally` because a
      //    timed-out or crashed agent can still have resolved an issue first.
      if (before) {
        const restored = await restoreIssueState(ctx.target, before);
        if (restored > 0) {
          console.log(`  [lifecycle] Restored ${restored} mutated issue(s) in ${ctx.target.org}/${ctx.target.project}`);
        }
      }
    }

    writeFileSync(join(artifactDir, "agent_output.txt"), agentOutput);

    // 6. Parse usage
    const usage = parseClaudeJsonl(agentOutput, { model: spec.model, wallClockSeconds });

    const finalOutput = extractClaudeFinalOutput(agentOutput);

    // 7. Grade — pass raw JSONL so the judge sees the full trajectory
    const usageValidationError = validateCommandPolicy(condition, usage.command_log, agentOutput);
    const gradeResult = usageValidationError
      ? {
          task_success: false,
          details: usageValidationError,
          failure_reason: "policy_violation" as const,
        }
      : grade(task.grading, prompt, agentOutput, artifactDir);
    writeFileSync(join(artifactDir, "grade.json"), JSON.stringify(gradeResult, null, 2));

    // 8. Build result
    const result: RunResult = {
      condition: spec.condition,
      task: spec.task,
      run: spec.run,
      model: spec.model,
      timestamp: new Date().toISOString(),
      usage,
      grade: gradeResult,
      agent_output: finalOutput.slice(0, 2000), // Truncate for JSONL
    };

    // 9. Upsert into per-condition results file
    upsertResult(result);

    return result;
  } finally {
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

function upsertResult(result: RunResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const conditionJsonl = join(RESULTS_DIR, `${result.condition}.jsonl`);
  if (existsSync(conditionJsonl)) {
    const kept = readFileSync(conditionJsonl, "utf-8")
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        try {
          const r = JSON.parse(l) as { task: string; run: number };
          return !(r.task === result.task && r.run === result.run);
        } catch { return true; }
      });
    writeFileSync(conditionJsonl, kept.length > 0 ? kept.join("\n") + "\n" : "");
  }
  appendFileSync(conditionJsonl, JSON.stringify(result) + "\n");
}

/** Extract the agent's final text output from Claude stream-json output. */
function extractClaudeFinalOutput(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "result" && typeof entry.result === "string") {
        return entry.result;
      }
      if (entry.type === "assistant") {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (msg && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              parts.push(b.text);
            }
          }
        }
      }
    } catch {
      continue;
    }
  }
  return parts.length > 0 ? parts.join("\n") : jsonl;
}

/** PATH with the bench shim first, so `sentry-axi` resolves for agents. */
export function benchPath(): string {
  return `${join(BENCH_ROOT, "bin")}:${process.env.PATH ?? ""}`;
}

/**
 * Delete a run's sentry-axi session state. sentry-axi has no daemon (Sentry is
 * a stateless HTTPS API), so a "session" is purely the on-disk scope +
 * generation counter + refs under ~/.sentry-axi/sessions/<name> — removing the
 * directory is the whole teardown.
 */
function reapSentryAxiSession(sessionName: string): void {
  const stateDir = join(homedir(), ".sentry-axi", "sessions", sessionName);
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // Session may never have been written to - fine.
  }
}

function runAgent(
  spec: RunSpec,
  condition: ConditionDef,
  prompt: string,
  artifactDir: string,
  workspaceDir: string,
  agentsMd: string,
): { agentOutput: string; wallClockSeconds: number } {
  const args: string[] = [
    "--setting-sources", "",
    "-p", prompt,
    "--model", spec.model,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--append-system-prompt", agentsMd,
    "--disable-slash-commands",
  ];

  // All conditions: disallow WebFetch/WebSearch so agents must use the
  // designated tool rather than hitting the Sentry web UI/API around it.
  const disallowedTools: string[] = ["WebFetch", "WebSearch"];

  if (condition.id === "sentry-mcp") {
    // MCP condition: tools loaded upfront into context (no ToolSearch),
    // mirroring flutter-axi's dart-mcp condition. No Bash at all — the raw MCP
    // server is the only way to reach Sentry.
    const mcpConfigPath = join(artifactDir, ".mcp-config.json");
    disallowedTools.push("ToolSearch");
    args.push(
      "--strict-mcp-config",
      "--mcp-config", mcpConfigPath,
      "--allowedTools", "Read,Write",
      "--disallowedTools", disallowedTools.join(","),
    );
  } else {
    // CLI condition: empty MCP config prevents local MCP servers leaking in.
    const emptyMcpConfigPath = join(artifactDir, ".empty-mcp-config.json");
    args.push(
      "--strict-mcp-config",
      "--mcp-config", emptyMcpConfigPath,
      "--allowedTools", "Bash,Read,Write",
      "--disallowedTools", disallowedTools.join(","),
    );
  }

  const startTime = Date.now();
  let agentOutput = "";
  try {
    agentOutput = execFileSync("claude", args, {
      encoding: "utf-8",
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Isolate sentry-axi scope/refs per run; harmless for the MCP condition.
        SENTRY_AXI_SESSION: makeSessionName(spec),
        // Deliberately NOT setting SENTRY_ORG/SENTRY_PROJECT: that would hand
        // the CLI condition a pre-pinned scope the MCP condition cannot have.
        // Both agents learn the org/project from the task prompt and must
        // establish scope themselves (`sentry-axi use` vs per-call arguments).
        // Both inherit the same SENTRY_AUTH_TOKEN from process.env.
        // Expose the repo's sentry-axi as a PATH binary for Bash commands.
        PATH: benchPath(),
      },
      cwd: workspaceDir,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    agentOutput = execErr.stdout ?? "";
    const stderr = execErr.stderr ?? "";
    writeFileSync(join(artifactDir, "stderr.txt"), stderr);
  }
  return { agentOutput, wallClockSeconds: (Date.now() - startTime) / 1000 };
}
