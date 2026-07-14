import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildGradingPrompt, extractVerdict, formatTrajectory } from "../src/grader.js";
import { isApplicable, renderPrompt, type RunContext } from "../src/runner.js";
import { summarize, markdownReport } from "../src/reporter.js";
import { parseClaudeJsonl } from "../src/usage.js";
import { validateCommandPolicy } from "../src/validation.js";
import type { RunResult, TaskDef, ConditionDef } from "../src/types.js";

const CONFIG_DIR = join(resolve(import.meta.dirname, ".."), "config");

function loadTasks(): TaskDef[] {
  const doc = parseYaml(readFileSync(join(CONFIG_DIR, "tasks.yaml"), "utf-8")) as {
    tasks: Record<string, Omit<TaskDef, "id">>;
  };
  return Object.entries(doc.tasks).map(([id, def]) => ({ ...def, id }));
}

function loadConditions(): ConditionDef[] {
  const doc = parseYaml(
    readFileSync(join(CONFIG_DIR, "conditions.yaml"), "utf-8"),
  ) as { conditions: Record<string, Omit<ConditionDef, "id">> };
  return Object.entries(doc.conditions).map(([id, def]) => ({
    ...def,
    id: id as ConditionDef["id"],
  }));
}

describe("config files", () => {
  it("loads both conditions", () => {
    const conditions = loadConditions();
    expect(conditions.map((c) => c.id).sort()).toEqual([
      "sentry-axi",
      "sentry-mcp",
    ]);
    const mcp = conditions.find((c) => c.id === "sentry-mcp");
    expect(mcp?.mcp_config?.mcpServers).toHaveProperty("sentry");
    // The MCP condition must point at Sentry's official remote server.
    expect(JSON.stringify(mcp?.mcp_config)).toContain("mcp.sentry.dev");
  });

  it("loads 14 tasks with ref-layer ones sentry-axi-only", () => {
    const tasks = loadTasks();
    expect(tasks.length).toBe(14);
    for (const task of tasks) {
      expect(task.prompt.length).toBeGreaterThan(20);
      expect(task.grading.grading_hint).toBeTruthy();
      if (task.category === "refs") {
        expect(task.applicable_conditions).toEqual(["sentry-axi"]);
      } else {
        expect(task.applicable_conditions).toBeUndefined();
      }
    }
  });

  it("flags exactly the write-back tasks as mutating", () => {
    const tasks = loadTasks();
    const mutating = tasks.filter((t) => t.mutating).map((t) => t.id).sort();
    expect(mutating).toEqual(["assign_top_issue", "resolve_top_issue"]);
    // Category and flag must agree — the runner keys state restoration off the
    // flag, so a `mutating` category with no flag would silently skip revert.
    for (const task of tasks) {
      expect(Boolean(task.mutating)).toBe(task.category === "mutating");
    }
  });

  it("only substitutes placeholders the runner knows about", () => {
    const known = ["__ORG__", "__PROJECT__", "__ASSIGNEE__"];
    for (const task of loadTasks()) {
      for (const placeholder of task.prompt.match(/__[A-Z_]+__/g) ?? []) {
        expect(known).toContain(placeholder);
      }
    }
  });
});

describe("isApplicable", () => {
  const tasks = loadTasks();

  it("both conditions run triage tasks; only sentry-axi runs ref tasks", () => {
    const triage = tasks.find((t) => t.id === "unresolved_count_24h")!;
    const refs = tasks.find((t) => t.id === "refs_cross_command")!;
    expect(isApplicable(triage, "sentry-axi")).toBe(true);
    expect(isApplicable(triage, "sentry-mcp")).toBe(true);
    expect(isApplicable(refs, "sentry-axi")).toBe(true);
    expect(isApplicable(refs, "sentry-mcp")).toBe(false);
  });
});

describe("renderPrompt", () => {
  const ctx: RunContext = {
    target: { org: "acme", project: "axi-bench" },
    assignee: "triage@example.com",
  };

  it("substitutes org, project and assignee placeholders", () => {
    const rendered = renderPrompt(
      "Triage __ORG__/__PROJECT__ and assign to __ASSIGNEE__ (__PROJECT__)",
      ctx,
    );
    expect(rendered).toBe(
      "Triage acme/axi-bench and assign to triage@example.com (axi-bench)",
    );
    expect(rendered).not.toContain("__");
  });

  it("renders every configured task without leaving a placeholder behind", () => {
    for (const task of loadTasks()) {
      expect(renderPrompt(task.prompt, ctx)).not.toMatch(/__[A-Z_]+__/);
    }
  });
});

describe("usage parsing", () => {
  it("sums tokens, cost, turns and Bash commands from stream-json", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "sentry-axi issues" } },
            { type: "tool_use", name: "Bash", input: { command: "sentry-axi stacktrace @g1:1" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
      }),
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.0321,
        num_turns: 4,
        duration_ms: 12_500,
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 1500,
          output_tokens: 250,
        },
      }),
    ].join("\n");

    const usage = parseClaudeJsonl(jsonl, { model: "claude-sonnet-4-6" });
    expect(usage.input_tokens).toBe(2000);
    expect(usage.input_tokens_cached).toBe(1500);
    expect(usage.input_tokens_uncached).toBe(500);
    expect(usage.output_tokens).toBe(250);
    expect(usage.total_cost_usd).toBeCloseTo(0.0321, 6);
    expect(usage.turn_count).toBe(4);
    expect(usage.wall_clock_seconds).toBe(12.5);
    expect(usage.command_count).toBe(2);
    expect(usage.error_count).toBe(1);
    expect(usage.command_log).toEqual([
      "sentry-axi issues",
      "sentry-axi stacktrace @g1:1",
    ]);
  });

  it("computes cost from tokens when the agent crashed before the result event", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 0 },
        content: [],
      },
    });
    const usage = parseClaudeJsonl(jsonl, { model: "claude-sonnet-4-6" });
    expect(usage.total_cost_usd).toBeCloseTo(3.0, 4); // $3/1M uncached input
  });

  it("returns zeroed metrics for empty output", () => {
    const usage = parseClaudeJsonl("");
    expect(usage.input_tokens).toBe(0);
    expect(usage.total_cost_usd).toBe(0);
    expect(usage.command_log).toEqual([]);
  });
});

describe("grader", () => {
  it("extracts verdicts from plain and fenced JSON", () => {
    expect(extractVerdict('{"pass": true, "reason": "ok"}')).toEqual({
      pass: true,
      reason: "ok",
    });
    expect(
      extractVerdict('```json\n{"pass": false, "reason": "hallucinated"}\n```'),
    ).toEqual({ pass: false, reason: "hallucinated" });
    expect(extractVerdict("no json here")).toBeNull();
  });

  it("formats Bash commands, MCP tool calls and results into a trajectory", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "sentry-axi issues" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "@g1:1 TypeError Cannot read properties of undefined" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__sentry__search_issues", input: { query: "is:unresolved" } },
          ],
        },
      }),
      JSON.stringify({ type: "result", result: "5 unresolved issues" }),
    ].join("\n");
    const trajectory = formatTrajectory(jsonl);
    expect(trajectory).toContain("COMMAND: sentry-axi issues");
    expect(trajectory).toContain("OUTPUT: @g1:1 TypeError");
    expect(trajectory).toContain("TOOL_CALL: mcp__sentry__search_issues");
    expect(trajectory).toContain("AGENT: 5 unresolved issues");
  });

  it("builds a triage-rubric grading prompt", () => {
    const prompt = buildGradingPrompt(
      "Resolve the top issue",
      "COMMAND: ...",
      "the top issue is the TypeError",
    );
    expect(prompt).toContain("Sentry error-triage task");
    expect(prompt).toContain("KNOWN FACTS: the top issue is the TypeError");
    expect(prompt).toContain('{"pass": true');
  });
});

describe("command policy", () => {
  const condition = loadConditions().find((c) => c.id === "sentry-axi")!;

  it("passes when sentry-axi was used", () => {
    expect(validateCommandPolicy(condition, ["sentry-axi issues"])).toBeNull();
  });

  it("fails when the agent bypassed the CLI", () => {
    expect(
      validateCommandPolicy(condition, [
        "sentry-axi issues",
        "curl -H 'Authorization: Bearer x' https://sentry.io/api/0/issues/",
      ]),
    ).toMatch(/forbidden/);
    expect(
      validateCommandPolicy(condition, [
        "sentry-axi issues",
        "sentry-cli issues list",
      ]),
    ).toMatch(/forbidden/);
    expect(validateCommandPolicy(condition, ["echo hi"])).toMatch(
      /no Bash command used a required/,
    );
  });

  it("catches an interpreter reaching the REST API around the CLI", () => {
    expect(
      validateCommandPolicy(condition, [
        "sentry-axi issues",
        "node -e \"fetch('https://sentry.io/api/0/projects/acme/bench/issues/')\"",
      ]),
    ).toMatch(/forbidden/);
  });

  it("imposes no policy on the MCP condition (it has no Bash)", () => {
    const mcp = loadConditions().find((c) => c.id === "sentry-mcp")!;
    expect(validateCommandPolicy(mcp, [])).toBeNull();
  });
});

function fakeResult(overrides: Partial<RunResult>): RunResult {
  return {
    condition: "sentry-axi",
    task: "t",
    run: 1,
    model: "m",
    timestamp: "2026-07-14T00:00:00Z",
    usage: {
      input_tokens: 1000,
      input_tokens_cached: 500,
      input_tokens_uncached: 500,
      output_tokens: 100,
      reasoning_tokens: 0,
      total_cost_usd: 0.01,
      wall_clock_seconds: 10,
      turn_count: 3,
      command_count: 2,
      error_count: 0,
      command_log: [],
    },
    grade: { task_success: true, details: "" },
    agent_output: "",
    ...overrides,
  };
}

describe("reporter aggregation", () => {
  it("averages usage per condition", () => {
    const summaries = summarize([
      fakeResult({ task: "a" }),
      fakeResult({
        task: "b",
        usage: { ...fakeResult({}).usage, input_tokens: 3000, input_tokens_cached: 1500, total_cost_usd: 0.03, turn_count: 5 },
        grade: { task_success: false, details: "", failure_reason: "task_failure" },
      }),
    ]);
    const axi = summaries.find((s) => s.condition === "sentry-axi")!;
    expect(axi.total_tasks).toBe(2);
    expect(axi.avg_input_tokens).toBe(2000);
    expect(axi.avg_cached_pct).toBeCloseTo(0.5, 6);
    expect(axi.avg_cost_usd).toBeCloseTo(0.02, 6);
    expect(axi.total_cost_usd).toBeCloseTo(0.04, 6);
    expect(axi.avg_turns).toBe(4);
    expect(axi.success_rate).toBe(0.5);
  });
});

describe("reporter N/A handling", () => {
  it("excludes not_applicable runs from rates and marks them N/A", () => {
    const results: RunResult[] = [
      fakeResult({ condition: "sentry-axi", task: "refs_cross_command" }),
      fakeResult({
        condition: "sentry-mcp",
        task: "refs_cross_command",
        grade: {
          task_success: false,
          details: "n/a",
          failure_reason: "not_applicable",
        },
      }),
      fakeResult({ condition: "sentry-mcp", task: "unresolved_count_24h" }),
    ];
    const summaries = summarize(results);
    const mcp = summaries.find((s) => s.condition === "sentry-mcp")!;
    expect(mcp.not_applicable).toBe(1);
    expect(mcp.total_tasks).toBe(1);
    // The N/A run must not drag the success rate down.
    expect(mcp.success_rate).toBe(1);

    const md = markdownReport(results);
    expect(md).toContain("| sentry-mcp | N/A |");
    expect(md).toContain("reported N/A, not failed");
  });
});
