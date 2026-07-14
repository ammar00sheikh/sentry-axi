import { describe, expect, it } from "vitest";
import { parseTransactions, parseVolume } from "../src/perf.js";

/**
 * The exact `GET /organizations/{org}/events/` (Discover) payload captured in
 * test/fixtures/api-responses.md. Note the aggregate keys: Discover returns
 * them as the *literal function name*, parentheses and all.
 */
const DISCOVER = {
  data: [
    {
      transaction: "GET /api/checkout",
      "p50()": 412.5,
      "p95()": 3180.25,
      "count()": 8421,
      "failure_rate()": 0.031,
    },
  ],
};

/** The exact `GET /organizations/{org}/stats_v2/` payload from the fixtures. */
const STATS = {
  groups: [
    { by: { outcome: "accepted" }, totals: { "sum(quantity)": 14203 } },
    { by: { outcome: "rate_limited" }, totals: { "sum(quantity)": 87 } },
    { by: { outcome: "filtered" }, totals: { "sum(quantity)": 12 } },
  ],
};

describe("parseTransactions", () => {
  it("reads the parenthesized aggregate keys Discover actually sends", () => {
    // The keys are `p95()`, not `p95`. Reading the un-parenthesized name gives
    // undefined -> 0 for every row, and the perf table prints a wall of zeroes
    // that looks like "nothing is slow".
    expect(parseTransactions(DISCOVER)).toEqual([
      {
        transaction: "GET /api/checkout",
        p50: 412.5,
        p95: 3180.3,
        count: 8421,
        failurePct: 3.1,
      },
    ]);
  });

  it("reports failure_rate as a percentage, not a one-decimal ratio", () => {
    // REGRESSION GUARD. `failure_rate()` is a ratio in [0,1], but durations are
    // float milliseconds and want one-decimal rounding. Applying that same
    // rounding to the ratio collapses every failure rate under 5% to 0.0 - so a
    // checkout endpoint failing 3.1% of requests gets reported as failing 0%,
    // and an agent asked "is checkout erroring?" confidently answers no.
    // Scale to a percentage BEFORE rounding.
    expect(parseTransactions(DISCOVER)[0].failurePct).toBe(3.1);

    // Small but real failure rates must survive.
    expect(
      parseTransactions({ data: [{ "failure_rate()": 0.0012 }] })[0].failurePct,
    ).toBe(0.12);
    expect(
      parseTransactions({ data: [{ "failure_rate()": 0.06 }] })[0].failurePct,
    ).toBe(6);
    expect(
      parseTransactions({ data: [{ "failure_rate()": 1 }] })[0].failurePct,
    ).toBe(100);
  });

  it("rounds durations to one decimal", () => {
    const [row] = parseTransactions({
      data: [{ transaction: "t", "p95()": 3180.25, "p50()": 1.04 }],
    });
    expect(row.p95).toBe(3180.3);
    expect(row.p50).toBe(1);
  });

  it("degrades missing fields to 0, never NaN", () => {
    // A NaN in the table renders as literal "NaN" and an agent cannot rank on
    // it. Discover omits a key entirely when the field has no data.
    expect(parseTransactions({ data: [{}] })).toEqual([
      {
        transaction: "<unknown>",
        p50: 0,
        p95: 0,
        count: 0,
        failurePct: 0,
      },
    ]);
  });

  it("coerces string numerics and rejects unparseable ones", () => {
    const [row] = parseTransactions({
      data: [{ transaction: "t", "count()": "8421", "p95()": "n/a" }],
    });
    expect(row.count).toBe(8421);
    expect(row.p95).toBe(0);
    expect(Number.isNaN(row.p95)).toBe(false);
  });

  it("returns an empty list for an empty or absent data array", () => {
    expect(parseTransactions({ data: [] })).toEqual([]);
    expect(parseTransactions({})).toEqual([]);
  });
});

describe("parseVolume", () => {
  it("folds the captured stats_v2 groups into an outcome summary", () => {
    // The quantity is nested under the literal key `totals["sum(quantity)"]` -
    // the same parenthesized-aggregate convention as Discover.
    expect(parseVolume(STATS)).toEqual({
      accepted: 14203,
      filtered: 12,
      rateLimited: 87,
      invalid: 0,
      total: 14302,
    });
  });

  it("maps rate_limited onto rateLimited", () => {
    // Sentry's wire name is snake_case; the rendered field is camelCase. A
    // mismatch here silently reports 0 dropped events while events are dropping.
    expect(parseVolume(STATS).rateLimited).toBe(87);
  });

  it("counts an unknown outcome in the total but in no named bucket", () => {
    // Sentry adds outcomes over time (`client_discard` is the recent one). An
    // unrecognized outcome must not be misfiled into `accepted` - that would
    // report dropped events as delivered, the exact inversion of the truth.
    const stats = parseVolume({
      groups: [
        ...STATS.groups,
        { by: { outcome: "client_discard" }, totals: { "sum(quantity)": 5 } },
      ],
    });
    expect(stats.accepted).toBe(14203);
    expect(stats.filtered).toBe(12);
    expect(stats.rateLimited).toBe(87);
    expect(stats.invalid).toBe(0);
    expect(stats.total).toBe(14307);
  });

  it("treats a group with a missing outcome or missing totals as zero", () => {
    const stats = parseVolume({
      groups: [
        { totals: { "sum(quantity)": 9 } },
        { by: { outcome: "accepted" } },
        {},
      ],
    });
    expect(stats.accepted).toBe(0);
    expect(stats.total).toBe(9);
    expect(Number.isNaN(stats.total)).toBe(false);
  });

  it("returns all-zero for an empty or absent groups array", () => {
    // "No events at all" is a legitimate answer (a quiet project, a fresh
    // window) and must come back as zeroes, not as a crash.
    const zero = {
      accepted: 0,
      filtered: 0,
      rateLimited: 0,
      invalid: 0,
      total: 0,
    };
    expect(parseVolume({ groups: [] })).toEqual(zero);
    expect(parseVolume({})).toEqual(zero);
  });

  it("sums repeated groups for the same outcome", () => {
    // stats_v2 splits by every grouping dimension asked for, so the same
    // outcome can legitimately appear more than once.
    expect(
      parseVolume({
        groups: [
          { by: { outcome: "invalid" }, totals: { "sum(quantity)": 3 } },
          { by: { outcome: "invalid" }, totals: { "sum(quantity)": 4 } },
        ],
      }).invalid,
    ).toBe(7);
  });
});
