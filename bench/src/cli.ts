#!/usr/bin/env tsx
/**
 * CLI entry point for the Sentry triage benchmark harness.
 *
 * Commands:
 *   run       — Run a single benchmark (--condition, --task, --repeat, --model)
 *   matrix    — Run all condition x task combinations
 *   report    — Generate summary from results jsonl files
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ConditionDef, ConditionId, TaskDef } from "./types.js";
import { isApplicable, runOne, type RunContext } from "./runner.js";
import { writeReports } from "./reporter.js";
import {
  assertFixtureReady,
  resolveAssignee,
  resolveTarget,
  startDaemon,
  stopDaemon,
} from "./lifecycle.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_DIR = join(BENCH_ROOT, "config");
const DEFAULT_MODEL = "claude-sonnet-4-6";

function loadConditions(): Map<string, ConditionDef> {
  const raw = readFileSync(join(CONFIG_DIR, "conditions.yaml"), "utf-8");
  const doc = parseYaml(raw) as {
    conditions: Record<string, Omit<ConditionDef, "id">>;
  };
  const map = new Map<string, ConditionDef>();
  for (const [id, def] of Object.entries(doc.conditions)) {
    map.set(id, { ...def, id: id as ConditionId });
  }
  return map;
}

function loadTasks(): Map<string, TaskDef> {
  const raw = readFileSync(join(CONFIG_DIR, "tasks.yaml"), "utf-8");
  const doc = parseYaml(raw) as { tasks: Record<string, Omit<TaskDef, "id">> };
  const map = new Map<string, TaskDef>();
  for (const [id, def] of Object.entries(doc.tasks)) {
    map.set(id, { ...def, id });
  }
  return map;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args[key] = val;
      if (val !== "true") i++;
    }
  }
  return args;
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Resolve the throwaway bench project and check it is seeded. The assignee is
 * only demanded when a selected task actually mutates Sentry, so a read-only
 * subset of the matrix runs without it.
 */
async function prepareContext(tasks: TaskDef[]): Promise<RunContext> {
  const target = resolveTarget();
  console.log(`Bench project: ${target.org}/${target.project}`);
  await assertFixtureReady(target);

  const mutating = tasks.some((t) => t.mutating);
  const assignee = mutating ? resolveAssignee() : "";
  if (mutating) {
    console.log(
      `Mutating tasks selected — issue state will be snapshotted and restored around each run (assignee: ${assignee})`,
    );
  }

  return { target, assignee };
}

async function cmdRun(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const conditionId = args.condition;
  const taskId = args.task;
  const repeat = parseInt(args.repeat ?? "1", 10);
  const model = args.model ?? DEFAULT_MODEL;

  if (!conditionId || !taskId) {
    console.error(
      "Usage: bench run --condition <id> --task <id> [--repeat N] [--model M]",
    );
    process.exit(1);
  }

  const conditions = loadConditions();
  const tasks = loadTasks();

  const condition = conditions.get(conditionId);
  if (!condition) {
    console.error(
      `Unknown condition: ${conditionId}. Available: ${[...conditions.keys()].join(", ")}`,
    );
    process.exit(1);
  }

  const task = tasks.get(taskId);
  if (!task) {
    console.error(
      `Unknown task: ${taskId}. Available: ${[...tasks.keys()].join(", ")}`,
    );
    process.exit(1);
  }

  const ctx = await prepareContext([task]);
  startDaemon(condition);

  try {
    for (let r = 1; r <= repeat; r++) {
      console.log(`\n=== Run ${r}/${repeat}: ${conditionId} x ${taskId} ===\n`);
      const result = await runOne(
        { condition: conditionId as ConditionId, task: taskId, run: r, model },
        condition,
        task,
        ctx,
      );
      if (result.grade.failure_reason === "not_applicable") {
        console.log("  N/A: task does not apply to this condition");
        continue;
      }
      console.log(`  Success: ${result.grade.task_success}`);
      console.log(
        `  Turns: ${result.usage.turn_count}, Commands: ${result.usage.command_count}`,
      );
      console.log(
        `  Input tokens: ${result.usage.input_tokens} (cached: ${result.usage.input_tokens_cached})`,
      );
      console.log(`  Cost: $${result.usage.total_cost_usd.toFixed(4)}`);
      console.log(`  Time: ${result.usage.wall_clock_seconds.toFixed(1)}s`);
    }
  } finally {
    stopDaemon(condition);
  }
}

async function cmdMatrix(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const repeat = parseInt(args.repeat ?? "1", 10);
  const model = args.model ?? DEFAULT_MODEL;
  const conditionFilter = args.condition;
  const taskFilter = args.task;
  const categoryFilter = args.category;

  const conditions = loadConditions();
  const tasks = loadTasks();

  const conditionIds = conditionFilter
    ? conditionFilter.split(",")
    : [...conditions.keys()];

  let taskIds = taskFilter ? taskFilter.split(",") : [...tasks.keys()];

  if (categoryFilter) {
    taskIds = taskIds.filter((id) => {
      const t = tasks.get(id);
      return t && t.category === categoryFilter;
    });
  }

  const selectedTasks = taskIds
    .map((id) => tasks.get(id))
    .filter((t): t is TaskDef => t !== undefined);
  const ctx = await prepareContext(selectedTasks);

  // Randomize condition and task order to prevent systematic ordering bias
  const orderedConditionIds = shuffleArray(conditionIds);
  console.log(`Condition order (randomized): ${orderedConditionIds.join(", ")}`);

  const total = orderedConditionIds.length * taskIds.length * repeat;

  for (const condId of orderedConditionIds) {
    const condition = conditions.get(condId);
    if (!condition) {
      console.error(`Skipping unknown condition: ${condId}`);
      continue;
    }

    startDaemon(condition);

    try {
      let condDone = 0;
      const orderedTaskIds = shuffleArray(taskIds);
      const condTotal = orderedTaskIds.length * repeat;

      for (const taskId of orderedTaskIds) {
        const task = tasks.get(taskId);
        if (!task) {
          console.error(`Skipping unknown task: ${taskId}`);
          continue;
        }

        for (let r = 1; r <= repeat; r++) {
          condDone++;
          console.log(
            `\n[${condId} ${condDone}/${condTotal}] ${taskId} (run ${r})`,
          );

          const result = await runOne(
            { condition: condId as ConditionId, task: taskId, run: r, model },
            condition,
            task,
            ctx,
          );

          if (!isApplicable(task, condId)) {
            console.log("  N/A (recorded)");
            continue;
          }

          const status = result.grade.task_success ? "PASS" : "FAIL";
          console.log(
            `  ${status} | ${result.usage.turn_count} turns | $${result.usage.total_cost_usd.toFixed(4)} | ${result.usage.wall_clock_seconds.toFixed(1)}s`,
          );
        }
      }
    } finally {
      stopDaemon(condition);
    }
  }

  console.log(`\nMatrix complete: ${total} runs.`);
  writeReports();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "run":
      return cmdRun(rest);
    case "matrix":
      return cmdMatrix(rest);
    case "report":
      writeReports();
      return;
    default:
      console.log(`sentry-axi-bench — benchmark harness for Sentry error-triage tools

Compares agent performance triaging a live Sentry project through sentry-axi
(AXI CLI) versus Sentry's official remote MCP server, replicating axi's
bench-browser methodology (LLM-as-Judge grading, randomized order, per-run
isolation).

Prerequisites:
  - \`claude\` CLI authenticated
  - SENTRY_AUTH_TOKEN with scopes: org:read, project:read, project:write, event:write
  - SENTRY_BENCH_ORG / SENTRY_BENCH_PROJECT pointing at a DEDICATED THROWAWAY
    project (mutating tasks resolve and assign real issues)
  - SENTRY_BENCH_ASSIGNEE (a member of the bench org) for the assignment task
  - bench/scripts/setup-fixture.sh has been run once (seeds the error fixture)

Commands:
  run       Run a single benchmark
              --condition <sentry-axi|sentry-mcp>
              --task <task_id>
              --repeat <N>  (default: 1)
              --model <M>   (default: ${DEFAULT_MODEL})

  matrix    Run all condition x task combinations (sequential, randomized order)
              --repeat <N>            (default: 1)
              --model <M>             (default: ${DEFAULT_MODEL})
              --condition <id,id,...>  (filter conditions)
              --task <id,id,...>       (filter tasks)
              --category <single_step|multi_step|investigation|mutating|refs>

  report    Generate summary from results jsonl files
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
