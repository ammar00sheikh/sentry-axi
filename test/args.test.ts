import { describe, expect, it } from "vitest";
import {
  flagBool,
  flagInt,
  flagString,
  parseArgs,
  requirePositional,
} from "../src/args.js";
import { SentryAxiError } from "../src/errors.js";

describe("parseArgs", () => {
  it("splits positionals from valued flags", () => {
    const parsed = parseArgs(["@g1:2", "--period", "14d", "--sort", "freq"]);
    expect(parsed.positional).toEqual(["@g1:2"]);
    expect(parsed.flags).toEqual({ period: "14d", sort: "freq" });
  });

  it("does not let a boolean flag swallow the next token", () => {
    // `stacktrace --full @g1:2` is the shape an agent naturally types. Without
    // the declared boolean set, `--full` would eat `@g1:2` as its value and the
    // agent would get "missing issue" instead of the trace it asked for - a
    // baffling error with no relationship to what it did wrong.
    const parsed = parseArgs(["--full", "@g1:2"], ["full"]);
    expect(parsed.flags.full).toBe(true);
    expect(parsed.positional).toEqual(["@g1:2"]);
  });

  it("accepts the --key=value form", () => {
    const parsed = parseArgs(["--query=is:unresolved level:error"]);
    expect(parsed.flags.query).toBe("is:unresolved level:error");
    expect(parsed.positional).toEqual([]);
  });

  it("takes --key=value even for a declared boolean", () => {
    // `--full=false` is not meaningful to sentry-axi, but the `=` form must not
    // be misparsed into `true`; whatever the user wrote is preserved verbatim.
    const parsed = parseArgs(["--full=yes"], ["full"]);
    expect(parsed.flags.full).toBe("yes");
    expect(flagBool(parsed, "full")).toBe(false);
  });

  it("passes everything after `--` through verbatim", () => {
    // `monitor run <slug> -- npm run build` must hand the child command to
    // sentry-cli untouched: its own `--flags` belong to the child, not to us.
    const parsed = parseArgs(
      [
        "nightly-build",
        "--environment",
        "prod",
        "--",
        "npm",
        "run",
        "build",
        "--silent",
      ],
      ["full"],
    );
    expect(parsed.flags).toEqual({ environment: "prod" });
    expect(parsed.positional).toEqual([
      "nightly-build",
      "npm",
      "run",
      "build",
      "--silent",
    ]);
  });

  it("treats a bare `--` at the end as an empty passthrough", () => {
    const parsed = parseArgs(["slug", "--"]);
    expect(parsed.positional).toEqual(["slug"]);
  });

  it("throws VALIDATION_ERROR when a valued flag has no value", () => {
    // Caught here, before any network call, so the agent pays no latency for a
    // typo and gets a code it can branch on.
    let thrown: unknown;
    try {
      parseArgs(["--period"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SentryAxiError);
    expect((thrown as SentryAxiError).code).toBe("VALIDATION_ERROR");
    expect((thrown as SentryAxiError).suggestions.length).toBeGreaterThan(0);
  });

  it("throws when a valued flag is followed by another flag", () => {
    // `--period --sort freq` is a dropped value, not a period of "--sort".
    expect(() => parseArgs(["--period", "--sort", "freq"])).toThrow(
      /--period needs a value/,
    );
  });

  it("returns empty structures for no args", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});

describe("flagString / flagBool", () => {
  const parsed = parseArgs(["--query", "is:unresolved", "--full"], ["full"]);

  it("reads valued flags as strings and absent ones as undefined", () => {
    expect(flagString(parsed, "query")).toBe("is:unresolved");
    expect(flagString(parsed, "nope")).toBeUndefined();
  });

  it("never reports a boolean flag as a string", () => {
    // flagString must not hand `true` back as a value - callers pass its result
    // straight into query params, and `?query=true` would silently return the
    // wrong issues rather than failing.
    expect(flagString(parsed, "full")).toBeUndefined();
  });

  it("reads boolean flags", () => {
    expect(flagBool(parsed, "full")).toBe(true);
    expect(flagBool(parsed, "query")).toBe(false);
    expect(flagBool(parsed, "nope")).toBe(false);
  });
});

describe("flagInt", () => {
  it("parses a positive integer and falls back when absent", () => {
    expect(flagInt(parseArgs(["--limit", "50"]), "limit", 25)).toBe(50);
    expect(flagInt(parseArgs([]), "limit", 25)).toBe(25);
  });

  it("rejects non-numbers, zero, and negatives", () => {
    // A limit of 0 or -1 would produce an empty or nonsensical Sentry query
    // that looks like "nothing is broken" - failing loudly is the safer answer.
    expect(() => flagInt(parseArgs(["--limit", "many"]), "limit", 25)).toThrow(
      /positive integer/,
    );
    expect(() => flagInt(parseArgs(["--limit", "0"]), "limit", 25)).toThrow();
    expect(() => flagInt(parseArgs(["--limit", "-5"]), "limit", 25)).toThrow();
  });

  it("carries a code and recovery suggestions on the error", () => {
    let thrown: unknown;
    try {
      flagInt(parseArgs(["--limit", "many"]), "limit", 25);
    } catch (error) {
      thrown = error;
    }
    const err = thrown as SentryAxiError;
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.suggestions.length).toBeGreaterThan(0);
    // The example must show the flag actually being fixed, not generic prose.
    expect(err.suggestions[0]).toContain("--limit 25");
  });
});

describe("requirePositional", () => {
  it("returns the positional at the index", () => {
    const parsed = parseArgs(["@g1:2", "alice@acme.com"]);
    expect(requirePositional(parsed, 0, "issue ref")).toBe("@g1:2");
    expect(requirePositional(parsed, 1, "assignee")).toBe("alice@acme.com");
  });

  it("names the missing argument and forwards the caller's suggestions", () => {
    let thrown: unknown;
    try {
      requirePositional(
        parseArgs([]),
        0,
        "issue ref",
        "Run `sentry-axi issues` first",
      );
    } catch (error) {
      thrown = error;
    }
    const err = thrown as SentryAxiError;
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("issue ref");
    expect(err.suggestions).toEqual(["Run `sentry-axi issues` first"]);
  });

  it("treats a whitespace-only positional as missing", () => {
    // A quoted empty string (`stacktrace ""`) is a user error, not a ref.
    expect(() => requirePositional(parseArgs(["  "]), 0, "issue ref")).toThrow(
      /Missing required argument/,
    );
  });
});
