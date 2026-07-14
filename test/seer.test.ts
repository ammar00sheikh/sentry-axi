import { describe, expect, it, vi } from "vitest";
import {
  extractInsights,
  isTerminal,
  parseSeerState,
  runSeer,
  type SeerResponse,
  type SeerStep,
} from "../src/seer.js";
import { SentryAxiError } from "../src/errors.js";
import type { SentryApi } from "../src/api.js";

/**
 * The exact `GET /issues/{id}/autofix/` payload captured in
 * test/fixtures/api-responses.md. Seer's step shape is the least stable thing
 * in the Sentry API, so the parser is tested against the real bytes.
 */
const SEER_PAYLOAD: SeerResponse = {
  autofix: {
    run_id: 90210,
    status: "COMPLETED",
    steps: [
      {
        id: "root_cause_analysis",
        type: "root_cause_analysis",
        title: "Root cause",
        status: "COMPLETED",
        causes: [
          {
            description:
              "`user` is undefined when the profile route renders before the fetch resolves.",
            markdown:
              "The `UserCard` component reads `user.name` without a null guard. On a cold navigation, `Profile.tsx:18` renders `UserCard` with `user === undefined` because the `/api/users/:id` request has not resolved yet.",
          },
        ],
      },
      {
        id: "solution",
        type: "solution",
        title: "Solution",
        status: "COMPLETED",
        solution: [
          "Guard the render: return a skeleton while `user` is undefined, or make `Profile` suspend until the fetch resolves.",
        ],
      },
    ],
    changes: [],
  },
};

/** A `request` spy shaped like SentryApi, so no test touches the network. */
function fakeApi(
  request: (path: string, options?: unknown) => Promise<unknown>,
): { api: SentryApi; request: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(request);
  return {
    api: {
      org: "acme",
      project: "frontend",
      request: spy,
    } as unknown as SentryApi,
    request: spy,
  };
}

describe("parseSeerState", () => {
  it("normalizes the captured autofix payload", () => {
    const state = parseSeerState(SEER_PAYLOAD);
    expect(state.status).toBe("COMPLETED");
    expect(state.steps).toHaveLength(2);
    expect(state.runId).toBe(90210);
  });

  it("treats a null/absent autofix as a run still spinning up", () => {
    // Sentry returns `{"autofix": null}` in the window between the POST landing
    // and the first step existing. Reporting that as an error would make the
    // agent give up on a run that is about to produce an answer.
    expect(parseSeerState({ autofix: null })).toEqual({
      status: "PROCESSING",
      steps: [],
    });
    expect(parseSeerState(null).status).toBe("PROCESSING");
  });

  it("omits changes and runId when the payload has none", () => {
    const state = parseSeerState({ autofix: { status: "PROCESSING" } });
    expect("changes" in state).toBe(false);
    expect("runId" in state).toBe(false);
  });
});

describe("isTerminal", () => {
  it("recognizes every finished status", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("ERROR")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("NEED_MORE_INFORMATION")).toBe(true);
  });

  it("keeps polling for in-flight and unknown statuses", () => {
    // An unrecognized status must NOT be treated as terminal: a new Sentry
    // status we have never seen most likely means "still working", and stopping
    // early would hand the agent a half-finished analysis as if it were final.
    expect(isTerminal("PROCESSING")).toBe(false);
    expect(isTerminal("SOME_NEW_SENTRY_STATUS")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isTerminal("completed")).toBe(true);
  });
});

describe("extractInsights", () => {
  it("pulls the prose out of the captured root-cause step", () => {
    const insights = extractInsights(SEER_PAYLOAD.autofix!.steps![0]);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toContain("reads `user.name` without a null guard");
  });

  it("pulls the prose out of the captured solution step", () => {
    const insights = extractInsights(SEER_PAYLOAD.autofix!.steps![1]);
    expect(insights).toEqual([
      "Guard the render: return a skeleton while `user` is undefined, or make `Profile` suspend until the fetch resolves.",
    ]);
  });

  it("accepts prose under any of the known keys", () => {
    // Seer's steps have been renamed and re-typed across releases and the text
    // lands under a different key per step type. Matching a strict schema would
    // mean the command starts printing nothing the day Sentry ships a rename;
    // walking defensively means it keeps working.
    const shapes: SeerStep[] = [
      { causes: ["a plain string"] },
      { causes: [{ markdown: "markdown key" }] },
      { causes: [{ description: "description key" }] },
      { causes: [{ title: "title key" }] },
      { causes: [{ insight: "insight key" }] },
      { causes: [{ cause: "cause key" }] },
      { causes: [{ text: "text key" }] },
    ];
    expect(shapes.map((step) => extractInsights(step)[0])).toEqual([
      "a plain string",
      "markdown key",
      "description key",
      "title key",
      "insight key",
      "cause key",
      "text key",
    ]);
  });

  it("collects across causes, insights, and solution, in that order", () => {
    expect(
      extractInsights({
        causes: [{ markdown: "why" }],
        insights: ["observed", { description: "also observed" }],
        solution: [{ markdown: "fix" }],
      }),
    ).toEqual(["why", "observed", "also observed", "fix"]);
  });

  it("prefers markdown over the other keys on the same object", () => {
    // Seer sends a short `description` and a long `markdown` for the same
    // cause. The markdown is the one worth spending the agent's tokens on.
    expect(
      extractInsights({ causes: [{ description: "short", markdown: "long" }] }),
    ).toEqual(["long"]);
  });

  it("falls back to the step description only when nothing else was found", () => {
    expect(extractInsights({ description: "fallback" })).toEqual(["fallback"]);
    expect(
      extractInsights({ causes: ["real"], description: "fallback" }),
    ).toEqual(["real"]);
  });

  it("degrades to fewer insights - never throws - on an unrecognized shape", () => {
    // This is the whole contract of the module: a Sentry shape change must cost
    // the agent some prose, not crash the `seer` command mid-triage.
    const alien = {
      causes: [{ some_new_key: { nested: "prose" } }, 42, null, [[["deep"]]]],
      // A future Sentry could send a bare string where an array is documented.
      insights: "not-an-array",
      solution: [{}, ""],
    } as unknown as SeerStep;
    expect(() => extractInsights(alien)).not.toThrow();
    expect(extractInsights(alien)).toEqual(["deep", "not-an-array"]);
  });

  it("returns an empty list for an empty step", () => {
    expect(extractInsights({})).toEqual([]);
    expect(extractInsights({ causes: [], insights: [], solution: [] })).toEqual(
      [],
    );
  });

  it("drops whitespace-only prose", () => {
    expect(extractInsights({ causes: ["   ", "real"] })).toEqual(["real"]);
  });
});

describe("runSeer", () => {
  const noSleep = async (): Promise<void> => {};

  it("returns an already-completed run without starting a new one", async () => {
    // Seer runs cost real money and tens of seconds. Re-running one that has
    // already answered would make `seer @ref` slow and non-idempotent, when it
    // should be a cheap re-read of the result the agent already paid for.
    const { api, request } = fakeApi(async () => SEER_PAYLOAD);

    const state = await runSeer(api, "4509172", { sleep: noSleep });

    expect(state.status).toBe("COMPLETED");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/issues/4509172/autofix/");
    // No POST was issued.
    expect(
      request.mock.calls.some(
        (call) =>
          (call[1] as { method?: string } | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("starts a run when there are no steps yet, then polls until terminal", async () => {
    const statuses = ["PROCESSING", "PROCESSING", "COMPLETED"];
    let get = -1;
    const { api, request } = fakeApi(async (path, options) => {
      const method = (options as { method?: string } | undefined)?.method;
      if (method === "POST") return {};
      get++;
      if (get === 0) return { autofix: null }; // no run yet
      return {
        autofix: {
          status: statuses[Math.min(get - 1, statuses.length - 1)],
          steps: [{ id: "root_cause_analysis" }],
        },
      };
    });

    const state = await runSeer(api, "4509172", {
      sleep: noSleep,
      pollIntervalMs: 1,
      timeoutMs: 60_000,
    });

    expect(state.status).toBe("COMPLETED");
    const posts = request.mock.calls.filter(
      (call) => (call[1] as { method?: string } | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/issues/4509172/autofix/");
    // 1 initial GET + 1 POST + 3 polling GETs.
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("throws TIMEOUT with a longer-wait suggestion once the deadline passes", async () => {
    // The run keeps going server-side, so the recovery is "wait longer" or
    // "just re-run later" - not "Seer failed". Saying the wrong one sends the
    // agent off to debug an analysis that is about to succeed.
    let clock = 0;
    const { api } = fakeApi(async () => ({
      autofix: { status: "PROCESSING", steps: [{ id: "s" }] },
    }));

    const error = (await runSeer(api, "4509172", {
      timeoutMs: 10_000,
      pollIntervalMs: 3_000,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    }).catch((e: unknown) => e)) as SentryAxiError;

    expect(error).toBeInstanceOf(SentryAxiError);
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toContain("10s");
    expect(error.message).toContain("PROCESSING");
    expect(error.suggestions.length).toBeGreaterThan(0);
    expect(error.suggestions.join("\n")).toContain("--timeout");
  });

  it("returns a terminal-but-failed run rather than throwing", async () => {
    // ERROR / NEED_MORE_INFORMATION are answers, not exceptions - the renderer
    // shows the agent what Seer got stuck on.
    const { api } = fakeApi(async () => ({
      autofix: {
        status: "ERROR",
        steps: [{ id: "s", description: "no trace" }],
      },
    }));
    const state = await runSeer(api, "4509172", { sleep: noSleep });
    expect(state.status).toBe("ERROR");
  });
});
