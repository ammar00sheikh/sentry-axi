/**
 * Target resolution + Sentry state lifecycle for benchmark conditions.
 *
 * sentry-axi has no bridge process and the Sentry MCP server is remote, so
 * neither condition needs a daemon (startDaemon/stopDaemon stay for config
 * parity with the flutter-axi harness this is ported from). What *does* need
 * managing is the Sentry project's own state:
 *
 * - Read-only tasks ("how many unresolved issues in the last 24h") are safe to
 *   repeat: they leave the project untouched.
 * - Mutating tasks (`resolve`, `ignore`, `assign`) change real Sentry state.
 *   Repeat 2 of "resolve the top issue" would otherwise find the issue already
 *   resolved — a strictly easier task, and one whose grade is meaningless.
 *   So the runner snapshots every issue's status/assignee before a mutating
 *   run and restores it afterwards, and the whole harness refuses to run
 *   against anything but the dedicated throwaway project named in
 *   SENTRY_BENCH_PROJECT.
 *
 * The bench project must be seeded first: bench/scripts/setup-fixture.sh.
 */

import { execSync } from "node:child_process";
import type { BenchTarget, ConditionDef } from "./types.js";

/** Sentry state a mutating task can change, and that we therefore must restore. */
export interface IssueState {
  id: string;
  status: string;
  /** Sentry actor id ("user:123") or null when unassigned. */
  assignedTo: string | null;
}

const API_TIMEOUT_MS = 30_000;

export function resolveApiUrl(): string {
  const raw = process.env.SENTRY_URL?.trim() || "https://sentry.io";
  return raw.replace(/\/+$/, "");
}

function requireToken(): string {
  const token = process.env.SENTRY_AUTH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "SENTRY_AUTH_TOKEN is not set - the harness needs it to seed/verify the bench project and to restore state after mutating tasks",
    );
  }
  return token;
}

/**
 * The org/project every run is pointed at. Deliberately read from
 * SENTRY_BENCH_ORG / SENTRY_BENCH_PROJECT and *not* from the user's ambient
 * `sentry-axi use` scope or SENTRY_ORG/SENTRY_PROJECT, so a stray shell that
 * happens to be pinned to a production project can never become the target of
 * a benchmark run that resolves issues.
 */
export function resolveTarget(): BenchTarget {
  const org = process.env.SENTRY_BENCH_ORG?.trim();
  const project = process.env.SENTRY_BENCH_PROJECT?.trim();
  if (!org || !project) {
    throw new Error(
      "SENTRY_BENCH_ORG and SENTRY_BENCH_PROJECT must be set to a dedicated throwaway Sentry project - the benchmark resolves and assigns real issues and must never touch a production project",
    );
  }
  return { org, project };
}

/**
 * Sentry username/email the assignment task assigns issues to. Must be a
 * member of the bench org. Only mutating tasks need it, so it is resolved
 * lazily and its absence is a clear error rather than a 400 from Sentry.
 */
export function resolveAssignee(): string {
  const assignee = process.env.SENTRY_BENCH_ASSIGNEE?.trim();
  if (!assignee) {
    throw new Error(
      "SENTRY_BENCH_ASSIGNEE must be set to a Sentry username/email that is a member of the bench org (used by the assignment task)",
    );
  }
  return assignee;
}

async function sentryFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${resolveApiUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sentry API ${res.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : await res.json();
}

interface ApiIssue {
  id: string;
  status?: string;
  assignedTo?: { id?: string; type?: string } | null;
}

/** Every issue in the bench project, regardless of status. */
async function listIssues(target: BenchTarget): Promise<ApiIssue[]> {
  const issues = await sentryFetch(
    `/api/0/projects/${target.org}/${target.project}/issues/?query=&statsPeriod=90d&limit=100`,
  );
  return Array.isArray(issues) ? (issues as ApiIssue[]) : [];
}

/**
 * Fail fast when the fixture has not been seeded. An empty project would let
 * every triage task "pass" vacuously ("there are no unresolved issues").
 */
export async function assertFixtureReady(target: BenchTarget): Promise<void> {
  let issues: ApiIssue[];
  try {
    issues = await listIssues(target);
  } catch (err) {
    throw new Error(
      `Cannot read ${target.org}/${target.project}: ${(err as Error).message}\nCheck SENTRY_AUTH_TOKEN scopes (project:read, project:write, event:write, org:read).`,
    );
  }
  if (issues.length === 0) {
    throw new Error(
      `Bench project ${target.org}/${target.project} has no issues - run bench/scripts/setup-fixture.sh first to seed the deterministic error fixture`,
    );
  }
}

/** Capture status + assignee of every issue, so a mutating run can be undone. */
export async function snapshotIssueState(
  target: BenchTarget,
): Promise<IssueState[]> {
  const issues = await listIssues(target);
  return issues.map((issue) => ({
    id: issue.id,
    status: issue.status ?? "unresolved",
    assignedTo:
      issue.assignedTo && issue.assignedTo.id
        ? `${issue.assignedTo.type ?? "user"}:${issue.assignedTo.id}`
        : null,
  }));
}

/**
 * Put every issue back the way the snapshot found it. Only issues that
 * actually drifted are written, so a read-only run costs zero writes and a
 * mutating run costs exactly one PUT per issue it touched.
 */
export async function restoreIssueState(
  target: BenchTarget,
  snapshot: IssueState[],
): Promise<number> {
  const current = await snapshotIssueState(target);
  const byId = new Map(current.map((issue) => [issue.id, issue]));

  let restored = 0;
  for (const before of snapshot) {
    const after = byId.get(before.id);
    if (!after) continue;
    if (after.status === before.status && after.assignedTo === before.assignedTo) {
      continue;
    }
    await sentryFetch(`/api/0/organizations/${target.org}/issues/${before.id}/`, {
      method: "PUT",
      body: JSON.stringify({
        status: before.status,
        assignedTo: before.assignedTo,
      }),
    });
    restored++;
  }
  return restored;
}

export function startDaemon(condition: ConditionDef): void {
  if (condition.daemon === "explicit" && condition.daemon_start) {
    console.log(`  [lifecycle] Starting daemon: ${condition.daemon_start}`);
    try {
      execSync(condition.daemon_start, {
        encoding: "utf-8",
        timeout: 60_000,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string };
      console.log(`  [lifecycle] Daemon start note: ${execErr.stderr ?? "already running?"}`);
    }
  }
}

export function stopDaemon(condition: ConditionDef): void {
  if (condition.daemon === "explicit" && condition.daemon_stop) {
    console.log(`  [lifecycle] Stopping daemon: ${condition.daemon_stop}`);
    try {
      execSync(condition.daemon_stop, {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: "pipe",
      });
    } catch {
      console.log(`  [lifecycle] Daemon stop failed (may already be stopped)`);
    }
  }
}
