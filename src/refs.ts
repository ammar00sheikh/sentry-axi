/**
 * uid -> entity registry.
 *
 * Listing commands (`issues`, `search`, `events`, `releases`, `projects`) mint
 * short generation-stamped uids - `@g3:12` - and persist what each one points
 * at in refs.json in the session state dir, so action commands in later
 * short-lived CLI processes can translate a uid back into a Sentry id without
 * the agent ever having to echo a 19-digit numeric issue id.
 *
 * ## Why these refs do not go stale the way flutter-axi's do
 *
 * flutter-axi wipes its registry on every snapshot and hard-fails older refs
 * with STALE_REF, because its refs resolve to *positional widget finders*: the
 * tree re-renders, and the widget that used to be at that finder may now be a
 * different button. Acting on a stale one is dangerous.
 *
 * Sentry refs resolve to *immutable entity ids*. `@g1:3` -> issue `4509` means
 * issue 4509 forever; re-running `issues` cannot make that ref point somewhere
 * else. Hard-failing it would just force a pointless re-listing before every
 * `resolve`, which is the exact chattiness an AXI exists to remove.
 *
 * So the registry **accumulates** across generations and keeps the last
 * `RETAINED_GENERATIONS` of them. A ref from a recent generation resolves
 * normally; one older than the window is pruned and reports STALE_REF, which
 * is a real signal ("that listing is long gone, re-run `issues`") rather than
 * a safety trip.
 *
 * The escape hatch is the same idea as flutter-axi's finder strings: an agent
 * that already knows an identifier can bypass the registry entirely with
 * `short:PROJECT-4F`, `id:4509`, or a pasted Sentry URL.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";
import { SentryAxiError } from "./errors.js";

/** How many generations of refs stay resolvable. */
export const RETAINED_GENERATIONS = 5;

export type RefKind = "issue" | "event" | "release" | "project" | "transaction";

export interface Ref {
  kind: RefKind;
  /** The canonical Sentry id (issue id, event id, release version, slug). */
  id: string;
  /** Human-readable short id (e.g. `FRONTEND-4F`) when the entity has one. */
  shortId?: string;
  /** One-line label, used in errors and suggestions so they read naturally. */
  label?: string;
  /** Generation this uid was minted in. */
  generation: number;
}

export interface RefsFile {
  generation: number;
  refs: Record<string, Ref>;
}

function refsFile(session?: string): string {
  return join(resolveSessionStateDir(session), "refs.json");
}

export function readRefs(session?: string): RefsFile | null {
  const file = refsFile(session);
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (
      data === null ||
      typeof data !== "object" ||
      typeof data.generation !== "number" ||
      data.refs === null ||
      typeof data.refs !== "object"
    ) {
      return null;
    }
    return data as RefsFile;
  } catch {
    return null;
  }
}

/**
 * Merge a generation's freshly minted refs into the registry, pruning any
 * whose generation has fallen outside the retention window.
 */
export function writeRefs(
  generation: number,
  minted: Record<string, Ref>,
  session?: string,
): void {
  const existing = readRefs(session);
  const cutoff = generation - RETAINED_GENERATIONS + 1;
  const merged: Record<string, Ref> = {};

  for (const [uid, ref] of Object.entries(existing?.refs ?? {})) {
    if (ref.generation >= cutoff) merged[uid] = ref;
  }
  Object.assign(merged, minted);

  const file = refsFile(session);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ generation, refs: merged }));
  // rename is atomic on POSIX - concurrent readers never see a torn write.
  renameSync(tmp, file);
}

/** Look up the entity for a uid; null when unknown. */
export function lookupRef(uid: string, session?: string): Ref | null {
  const data = readRefs(session);
  if (!data) return null;
  return data.refs[uid] ?? null;
}

/** Format a uid for printing: `g<generation>:<index>`. */
export function formatUid(generation: number, index: number): string {
  return `g${generation}:${index}`;
}

/** Parse the generation out of a printed uid; null when malformed. */
export function parseUidGeneration(uid: string): number | null {
  const m = uid.match(/^g(\d+):\d+$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

// --- Direct identifier escape hatch ---

/**
 * Parse a bare identifier that bypasses the uid registry:
 *   short:FRONTEND-4F   -> issue by short id
 *   id:4509172          -> issue (or event) by canonical id
 *   https://acme.sentry.io/issues/4509172/  -> issue id lifted from the URL
 *
 * Returns null when the string is not a direct identifier, in which case the
 * caller falls through to the uid registry.
 */
export function parseIdentifier(arg: string): Ref | null {
  const url = arg.match(
    /^https?:\/\/[^/]+\/(?:organizations\/[^/]+\/)?issues\/(\d+)/,
  );
  if (url) {
    return { kind: "issue", id: url[1], generation: 0 };
  }

  const m = arg.match(/^(short|id):(.+)$/s);
  if (!m) return null;

  const value = m[2].trim();
  if (value.length === 0) return null;

  return m[1] === "short"
    ? { kind: "issue", id: value, shortId: value, generation: 0 }
    : { kind: "issue", id: value, generation: 0 };
}

/**
 * Resolve a command argument to an entity: a direct identifier, a `@uid` ref,
 * or a bare uid. Fails loudly - never silently guesses - so an agent that
 * passed a ref from a pruned listing is told to re-list rather than acting on
 * the wrong issue.
 */
export function resolveRefArg(
  arg: string,
  expected: RefKind,
  session?: string,
): Ref {
  const direct = parseIdentifier(arg);
  if (direct) return { ...direct, kind: expected };

  const uid = arg.startsWith("@") ? arg.slice(1) : arg;
  const found = lookupRef(uid, session);
  if (found) return found;

  const generation = parseUidGeneration(uid);
  const current = readRefs(session);

  if (
    generation !== null &&
    current !== null &&
    generation < current.generation - RETAINED_GENERATIONS + 1
  ) {
    throw new SentryAxiError(
      `Ref @${uid} is from generation ${generation}, older than the ${RETAINED_GENERATIONS} retained generations (current: g${current.generation})`,
      "STALE_REF",
      [
        "Run `sentry-axi issues` to re-list and mint fresh refs",
        "Or address the issue directly: `short:<SHORT-ID>` or `id:<numeric id>`",
      ],
    );
  }

  throw new SentryAxiError(`Unknown ref @${uid}`, "REF_NOT_FOUND", [
    "Run `sentry-axi issues` to list issues and mint refs",
    "Or address the issue directly: `short:<SHORT-ID>` or `id:<numeric id>`",
  ]);
}
