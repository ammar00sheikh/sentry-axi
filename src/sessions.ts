/**
 * Named sessions - per-session scope isolation.
 *
 * A session pins one Sentry scope: an org, a project, and the API base URL.
 * Setting `SENTRY_AXI_SESSION` (or passing `--session <name>` on any command)
 * to a non-default name binds the on-disk state (scope, snapshot-generation
 * counter, uid->entity refs) to that name, so an agent can hold several
 * project scopes at once without them stepping on each other's refs:
 *
 *   sentry-axi --session web use acme/frontend
 *   sentry-axi --session api use acme/backend
 *   sentry-axi --session api issues
 *
 * This is the direct analogue of flutter-axi's `--app` sessions. The
 * difference is that sentry-axi has no bridge process: Sentry is a stateless
 * HTTPS API, so a session is purely on-disk scope + refs, and needs no port.
 *
 * The default session name is "default", stored in `~/.sentry-axi/`.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SESSION_NAME = "default";

const STATE_DIR_NAME = ".sentry-axi";

/**
 * Resolve the active session name from `SENTRY_AXI_SESSION`. Returns
 * DEFAULT_SESSION_NAME when unset, empty, or whitespace.
 *
 * A configured-but-unsafe name throws (via `validateSessionName`). This is the
 * single chokepoint through which every command obtains the active session, so
 * validating here guarantees that no entry point - the scope store, the
 * generation counter, or the refs registry - can resolve an invalid name into a
 * filesystem path that escapes or collapses onto the default session's dir.
 */
export function resolveSessionName(): string {
  const raw = process.env.SENTRY_AXI_SESSION?.trim();
  const name = raw && raw.length > 0 ? raw : DEFAULT_SESSION_NAME;
  validateSessionName(name);
  return name;
}

/**
 * Throw if a non-default session name is unsafe for a filesystem path. Allows
 * 1-64 chars from `[A-Za-z0-9._-]`; rejects path traversal, separators, shell
 * metacharacters, overlong names, and names made only of dots (`.` / `..`),
 * which `resolveSessionStateDir` would otherwise collapse onto the default
 * session's state directory.
 */
export function validateSessionName(name: string): void {
  if (name === DEFAULT_SESSION_NAME) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid session name "${name}": use 1-64 chars from [A-Za-z0-9._-]`,
    );
  }
  if (/^\.+$/.test(name)) {
    throw new Error(
      `Invalid session name "${name}": a name made only of dots would collapse onto the default session's state directory`,
    );
  }
}

/** Resolve an explicit session name (validated) or the ambient one. */
export function resolveSession(session?: string): string {
  if (session === undefined) return resolveSessionName();
  const name = session.trim();
  if (name.length === 0) return resolveSessionName();
  validateSessionName(name);
  return name;
}

/**
 * State directory for a session. The default session uses `~/.sentry-axi/`;
 * named sessions live under a per-name subdirectory.
 */
export function resolveSessionStateDir(
  name: string = resolveSessionName(),
): string {
  const base = join(homedir(), STATE_DIR_NAME);
  return name === DEFAULT_SESSION_NAME ? base : join(base, "sessions", name);
}
