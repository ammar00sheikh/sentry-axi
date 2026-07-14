import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RETAINED_GENERATIONS,
  formatUid,
  lookupRef,
  parseIdentifier,
  parseUidGeneration,
  readRefs,
  resolveRefArg,
  writeRefs,
  type Ref,
} from "../src/refs.js";
import {
  bumpGeneration,
  getCurrentGeneration,
  resetGeneration,
} from "../src/generation.js";

let home: string;

beforeEach(() => {
  // Never touch the real ~/.sentry-axi.
  home = mkdtempSync(join(tmpdir(), "sentry-axi-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function ref(id: string, generation: number, shortId?: string): Ref {
  return { kind: "issue", id, generation, ...(shortId ? { shortId } : {}) };
}

describe("uid formatting", () => {
  it("round-trips a uid's generation", () => {
    expect(formatUid(3, 12)).toBe("g3:12");
    expect(parseUidGeneration("g3:12")).toBe(3);
  });

  it("rejects a malformed uid rather than guessing", () => {
    expect(parseUidGeneration("12")).toBeNull();
    expect(parseUidGeneration("gX:1")).toBeNull();
    expect(parseUidGeneration("")).toBeNull();
  });
});

describe("generation counter", () => {
  it("starts at zero and increments across processes", () => {
    expect(getCurrentGeneration()).toBe(0);
    expect(bumpGeneration()).toBe(1);
    expect(bumpGeneration()).toBe(2);
    expect(getCurrentGeneration()).toBe(2);
  });

  it("resets cleanly", () => {
    bumpGeneration();
    resetGeneration();
    expect(getCurrentGeneration()).toBe(0);
  });
});

describe("refs registry", () => {
  it("persists and reads back refs", () => {
    writeRefs(1, { "g1:1": ref("4509", 1, "FRONT-4F") });

    const found = lookupRef("g1:1");
    expect(found?.id).toBe("4509");
    expect(found?.shortId).toBe("FRONT-4F");
  });

  // This is the deliberate divergence from flutter-axi. Its refs resolve to
  // positional widget finders, so a re-render can make an old ref point at a
  // different widget - it MUST hard-fail. A Sentry ref resolves to an immutable
  // issue id, so keeping it valid across a re-listing is safe, and forcing a
  // re-list before every `resolve` would be exactly the chattiness an AXI exists
  // to remove.
  it("keeps refs from earlier generations resolvable", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });
    writeRefs(2, { "g2:1": ref("200", 2) });
    writeRefs(3, { "g3:1": ref("300", 3) });

    expect(lookupRef("g1:1")?.id).toBe("100");
    expect(lookupRef("g3:1")?.id).toBe("300");
    expect(resolveRefArg("@g1:1", "issue").id).toBe("100");
  });

  it("prunes refs older than the retention window", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });

    // Push the window past generation 1.
    for (let g = 2; g <= RETAINED_GENERATIONS + 1; g++) {
      writeRefs(g, { [`g${g}:1`]: ref(`${g}00`, g) });
    }

    expect(lookupRef("g1:1")).toBeNull();
    expect(readRefs()?.generation).toBe(RETAINED_GENERATIONS + 1);
  });

  it("reports a pruned ref as STALE_REF, telling the agent to re-list", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });
    for (let g = 2; g <= RETAINED_GENERATIONS + 1; g++) {
      writeRefs(g, { [`g${g}:1`]: ref(`${g}00`, g) });
    }

    const error = (() => {
      try {
        resolveRefArg("@g1:1", "issue");
      } catch (e) {
        return e as { code: string; suggestions: string[] };
      }
    })();

    expect(error?.code).toBe("STALE_REF");
    expect(error?.suggestions.join(" ")).toContain("issues");
  });

  it("reports an invented ref as REF_NOT_FOUND", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });

    const error = (() => {
      try {
        resolveRefArg("@g1:99", "issue");
      } catch (e) {
        return e as { code: string };
      }
    })();

    expect(error?.code).toBe("REF_NOT_FOUND");
  });

  it("accepts a uid with or without the @ prefix", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });
    expect(resolveRefArg("g1:1", "issue").id).toBe("100");
    expect(resolveRefArg("@g1:1", "issue").id).toBe("100");
  });

  it("survives a corrupt refs.json instead of crashing the CLI", () => {
    writeRefs(1, { "g1:1": ref("100", 1) });
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(home, ".sentry-axi", "refs.json"), "{not json");

    expect(readRefs()).toBeNull();
    expect(lookupRef("g1:1")).toBeNull();
  });
});

describe("direct identifier escape hatch", () => {
  // Agents paste short ids straight out of Sentry alert emails, and issue URLs
  // straight out of a chat message. Neither should require a listing first.
  it("parses a short id", () => {
    expect(parseIdentifier("short:FRONTEND-4F")).toMatchObject({
      kind: "issue",
      id: "FRONTEND-4F",
      shortId: "FRONTEND-4F",
    });
  });

  it("parses a numeric id", () => {
    expect(parseIdentifier("id:4509172")).toMatchObject({ id: "4509172" });
  });

  it("lifts the issue id out of a pasted Sentry URL", () => {
    expect(
      parseIdentifier("https://acme.sentry.io/issues/4509172/"),
    ).toMatchObject({
      id: "4509172",
    });
    expect(
      parseIdentifier(
        "https://acme.sentry.io/organizations/acme/issues/4509172/events/latest/",
      ),
    ).toMatchObject({ id: "4509172" });
  });

  it("returns null for a plain uid so it falls through to the registry", () => {
    expect(parseIdentifier("@g1:2")).toBeNull();
    expect(parseIdentifier("g1:2")).toBeNull();
  });

  it("resolves a direct identifier without consulting the registry at all", () => {
    // No refs written - this must still work.
    expect(resolveRefArg("short:FRONTEND-4F", "issue").shortId).toBe(
      "FRONTEND-4F",
    );
  });
});
