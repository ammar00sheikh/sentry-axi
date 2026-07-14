import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_NAMES,
  TOP_HELP,
  extractGlobalFlags,
  formatError,
  getCommandHelp,
  renderUnknownCommand,
} from "../src/cli.js";
import { SentryAxiError } from "../src/errors.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extractGlobalFlags", () => {
  // The scope flags are lifted out of argv and exported as the env vars the
  // config layer already reads, so no downstream module needs plumbing. The
  // flags must therefore be honored from ANY position - an agent writes
  // `sentry-axi issues --org acme` as readily as `sentry-axi --org acme issues`.
  it("extracts --session/--org/--project from anywhere in argv", () => {
    vi.stubEnv("SENTRY_AXI_SESSION", "");
    vi.stubEnv("SENTRY_ORG", "");
    vi.stubEnv("SENTRY_PROJECT", "");

    const rest = extractGlobalFlags([
      "issues",
      "--org",
      "acme",
      "--limit",
      "5",
      "--session",
      "api",
      "--project",
      "frontend",
    ]);

    expect(rest).toEqual(["issues", "--limit", "5"]);
    expect(process.env.SENTRY_ORG).toBe("acme");
    expect(process.env.SENTRY_PROJECT).toBe("frontend");
    expect(process.env.SENTRY_AXI_SESSION).toBe("api");
  });

  it("leaves an unrelated argv untouched", () => {
    expect(extractGlobalFlags(["stacktrace", "@g1:1", "--context"])).toEqual([
      "stacktrace",
      "@g1:1",
      "--context",
    ]);
  });

  // A trailing `--org` with no value must not silently eat the next thing or
  // crash - it just stays in argv and the command's own parser reports it.
  it("passes a valueless trailing flag through rather than swallowing argv", () => {
    expect(extractGlobalFlags(["issues", "--org"])).toEqual([
      "issues",
      "--org",
    ]);
  });
});

describe("formatError", () => {
  // Errors must render in the same shape as successes. The SDK's default
  // renderer TOON-encodes the whole payload, which collapses `help` onto one
  // comma-separated line - unusable for commands an agent copies back verbatim.
  it("renders a structured error with a one-per-line help block", () => {
    const { output, exitCode } = formatError(
      new SentryAxiError("No Sentry auth token found", "AUTH_REQUIRED", [
        "Run `sentry-axi login --token <token>` to store one",
        "Or set SENTRY_AUTH_TOKEN in the environment",
      ]),
    );

    expect(output).toContain("code: AUTH_REQUIRED");
    expect(output).toContain("help[2]:");
    expect(output).toContain(
      "\n  Run `sentry-axi login --token <token>` to store one\n",
    );
    expect(output.endsWith("\n")).toBe(true);
    expect(exitCode).toBeGreaterThan(0);
  });

  it("gives an unexpected non-AxiError a code and a way forward", () => {
    const { output, exitCode } = formatError(new Error("kaboom"));

    expect(output).toContain("code: UNKNOWN");
    expect(output).toContain("doctor");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("never leaves an error without a help block", () => {
    for (const error of [
      new SentryAxiError("x", "TIMEOUT", ["retry"]),
      new SentryAxiError("x", "UNKNOWN"),
      new Error("x"),
      "a bare string",
    ]) {
      expect(formatError(error).output).toMatch(/help\[\d+\]:/);
    }
  });
});

describe("renderUnknownCommand", () => {
  it("names the command and points at the triage loop", () => {
    const output = renderUnknownCommand("frobnicate");

    expect(output).toContain("Unknown command: frobnicate");
    expect(output).toContain("code: VALIDATION_ERROR");
    expect(output).toContain("--help");
  });
});

describe("command help coverage", () => {
  // The AXI checklist requires a per-command --help entry. A command without
  // one is invisible: an agent that runs `sentry-axi <cmd> --help` gets nothing
  // and has no way to discover the flags.
  it("every registered command has a --help entry", () => {
    const missing = COMMAND_NAMES.filter((name) => !getCommandHelp(name));
    expect(missing).toEqual([]);
  });

  it("every --help entry starts with a usage line naming the command", () => {
    for (const name of COMMAND_NAMES) {
      const help = getCommandHelp(name)!;
      expect(help.startsWith(`usage: sentry-axi ${name}`)).toBe(true);
    }
  });

  it("every --help entry carries at least one worked example", () => {
    for (const name of COMMAND_NAMES) {
      expect(getCommandHelp(name)).toContain("examples:");
    }
  });

  it("returns null for a command that does not exist", () => {
    expect(getCommandHelp("frobnicate")).toBeNull();
  });
});

describe("TOP_HELP", () => {
  // src/skill.ts regexes the `commands[N]:` block straight out of TOP_HELP to
  // build SKILL.md. If the declared count drifts from reality, the skill ships
  // a command list that does not match the CLI.
  it("declares a command count matching the registered commands", () => {
    const declared = TOP_HELP.match(/^commands\[(\d+)\]:/m);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(COMMAND_NAMES.length);
  });

  it("mentions every registered command", () => {
    const block = TOP_HELP.match(/^commands\[\d+\]:\n((?: {2}.*\n)+)/m)![1];
    const missing = COMMAND_NAMES.filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(block),
    );
    expect(missing).toEqual([]);
  });

  it("documents the environment variables the config layer reads", () => {
    for (const key of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SENTRY_AXI_SESSION",
      "SENTRY_AXI_URL",
    ]) {
      expect(TOP_HELP).toContain(key);
    }
  });
});
