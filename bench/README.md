# sentry-axi benchmark harness

Compares agent performance triaging a live Sentry project through **sentry-axi** (AXI-compliant CLI) versus **Sentry's official remote MCP server** (`https://mcp.sentry.dev`), replicating the methodology of [axi's bench-browser](https://github.com/kunchenguid/axi): YAML-defined tasks and conditions, sequential execution with randomized order, per-run isolation, stream-json usage parsing, and LLM-as-Judge grading.

## Prerequisites

- `claude` CLI authenticated
- A **dedicated throwaway Sentry project** — the benchmark resolves and assigns real issues
- Environment:

```sh
export SENTRY_AUTH_TOKEN=...          # scopes: org:read, project:read, project:write, event:write
export SENTRY_BENCH_ORG=acme          # throwaway org
export SENTRY_BENCH_PROJECT=axi-bench # throwaway project — NEVER a production one
export SENTRY_BENCH_DSN='https://<key>@o0.ingest.sentry.io/0'  # DSN of that project
export SENTRY_BENCH_ASSIGNEE=you@example.com                   # member of the bench org
```

- The error fixture: `bench/scripts/setup-fixture.sh` (seeds the project with a deterministic set of errors, transactions, breadcrumbs and tags)

## Usage

```sh
npm install

# Seed the fixture once (idempotent; --force to re-emit)
./scripts/setup-fixture.sh

# Single condition x task
npm run bench -- run --condition sentry-axi --task top_error_stacktrace
npm run bench -- run --condition sentry-mcp --task top_error_stacktrace

# Full matrix
npm run bench -- matrix --repeat 5

# Summary report (results/report.md + report.csv)
npm run bench -- report
```

## Conditions

| Condition | What the agent gets |
|---|---|
| `sentry-axi` | The `sentry-axi` CLI on PATH, used via Bash. Command policy forbids bypassing it with `sentry-cli`, curl, or an interpreter hitting the REST API. |
| `sentry-mcp` | Sentry's official remote MCP server loaded as MCP tools (no ToolSearch — schemas in context up front). No Bash at all. |

Both authenticate with the same `SENTRY_AUTH_TOKEN`, against the same project, and both learn the org/project slugs from the task prompt.

## Tasks

12 triage tasks run under both conditions against the seeded project: unresolved count in the last 24h, top error + stack trace, most-users-affected issue and its source file, the release that introduced the top error, breadcrumb trail before the top crash, slowest transaction, Seer root-cause analysis, a Sentry-search query, tag distribution, event listing, plus two **mutating** tasks (resolve the top issue; assign the most-users issue).

2 ref-layer tasks (`sentry-axi` only): addressing issues purely through generation-stamped `@g1:N` refs from a single listing, and pinning scope once with `use` so later commands carry no org/project. The remote MCP is stateless — every call carries its own org/project/issue id — so it has no equivalent; those tasks are reported **N/A**, not failed.

The fixture is built so that the **most frequent** issue and the **most users affected** issue are different: an agent that skims the issue list and answers "the top one" to both questions fails one of them.

## Metrics

Per run: input/output tokens, cache hit %, cost (USD), wall-clock seconds, turn count, command count, LLM-judged success. Judge model: `claude-sonnet-4-6`, pass/fail with an anti-hallucination rubric (answers must come from live Sentry data, not memory).

## Fairness caveats (read before quoting results)

1. **Both conditions get the same task text, the same agent model, the same repeat count, and the same Sentry token against the same project.** Neither is given a pre-pinned scope: the runner deliberately does *not* export `SENTRY_ORG`/`SENTRY_PROJECT`, because that would hand the CLI a free setup step the MCP condition cannot have. Each agent establishes scope its own way (`sentry-axi use` vs per-call arguments), and that setup cost is counted against it.

2. **Mutating tasks change real Sentry state — here is exactly how that is handled.** `resolve_top_issue` and `assign_top_issue` write back to Sentry. Repeat 2 of "resolve the top issue" would otherwise open on an already-resolved issue: a strictly easier task, and one whose grade means nothing. Two mechanisms keep repeats honest:
   - **A dedicated throwaway project is mandatory.** The harness reads its target only from `SENTRY_BENCH_ORG`/`SENTRY_BENCH_PROJECT` — never from the ambient `SENTRY_ORG`/`SENTRY_PROJECT` or a `sentry-axi use` scope — so a shell pinned to production cannot become the target. `setup-fixture.sh` additionally refuses to emit unless the DSN it is given resolves, through the Sentry API, to that same project.
   - **State is snapshotted and restored around every mutating run.** Before the agent starts, the runner records every issue's `status` and `assignedTo`; in a `finally` block (so a crashed or timed-out agent is covered too) it PUTs back anything that drifted. Read-only runs cost zero writes; a mutating run costs exactly one PUT per issue it touched.

   This is a *revert*, not a rollback: Sentry keeps the resolve/assign in the issue's activity log, and the restore is itself an API write. It does not perfectly restore "a project no one has ever triaged" — which is why the target must be a throwaway project, and why nobody else should be working in it during a run.

3. **Read-only tasks are safe to repeat**; they leave the project untouched, so repeats measure variance in the agent, not drift in the data.

4. **The remote MCP pays network latency the CLI does not.** `sentry-mcp` is a hosted endpoint (`mcp.sentry.dev`) that itself calls Sentry; `sentry-axi` calls the Sentry REST API directly. Wall-clock comparisons include that extra hop. Token and turn comparisons do not.

5. **Ref-layer tasks are excluded from the headline comparison**, not counted as failures for the MCP. They exist to document what the AXI ref system buys, and their N/A cells are visible in every table — success rates and averages are computed only over tasks a condition can actually attempt.

6. **The fixture is seeded, not organic.** Real Sentry projects have noisier issue distributions. The counts, releases and stack frames here are deterministic precisely so the judge's KNOWN FACTS can be exact; re-seed before a matrix run, because event counts drift as Sentry ages data out of the retention window.

7. **Seer is nondeterministic.** `seer_root_cause` is graded on whether the agent actually invoked Seer and faithfully reported what it returned — not on matching a fixed root-cause string.
