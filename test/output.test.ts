import { describe, expect, it } from "vitest";
import {
  compose,
  helpBlock,
  textBlock,
  toon,
  truncationNote,
} from "../src/output.js";

describe("toon", () => {
  // The tabular encoding is the whole token argument: field names are stated
  // once in the header instead of being repeated on every row the way JSON
  // does. For a 25-issue listing that is ~400 tokens instead of ~4,000.
  it("encodes an array of objects as a table with a single header", () => {
    const encoded = toon({
      issues: [
        { uid: "g1:1", level: "error", users: 89 },
        { uid: "g1:2", level: "warning", users: 12 },
      ],
    });

    expect(encoded).toContain("issues[2]{uid,level,users}:");
    // The field names appear exactly once - in the header, not per row.
    expect(encoded.match(/level/g)).toHaveLength(1);
    expect(encoded).toContain("error,89");
  });

  it("encodes a nested object as indented key/value lines", () => {
    expect(toon({ scope: { org: "acme", project: "frontend" } })).toBe(
      "scope:\n  org: acme\n  project: frontend",
    );
  });
});

describe("helpBlock", () => {
  // Suggestions are commands an agent copies back verbatim, so they must be one
  // per line. TOON would inline a string array onto a single comma-separated
  // line, which is why this is rendered by hand rather than through the encoder.
  it("renders one suggestion per line under a counted header", () => {
    const rendered = helpBlock([
      "Run `sentry-axi stacktrace @g1:1` to see where it throws",
      "Run `sentry-axi seer @g1:1` for AI root-cause analysis",
    ]);

    expect(rendered).toBe(
      "help[2]:\n" +
        "  Run `sentry-axi stacktrace @g1:1` to see where it throws\n" +
        "  Run `sentry-axi seer @g1:1` for AI root-cause analysis",
    );
  });

  it("renders nothing for no suggestions, rather than an empty help[0] block", () => {
    expect(helpBlock([])).toBe("");
  });
});

describe("compose", () => {
  it("joins blocks with exactly one newline and drops empties", () => {
    expect(compose("a:", "", undefined, null, "b:")).toBe("a:\nb:");
  });

  it("drops whitespace-only blocks", () => {
    expect(compose("a:", "   \n  ", "b:")).toBe("a:\nb:");
  });

  it("returns an empty string when every block is empty", () => {
    expect(compose(undefined, "", null)).toBe("");
  });
});

describe("textBlock", () => {
  it("labels a free-text body", () => {
    expect(textBlock("stacktrace", "  > UserCard at a.tsx:42")).toBe(
      "stacktrace:\n  > UserCard at a.tsx:42",
    );
  });
});

describe("truncationNote", () => {
  // Silently capping output is how an agent ends up confidently reasoning about
  // half a stack trace. If we truncate, we say so and say how to see the rest.
  it("says how much was dropped and how to see it", () => {
    const note = truncationNote(37);
    expect(note).toContain("37 more lines");
    expect(note).toContain("--full");
  });

  it("renders nothing when nothing was truncated", () => {
    expect(truncationNote(0)).toBe("");
    expect(truncationNote(-1)).toBe("");
  });
});
