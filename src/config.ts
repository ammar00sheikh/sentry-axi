/**
 * Auth token, API base URL, and org/project scope resolution.
 *
 * sentry-axi deliberately reads the *same* config files the official
 * `sentry-cli` already uses (`.sentryclirc`, `sentry.properties`), so a repo
 * that is already set up for Sentry needs zero sentry-axi configuration - the
 * agent runs `sentry-axi issues` and it just works.
 *
 * Precedence, highest first:
 *   token   - SENTRY_AUTH_TOKEN > SENTRY_AXI_TOKEN > ~/.sentry-axi/auth.json
 *             > ./.sentryclirc > ~/.sentryclirc
 *   url     - SENTRY_AXI_URL > SENTRY_URL > ./.sentryclirc > https://sentry.io
 *   scope   - --org/--project flags > SENTRY_ORG/SENTRY_PROJECT
 *             > the session's scope.json (set by `use`) > ./.sentryclirc
 *             > ./sentry.properties
 *
 * The parsers are pure and exported so they can be unit-tested against the
 * exact file shapes without touching the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";
import { SentryAxiError } from "./errors.js";

export const DEFAULT_API_URL = "https://sentry.io";

export interface Scope {
  org: string | null;
  project: string | null;
}

export interface ResolvedConfig {
  token: string;
  /** Base URL with no trailing slash, e.g. `https://sentry.io`. */
  url: string;
  org: string;
  /** Null for org-wide commands (`orgs`, `projects`, org-level search). */
  project: string | null;
}

// --- Pure parsers ---

/**
 * Parse an INI-style `.sentryclirc`. Returns a flat `section.key -> value` map
 * (e.g. `auth.token`, `defaults.org`). Comments (`#`, `;`) and blank lines are
 * skipped; keys outside any section land under the empty section.
 */
export function parseSentryClirc(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = "";

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length === 0) continue;

    out[section ? `${section}.${key}` : key] = value;
  }

  return out;
}

/**
 * Parse a Java-properties-style `sentry.properties` (as emitted by the Sentry
 * wizards). Keys look like `defaults.org=acme`. Separators may be `=` or `:`.
 */
export function parseSentryProperties(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }

    const m = line.match(/^([^=:]+)[=:](.*)$/);
    if (!m) continue;

    const key = m[1].trim();
    const value = m[2].trim();
    if (key.length === 0) continue;

    out[key] = value;
  }

  return out;
}

/**
 * Split an `org/project` argument. A bare value with no slash is treated as a
 * project within the already-configured org.
 */
export function parseScopeArg(arg: string): Scope {
  const trimmed = arg.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { org: null, project: trimmed || null };
  }
  return {
    org: trimmed.slice(0, slash).trim() || null,
    project: trimmed.slice(slash + 1).trim() || null,
  };
}

/** Strip a trailing slash so URL joining stays predictable. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// --- File-backed lookups ---

function readFileIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Config discovered in the current working directory, then the home dir. */
function discoveredConfig(): Record<string, string> {
  const local = readFileIfExists(join(process.cwd(), ".sentryclirc"));
  const global = readFileIfExists(join(homedir(), ".sentryclirc"));
  const props = readFileIfExists(join(process.cwd(), "sentry.properties"));

  return {
    ...(global ? parseSentryClirc(global) : {}),
    ...(props ? parseSentryProperties(props) : {}),
    ...(local ? parseSentryClirc(local) : {}),
  };
}

function authFile(session?: string): string {
  return join(resolveSessionStateDir(session), "auth.json");
}

function scopeFile(session?: string): string {
  return join(resolveSessionStateDir(session), "scope.json");
}

/**
 * Persist credentials from `sentry-axi login`.
 *
 * The URL is stored **with** the token, because they belong together: a token
 * is only valid against the instance that issued it. Storing the token alone
 * meant a self-hosted user logged in successfully and then had every later
 * command silently talk to sentry.io, where their token is meaningless - which
 * surfaces as "Invalid token" and sends them off to regenerate a token that was
 * never the problem.
 */
export function writeToken(
  token: string,
  url?: string,
  session?: string,
): void {
  const file = authFile(session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ token, ...(url ? { url: normalizeUrl(url) } : {}) }),
    { mode: 0o600 },
  );
}

export function readStoredToken(session?: string): string | null {
  try {
    const raw = readFileIfExists(authFile(session));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return typeof data?.token === "string" ? data.token : null;
  } catch {
    return null;
  }
}

/** The API URL stored beside the token by `login --url`. */
export function readStoredUrl(session?: string): string | null {
  try {
    const raw = readFileIfExists(authFile(session));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return typeof data?.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

/** Persist the active scope from `sentry-axi use <org>/<project>`. */
export function writeScope(scope: Scope, session?: string): void {
  const file = scopeFile(session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(scope, null, 2));
}

export function readScope(session?: string): Scope | null {
  try {
    const raw = readFileIfExists(scopeFile(session));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data === null || typeof data !== "object") return null;
    return {
      org: typeof data.org === "string" ? data.org : null,
      project: typeof data.project === "string" ? data.project : null,
    };
  } catch {
    return null;
  }
}

// --- Resolution ---

export function resolveToken(session?: string): string | null {
  const env = process.env.SENTRY_AUTH_TOKEN || process.env.SENTRY_AXI_TOKEN;
  if (env?.trim()) return env.trim();

  const stored = readStoredToken(session);
  if (stored?.trim()) return stored.trim();

  const discovered = discoveredConfig();
  const fromFile = discovered["auth.token"] || discovered["defaults.token"];
  return fromFile?.trim() || null;
}

export function resolveApiUrl(session?: string): string {
  const env = process.env.SENTRY_AXI_URL || process.env.SENTRY_URL;
  if (env?.trim()) return normalizeUrl(env.trim());

  // The URL saved by `login --url` - checked before .sentryclirc so that an
  // explicit login always wins over a stale config file lying around the repo.
  const stored = readStoredUrl(session);
  if (stored?.trim()) return normalizeUrl(stored.trim());

  const discovered = discoveredConfig();
  const fromFile = discovered["defaults.url"];
  return normalizeUrl(fromFile?.trim() || DEFAULT_API_URL);
}

/**
 * Resolve org/project without throwing - used by the home view, which must
 * render something useful even when nothing is configured yet.
 */
export function resolveScope(
  overrides: Scope = { org: null, project: null },
  session?: string,
): Scope {
  const discovered = discoveredConfig();
  const stored = readScope(session);

  const org =
    overrides.org ||
    process.env.SENTRY_ORG?.trim() ||
    stored?.org ||
    discovered["defaults.org"] ||
    null;

  const project =
    overrides.project ||
    process.env.SENTRY_PROJECT?.trim() ||
    stored?.project ||
    discovered["defaults.project"] ||
    null;

  return { org: org || null, project: project || null };
}

/**
 * Full config for a command that needs to talk to Sentry. Throws a structured
 * error - never a bare 401 later - when something it needs is missing.
 *
 * `requireProject: false` is for org-wide commands (`projects`, `search`).
 *
 * `requireOrg: false` is for the bootstrap command `orgs`, which hits
 * `/organizations/` and needs no scope at all. Requiring an org there produced a
 * **circular dead end**: `orgs` failed with "no organization configured", and its
 * own recovery suggestion was to run `sentry-axi orgs`. An agent following the
 * suggestions could never escape - which is the worst failure an AXI can have,
 * because the suggestions are the thing it is supposed to be able to trust.
 */
export function requireConfig(
  overrides: Scope = { org: null, project: null },
  options: {
    requireOrg?: boolean;
    requireProject?: boolean;
    session?: string;
  } = {},
): ResolvedConfig {
  const { requireOrg = true, requireProject = true, session } = options;

  const token = resolveToken(session);
  if (!token) {
    throw new SentryAxiError("No Sentry auth token found", "AUTH_REQUIRED", [
      "Run `sentry-axi login --token <token>` to store one",
      "Or set SENTRY_AUTH_TOKEN in the environment",
      "Create a token at https://sentry.io/settings/account/api/auth-tokens/ with scopes: org:read, project:read, project:write, event:read",
      "Add project:releases and event:write only if you also use `release`/`deploy`/`sendevent`",
    ]);
  }

  const scope = resolveScope(overrides, session);

  if (requireOrg && !scope.org) {
    throw new SentryAxiError(
      "No Sentry organization configured",
      "NO_PROJECT",
      [
        "Run `sentry-axi orgs` to list organizations you can access",
        "Then run `sentry-axi use <org>/<project>` to pin a scope",
        "Or pass `--org <slug>` on this command",
      ],
    );
  }

  if (requireProject && !scope.project) {
    throw new SentryAxiError("No Sentry project configured", "NO_PROJECT", [
      `Run \`sentry-axi projects\` to list projects in ${scope.org}`,
      `Then run \`sentry-axi use ${scope.org}/<project>\` to pin a scope`,
      "Or pass `--project <slug>` on this command",
    ]);
  }

  return {
    token,
    url: resolveApiUrl(),
    // Empty only when requireOrg is false, i.e. for `orgs`, whose endpoint is
    // org-independent and never interpolates this.
    org: scope.org ?? "",
    project: scope.project,
  };
}
