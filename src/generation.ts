/**
 * Snapshot generation persistence. The counter survives across CLI
 * invocations (which are short-lived processes) by writing to a file in the
 * session state dir. Every listing command bumps the counter, so each printed
 * ref carries the generation it was minted in (`@g3:12`).
 *
 * Unlike flutter-axi, an older generation is not automatically invalid - see
 * `refs.ts` for why Sentry refs survive a re-listing.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

/** Path to a session's snapshot-generation counter file. */
function genFile(session?: string): string {
  return join(resolveSessionStateDir(session), "snapshot-generation");
}

export function getCurrentGeneration(session?: string): number {
  const file = genFile(session);
  try {
    if (!existsSync(file)) return 0;
    const parsed = Number.parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

export function bumpGeneration(session?: string): number {
  const next = getCurrentGeneration(session) + 1;
  const file = genFile(session);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(next));
  } catch {
    // Best-effort: a write failure still returns the bumped value so the
    // current invocation stays self-consistent. The next process re-reads the
    // on-disk value; the worst case is a reused generation label, not a hang.
  }
  return next;
}

export function resetGeneration(session?: string): void {
  const file = genFile(session);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
}
