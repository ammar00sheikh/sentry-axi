/**
 * Rendering: raw Sentry JSON -> the compact text an agent actually reads.
 *
 * This module is where the token savings live. A single Sentry event payload
 * is routinely 50-200KB of JSON: every frame carries `vars`, `context` source
 * lines, module paths, instruction addresses, and a dozen redundant id fields.
 * Handing that to an agent is what makes raw-MCP Sentry access so expensive.
 *
 * Everything here is a pure function over already-parsed JSON, so it is
 * unit-tested against the captured payloads in `test/fixtures/api-responses.md`
 * with no network involved.
 */

import type { Ref } from "./refs.js";

// --- Sentry shapes (only the fields sentry-axi actually reads) ---

export interface SentryIssue {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  permalink?: string;
  level?: string;
  status?: string;
  substatus?: string | null;
  platform?: string;
  isUnhandled?: boolean;
  /** Sentry sends the event count as a *string*. */
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  assignedTo?: { name?: string; email?: string; type?: string } | null;
  metadata?: {
    type?: string;
    value?: string;
    filename?: string;
    function?: string;
  };
  project?: { slug?: string };
}

export interface SentryFrame {
  filename?: string;
  absPath?: string;
  module?: string;
  function?: string;
  lineNo?: number | null;
  colNo?: number | null;
  inApp?: boolean;
  context?: Array<[number, string]>;
}

export interface SentryException {
  type?: string;
  value?: string;
  module?: string;
  mechanism?: { type?: string; handled?: boolean | null } | null;
  stacktrace?: { frames?: SentryFrame[] } | null;
}

export interface SentryBreadcrumb {
  timestamp?: string;
  type?: string;
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SentryEntry {
  type: string;
  data: unknown;
}

export interface SentryEvent {
  id?: string;
  eventID?: string;
  groupID?: string;
  title?: string;
  message?: string;
  platform?: string;
  dateCreated?: string;
  entries?: SentryEntry[];
  tags?: Array<{ key: string; value: string }>;
  contexts?: Record<string, Record<string, unknown>>;
  user?: {
    id?: string;
    email?: string;
    username?: string;
    ip_address?: string;
  } | null;
  sdk?: { name?: string; version?: string };
  release?: { version?: string } | null;
}

// --- Entry extraction ---

function findEntry(event: SentryEvent, type: string): unknown {
  return event.entries?.find((entry) => entry.type === type)?.data ?? null;
}

/**
 * Pull the exception chain out of an event. Sentry nests it under
 * `entries[type=exception].data.values`, ordered outermost-cause-first.
 */
export function extractExceptions(event: SentryEvent): SentryException[] {
  const data = findEntry(event, "exception") as {
    values?: SentryException[];
  } | null;
  return data?.values ?? [];
}

export function extractBreadcrumbs(event: SentryEvent): SentryBreadcrumb[] {
  const data = findEntry(event, "breadcrumbs") as {
    values?: SentryBreadcrumb[];
  } | null;
  return data?.values ?? [];
}

/** The human message for a non-exception (log/message) event. */
export function extractMessage(event: SentryEvent): string | null {
  const data = findEntry(event, "message") as { formatted?: string } | null;
  return data?.formatted ?? event.message ?? null;
}

// --- Frame rendering ---

/** `app/components/UserCard.tsx:42` - the location an agent needs to open. */
export function formatFrameLocation(frame: SentryFrame): string {
  const file = frame.filename || frame.absPath || frame.module || "<unknown>";
  if (frame.lineNo === null || frame.lineNo === undefined) return file;
  return `${file}:${frame.lineNo}`;
}

/**
 * Render one exception's stack trace.
 *
 * Two deliberate choices, both of which change how well an agent can act on it:
 *
 * 1. **Frames are reversed.** Sentry stores them oldest-caller-first, so the
 *    frame that actually threw is LAST in the array. Agents consistently read
 *    the first line as the culprit, so we print crash-frame-first and label it.
 *
 * 2. **In-app frames are kept, library frames are collapsed.** A React stack is
 *    90% `node_modules/react-dom` frames that no agent can fix. We print every
 *    `inApp` frame and collapse consecutive non-app runs into one
 *    `... N library frames` line, unless `full` is set.
 */
export function renderStacktrace(
  exception: SentryException,
  options: { full?: boolean; contextLines?: boolean } = {},
): string {
  const { full = false, contextLines = false } = options;
  const frames = [...(exception.stacktrace?.frames ?? [])].reverse();

  if (frames.length === 0) {
    return "  <no stack trace on this event>";
  }

  const lines: string[] = [];
  let collapsed = 0;

  const flush = () => {
    if (collapsed > 0) {
      lines.push(
        `  ... ${collapsed} library frame${collapsed === 1 ? "" : "s"}`,
      );
      collapsed = 0;
    }
  };

  frames.forEach((frame, index) => {
    const isApp = frame.inApp === true;

    if (!isApp && !full) {
      collapsed++;
      return;
    }
    flush();

    const marker = index === 0 ? ">" : " ";
    const fn = frame.function || "<anonymous>";
    const tag = isApp ? "" : "  (lib)";
    lines.push(`  ${marker} ${fn} at ${formatFrameLocation(frame)}${tag}`);

    // Source context is the single biggest payload multiplier - opt-in only,
    // and only for the crashing frame, which is the one worth seeing inline.
    if (contextLines && index === 0 && frame.context?.length) {
      for (const [lineNo, text] of frame.context) {
        const hit = lineNo === frame.lineNo ? ">" : " ";
        lines.push(`      ${hit} ${lineNo} | ${text}`);
      }
    }
  });

  flush();
  return lines.join("\n");
}

/**
 * Render the whole exception chain of an event, newest cause first, each with
 * its stack. This is what `sentry-axi stacktrace @ref` prints.
 */
export function renderExceptionChain(
  event: SentryEvent,
  options: { full?: boolean; contextLines?: boolean } = {},
): string {
  const exceptions = extractExceptions(event);

  if (exceptions.length === 0) {
    const message = extractMessage(event);
    return message
      ? `message: ${message}`
      : "<this event carries no exception and no message>";
  }

  // Sentry orders the chain cause-first; the thrown exception is last.
  return [...exceptions]
    .reverse()
    .map((exception, index) => {
      const type = exception.type || "Error";
      const value = exception.value ? `: ${exception.value}` : "";
      const heading =
        index === 0 ? `${type}${value}` : `caused by ${type}${value}`;
      const handled = exception.mechanism?.handled;
      const suffix =
        handled === false
          ? "  [unhandled]"
          : handled === true
            ? "  [handled]"
            : "";

      return `${heading}${suffix}\n${renderStacktrace(exception, options)}`;
    })
    .join("\n\n");
}

// --- Breadcrumb rendering ---

/**
 * Breadcrumbs as a compact trail, oldest first, ending at the crash. Sentry
 * attaches up to 100 and each one is a fat object; we keep timestamp, category,
 * level, and message, and drop the rest.
 */
export function renderBreadcrumbs(
  crumbs: SentryBreadcrumb[],
  limit = 20,
): string {
  if (crumbs.length === 0) return "<no breadcrumbs on this event>";

  const tail = crumbs.slice(-limit);
  const dropped = crumbs.length - tail.length;

  const lines = tail.map((crumb) => {
    const time = crumb.timestamp ? formatTime(crumb.timestamp) : "--:--:--";
    const category = crumb.category || crumb.type || "default";
    const level =
      crumb.level && crumb.level !== "info" ? ` [${crumb.level}]` : "";
    const message = crumb.message || describeCrumbData(crumb.data) || "";
    return `  ${time}  ${category}${level}  ${message}`.trimEnd();
  });

  if (dropped > 0) {
    lines.unshift(
      `  ... ${dropped} earlier breadcrumb${dropped === 1 ? "" : "s"}`,
    );
  }

  return lines.join("\n");
}

/** HTTP breadcrumbs carry no message - synthesize one from `data`. */
function describeCrumbData(data?: Record<string, unknown>): string | null {
  if (!data) return null;
  const method = data.method;
  const url = data.url;
  const status = data.status_code;
  if (typeof url === "string") {
    const verb = typeof method === "string" ? `${method} ` : "";
    const code = status === undefined || status === null ? "" : ` -> ${status}`;
    return `${verb}${url}${code}`;
  }
  return null;
}

/** `2026-07-14T09:12:03.482Z` -> `09:12:03`. */
export function formatTime(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : iso;
}

// --- Issue rendering ---

/** Sentry sends counts as strings; normalize and keep them readable. */
export function formatCount(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** `1247` -> `1.2k`, so a wide issue table stays narrow. */
export function abbreviateCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Coarse relative age (`3h`, `2d`). Sentry timestamps are absolute; an agent
 * triaging "what broke recently" only ever needs the relative form.
 */
export function relativeAge(
  iso: string | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "-";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";

  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** The one-line summary an agent reads to decide whether to dig in. */
export function summarizeIssue(issue: SentryIssue): {
  shortId: string;
  level: string;
  title: string;
  culprit: string;
  events: string;
  users: number;
  lastSeen: string;
  unhandled: boolean;
} {
  return {
    shortId: issue.shortId ?? issue.id,
    level: issue.level ?? "error",
    title: issue.title ?? issue.metadata?.value ?? "<untitled>",
    culprit: issue.culprit ?? issue.metadata?.filename ?? "-",
    events: abbreviateCount(formatCount(issue.count)),
    users: issue.userCount ?? 0,
    lastSeen: relativeAge(issue.lastSeen),
    unhandled: issue.isUnhandled === true,
  };
}

/** Build the ref an issue is minted as, for the refs registry. */
export function issueRef(issue: SentryIssue, generation: number): Ref {
  return {
    kind: "issue",
    id: issue.id,
    ...(issue.shortId ? { shortId: issue.shortId } : {}),
    label: issue.title ?? issue.metadata?.value ?? issue.id,
    generation,
  };
}

// --- Truncation ---

/**
 * Cap a rendered block. Every snapshot-producing command accepts `--full` to
 * bypass this; the default keeps an accidental 5000-frame trace from blowing
 * the agent's context window.
 */
export function truncateText(
  text: string,
  maxLines: number,
  full: boolean,
): { text: string; truncated: number } {
  if (full) return { text, truncated: 0 };

  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: 0 };

  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: lines.length - maxLines,
  };
}
