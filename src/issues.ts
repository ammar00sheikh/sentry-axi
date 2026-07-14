/**
 * Issue listing, detail, and mutation.
 *
 * This is the core agent loop: "what's broken" -> "show me the stack" ->
 * "resolve it". The listing commands mint refs; the mutation commands consume
 * them.
 */

import type { SentryApi } from "./api.js";
import { SentryAxiError, validationError } from "./errors.js";
import type { SentryEvent, SentryIssue } from "./render.js";

export type IssueStatus = "resolved" | "ignored" | "unresolved";

export interface ListIssuesOptions {
  /** Sentry search syntax, e.g. `is:unresolved level:error`. */
  query?: string;
  /** `24h`, `14d`, ... Sentry's statsPeriod. */
  period?: string;
  /** `date` (last seen), `freq` (events), `user` (users affected), `new`. */
  sort?: string;
  limit?: number;
}

const DEFAULT_QUERY = "is:unresolved";
const DEFAULT_PERIOD = "24h";
const DEFAULT_SORT = "freq";
const DEFAULT_LIMIT = 25;

const VALID_SORTS = new Set(["date", "new", "freq", "user", "trends"]);

/**
 * Shape check for the endpoints that take an arbitrary window (Discover, stats):
 * Sentry accepts `<n>[mhdw]` there. Reject anything else before spending a
 * request.
 */
export function validatePeriod(period: string): string {
  if (!/^\d+[mhdw]$/.test(period)) {
    throw validationError(
      `Invalid period "${period}"`,
      "Use a number followed by m/h/d/w, e.g. --period 24h, --period 7d",
    );
  }
  return period;
}

/**
 * The issues endpoints are stricter than the rest of the API: `statsPeriod`
 * there accepts **only** `24h` or `14d` (it sizes the sparkline, not the
 * filter). Passing `90d` earns a 400 from Sentry.
 *
 * That is a trap worth catching locally, because the fix is not "pick a smaller
 * window" - it is "filter by age in the query instead", which is a different
 * concept entirely and one an agent will not guess from a raw 400.
 */
export const VALID_ISSUE_PERIODS = ["24h", "14d"] as const;

export function validateIssuePeriod(period: string): string {
  if ((VALID_ISSUE_PERIODS as readonly string[]).includes(period)) {
    return period;
  }

  throw validationError(
    `Sentry's issue endpoints only accept --period ${VALID_ISSUE_PERIODS.join(" or ")} (got "${period}")`,
    "Use `--period 24h` or `--period 14d`",
    'To reach further back, filter by age in the query instead: `--query "is:unresolved age:+30d"` (first seen over 30 days ago)',
    'Or by last occurrence: `--query "is:unresolved lastSeen:-90d"` (seen within the last 90 days)',
  );
}

export function validateSort(sort: string): string {
  if (!VALID_SORTS.has(sort)) {
    throw validationError(
      `Invalid sort "${sort}"`,
      `Use one of: ${[...VALID_SORTS].join(", ")}`,
    );
  }
  return sort;
}

export async function listIssues(
  api: SentryApi,
  options: ListIssuesOptions = {},
): Promise<SentryIssue[]> {
  const {
    query = DEFAULT_QUERY,
    period = DEFAULT_PERIOD,
    sort = DEFAULT_SORT,
    limit = DEFAULT_LIMIT,
  } = options;

  if (!api.project) {
    throw new SentryAxiError("Listing issues needs a project", "NO_PROJECT", [
      "Run `sentry-axi use <org>/<project>` to pin one",
    ]);
  }

  return api.request<SentryIssue[]>(
    `/projects/${api.org}/${api.project}/issues/`,
    {
      query: {
        query,
        statsPeriod: validateIssuePeriod(period),
        sort: validateSort(sort),
        limit: Math.min(limit, 100),
      },
      paginate: true,
      limit,
    },
  );
}

/**
 * Org-wide search across every project the token can see. This is the
 * `sentry-axi search` command - the same endpoint, but not project-scoped, so
 * an agent can ask "is this error happening anywhere else".
 */
export async function searchIssues(
  api: SentryApi,
  options: ListIssuesOptions = {},
): Promise<SentryIssue[]> {
  const {
    query = DEFAULT_QUERY,
    period = DEFAULT_PERIOD,
    sort = DEFAULT_SORT,
    limit = DEFAULT_LIMIT,
  } = options;

  return api.request<SentryIssue[]>(`/organizations/${api.org}/issues/`, {
    query: {
      query,
      statsPeriod: validateIssuePeriod(period),
      sort: validateSort(sort),
      limit: Math.min(limit, 100),
    },
    paginate: true,
    limit,
  });
}

export async function getIssue(
  api: SentryApi,
  issueId: string,
): Promise<SentryIssue> {
  return api.request<SentryIssue>(`/issues/${encodeURIComponent(issueId)}/`);
}

/**
 * Resolve a short id (`FRONTEND-4F`) to a numeric issue id. Agents paste short
 * ids constantly - they are what Sentry's own UI and alert emails show - so
 * every command that takes an issue accepts one.
 */
export async function resolveShortId(
  api: SentryApi,
  shortId: string,
): Promise<string> {
  const result = await api.request<{
    group?: { id?: string };
    groupId?: string;
  }>(`/organizations/${api.org}/shortids/${encodeURIComponent(shortId)}/`);

  const id = result?.group?.id ?? result?.groupId;
  if (!id) {
    throw new SentryAxiError(
      `No issue found for short id ${shortId}`,
      "NOT_FOUND",
      ["Run `sentry-axi issues` to list issues with their short ids"],
    );
  }

  return String(id);
}

/** The latest event on an issue - the payload the stack trace comes from. */
export async function getLatestEvent(
  api: SentryApi,
  issueId: string,
): Promise<SentryEvent> {
  return api.request<SentryEvent>(
    `/issues/${encodeURIComponent(issueId)}/events/latest/`,
  );
}

export async function listEvents(
  api: SentryApi,
  issueId: string,
  limit = 10,
): Promise<SentryEvent[]> {
  return api.request<SentryEvent[]>(
    `/issues/${encodeURIComponent(issueId)}/events/`,
    { query: { limit: Math.min(limit, 100) }, paginate: true, limit },
  );
}

export async function getEvent(
  api: SentryApi,
  issueId: string,
  eventId: string,
): Promise<SentryEvent> {
  return api.request<SentryEvent>(
    `/issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(eventId)}/`,
  );
}

export interface IssueTag {
  key: string;
  name?: string;
  totalValues?: number;
  topValues?: Array<{ value: string; count: number }>;
}

export async function getIssueTags(
  api: SentryApi,
  issueId: string,
): Promise<IssueTag[]> {
  return api.request<IssueTag[]>(
    `/issues/${encodeURIComponent(issueId)}/tags/`,
  );
}

/**
 * Change an issue's status. Idempotent by construction - Sentry's PUT is a
 * set-to-state, not a toggle, so resolving an already-resolved issue is a
 * successful no-op, which is exactly the AXI contract for mutations.
 */
export async function setIssueStatus(
  api: SentryApi,
  issueId: string,
  status: IssueStatus,
): Promise<SentryIssue> {
  return api.request<SentryIssue>(`/issues/${encodeURIComponent(issueId)}/`, {
    method: "PUT",
    body: { status },
  });
}

/**
 * Assign an issue. Sentry takes an actor string: a username/email, or
 * `team:<slug>`. Passing `""` unassigns.
 */
export async function assignIssue(
  api: SentryApi,
  issueId: string,
  assignee: string,
): Promise<SentryIssue> {
  return api.request<SentryIssue>(`/issues/${encodeURIComponent(issueId)}/`, {
    method: "PUT",
    body: { assignedTo: assignee },
  });
}
