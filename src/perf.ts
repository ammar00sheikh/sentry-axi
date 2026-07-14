/**
 * Performance and project health.
 *
 * Everything here returns a **pre-aggregated, decision-ready summary** rather
 * than a raw event stream - the same contract flutter-axi's `perf` holds. An
 * agent asking "what's slow" should get a ranked table, not 10,000 spans to
 * reduce itself.
 *
 * Two backends:
 *   - the Discover events endpoint (`/organizations/{org}/events/`) for
 *     transaction percentiles, ranked by p95
 *   - the stats endpoint (`/organizations/{org}/stats_v2/`) for accepted vs
 *     dropped event volume, which is how you answer "is the error rate up"
 */

import type { SentryApi } from "./api.js";
import { validatePeriod } from "./issues.js";

export interface SentryProject {
  id: string;
  slug: string;
  name?: string;
  platform?: string | null;
  dateCreated?: string;
  firstEvent?: string | null;
  hasAccess?: boolean;
  isMember?: boolean;
  organization?: { slug?: string };
}

export interface SentryOrg {
  id: string;
  slug: string;
  name?: string;
}

export async function listOrgs(api: SentryApi): Promise<SentryOrg[]> {
  return api.request<SentryOrg[]>("/organizations/", {
    paginate: true,
    limit: 100,
  });
}

export async function listProjects(api: SentryApi): Promise<SentryProject[]> {
  return api.request<SentryProject[]>(`/organizations/${api.org}/projects/`, {
    paginate: true,
    limit: 100,
  });
}

export async function getProject(
  api: SentryApi,
  project: string,
): Promise<SentryProject> {
  return api.request<SentryProject>(`/projects/${api.org}/${project}/`);
}

// --- Transactions ---

export interface TransactionRow {
  transaction: string;
  /** Milliseconds. */
  p50: number;
  /** Milliseconds. */
  p95: number;
  count: number;
  /**
   * Failure rate as a **percentage** (0-100), not the raw ratio.
   *
   * Discover returns `failure_rate()` as a ratio in [0,1]. Rounding that to the
   * same one decimal place as the millisecond durations would collapse every
   * failure rate under 5% to `0.0` - so a checkout endpoint failing 3.1% of
   * requests would be reported to the agent as failing 0%, and it would
   * conclude the endpoint is healthy. Scale to a percentage first.
   */
  failurePct: number;
}

interface DiscoverResponse {
  data?: Array<Record<string, unknown>>;
}

/** Coerce to a number, tolerating the stringified numerics Sentry sometimes sends. */
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Round to `decimals` places. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function parseTransactions(
  response: DiscoverResponse,
): TransactionRow[] {
  return (response.data ?? []).map((row) => ({
    transaction: String(row.transaction ?? "<unknown>"),
    p50: round(num(row["p50()"]), 1),
    p95: round(num(row["p95()"]), 1),
    count: round(num(row["count()"]), 0),
    failurePct: round(num(row["failure_rate()"]) * 100, 2),
  }));
}

/**
 * Slowest transactions by p95. Discover needs a *numeric* project id, not a
 * slug, so callers resolve the project first - which is also why this takes
 * `projectId` rather than reading `api.project`.
 */
export async function slowestTransactions(
  api: SentryApi,
  projectId: string,
  options: { period?: string; limit?: number; query?: string } = {},
): Promise<TransactionRow[]> {
  const { period = "24h", limit = 10, query = "" } = options;

  const response = await api.request<DiscoverResponse>(
    `/organizations/${api.org}/events/`,
    {
      query: {
        field: ["transaction", "p50()", "p95()", "count()", "failure_rate()"],
        query: `event.type:transaction ${query}`.trim(),
        statsPeriod: validatePeriod(period),
        project: projectId,
        sort: "-p95",
        per_page: Math.min(limit, 100),
        dataset: "transactions",
        referrer: "sentry-axi",
      },
    },
  );

  return parseTransactions(response);
}

// --- Event volume / health ---

export interface VolumeStats {
  accepted: number;
  filtered: number;
  rateLimited: number;
  invalid: number;
  total: number;
}

interface StatsResponse {
  groups?: Array<{
    by?: Record<string, string>;
    totals?: Record<string, number>;
  }>;
}

/**
 * Fold the stats_v2 group list into a flat outcome summary. Sentry groups by
 * `outcome` (accepted / filtered / rate_limited / invalid / client_discard) and
 * an agent only cares about the totals.
 */
export function parseVolume(response: StatsResponse): VolumeStats {
  const stats: VolumeStats = {
    accepted: 0,
    filtered: 0,
    rateLimited: 0,
    invalid: 0,
    total: 0,
  };

  for (const group of response.groups ?? []) {
    const outcome = group.by?.outcome ?? "";
    // Coerced, not trusted: Sentry already sends `count` on issues as a string,
    // so a stringified quantity here would turn `+=` into string concatenation
    // and silently produce "014203" instead of a sum.
    const quantity = num(group.totals?.["sum(quantity)"]);

    stats.total += quantity;
    if (outcome === "accepted") stats.accepted += quantity;
    else if (outcome === "filtered") stats.filtered += quantity;
    else if (outcome === "rate_limited") stats.rateLimited += quantity;
    else if (outcome === "invalid") stats.invalid += quantity;
  }

  return stats;
}

export async function errorVolume(
  api: SentryApi,
  projectId: string,
  period = "24h",
): Promise<VolumeStats> {
  const response = await api.request<StatsResponse>(
    `/organizations/${api.org}/stats_v2/`,
    {
      query: {
        field: "sum(quantity)",
        groupBy: "outcome",
        category: "error",
        statsPeriod: validatePeriod(period),
        project: projectId,
      },
    },
  );

  return parseVolume(response);
}
