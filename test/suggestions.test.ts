import { describe, expect, it } from "vitest";
import { getSuggestions, type SuggestedIssue } from "../src/suggestions.js";

const TOP: SuggestedIssue = {
  uid: "g1:1",
  shortId: "FRONTEND-4F",
  title: "TypeError: Cannot read properties of undefined (reading 'name')",
  unhandled: true,
};

/** Every command that mints a `help[N]:` block, with the context it mints it in. */
const COMMANDS = [
  "issues",
  "search",
  "issue",
  "stacktrace",
  "seer",
  "suspect",
  "resolve",
  "ignore",
  "assign",
  "breadcrumbs",
  "tags",
  "events",
  "perf",
  "releases",
  "projects",
  "orgs",
  "some-unmapped-command",
];

describe("getSuggestions", () => {
  it("never leaves the agent at a dead end", () => {
    // A response with no next step is where an agent stops and reports failure.
    // Every command - including one the switch has no case for - must hand back
    // at least one thing to try.
    for (const command of COMMANDS) {
      const lines = getSuggestions({ command, issues: [TOP] });
      expect(
        lines.length,
        `command "${command}" produced no suggestions`,
      ).toBeGreaterThan(0);
    }
  });

  it("drives the triage loop from a listing: stacktrace -> issue -> seer", () => {
    // The ordering is the product: "what is broken" should lead the agent to
    // "where does it throw", not to a docs page.
    const lines = getSuggestions({ command: "issues", issues: [TOP] });
    expect(lines[0]).toContain("stacktrace @g1:1");
    expect(lines[0]).toContain("FRONTEND-4F");
    expect(lines.join("\n")).toContain("seer @g1:1");
  });

  it("embeds the actual uid it was handed, so the agent copies back the printed form", () => {
    // Refs carry a generation prefix (`g3:2`). If the suggestion printed a bare
    // index the agent would compose `@2`, get REF_NOT_FOUND, and have to guess.
    const lines = getSuggestions({
      command: "stacktrace",
      issues: [{ uid: "g7:12" }],
    });
    for (const line of lines.filter((l) => l.includes("@"))) {
      expect(line).toContain("@g7:12");
    }
    expect(lines.join("\n")).not.toContain("@undefined");
  });

  it("suggests widening the window instead of giving up on an empty result", () => {
    // "0 issues" is the most common place an agent concludes the task is done
    // when really it is looking at the wrong window or the wrong project.
    const lines = getSuggestions({ command: "issues", empty: true });
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("--period 14d");
    expect(joined).toContain("widen");
    expect(joined).toContain("projects");
  });

  it("still offers a way forward on an empty non-listing command", () => {
    const lines = getSuggestions({ command: "perf", empty: true });
    expect(lines).toEqual([
      "Run `sentry-axi issues` to see what is currently broken",
    ]);
  });

  it("threads a non-default session into every suggested command", () => {
    // Sessions hold independent scopes and independent refs. A suggestion that
    // dropped `--session api` would resolve @g1:1 against the *default*
    // session's registry and either 404 or - far worse - hit a different issue.
    const lines = getSuggestions({
      command: "issues",
      issues: [TOP],
      session: "api",
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("sentry-axi --session api ");
    }
    expect(lines.join("\n")).toContain(
      "`sentry-axi --session api issues --query",
    );
  });

  it("carries the session into the empty-result branch too", () => {
    const lines = getSuggestions({
      command: "issues",
      empty: true,
      session: "web",
    });
    for (const line of lines) {
      expect(line).toContain("--session web");
    }
  });

  it("omits the selector for the default session", () => {
    const lines = getSuggestions({
      command: "issues",
      issues: [TOP],
      session: "default",
    });
    expect(lines.join("\n")).not.toContain("--session");
  });

  it("teaches the ref-free escape hatch whenever refs are in play", () => {
    // A short id pasted out of an alert email needs no listing at all. Agents
    // do not discover `short:` on their own, so every ref-bearing response says it.
    const lines = getSuggestions({ command: "issue", issues: [TOP] });
    const joined = lines.join("\n");
    expect(joined).toContain("short:<SHORT-ID>");
    expect(joined).toContain("id:<numeric id>");
  });

  it("closes the loop after a mutation", () => {
    for (const command of ["resolve", "ignore", "assign"]) {
      expect(getSuggestions({ command }).join("\n")).toContain("issues");
    }
  });

  it("points a completed Seer run at the fix, then at resolve", () => {
    const lines = getSuggestions({ command: "seer", issues: [TOP] });
    expect(lines.join("\n")).toContain("stacktrace @g1:1 --context");
    expect(lines.join("\n")).toContain("resolve @g1:1");
  });

  it("labels the stacktrace suggestion even when the issue has no short id", () => {
    const lines = getSuggestions({
      command: "issues",
      issues: [{ uid: "g1:1" }],
    });
    expect(lines[0]).toBe(
      "Run `sentry-axi stacktrace @g1:1` to see where throws",
    );
  });
});
