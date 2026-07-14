/**
 * Seer - Sentry's AI root-cause analysis.
 *
 * `POST /issues/{id}/autofix/` kicks off a run; `GET` on the same path returns
 * the evolving state. A run takes tens of seconds, so `sentry-axi seer @ref`
 * starts it and polls to completion rather than making the agent write its own
 * poll loop (an AXI combines the operation; the agent should issue one command
 * and get an answer).
 *
 * ## Why the parsing here is defensive
 *
 * Seer's step payloads are the least stable shape in the Sentry API - steps
 * have been renamed, nested, and re-typed across releases, and the `causes` /
 * `solution` arrays carry markdown-ish prose whose keys differ per step type.
 * Rather than a strict schema that breaks the moment Sentry ships a change,
 * `extractInsights` walks the step defensively and pulls out whatever
 * human-readable text it can find. A shape change degrades the output; it does
 * not throw. Captured payloads live in `test/fixtures/api-responses.md`.
 */

import type { SentryApi } from "./api.js";
import { SentryAxiError } from "./errors.js";

export type SeerStatus =
  | "PROCESSING"
  | "COMPLETED"
  | "ERROR"
  | "NEED_MORE_INFORMATION"
  | "CANCELLED"
  | string;

export interface SeerStep {
  id?: string;
  type?: string;
  key?: string;
  title?: string;
  status?: string;
  causes?: unknown[];
  insights?: unknown[];
  solution?: unknown[];
  description?: string;
  [key: string]: unknown;
}

export interface SeerState {
  status: SeerStatus;
  steps: SeerStep[];
  /** Present when Seer produced a code change. */
  changes?: unknown[];
  runId?: string | number;
}

export interface SeerResponse {
  autofix?: {
    status?: SeerStatus;
    steps?: SeerStep[];
    changes?: unknown[];
    run_id?: string | number;
  } | null;
}

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 180_000;

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "ERROR",
  "CANCELLED",
  "NEED_MORE_INFORMATION",
]);

export function isTerminal(status: SeerStatus): boolean {
  return TERMINAL_STATUSES.has(String(status).toUpperCase());
}

/** Normalize the wire payload into the shape the CLI renders. */
export function parseSeerState(response: SeerResponse | null): SeerState {
  const autofix = response?.autofix;
  return {
    status: autofix?.status ?? "PROCESSING",
    steps: autofix?.steps ?? [],
    ...(autofix?.changes ? { changes: autofix.changes } : {}),
    ...(autofix?.run_id !== undefined ? { runId: autofix.run_id } : {}),
  };
}

/**
 * Pull readable prose out of a Seer step regardless of which key it landed in.
 * Handles strings, `{markdown}`, `{description}`, `{title}`, and `{insight}`
 * shapes, plus arrays of any of those.
 */
export function extractInsights(step: SeerStep): string[] {
  const out: string[] = [];

  const take = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) out.push(text);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) take(item);
      return;
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of [
        "markdown",
        "insight",
        "description",
        "title",
        "cause",
        "text",
      ]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) {
          out.push(candidate.trim());
          return;
        }
      }
    }
  };

  take(step.causes);
  take(step.insights);
  take(step.solution);
  if (out.length === 0) take(step.description);

  return out;
}

/** Start a Seer run. Safe to call on an issue that already has one. */
export async function startSeer(
  api: SentryApi,
  issueId: string,
): Promise<void> {
  try {
    await api.request(`/issues/${encodeURIComponent(issueId)}/autofix/`, {
      method: "POST",
      body: { instruction: "" },
    });
  } catch (error) {
    // A 400/403 here almost always means Seer is not enabled for the org
    // rather than a malformed request - say so instead of echoing a raw 4xx.
    if (
      error instanceof SentryAxiError &&
      (error.code === "API_ERROR" || error.code === "AUTH_INVALID")
    ) {
      throw new SentryAxiError(
        `Seer could not be started for issue ${issueId}: ${error.message}`,
        "SEER_UNAVAILABLE",
        [
          "Confirm Seer is enabled for the org at https://sentry.io/settings/<org>/seer/",
          "Seer needs the issue to have a recent event with a stack trace",
          "Run `sentry-axi stacktrace @<ref>` to inspect the trace yourself instead",
        ],
      );
    }
    throw error;
  }
}

export async function getSeerState(
  api: SentryApi,
  issueId: string,
): Promise<SeerState> {
  const response = await api.request<SeerResponse>(
    `/issues/${encodeURIComponent(issueId)}/autofix/`,
  );
  return parseSeerState(response);
}

export interface RunSeerOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected in tests so the poll loop does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the deadline is deterministic. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a Seer run (unless one is already in flight) and poll until it reaches
 * a terminal status or the deadline passes. Returns the final state.
 */
export async function runSeer(
  api: SentryApi,
  issueId: string,
  options: RunSeerOptions = {},
): Promise<SeerState> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;

  const existing = await getSeerState(api, issueId);
  if (isTerminal(existing.status) && existing.steps.length > 0) {
    return existing;
  }

  if (existing.steps.length === 0) {
    await startSeer(api, issueId);
  }

  const deadline = now() + timeoutMs;

  for (;;) {
    await sleep(pollIntervalMs);

    const state = await getSeerState(api, issueId);
    if (isTerminal(state.status)) return state;

    if (now() >= deadline) {
      throw new SentryAxiError(
        `Seer run on issue ${issueId} did not finish within ${Math.round(timeoutMs / 1000)}s (status: ${state.status})`,
        "TIMEOUT",
        [
          `Run \`sentry-axi seer @${issueId} --timeout 300\` to wait longer`,
          "Seer keeps running server-side - re-run the command to pick up the result",
        ],
      );
    }
  }
}
