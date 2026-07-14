import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  abbreviateCount,
  extractBreadcrumbs,
  extractExceptions,
  formatCount,
  formatFrameLocation,
  formatTime,
  relativeAge,
  renderBreadcrumbs,
  renderExceptionChain,
  renderStacktrace,
  summarizeIssue,
  truncateText,
  type SentryEvent,
  type SentryException,
  type SentryIssue,
} from "../src/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const event = JSON.parse(
  readFileSync(join(here, "fixtures", "event.json"), "utf-8"),
) as SentryEvent;

describe("extractExceptions", () => {
  it("pulls the exception chain out of the entries array", () => {
    const exceptions = extractExceptions(event);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].type).toBe("TypeError");
  });

  it("returns empty for an event with no exception entry", () => {
    expect(extractExceptions({ entries: [] })).toEqual([]);
    expect(extractExceptions({})).toEqual([]);
  });
});

describe("renderStacktrace", () => {
  const exception = extractExceptions(event)[0];

  it("prints the crashing frame first", () => {
    // Sentry stores frames oldest-caller-first, so UserCard (the thrower) is
    // LAST in the payload. Getting this backwards is the single most damaging
    // rendering bug possible: the agent would go edit react-dom.
    const lines = renderStacktrace(exception).split("\n");
    expect(lines[0]).toContain("UserCard");
    expect(lines[0]).toContain("app/components/UserCard.tsx:42");
    expect(lines[0].trim().startsWith(">")).toBe(true);
  });

  it("collapses consecutive library frames by default", () => {
    const rendered = renderStacktrace(exception);
    expect(rendered).toContain("... 2 library frames");
    expect(rendered).not.toContain("renderWithHooks");
  });

  it("keeps every in-app frame", () => {
    const rendered = renderStacktrace(exception);
    expect(rendered).toContain("UserCard");
    expect(rendered).toContain("Profile");
  });

  it("shows library frames under --full", () => {
    const rendered = renderStacktrace(exception, { full: true });
    expect(rendered).toContain("renderWithHooks");
    expect(rendered).toContain("beginWork");
    expect(rendered).toContain("(lib)");
    expect(rendered).not.toContain("library frames");
  });

  it("includes source context only for the crashing frame when asked", () => {
    const rendered = renderStacktrace(exception, { contextLines: true });
    expect(rendered).toContain("42 |");
    expect(rendered).toContain("{user.name}");
    // The context belongs to the crash frame; Profile must not sprout one.
    expect(rendered).not.toContain("18 |");
  });

  it("handles an exception with no stack trace", () => {
    expect(renderStacktrace({ type: "Error" })).toContain("no stack trace");
  });

  it("singularizes a single collapsed library frame", () => {
    const single: SentryException = {
      type: "Error",
      stacktrace: {
        frames: [
          { filename: "lib.js", function: "helper", lineNo: 1, inApp: false },
          { filename: "app.ts", function: "main", lineNo: 2, inApp: true },
        ],
      },
    };
    expect(renderStacktrace(single)).toContain("... 1 library frame");
    expect(renderStacktrace(single)).not.toContain("1 library frames");
  });
});

describe("renderExceptionChain", () => {
  it("marks an unhandled exception", () => {
    const rendered = renderExceptionChain(event);
    expect(rendered).toContain(
      "TypeError: Cannot read properties of undefined",
    );
    expect(rendered).toContain("[unhandled]");
  });

  it("labels nested causes", () => {
    const chained: SentryEvent = {
      entries: [
        {
          type: "exception",
          data: {
            values: [
              { type: "ConnectionError", value: "socket closed" },
              { type: "QueryError", value: "could not run query" },
            ],
          },
        },
      ],
    };
    const rendered = renderExceptionChain(chained);
    // Sentry orders the chain cause-first, so the thrown one (QueryError) leads
    // and ConnectionError is reported as its cause.
    expect(rendered.indexOf("QueryError")).toBeLessThan(
      rendered.indexOf("ConnectionError"),
    );
    expect(rendered).toContain("caused by ConnectionError");
  });

  it("falls back to the message for a non-exception event", () => {
    const message: SentryEvent = {
      entries: [
        { type: "message", data: { formatted: "payment webhook retried" } },
      ],
    };
    expect(renderExceptionChain(message)).toBe(
      "message: payment webhook retried",
    );
  });
});

describe("renderBreadcrumbs", () => {
  it("renders the trail oldest-first, ending at the crash", () => {
    const crumbs = extractBreadcrumbs(event);
    const lines = renderBreadcrumbs(crumbs).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("navigation");
    expect(lines[2]).toContain("[error]");
  });

  it("synthesizes a message for HTTP crumbs, which carry none", () => {
    const rendered = renderBreadcrumbs(extractBreadcrumbs(event));
    expect(rendered).toContain("GET /api/users/1042 -> 200");
  });

  it("notes how many earlier crumbs were dropped", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      timestamp: "2026-07-14T08:00:00.000Z",
      category: "console",
      message: `line ${i}`,
    }));
    const rendered = renderBreadcrumbs(many, 5);
    expect(rendered).toContain("... 25 earlier breadcrumbs");
    expect(rendered).toContain("line 29");
    expect(rendered).not.toContain("line 24");
  });

  it("handles an event with no breadcrumbs", () => {
    expect(renderBreadcrumbs([])).toContain("no breadcrumbs");
  });
});

describe("counts", () => {
  it("parses Sentry's string counts", () => {
    // Sentry sends `count` as a string. Treating it as a number silently
    // yields NaN and the issue table prints garbage.
    expect(formatCount("1247")).toBe(1247);
    expect(formatCount(89)).toBe(89);
    expect(formatCount(undefined)).toBe(0);
    expect(formatCount("not-a-number")).toBe(0);
  });

  it("abbreviates large counts", () => {
    expect(abbreviateCount(999)).toBe("999");
    expect(abbreviateCount(1247)).toBe("1.2k");
    expect(abbreviateCount(2000)).toBe("2k");
    expect(abbreviateCount(1_500_000)).toBe("1.5M");
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  it("renders coarse relative ages", () => {
    expect(relativeAge("2026-07-14T11:59:30.000Z", now)).toBe("30s");
    expect(relativeAge("2026-07-14T11:30:00.000Z", now)).toBe("30m");
    expect(relativeAge("2026-07-14T09:00:00.000Z", now)).toBe("3h");
    expect(relativeAge("2026-07-11T12:00:00.000Z", now)).toBe("3d");
  });

  it("survives missing and malformed timestamps", () => {
    expect(relativeAge(undefined, now)).toBe("-");
    expect(relativeAge("never", now)).toBe("-");
  });

  it("never renders a negative age for a clock-skewed future timestamp", () => {
    expect(relativeAge("2026-07-14T12:05:00.000Z", now)).toBe("0s");
  });
});

describe("formatFrameLocation", () => {
  it("falls back through filename -> absPath -> module", () => {
    expect(formatFrameLocation({ filename: "a.ts", lineNo: 4 })).toBe("a.ts:4");
    expect(formatFrameLocation({ absPath: "/tmp/a.ts", lineNo: 4 })).toBe(
      "/tmp/a.ts:4",
    );
    expect(formatFrameLocation({ module: "app.core" })).toBe("app.core");
    expect(formatFrameLocation({})).toBe("<unknown>");
  });

  it("omits the line number when Sentry has none", () => {
    expect(formatFrameLocation({ filename: "a.ts", lineNo: null })).toBe(
      "a.ts",
    );
  });
});

describe("summarizeIssue", () => {
  const issue: SentryIssue = {
    id: "4509172",
    shortId: "FRONTEND-4F",
    title: "TypeError: undefined",
    culprit: "app/components/UserCard",
    level: "error",
    count: "1247",
    userCount: 89,
    isUnhandled: true,
    lastSeen: new Date().toISOString(),
  };

  it("summarizes to the fields the issue table prints", () => {
    const summary = summarizeIssue(issue);
    expect(summary.shortId).toBe("FRONTEND-4F");
    expect(summary.events).toBe("1.2k");
    expect(summary.users).toBe(89);
    expect(summary.unhandled).toBe(true);
  });

  it("falls back to the numeric id and metadata when fields are absent", () => {
    const sparse = summarizeIssue({ id: "1", metadata: { value: "boom" } });
    expect(sparse.shortId).toBe("1");
    expect(sparse.title).toBe("boom");
    expect(sparse.level).toBe("error");
  });
});

describe("truncateText", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");

  it("caps output and reports how much was dropped", () => {
    const result = truncateText(text, 4, false);
    expect(result.text.split("\n")).toHaveLength(4);
    expect(result.truncated).toBe(6);
  });

  it("passes everything through under --full", () => {
    expect(truncateText(text, 4, true)).toEqual({ text, truncated: 0 });
  });

  it("does not truncate when already short enough", () => {
    expect(truncateText("one\ntwo", 5, false).truncated).toBe(0);
  });
});

describe("formatTime", () => {
  it("keeps only the wall-clock portion", () => {
    expect(formatTime("2026-07-14T08:59:58.100Z")).toBe("08:59:58");
    expect(formatTime("garbage")).toBe("garbage");
  });
});
