import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SESSION_NAME,
  resolveSession,
  resolveSessionName,
  resolveSessionStateDir,
  validateSessionName,
} from "../src/sessions.js";

// Every state path is derived from the home directory, so point HOME at a tmp
// dir: no test may read or write the developer's real ~/.sentry-axi.
const HOME = mkdtempSync(join(tmpdir(), "sentry-axi-sessions-"));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSessionName", () => {
  it("defaults when SENTRY_AXI_SESSION is unset, empty, or whitespace", () => {
    vi.stubEnv("SENTRY_AXI_SESSION", "");
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
    vi.stubEnv("SENTRY_AXI_SESSION", "   ");
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
    vi.stubEnv("SENTRY_AXI_SESSION", undefined);
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it("trims a configured name", () => {
    vi.stubEnv("SENTRY_AXI_SESSION", "  api  ");
    expect(resolveSessionName()).toBe("api");
  });

  it("validates the ambient name too, not just an explicit --session", () => {
    // This is the single chokepoint every command goes through to learn its
    // session. If a poisoned SENTRY_AXI_SESSION got past it, the scope store,
    // the generation counter, and the refs registry would each build a path
    // from it independently - so it has to be rejected exactly once, here.
    vi.stubEnv("SENTRY_AXI_SESSION", "../../etc");
    expect(() => resolveSessionName()).toThrow(/Invalid session name/);
  });
});

describe("validateSessionName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["api", "web", "acme-frontend", "team_1", "v1.2", "a"]) {
      expect(() => validateSessionName(name)).not.toThrow();
    }
  });

  it("accepts the reserved default name", () => {
    expect(() => validateSessionName(DEFAULT_SESSION_NAME)).not.toThrow();
  });

  it("rejects path separators and traversal", () => {
    // The name is concatenated into a filesystem path. `../../` would let a
    // session name write state outside ~/.sentry-axi entirely.
    for (const name of ["../etc", "a/b", "a\\b", "/abs", "..%2f", "a/../b"]) {
      expect(() => validateSessionName(name), name).toThrow(
        /Invalid session name/,
      );
    }
  });

  it("rejects a name made only of dots", () => {
    // `.` and `..` pass no separator check but `join(base, "sessions", ".")`
    // collapses back onto the parent - a named session would then silently
    // share (and clobber) the default session's refs and scope. Dots-only names
    // are the one traversal that survives a naive character filter.
    for (const name of [".", "..", "...", "...."]) {
      expect(() => validateSessionName(name), name).toThrow(
        /collapse onto the default session/,
      );
    }
  });

  it("rejects shell metacharacters and whitespace", () => {
    for (const name of [
      "a b",
      "a;rm -rf /",
      "a$(id)",
      "a|b",
      "a&b",
      "a`b`",
      "a'b",
      'a"b',
      "*",
    ]) {
      expect(() => validateSessionName(name), name).toThrow(
        /Invalid session name/,
      );
    }
  });

  it("rejects an empty name and one longer than 64 chars", () => {
    expect(() => validateSessionName("")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("a".repeat(64))).not.toThrow();
    expect(() => validateSessionName("a".repeat(65))).toThrow(
      /Invalid session name/,
    );
  });

  it("rejects non-ASCII and NUL bytes", () => {
    expect(() => validateSessionName("café")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("a\0b")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("a\nb")).toThrow(/Invalid session name/);
  });
});

describe("resolveSession", () => {
  it("prefers an explicit name over the ambient one", () => {
    vi.stubEnv("SENTRY_AXI_SESSION", "api");
    expect(resolveSession("web")).toBe("web");
    expect(resolveSession(" web ")).toBe("web");
  });

  it("falls back to the ambient name for undefined or blank", () => {
    // `--session ""` is a mistake, not a request for a session named "". Falling
    // back keeps it from minting a state dir with an empty path component.
    vi.stubEnv("SENTRY_AXI_SESSION", "api");
    expect(resolveSession(undefined)).toBe("api");
    expect(resolveSession("")).toBe("api");
    expect(resolveSession("   ")).toBe("api");
  });

  it("validates an explicit name", () => {
    expect(() => resolveSession("../../etc")).toThrow(/Invalid session name/);
    expect(() => resolveSession("..")).toThrow(
      /collapse onto the default session/,
    );
  });
});

describe("resolveSessionStateDir", () => {
  it("puts the default session at ~/.sentry-axi", () => {
    vi.stubEnv("HOME", HOME);
    vi.stubEnv("USERPROFILE", HOME);
    expect(resolveSessionStateDir(DEFAULT_SESSION_NAME)).toBe(
      join(HOME, ".sentry-axi"),
    );
  });

  it("nests a named session under sessions/<name>", () => {
    // Named sessions must be strictly *below* the default session's dir, never
    // beside or on top of it: that containment is what keeps two agents holding
    // two projects at once from colliding on refs.
    vi.stubEnv("HOME", HOME);
    vi.stubEnv("USERPROFILE", HOME);
    expect(resolveSessionStateDir("api")).toBe(
      join(HOME, ".sentry-axi", "sessions", "api"),
    );
  });

  it("defaults to the ambient session name", () => {
    vi.stubEnv("HOME", HOME);
    vi.stubEnv("USERPROFILE", HOME);
    vi.stubEnv("SENTRY_AXI_SESSION", "web");
    expect(resolveSessionStateDir()).toBe(
      join(HOME, ".sentry-axi", "sessions", "web"),
    );
  });

  it("gives every distinct session a distinct directory", () => {
    vi.stubEnv("HOME", HOME);
    vi.stubEnv("USERPROFILE", HOME);
    const dirs = ["default", "api", "web"].map((name) =>
      resolveSessionStateDir(name),
    );
    expect(new Set(dirs).size).toBe(3);
  });
});
