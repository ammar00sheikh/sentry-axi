import { describe, expect, it, vi } from "vitest";
import {
  assignIssue,
  listIssues,
  searchIssues,
  setIssueStatus,
  validatePeriod,
  validateSort,
} from "../src/issues.js";
import { SentryAxiError } from "../src/errors.js";
import type { SentryApi } from "../src/api.js";

/**
 * A `request` spy wearing SentryApi's shape. Nothing here touches the network:
 * the point of these tests is the *request* sentry-axi builds, which is what
 * decides whether the agent gets the right issues back.
 */
function fakeApi(project: string | null = "frontend"): {
  api: SentryApi;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => []);
  return {
    api: { org: "acme", project, request } as unknown as SentryApi,
    request,
  };
}

describe("validatePeriod", () => {
  it("accepts Sentry's <n>[mhdw] form", () => {
    for (const period of ["15m", "24h", "14d", "2w"]) {
      expect(validatePeriod(period)).toBe(period);
    }
  });

  it("rejects anything else before a request is spent", () => {
    // Sentry answers an unparseable statsPeriod with a 400 whose body an agent
    // has to guess at. Catching it locally costs no latency and names the fix.
    for (const bad of ["24", "h", "1y", "24 h", "", "24hh", "-1d"]) {
      expect(() => validatePeriod(bad)).toThrow(/Invalid period/);
    }
  });

  it("carries VALIDATION_ERROR and a worked example", () => {
    const error = (() => {
      try {
        validatePeriod("1y");
      } catch (e) {
        return e as SentryAxiError;
      }
      throw new Error("expected a throw");
    })();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.suggestions.length).toBeGreaterThan(0);
    expect(error.suggestions[0]).toContain("--period 24h");
  });
});

describe("validateSort", () => {
  it("accepts every sort Sentry supports", () => {
    for (const sort of ["date", "new", "freq", "user", "trends"]) {
      expect(validateSort(sort)).toBe(sort);
    }
  });

  it("rejects an unknown sort and lists the valid ones", () => {
    // `--sort freq` and `--sort user` name genuinely different issues, so a
    // typo'd sort silently answering a different question is a real hazard.
    const error = (() => {
      try {
        validateSort("frequency");
      } catch (e) {
        return e as SentryAxiError;
      }
      throw new Error("expected a throw");
    })();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("frequency");
    expect(error.suggestions.length).toBeGreaterThan(0);
    expect(error.suggestions[0]).toContain("freq");
  });
});

describe("listIssues", () => {
  it("hits the project issues endpoint with the documented defaults", () => {
    const { api, request } = fakeApi();
    return listIssues(api).then(() => {
      expect(request).toHaveBeenCalledWith("/projects/acme/frontend/issues/", {
        query: {
          query: "is:unresolved",
          statsPeriod: "24h",
          sort: "freq",
          limit: 25,
        },
        paginate: true,
        limit: 25,
      });
    });
  });

  it("threads the caller's query, period, and sort through", async () => {
    const { api, request } = fakeApi();
    await listIssues(api, {
      query: "is:unresolved level:error",
      period: "14d",
      sort: "user",
      limit: 5,
    });
    expect(request.mock.calls[0][1]).toMatchObject({
      query: {
        query: "is:unresolved level:error",
        statsPeriod: "14d",
        sort: "user",
        limit: 5,
      },
    });
  });

  it("clamps the per-page limit to Sentry's maximum of 100", async () => {
    // Sentry rejects per-page > 100. The overall `limit` still says 500,
    // because pagination is what actually collects them - clamping only the
    // page size keeps a big listing working instead of 400-ing.
    const { api, request } = fakeApi();
    await listIssues(api, { limit: 500 });
    const options = request.mock.calls[0][1] as {
      query: { limit: number };
      limit: number;
    };
    expect(options.query.limit).toBe(100);
    expect(options.limit).toBe(500);
  });

  // Sentry's issue endpoints accept ONLY 24h or 14d for statsPeriod - a real
  // 400 discovered by running against a live instance. A well-formed but
  // unsupported window like 90d must be caught here, with the actual fix
  // (filter by age in the query), not shipped as a bare 400 from Sentry.
  it("rejects a period the issue endpoints do not support, before requesting", async () => {
    const { api, request } = fakeApi();

    for (const bad of ["90d", "7d", "1h", "yesterday"]) {
      await expect(listIssues(api, { period: bad })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }

    expect(request).not.toHaveBeenCalled();
  });

  it("tells the agent to filter by age instead of just failing", async () => {
    const { api } = fakeApi();

    const error = await listIssues(api, { period: "90d" }).catch((e) => e);
    expect(error.suggestions.join(" ")).toContain("age:+30d");
  });

  it("accepts both supported windows", async () => {
    const { api, request } = fakeApi();

    await listIssues(api, { period: "24h" });
    await listIssues(api, { period: "14d" });

    expect(request.mock.calls[0][1].query.statsPeriod).toBe("24h");
    expect(request.mock.calls[1][1].query.statsPeriod).toBe("14d");
  });

  it("fails with NO_PROJECT, not a bad URL, when no project is pinned", async () => {
    // Without this guard the path would be `/projects/acme/null/issues/` and
    // Sentry would answer 404 - which reads to an agent as "the project has no
    // issues" rather than "you never told me which project".
    const { api, request } = fakeApi(null);
    const error = (await listIssues(api).catch(
      (e: unknown) => e,
    )) as SentryAxiError;
    expect(error).toBeInstanceOf(SentryAxiError);
    expect(error.code).toBe("NO_PROJECT");
    expect(error.suggestions[0]).toContain("use <org>/<project>");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("searchIssues", () => {
  it("searches org-wide, not project-scoped", async () => {
    // This is the "is this error happening anywhere else" question, so it must
    // deliberately drop the pinned project from the path.
    const { api, request } = fakeApi();
    await searchIssues(api, { query: "TypeError", period: "14d" });
    expect(request).toHaveBeenCalledWith("/organizations/acme/issues/", {
      query: {
        query: "TypeError",
        statsPeriod: "14d",
        sort: "freq",
        limit: 25,
      },
      paginate: true,
      limit: 25,
    });
  });

  it("works with no project pinned at all", async () => {
    const { api } = fakeApi(null);
    await expect(searchIssues(api, { query: "TypeError" })).resolves.toEqual(
      [],
    );
  });

  it("clamps the page size to 100 as well", async () => {
    const { api, request } = fakeApi();
    await searchIssues(api, { limit: 250 });
    expect(
      (request.mock.calls[0][1] as { query: { limit: number } }).query.limit,
    ).toBe(100);
  });
});

describe("setIssueStatus", () => {
  it("PUTs the target state, which makes it idempotent", async () => {
    // Sentry's PUT is set-to-state, not a toggle. Resolving an already-resolved
    // issue is therefore a successful no-op, so an agent retrying after a
    // network blip cannot accidentally *unresolve* what it just fixed.
    const { api, request } = fakeApi();
    await setIssueStatus(api, "4509172", "resolved");
    expect(request).toHaveBeenCalledWith("/issues/4509172/", {
      method: "PUT",
      body: { status: "resolved" },
    });

    await setIssueStatus(api, "4509172", "resolved");
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });

  it("supports ignore and unresolve through the same path", async () => {
    const { api, request } = fakeApi();
    await setIssueStatus(api, "4509172", "ignored");
    await setIssueStatus(api, "4509172", "unresolved");
    expect(
      request.mock.calls.map((call) => (call[1] as { body: unknown }).body),
    ).toEqual([{ status: "ignored" }, { status: "unresolved" }]);
  });

  it("url-encodes the issue id", async () => {
    // Short ids reach these functions too (`FRONTEND-4F`), and a slug with a
    // slash in it would otherwise silently rewrite the path.
    const { api, request } = fakeApi();
    await setIssueStatus(api, "a/b", "resolved");
    expect(request.mock.calls[0][0]).toBe("/issues/a%2Fb/");
  });
});

describe("assignIssue", () => {
  it("PUTs assignedTo with the actor string", async () => {
    const { api, request } = fakeApi();
    await assignIssue(api, "4509172", "alice@acme.com");
    expect(request).toHaveBeenCalledWith("/issues/4509172/", {
      method: "PUT",
      body: { assignedTo: "alice@acme.com" },
    });
  });

  it("accepts a team actor and an empty string to unassign", async () => {
    const { api, request } = fakeApi();
    await assignIssue(api, "4509172", "team:frontend");
    await assignIssue(api, "4509172", "");
    expect(
      request.mock.calls.map((call) => (call[1] as { body: unknown }).body),
    ).toEqual([{ assignedTo: "team:frontend" }, { assignedTo: "" }]);
  });
});
