import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeUrl,
  parseScopeArg,
  parseSentryClirc,
  parseSentryProperties,
  readScope,
  requireConfig,
  resolveApiUrl,
  resolveScope,
  resolveToken,
  writeScope,
  writeToken,
} from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sentry-axi-cfg-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // A developer's real Sentry env must not leak into the tests.
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv("SENTRY_AXI_TOKEN", "");
  vi.stubEnv("SENTRY_ORG", "");
  vi.stubEnv("SENTRY_PROJECT", "");
  vi.stubEnv("SENTRY_AXI_URL", "");
  vi.stubEnv("SENTRY_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("parseSentryClirc", () => {
  // sentry-axi reads the official CLI's own config files so a repo already set
  // up for sentry-cli needs zero sentry-axi configuration.
  it("parses sections into flat section.key entries", () => {
    const parsed = parseSentryClirc(
      [
        "[auth]",
        "token=sntrys_abc",
        "",
        "[defaults]",
        "org = acme",
        "project= frontend",
      ].join("\n"),
    );

    expect(parsed["auth.token"]).toBe("sntrys_abc");
    expect(parsed["defaults.org"]).toBe("acme");
    expect(parsed["defaults.project"]).toBe("frontend");
  });

  it("skips comments and blank lines", () => {
    const parsed = parseSentryClirc(
      ["# a comment", "; another", "[auth]", "token=x", ""].join("\n"),
    );
    expect(parsed["auth.token"]).toBe("x");
    expect(Object.keys(parsed)).toHaveLength(1);
  });

  it("keeps '=' inside a value (tokens can contain it)", () => {
    const parsed = parseSentryClirc(["[auth]", "token=abc=def=="].join("\n"));
    expect(parsed["auth.token"]).toBe("abc=def==");
  });

  it("handles an empty file", () => {
    expect(parseSentryClirc("")).toEqual({});
  });
});

describe("parseSentryProperties", () => {
  it("parses the wizard-generated properties format", () => {
    const parsed = parseSentryProperties(
      [
        "defaults.org=acme",
        "defaults.project=backend",
        "auth.token=sntrys_x",
      ].join("\n"),
    );
    expect(parsed["defaults.org"]).toBe("acme");
    expect(parsed["defaults.project"]).toBe("backend");
  });

  it("accepts a colon separator and skips ! comments", () => {
    const parsed = parseSentryProperties(
      ["! comment", "defaults.org: acme"].join("\n"),
    );
    expect(parsed["defaults.org"]).toBe("acme");
  });
});

describe("parseScopeArg", () => {
  it("splits org/project", () => {
    expect(parseScopeArg("acme/frontend")).toEqual({
      org: "acme",
      project: "frontend",
    });
  });

  // A bare value is a project within the org you already pinned - this is what
  // makes `sentry-axi use backend` work as a quick project switch.
  it("treats a bare value as a project", () => {
    expect(parseScopeArg("frontend")).toEqual({
      org: null,
      project: "frontend",
    });
  });

  it("tolerates whitespace", () => {
    expect(parseScopeArg("  acme / frontend ")).toEqual({
      org: "acme",
      project: "frontend",
    });
  });
});

describe("normalizeUrl", () => {
  it("strips trailing slashes so URL joining stays predictable", () => {
    expect(normalizeUrl("https://sentry.io/")).toBe("https://sentry.io");
    expect(normalizeUrl("https://sentry.io///")).toBe("https://sentry.io");
    expect(normalizeUrl("https://sentry.io")).toBe("https://sentry.io");
  });
});

describe("token resolution", () => {
  it("finds nothing when nothing is configured", () => {
    expect(resolveToken()).toBeNull();
  });

  it("reads a stored token", () => {
    writeToken("sntrys_stored");
    expect(resolveToken()).toBe("sntrys_stored");
  });

  // The env var must win, or CI (which sets SENTRY_AUTH_TOKEN) would silently
  // use a developer's stale stored token instead.
  it("prefers SENTRY_AUTH_TOKEN over a stored token", () => {
    writeToken("sntrys_stored");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_env");
    expect(resolveToken()).toBe("sntrys_env");
  });
});

describe("scope resolution", () => {
  it("reads back a scope pinned by `use`", () => {
    writeScope({ org: "acme", project: "frontend" });
    expect(readScope()).toEqual({ org: "acme", project: "frontend" });

    const scope = resolveScope();
    expect(scope.org).toBe("acme");
    expect(scope.project).toBe("frontend");
  });

  it("lets an explicit override beat the pinned scope", () => {
    writeScope({ org: "acme", project: "frontend" });
    const scope = resolveScope({ org: null, project: "backend" });
    expect(scope.project).toBe("backend");
    expect(scope.org).toBe("acme");
  });

  it("lets env beat the pinned scope", () => {
    writeScope({ org: "acme", project: "frontend" });
    vi.stubEnv("SENTRY_PROJECT", "mobile");
    expect(resolveScope().project).toBe("mobile");
  });
});

describe("resolveApiUrl", () => {
  it("defaults to sentry.io", () => {
    expect(resolveApiUrl()).toBe("https://sentry.io");
  });

  it("honors a self-hosted URL and strips its trailing slash", () => {
    vi.stubEnv("SENTRY_AXI_URL", "https://sentry.internal.acme.com/");
    expect(resolveApiUrl()).toBe("https://sentry.internal.acme.com");
  });
});

describe("requireConfig", () => {
  // These are the two errors an agent is most likely to hit first, so each has
  // to say exactly which command fixes it - not just "unauthorized".
  it("throws AUTH_REQUIRED with a login suggestion when there is no token", () => {
    const error = (() => {
      try {
        requireConfig();
      } catch (e) {
        return e as { code: string; suggestions: string[] };
      }
    })();

    expect(error?.code).toBe("AUTH_REQUIRED");
    expect(error?.suggestions.join(" ")).toContain("sentry-axi login");
  });

  it("throws NO_PROJECT naming the `use` command when the org is missing", () => {
    writeToken("sntrys_x");

    const error = (() => {
      try {
        requireConfig();
      } catch (e) {
        return e as { code: string; suggestions: string[] };
      }
    })();

    expect(error?.code).toBe("NO_PROJECT");
    expect(error?.suggestions.join(" ")).toContain("sentry-axi use");
  });

  it("allows a missing project for org-wide commands", () => {
    writeToken("sntrys_x");
    writeScope({ org: "acme", project: null });

    const config = requireConfig(
      { org: null, project: null },
      { requireProject: false },
    );
    expect(config.org).toBe("acme");
    expect(config.project).toBeNull();
  });

  it("returns a complete config once auth and scope are set", () => {
    writeToken("sntrys_x");
    writeScope({ org: "acme", project: "frontend" });

    expect(requireConfig()).toEqual({
      token: "sntrys_x",
      url: "https://sentry.io",
      org: "acme",
      project: "frontend",
    });
  });
});

describe("self-hosted: the URL is stored with the token", () => {
  // REGRESSION GUARD, found by running `login` against a real self-hosted
  // instance. A token is only valid against the instance that ISSUED it, so
  // storing the token without the URL meant login verified it against
  // sentry.io - where it means nothing - and told the user "Invalid token".
  // The token was fine. There was no way to even tell login about a custom host.
  it("persists the URL alongside the token and prefers it over the default", () => {
    writeToken("sntryu_selfhosted", "https://sentry.acme.com");

    expect(resolveToken()).toBe("sntryu_selfhosted");
    expect(resolveApiUrl()).toBe("https://sentry.acme.com");
  });

  it("normalizes a trailing slash on the stored URL", () => {
    writeToken("t", "https://sentry.acme.com/");
    expect(resolveApiUrl()).toBe("https://sentry.acme.com");
  });

  it("still defaults to sentry.io when no URL was given", () => {
    writeToken("t");
    expect(resolveApiUrl()).toBe("https://sentry.io");
  });

  it("lets the environment override the stored URL", () => {
    // CI sets SENTRY_AXI_URL; it must beat whatever a developer logged into.
    writeToken("t", "https://sentry.acme.com");
    vi.stubEnv("SENTRY_AXI_URL", "https://sentry.other.com");
    expect(resolveApiUrl()).toBe("https://sentry.other.com");
  });
});
