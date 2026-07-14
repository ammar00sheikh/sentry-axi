import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
import { SentryApi } from "./api.js";
import {
  parseArgs,
  flagBool,
  flagInt,
  flagString,
  requirePositional,
  type ParsedArgs,
} from "./args.js";
import {
  parseScopeArg,
  readScope,
  requireConfig,
  resolveApiUrl,
  resolveScope,
  resolveToken,
  writeScope,
  writeToken,
  type Scope,
} from "./config.js";
import { SentryAxiError, validationError } from "./errors.js";
import { bumpGeneration } from "./generation.js";
import { installHooksOrThrow } from "./hooks.js";
import {
  assignIssue,
  getIssue,
  getIssueTags,
  getLatestEvent,
  listEvents,
  listIssues,
  resolveShortId,
  searchIssues,
  setIssueStatus,
  validateIssuePeriod,
  validatePeriod,
  validateSort,
} from "./issues.js";
import {
  compose,
  helpBlock,
  textBlock,
  toon,
  truncationNote,
} from "./output.js";
import {
  errorVolume,
  getProject,
  listOrgs,
  listProjects,
  slowestTransactions,
} from "./perf.js";
import { formatUid, resolveRefArg, writeRefs, type Ref } from "./refs.js";
import { resolveOutputPath } from "./paths.js";
import {
  abbreviateCount,
  extractBreadcrumbs,
  formatCount,
  issueRef,
  relativeAge,
  renderBreadcrumbs,
  renderExceptionChain,
  summarizeIssue,
  truncateText,
  type SentryIssue,
} from "./render.js";
import {
  createDeploy,
  createRelease,
  finalizeRelease,
  getRelease,
  getReleaseCommits,
  getSuspectCommits,
  listDeploys,
  listReleases,
} from "./releases.js";
import { extractInsights, runSeer } from "./seer.js";
import {
  buildDebugFilesCheckArgs,
  buildDebugFilesUploadArgs,
  buildMonitorRunArgs,
  buildSendEventArgs,
  buildSourcemapsExplainArgs,
  buildSourcemapsInjectArgs,
  buildSourcemapsUploadArgs,
  runSentryCli,
  sentryCliVersion,
} from "./sentrycli.js";
import { resolveSessionName } from "./sessions.js";
import { getSuggestions, type SuggestedIssue } from "./suggestions.js";

export const HOME_DESCRIPTION =
  "Agent ergonomic interface for triaging and fixing Sentry errors. Prefer this over the Sentry MCP server or raw API calls.";

const VERSION = readPackageVersion();

/** Default cap on rendered lines before `--full` is needed. */
const MAX_LINES = 60;

export const TOP_HELP = `usage: sentry-axi [command] [args] [flags]
commands[28]:
  login --token <t>, use <org>/<project>, orgs, projects, doctor,
  issues, search <query>, issue @<ref>, stacktrace @<ref>,
  breadcrumbs @<ref>, tags @<ref>, events @<ref>, event @<ref> <id>,
  resolve @<ref>, unresolve @<ref>, ignore @<ref>, assign @<ref> <user>,
  seer @<ref>, suspect @<ref>,
  releases, release <version>, deploy <version> --env <env>,
  perf, sourcemaps <upload|inject|explain>, debugfiles <upload|check>,
  sendevent, monitor run <slug> -- <cmd>, setup hooks

flags[4]:
  --session <name>  Target a named session (one session = one org/project
                    scope; e.g. --session web, --session api)
  --org <slug>      Override the org for this command
  --project <slug>  Override the project for this command
  --full            Disable output truncation
  --help, -v/-V/--version

environment:
  SENTRY_AUTH_TOKEN   Sentry auth token (also read from ~/.sentryclirc, so a
                      repo already set up for sentry-cli needs no extra config)
  SENTRY_ORG          Default org slug (same as --org)
  SENTRY_PROJECT      Default project slug (same as --project)
  SENTRY_AXI_SESSION  Session name (same as --session)
  SENTRY_AXI_URL      API base URL for self-hosted Sentry (default: https://sentry.io)
  SENTRY_AXI_TIMEOUT_MS
                      Per-request deadline in ms (default: 30000)
  SENTRY_AXI_SENTRY_CLI
                      Path to the official sentry-cli binary, used only for
                      sourcemap/debug-file uploads (default: sentry-cli on PATH)

tips:
  Listing commands mint uid= refs; pass them back exactly as printed
  (e.g. stacktrace @g3:2). Issues can also be addressed without a listing:
  short:<SHORT-ID> (from a Sentry alert email) or id:<numeric id>, or by
  pasting a Sentry issue URL.
  The triage loop is: issues -> stacktrace -> seer/suspect -> resolve.
`;

const COMMAND_HELP: Record<string, string> = {
  login: `usage: sentry-axi login --token <token>
Store a Sentry auth token for this session.

The token is written to ~/.sentry-axi/auth.json with 0600 permissions.
SENTRY_AUTH_TOKEN in the environment always takes precedence over it, and an
existing .sentryclirc is picked up automatically - so if this repo is already
set up for the official sentry-cli, you may not need to log in at all.

Create a token at https://sentry.io/settings/account/api/auth-tokens/
with scopes: org:read, project:read, project:write, event:read

examples:
  sentry-axi login --token sntrys_...
  sentry-axi doctor            # confirm the token and scope resolve`,

  use: `usage: sentry-axi use <org>/<project>
Pin the org and project for later commands in this session.

args:
  <org>/<project>  Full scope, or a bare <project> to keep the current org

examples:
  sentry-axi use acme/frontend
  sentry-axi use backend                 # keep org, switch project
  sentry-axi --session api use acme/backend`,

  orgs: `usage: sentry-axi orgs
List organizations the auth token can access.

examples:
  sentry-axi orgs`,

  projects: `usage: sentry-axi projects [--org <slug>]
List projects in the org, with their platform and whether they have events.

examples:
  sentry-axi projects
  sentry-axi projects --org acme`,

  doctor: `usage: sentry-axi doctor
Report the resolved auth token, API URL, org/project scope, and where each
value came from. Also probes for the optional sentry-cli binary.

This is the command to run first when anything is misbehaving - it never
mutates and it explains the precedence chain that produced the current config.

examples:
  sentry-axi doctor`,

  issues: `usage: sentry-axi issues [--query <q>] [--period <p>] [--sort <s>] [--limit <n>] [--full]
List issues in the current project. Mints @<uid> refs for every issue.

flags:
  --query <q>   Sentry search syntax (default: "is:unresolved")
  --period <p>  Stats window: 24h or 14d only (Sentry's issue endpoints
                accept nothing else). To reach further back, filter by age in
                the query: --query "is:unresolved age:+30d" (default: 24h)
  --sort <s>    date | new | freq | user | trends (default: freq)
  --limit <n>   Max issues to return (default: 25)

examples:
  sentry-axi issues
  sentry-axi issues --query "is:unresolved is:unassigned" --sort user
  sentry-axi issues --query "release:4.2.0" --period 14d
  sentry-axi issues --query "is:unresolved age:+30d"   # first seen >30d ago
  sentry-axi issues --query "is:unresolved level:fatal" --limit 5`,

  search: `usage: sentry-axi search <query> [--period <p>] [--sort <s>] [--limit <n>]
Search issues across every project in the org (not just the pinned one).

Use this to answer "is this error happening anywhere else".

examples:
  sentry-axi search "TypeError"
  sentry-axi search "is:unresolved user.email:alice@acme.com"`,

  issue: `usage: sentry-axi issue @<ref>
Full detail for one issue: level, status, counts, first/last seen, assignee,
the culprit location, and the top tag values.

args:
  @<ref>  A ref from a listing, or short:<SHORT-ID>, or id:<numeric id>

examples:
  sentry-axi issue @g1:2
  sentry-axi issue short:FRONTEND-4F`,

  stacktrace: `usage: sentry-axi stacktrace @<ref> [--context] [--full]
Render the stack trace of the issue's latest event.

Frames print crash-frame-first (Sentry stores them in the opposite order), and
library frames are collapsed into a "... N library frames" line so the app code
stays readable.

flags:
  --context  Include source lines around the crashing frame
  --full     Show every frame, including library frames

examples:
  sentry-axi stacktrace @g1:1
  sentry-axi stacktrace @g1:1 --context
  sentry-axi stacktrace short:FRONTEND-4F --full`,

  breadcrumbs: `usage: sentry-axi breadcrumbs @<ref> [--limit <n>] [--full]
The trail of events leading up to the crash - navigation, HTTP calls, console
logs, clicks - oldest first, ending at the exception.

flags:
  --limit <n>  How many trailing breadcrumbs to show (default: 20)

examples:
  sentry-axi breadcrumbs @g1:1`,

  tags: `usage: sentry-axi tags @<ref>
Top tag values for an issue: browser, OS, release, environment, user, and any
custom tags. This is how you find out whether an error is specific to one
release, one browser, or one customer.

examples:
  sentry-axi tags @g1:1`,

  events: `usage: sentry-axi events @<ref> [--limit <n>]
List recent events for an issue. Each event is one occurrence.

examples:
  sentry-axi events @g1:1 --limit 5`,

  event: `usage: sentry-axi event @<ref> <event-id> [--context] [--full]
Render one specific event of an issue by its id (from \`events\`).

examples:
  sentry-axi event @g1:1 a1b2c3d4e5f6...`,

  resolve: `usage: sentry-axi resolve @<ref> [--in-next-release]
Mark an issue resolved. Idempotent: resolving an already-resolved issue is a
successful no-op.

flags:
  --in-next-release  Resolve in the next release rather than immediately, so
                     Sentry reopens it if it recurs before that release ships

examples:
  sentry-axi resolve @g1:1
  sentry-axi resolve @g1:1 --in-next-release`,

  unresolve: `usage: sentry-axi unresolve @<ref>
Reopen a resolved or ignored issue. Idempotent.

This is the inverse of \`resolve\` and \`ignore\` - use it to undo a mistaken
triage decision without going to the Sentry UI.

examples:
  sentry-axi unresolve @g1:1`,

  ignore: `usage: sentry-axi ignore @<ref>
Archive/ignore an issue so it drops out of the unresolved list. Idempotent.
Undo it with \`sentry-axi unresolve @<ref>\`.

examples:
  sentry-axi ignore @g1:3`,

  assign: `usage: sentry-axi assign @<ref> <user>
Assign an issue to a user (email or username) or a team (team:<slug>).
Pass an empty string to unassign. Idempotent.

examples:
  sentry-axi assign @g1:1 alice@acme.com
  sentry-axi assign @g1:1 team:backend
  sentry-axi assign @g1:1 ""            # unassign`,

  seer: `usage: sentry-axi seer @<ref> [--timeout <seconds>]
Run Sentry's Seer AI root-cause analysis on an issue and print the result.

A Seer run takes tens of seconds. This command starts it (or picks up an
existing run), polls to completion, and prints the root cause and proposed
solution - so you issue one command rather than writing a poll loop.

flags:
  --timeout <s>  How long to wait for the run (default: 180)

examples:
  sentry-axi seer @g1:1
  sentry-axi seer @g1:1 --timeout 300`,

  suspect: `usage: sentry-axi suspect @<ref>
The commits Sentry has correlated with the failing stack frames, and their
authors. This is the highest-signal thing Sentry knows that you cannot derive
from the code alone.

Requires the repository to be linked to Sentry and commits associated with
releases; otherwise it reports that no suspect commits are available.

examples:
  sentry-axi suspect @g1:1`,

  releases: `usage: sentry-axi releases [--limit <n>]
List recent releases with their commit/deploy counts and new-issue counts.

examples:
  sentry-axi releases`,

  release: `usage: sentry-axi release <version> [--commits] [--new]
       sentry-axi release new <version> [--ref <sha>] [--url <url>]
       sentry-axi release finalize <version>
Detail for one release: dates, commit and deploy counts, deploys, and commits.

subcommands:
  new <version>       Create (or update) a release. Idempotent.
  finalize <version>  Mark the release as released, now.

examples:
  sentry-axi release 4.2.0
  sentry-axi release new 4.2.1 --ref $(git rev-parse HEAD)
  sentry-axi release finalize 4.2.1`,

  deploy: `usage: sentry-axi deploy <version> --env <environment> [--name <name>]
Record a deploy of a release to an environment.

examples:
  sentry-axi deploy 4.2.1 --env production
  sentry-axi deploy 4.2.1 --env staging --name "canary"`,

  perf: `usage: sentry-axi perf [--period <p>] [--limit <n>] [--query <q>]
Performance and health summary for the project: the slowest transactions by
p95, plus accepted/dropped event volume for the window.

Results are pre-aggregated - you get a ranked table, not a span dump.

flags:
  --period <p>  Time window (default: 24h)
  --limit <n>   How many transactions to rank (default: 10)
  --query <q>   Extra Sentry search terms to filter transactions

examples:
  sentry-axi perf
  sentry-axi perf --period 7d --limit 20
  sentry-axi perf --query "transaction.op:http.server"`,

  sourcemaps: `usage: sentry-axi sourcemaps upload <paths...> --release <v> [--url-prefix <p>] [--dist <d>]
       sentry-axi sourcemaps inject <paths...>
       sentry-axi sourcemaps explain <event-id>
Sourcemap operations. These delegate to the official \`sentry-cli\` binary,
which implements Sentry's chunked-upload protocol.

\`upload\` defaults to --strict, so uploading zero files is an error rather than
a silent success - a silently-empty upload is the most common cause of
unminified stack traces never appearing.

If sentry-cli is not installed, the command fails with TOOLCHAIN_MISSING and
tells you how to install it.

examples:
  sentry-axi sourcemaps inject ./dist
  sentry-axi sourcemaps upload ./dist --release 4.2.1
  sentry-axi sourcemaps explain a1b2c3d4e5f6...`,

  debugfiles: `usage: sentry-axi debugfiles upload <paths...> [--include-sources] [--wait]
       sentry-axi debugfiles check <path>
Upload or inspect debug information files (dSYM, PDB, ELF, ProGuard).
Delegates to the official \`sentry-cli\` binary.

examples:
  sentry-axi debugfiles upload ./build --include-sources
  sentry-axi debugfiles check ./MyApp.dSYM`,

  sendevent: `usage: sentry-axi sendevent [--message <m>] [--level <l>] [--file <path>] [--tag k:v]
Send a synthetic event to Sentry. Useful for verifying a DSN, an alert rule, or
a release association end to end. Delegates to the official \`sentry-cli\`.

examples:
  sentry-axi sendevent --message "deploy smoke test" --level info
  sentry-axi sendevent --file ./event.json`,

  monitor: `usage: sentry-axi monitor run <slug> [--env <e>] -- <command...>
Run a command under a Sentry cron monitor check-in. Delegates to the official
\`sentry-cli\`.

examples:
  sentry-axi monitor run nightly-sync -- ./scripts/sync.sh`,

  setup: `usage: sentry-axi setup hooks
Install a SessionStart hook for Claude Code, Codex, and OpenCode that surfaces
the current Sentry scope and open-issue count at the start of every agent
session.

Restart your agent session afterwards.

examples:
  sentry-axi setup hooks`,
};

export function getCommandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}

/**
 * Render errors in the same shape as every other response.
 *
 * The SDK's default error renderer TOON-encodes the whole payload, which
 * collapses `help` into one comma-separated line:
 *
 *     help[3]: Run `sentry-axi login ...`,Or set SENTRY_AUTH_TOKEN,"Create a ..."
 *
 * Suggestions are commands an agent copies back verbatim, so they have to be
 * one per line - and an agent should never have to parse two different shapes
 * for the same block depending on whether the command succeeded. This renders
 * the error head as TOON and the suggestions through the same `helpBlock` the
 * success paths use.
 */
export function formatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  const exitCode = exitCodeForError(error);

  // Never render an error with no way forward. Most throw sites supply their own
  // suggestions, but a bare `new SentryAxiError(msg, code)` would otherwise
  // print a dead end - and a dead-ended agent stops, or guesses.
  const fallback = [
    "Run `sentry-axi doctor` to check auth, scope, and connectivity",
  ];

  if (error instanceof AxiError) {
    const suggestions =
      error.suggestions.length > 0 ? error.suggestions : fallback;

    return {
      output: `${compose(
        toon({ error: error.message, code: error.code }),
        helpBlock(suggestions),
      )}\n`,
      exitCode,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${compose(
      toon({ error: message, code: "UNKNOWN" }),
      helpBlock(fallback),
    )}\n`,
    exitCode,
  };
}

export function renderUnknownCommand(command: string): string {
  return compose(
    toon({ error: `Unknown command: ${command}`, code: "VALIDATION_ERROR" }),
    helpBlock([
      "Run `sentry-axi --help` to see all commands",
      "The triage loop is: `issues` -> `stacktrace @<ref>` -> `seer @<ref>` -> `resolve @<ref>`",
    ]),
  );
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
    ]) {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (typeof pkg.version === "string") return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

// --- Shared plumbing ---

const GLOBAL_BOOLEANS = ["full"] as const;

function apiFor(
  options: { requireOrg?: boolean; requireProject?: boolean } = {},
): SentryApi {
  const config = requireConfig({ org: null, project: null }, options);
  return new SentryApi(config);
}

/**
 * Resolve a command argument to a numeric issue id.
 *
 * A `short:FRONTEND-4F` argument costs one extra API round trip to translate;
 * a `@uid` ref costs none, because the listing that minted it already recorded
 * the numeric id. That is the whole point of the registry.
 */
async function resolveIssueId(
  api: SentryApi,
  arg: string,
): Promise<{ id: string; ref: Ref }> {
  const ref = resolveRefArg(arg, "issue");

  // The `short:` escape hatch stores the short id in both fields - it has no
  // numeric id to work with until we ask Sentry for one.
  if (ref.shortId && ref.id === ref.shortId) {
    const id = await resolveShortId(api, ref.shortId);
    return { id, ref: { ...ref, id } };
  }

  return { id: ref.id, ref };
}

/** One issue in hand -> the suggestion context that names it. */
function suggestedFrom(ref: Ref, uid: string): SuggestedIssue[] {
  return [
    {
      uid,
      ...(ref.shortId ? { shortId: ref.shortId } : {}),
      ...(ref.label ? { title: ref.label } : {}),
    },
  ];
}

/**
 * Re-mint a single-issue ref so the suggestions printed after a detail command
 * carry a uid the agent can actually use. Without this, `issue short:FOO-1`
 * would suggest `stacktrace @undefined`.
 */
function mintSingle(issue: SentryIssue): { uid: string; ref: Ref } {
  const generation = bumpGeneration();
  const uid = formatUid(generation, 1);
  const ref = issueRef(issue, generation);
  writeRefs(generation, { [uid]: ref });
  return { uid, ref };
}

function session(): string {
  return resolveSessionName();
}

// --- Handlers: config & scope ---

async function handleLogin(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const token = flagString(parsed, "token");

  if (!token) {
    throw validationError(
      "A token is required",
      "Run `sentry-axi login --token <token>`",
      "Create one at https://sentry.io/settings/account/api/auth-tokens/ with scopes: org:read, project:read, project:write, event:read",
    );
  }

  writeToken(token);

  // Prove the token works now rather than failing on the agent's next command.
  const api = new SentryApi({
    token,
    url: resolveApiUrl(),
    org: "-",
    project: null,
  });
  const orgs = await listOrgs(api);

  return compose(
    toon({
      login: {
        stored: "~/.sentry-axi/auth.json",
        url: resolveApiUrl(),
        organizations: orgs.length,
      },
    }),
    toon({
      orgs: orgs.map((org) => ({ slug: org.slug, name: org.name ?? org.slug })),
    }),
    helpBlock([
      "Run `sentry-axi use <org>/<project>` to pin a scope",
      "Run `sentry-axi projects --org <slug>` to list a org's projects",
    ]),
  );
}

async function handleUse(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const arg = requirePositional(
    parsed,
    0,
    "<org>/<project>",
    "Run `sentry-axi projects` to list available projects",
  );

  const requested = parseScopeArg(arg);
  const current = readScope();

  const scope: Scope = {
    org: requested.org ?? current?.org ?? resolveScope().org,
    project: requested.project ?? current?.project ?? null,
  };

  if (!scope.org) {
    throw validationError(
      `Cannot resolve an org from "${arg}"`,
      "Pass the full scope: `sentry-axi use <org>/<project>`",
      "Run `sentry-axi orgs` to list organizations",
    );
  }

  writeScope(scope);

  return compose(
    toon({
      scope: {
        org: scope.org,
        project: scope.project ?? "-",
        session: session(),
      },
    }),
    helpBlock([
      "Run `sentry-axi issues` to see what is currently broken",
      "Run `sentry-axi doctor` to confirm the token and scope resolve",
    ]),
  );
}

async function handleOrgs(): Promise<string> {
  // The bootstrap command: it must work with a token and nothing else, because
  // it is how you find out what to put in `use`.
  const api = apiFor({ requireOrg: false, requireProject: false });
  const orgs = await listOrgs(api);

  return compose(
    toon({
      orgs: orgs.map((org) => ({ slug: org.slug, name: org.name ?? org.slug })),
    }),
    helpBlock(
      getSuggestions({
        command: "orgs",
        session: session(),
        empty: orgs.length === 0,
      }),
    ),
  );
}

async function handleProjects(): Promise<string> {
  const api = apiFor({ requireProject: false });
  const projects = await listProjects(api);

  return compose(
    toon({
      projects: projects.map((project) => ({
        slug: project.slug,
        platform: project.platform ?? "-",
        hasEvents: project.firstEvent ? "yes" : "no",
      })),
    }),
    helpBlock(
      getSuggestions({
        command: "projects",
        session: session(),
        empty: projects.length === 0,
      }),
    ),
  );
}

/**
 * The config explainer. Every value reports *where it came from*, because the
 * precedence chain (env > stored > .sentryclirc) is the thing that actually
 * confuses people when a command talks to the wrong org.
 */
async function handleDoctor(): Promise<string> {
  const token = resolveToken();
  const scope = resolveScope();
  const url = resolveApiUrl();

  const tokenSource = process.env.SENTRY_AUTH_TOKEN
    ? "SENTRY_AUTH_TOKEN"
    : process.env.SENTRY_AXI_TOKEN
      ? "SENTRY_AXI_TOKEN"
      : token
        ? "~/.sentry-axi/auth.json or .sentryclirc"
        : "not found";

  const orgSource = process.env.SENTRY_ORG
    ? "SENTRY_ORG"
    : readScope()?.org
      ? "session scope (`use`)"
      : scope.org
        ? ".sentryclirc / sentry.properties"
        : "not found";

  const cliVersion = await sentryCliVersion();

  // Probing needs only a token: /organizations/ is org-independent. Gating this
  // on a resolved org meant doctor reported "not checked" in exactly the state
  // where you most need to know whether the token works at all.
  let reachable = "not checked (no token)";
  if (token) {
    try {
      const api = new SentryApi({
        token,
        url,
        org: scope.org ?? "",
        project: scope.project,
      });
      await listOrgs(api);
      reachable = "yes";
    } catch (error) {
      reachable = error instanceof SentryAxiError ? error.code : "no";
    }
  }

  const suggestions: string[] = [];
  if (!token) {
    suggestions.push("Run `sentry-axi login --token <token>` to store a token");
  } else if (!scope.org) {
    suggestions.push(
      "Run `sentry-axi orgs` then `sentry-axi use <org>/<project>`",
    );
  } else if (!scope.project) {
    suggestions.push("Run `sentry-axi use <org>/<project>` to pin a project");
  } else {
    suggestions.push("Run `sentry-axi issues` to see what is currently broken");
  }
  if (!cliVersion) {
    suggestions.push(
      "The optional `sentry-cli` binary is not installed - only sourcemap/debug-file uploads need it (`npm i -g @sentry/cli`)",
    );
  }

  return compose(
    toon({
      doctor: {
        session: session(),
        token: token ? `set (${tokenSource})` : "MISSING",
        url,
        org: scope.org ?? "MISSING",
        orgSource,
        project: scope.project ?? "MISSING",
        apiReachable: reachable,
        sentryCli: cliVersion ?? "not installed (optional)",
      },
    }),
    helpBlock(suggestions),
  );
}

// --- Handlers: issues ---

/** Shared by `issues` and `search` - they differ only in the endpoint. */
async function renderIssueList(
  issues: SentryIssue[],
  command: "issues" | "search",
  meta: Record<string, unknown>,
  /**
   * Only consulted when the listing is empty. "No issues matched your query"
   * and "this project has never received an event" are indistinguishable in the
   * response but need opposite advice, and Sentry knows which it is - so on the
   * empty path (and only there) we spend one extra request to find out.
   */
  emptyContext?: { api: SentryApi; period: string; query: string },
): Promise<string> {
  const generation = bumpGeneration();
  const minted: Record<string, Ref> = {};
  const suggested: SuggestedIssue[] = [];

  const rows = issues.map((issue, index) => {
    const uid = formatUid(generation, index + 1);
    minted[uid] = issueRef(issue, generation);

    const summary = summarizeIssue(issue);
    suggested.push({ uid, shortId: summary.shortId, title: summary.title });

    return {
      uid,
      shortId: summary.shortId,
      level: summary.level,
      events: summary.events,
      users: summary.users,
      age: summary.lastSeen,
      title: summary.title,
      culprit: summary.culprit,
    };
  });

  writeRefs(generation, minted);

  let neverReceivedEvents = false;
  if (issues.length === 0 && emptyContext?.api.project) {
    const project = await getProject(
      emptyContext.api,
      emptyContext.api.project,
    ).catch(() => null);
    // `firstEvent: null` means no event has EVER reached this project.
    neverReceivedEvents = project !== null && !project.firstEvent;
  }

  return compose(
    toon({
      [command]: {
        ...meta,
        found: issues.length,
        ...(neverReceivedEvents
          ? { projectHasNeverReceivedAnEvent: true }
          : {}),
        generation: `g${generation}`,
      },
    }),
    toon({ results: rows }),
    helpBlock(
      getSuggestions({
        command,
        issues: suggested,
        session: session(),
        empty: issues.length === 0,
        projectNeverReceivedEvents: neverReceivedEvents,
        ...(emptyContext?.api.project
          ? { project: emptyContext.api.project }
          : {}),
        ...(emptyContext ? { period: emptyContext.period } : {}),
        ...(emptyContext ? { query: emptyContext.query } : {}),
      }),
    ),
  );
}

async function handleIssues(args: string[]): Promise<string> {
  // Arguments are validated before auth/scope is resolved. Otherwise a typo'd
  // `--limit abc` on an unauthenticated machine reports AUTH_REQUIRED, and the
  // agent goes and fixes the wrong thing.
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);

  const query = flagString(parsed, "query") ?? "is:unresolved";
  const period = validateIssuePeriod(flagString(parsed, "period") ?? "24h");
  const sort = validateSort(flagString(parsed, "sort") ?? "freq");
  const limit = flagInt(parsed, "limit", 25);

  const api = apiFor();
  const issues = await listIssues(api, { query, period, sort, limit });

  return renderIssueList(
    issues,
    "issues",
    {
      project: `${api.org}/${api.project}`,
      query,
      period,
      sort,
    },
    { api, period, query },
  );
}

async function handleSearch(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);

  const query = requirePositional(
    parsed,
    0,
    "<query>",
    'Example: sentry-axi search "is:unresolved TypeError"',
  );
  const period = validateIssuePeriod(flagString(parsed, "period") ?? "24h");
  const sort = validateSort(flagString(parsed, "sort") ?? "freq");
  const limit = flagInt(parsed, "limit", 25);

  const api = apiFor({ requireProject: false });
  const issues = await searchIssues(api, { query, period, sort, limit });

  return renderIssueList(issues, "search", {
    org: api.org,
    query,
    period,
    sort,
  });
}

async function handleIssue(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const { uid, ref } = mintSingle(issue);
  const summary = summarizeIssue(issue);

  const tags = await getIssueTags(api, id).catch(() => []);
  const topTags = tags
    .filter((tag) => (tag.topValues?.length ?? 0) > 0)
    .slice(0, 8)
    .map((tag) => ({
      key: tag.key,
      top: tag.topValues?.[0]?.value ?? "-",
      count: tag.topValues?.[0]?.count ?? 0,
    }));

  return compose(
    toon({
      issue: {
        uid,
        shortId: summary.shortId,
        title: summary.title,
        culprit: summary.culprit,
        level: summary.level,
        status: issue.status ?? "unknown",
        unhandled: summary.unhandled,
        events: formatCount(issue.count),
        users: summary.users,
        firstSeen: relativeAge(issue.firstSeen),
        lastSeen: relativeAge(issue.lastSeen),
        assignee:
          issue.assignedTo?.name ?? issue.assignedTo?.email ?? "unassigned",
        permalink: issue.permalink ?? "-",
      },
    }),
    topTags.length > 0 ? toon({ tags: topTags }) : "",
    helpBlock(
      getSuggestions({
        command: "issue",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

async function handleStacktrace(args: string[]): Promise<string> {
  const parsed = parseArgs(args, [...GLOBAL_BOOLEANS, "context"]);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const event = await getLatestEvent(api, id);
  const { uid, ref } = mintSingle(issue);

  const full = flagBool(parsed, "full");
  const rendered = renderExceptionChain(event, {
    full,
    contextLines: flagBool(parsed, "context"),
  });
  const { text, truncated } = truncateText(rendered, MAX_LINES, full);

  return compose(
    toon({
      issue: {
        uid,
        shortId: issue.shortId ?? id,
        title: issue.title ?? "-",
        event: event.eventID ?? event.id ?? "-",
        platform: event.platform ?? "-",
        release: event.release?.version ?? "-",
        when: relativeAge(event.dateCreated),
      },
    }),
    textBlock("stacktrace", text),
    truncationNote(truncated),
    helpBlock(
      getSuggestions({
        command: "stacktrace",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

async function handleBreadcrumbs(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const event = await getLatestEvent(api, id);
  const { uid, ref } = mintSingle(issue);

  const full = flagBool(parsed, "full");
  const crumbs = extractBreadcrumbs(event);
  const rendered = renderBreadcrumbs(
    crumbs,
    full ? crumbs.length : flagInt(parsed, "limit", 20),
  );
  const { text, truncated } = truncateText(rendered, MAX_LINES, full);

  return compose(
    toon({
      issue: {
        uid,
        shortId: issue.shortId ?? id,
        event: event.eventID ?? "-",
        crumbs: crumbs.length,
      },
    }),
    textBlock("breadcrumbs", text),
    truncationNote(truncated),
    helpBlock(
      getSuggestions({
        command: "breadcrumbs",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

async function handleTags(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id, ref } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const { uid } = mintSingle(issue);
  const tags = await getIssueTags(api, id);

  const rows = tags.flatMap((tag) =>
    (tag.topValues ?? []).slice(0, 3).map((value) => ({
      key: tag.key,
      value: value.value,
      count: value.count,
    })),
  );

  return compose(
    toon({ issue: { uid, shortId: issue.shortId ?? id, tags: tags.length } }),
    toon({ values: rows }),
    helpBlock(
      getSuggestions({
        command: "tags",
        issues: suggestedFrom({ ...ref, id }, uid),
        session: session(),
        empty: rows.length === 0,
      }),
    ),
  );
}

async function handleEvents(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id, ref } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const { uid } = mintSingle(issue);
  const events = await listEvents(api, id, flagInt(parsed, "limit", 10));

  return compose(
    toon({
      issue: { uid, shortId: issue.shortId ?? id, events: events.length },
    }),
    toon({
      results: events.map((event) => ({
        id: event.eventID ?? event.id ?? "-",
        when: relativeAge(event.dateCreated),
        release: event.release?.version ?? "-",
        user: event.user?.email ?? event.user?.id ?? "-",
      })),
    }),
    helpBlock(
      getSuggestions({
        command: "events",
        issues: suggestedFrom({ ...ref, id }, uid),
        session: session(),
        empty: events.length === 0,
      }),
    ),
  );
}

async function handleEvent(args: string[]): Promise<string> {
  const parsed = parseArgs(args, [...GLOBAL_BOOLEANS, "context"]);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const eventId = requirePositional(
    parsed,
    1,
    "<event-id>",
    "Run `sentry-axi events @<ref>` to list event ids",
  );

  const { id } = await resolveIssueId(api, arg);
  const issue = await getIssue(api, id);
  const { uid, ref } = mintSingle(issue);

  const { getEvent } = await import("./issues.js");
  const event = await getEvent(api, id, eventId);

  const full = flagBool(parsed, "full");
  const rendered = renderExceptionChain(event, {
    full,
    contextLines: flagBool(parsed, "context"),
  });
  const { text, truncated } = truncateText(rendered, MAX_LINES, full);

  return compose(
    toon({
      event: {
        uid,
        id: event.eventID ?? eventId,
        when: relativeAge(event.dateCreated),
        release: event.release?.version ?? "-",
        user: event.user?.email ?? event.user?.id ?? "-",
      },
    }),
    textBlock("stacktrace", text),
    truncationNote(truncated),
    helpBlock(
      getSuggestions({
        command: "events",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

// --- Handlers: mutations ---

async function handleResolve(args: string[]): Promise<string> {
  const parsed = parseArgs(args, [...GLOBAL_BOOLEANS, "in-next-release"]);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const inNextRelease = flagBool(parsed, "in-next-release");
  const updated = inNextRelease
    ? await api.request<SentryIssue>(`/issues/${encodeURIComponent(id)}/`, {
        method: "PUT",
        body: { status: "resolved", statusDetails: { inNextRelease: true } },
      })
    : await setIssueStatus(api, id, "resolved");

  return compose(
    toon({
      resolved: {
        shortId: updated.shortId ?? id,
        title: updated.title ?? "-",
        status: updated.status ?? "resolved",
        ...(inNextRelease ? { mode: "in next release" } : {}),
      },
    }),
    helpBlock(getSuggestions({ command: "resolve", session: session() })),
  );
}

async function handleIgnore(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);
  const updated = await setIssueStatus(api, id, "ignored");

  return compose(
    toon({
      ignored: {
        shortId: updated.shortId ?? id,
        title: updated.title ?? "-",
        status: updated.status ?? "ignored",
      },
    }),
    helpBlock(getSuggestions({ command: "ignore", session: session() })),
  );
}

/**
 * Reopen a resolved or ignored issue.
 *
 * Without this, `resolve` and `ignore` are one-way doors: an agent that
 * resolves the wrong issue has no way back, and has to go tell a human to fix
 * it in the UI. Any mutation an AXI offers needs its inverse.
 */
async function handleUnresolve(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);
  const updated = await setIssueStatus(api, id, "unresolved");

  return compose(
    toon({
      unresolved: {
        shortId: updated.shortId ?? id,
        title: updated.title ?? "-",
        status: updated.status ?? "unresolved",
      },
    }),
    helpBlock(getSuggestions({ command: "resolve", session: session() })),
  );
}

async function handleAssign(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  // An empty string is a legitimate value here - it unassigns - so this cannot
  // go through requirePositional, which rejects empties.
  const assignee = parsed.positional[1];
  if (assignee === undefined) {
    throw validationError(
      "Missing required argument: <user>",
      "Assign to a person: `sentry-axi assign @g1:1 alice@acme.com`",
      "Assign to a team: `sentry-axi assign @g1:1 team:backend`",
      'Unassign: `sentry-axi assign @g1:1 ""`',
    );
  }

  const { id } = await resolveIssueId(api, arg);
  const updated = await assignIssue(api, id, assignee);

  return compose(
    toon({
      assigned: {
        shortId: updated.shortId ?? id,
        title: updated.title ?? "-",
        assignee:
          updated.assignedTo?.name ?? updated.assignedTo?.email ?? "unassigned",
      },
    }),
    helpBlock(getSuggestions({ command: "assign", session: session() })),
  );
}

// --- Handlers: root cause ---

async function handleSeer(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const { uid, ref } = mintSingle(issue);

  const timeoutMs = flagInt(parsed, "timeout", 180) * 1000;
  const state = await runSeer(api, id, { timeoutMs });

  const sections = state.steps
    .map((step) => {
      const insights = extractInsights(step);
      if (insights.length === 0) return null;
      const title = step.title ?? step.type ?? "analysis";
      const body = insights.map((line) => `  ${line}`).join("\n");
      return `${title}:\n${body}`;
    })
    .filter((section): section is string => section !== null);

  const full = flagBool(parsed, "full");
  const { text, truncated } = truncateText(
    sections.join("\n\n") ||
      "<Seer produced no readable analysis for this issue>",
    MAX_LINES * 2,
    full,
  );

  return compose(
    toon({
      seer: {
        uid,
        shortId: issue.shortId ?? id,
        status: state.status,
        steps: state.steps.length,
        ...(state.changes?.length
          ? { proposedChanges: state.changes.length }
          : {}),
      },
    }),
    textBlock("analysis", text),
    truncationNote(truncated),
    helpBlock(
      getSuggestions({
        command: "seer",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

async function handleSuspect(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const arg = requirePositional(
    parsed,
    0,
    "@<ref>",
    "Run `sentry-axi issues` to list issues",
  );
  const { id } = await resolveIssueId(api, arg);

  const issue = await getIssue(api, id);
  const { uid, ref } = mintSingle(issue);

  const suspects = await getSuspectCommits(api, id).catch(() => []);

  if (suspects.length === 0) {
    return compose(
      toon({ suspect: { uid, shortId: issue.shortId ?? id, commits: 0 } }),
      helpBlock([
        "Sentry has no suspect commits for this issue",
        "Suspect commits need the repo linked to Sentry and commits associated with releases (`sentry-axi release new <v> --ref <sha>`)",
        `Run \`sentry-axi stacktrace @${uid}\` and inspect the failing frames directly`,
      ]),
    );
  }

  return compose(
    toon({
      suspect: { uid, shortId: issue.shortId ?? id, commits: suspects.length },
    }),
    toon({
      commits: suspects.map((suspect) => ({
        sha: suspect.commit.id.slice(0, 10),
        author: suspect.author?.email ?? suspect.author?.name ?? "-",
        when: relativeAge(suspect.commit.dateCreated),
        message: (suspect.commit.message ?? "").split("\n")[0].slice(0, 80),
      })),
    }),
    helpBlock(
      getSuggestions({
        command: "suspect",
        issues: suggestedFrom(ref, uid),
        session: session(),
      }),
    ),
  );
}

// --- Handlers: releases ---

async function handleReleases(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const releases = await listReleases(api, flagInt(parsed, "limit", 20));

  return compose(
    toon({ releases: { org: api.org, found: releases.length } }),
    toon({
      results: releases.map((release) => ({
        version: release.shortVersion ?? release.version,
        created: relativeAge(release.dateCreated),
        commits: release.commitCount ?? 0,
        deploys: release.deployCount ?? 0,
        newIssues: release.newGroups ?? 0,
      })),
    }),
    helpBlock(
      getSuggestions({
        command: "releases",
        session: session(),
        empty: releases.length === 0,
      }),
    ),
  );
}

async function handleRelease(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const first = requirePositional(
    parsed,
    0,
    "<version>",
    "Run `sentry-axi releases` to list versions",
  );

  // `release new <v>` / `release finalize <v>` - subcommands, flutter-axi style.
  if (first === "new") {
    const version = requirePositional(parsed, 1, "<version>");
    const config = requireConfig();
    const release = await createRelease(api, {
      version,
      projects: [config.project!],
      ...(flagString(parsed, "ref") ? { ref: flagString(parsed, "ref")! } : {}),
      ...(flagString(parsed, "url") ? { url: flagString(parsed, "url")! } : {}),
    });

    return compose(
      toon({
        release: {
          version: release.version,
          project: config.project,
          created: "yes",
        },
      }),
      helpBlock([
        `Run \`sentry-axi sourcemaps upload <dist> --release ${release.version}\` to attach sourcemaps`,
        `Run \`sentry-axi deploy ${release.version} --env production\` once it ships`,
        `Run \`sentry-axi release finalize ${release.version}\` to mark it released`,
      ]),
    );
  }

  if (first === "finalize") {
    const version = requirePositional(parsed, 1, "<version>");
    const release = await finalizeRelease(api, version);

    return compose(
      toon({ release: { version: release.version, finalized: "yes" } }),
      helpBlock([
        `Run \`sentry-axi deploy ${release.version} --env production\` to record a deploy`,
      ]),
    );
  }

  const release = await getRelease(api, first);
  const [commits, deploys] = await Promise.all([
    getReleaseCommits(api, first, 10).catch(() => []),
    listDeploys(api, first, 10).catch(() => []),
  ]);

  return compose(
    toon({
      release: {
        version: release.version,
        created: relativeAge(release.dateCreated),
        released: release.dateReleased
          ? relativeAge(release.dateReleased)
          : "not finalized",
        commits: release.commitCount ?? commits.length,
        deploys: release.deployCount ?? deploys.length,
        newIssues: release.newGroups ?? 0,
      },
    }),
    deploys.length > 0
      ? toon({
          deploys: deploys.map((deploy) => ({
            environment: deploy.environment ?? "-",
            name: deploy.name ?? "-",
            when: relativeAge(deploy.dateFinished),
          })),
        })
      : "",
    commits.length > 0
      ? toon({
          commits: commits.map((commit) => ({
            sha: commit.id.slice(0, 10),
            author: commit.author?.email ?? commit.author?.name ?? "-",
            message: (commit.message ?? "").split("\n")[0].slice(0, 80),
          })),
        })
      : "",
    helpBlock([
      `Run \`sentry-axi issues --query "first-release:${release.version}"\` to see what this release introduced`,
      `Run \`sentry-axi issues --query "release:${release.version}"\` for everything happening on it`,
    ]),
  );
}

async function handleDeploy(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const api = apiFor({ requireProject: false });

  const version = requirePositional(
    parsed,
    0,
    "<version>",
    "Run `sentry-axi releases` to list versions",
  );
  const environment = flagString(parsed, "env");
  if (!environment) {
    throw validationError(
      "An environment is required",
      `Run \`sentry-axi deploy ${version} --env production\``,
    );
  }

  const deploy = await createDeploy(
    api,
    version,
    environment,
    flagString(parsed, "name"),
  );

  return compose(
    toon({
      deploy: {
        version,
        environment: deploy.environment ?? environment,
        name: deploy.name ?? "-",
        recorded: "yes",
      },
    }),
    helpBlock([
      `Run \`sentry-axi issues --query "release:${version}" --period 1h\` to watch for new errors`,
    ]),
  );
}

// --- Handlers: performance ---

async function handlePerf(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);

  const period = validatePeriod(flagString(parsed, "period") ?? "24h");
  const limit = flagInt(parsed, "limit", 10);
  const query = flagString(parsed, "query") ?? "";

  const api = apiFor();

  // Discover needs the numeric project id, not the slug.
  const project = await getProject(api, api.project!);

  const [transactions, volume] = await Promise.all([
    slowestTransactions(api, project.id, { period, limit, query }).catch(
      () => [],
    ),
    errorVolume(api, project.id, period).catch(() => null),
  ]);

  return compose(
    toon({
      perf: {
        project: `${api.org}/${api.project}`,
        period,
        ...(volume
          ? {
              errorsAccepted: volume.accepted,
              errorsDropped:
                volume.filtered + volume.rateLimited + volume.invalid,
            }
          : {}),
      },
    }),
    transactions.length > 0
      ? toon({
          transactions: transactions.map((row) => ({
            transaction: row.transaction,
            p50ms: row.p50,
            p95ms: row.p95,
            count: abbreviateCount(row.count),
            failurePct: row.failurePct,
          })),
        })
      : toon({
          transactions:
            "none - this project has no transaction data (performance monitoring may not be enabled)",
        }),
    helpBlock(getSuggestions({ command: "perf", session: session() })),
  );
}

// --- Handlers: delegated to the official sentry-cli ---

async function handleSourcemaps(args: string[]): Promise<string> {
  const parsed = parseArgs(args, [...GLOBAL_BOOLEANS, "no-strict"]);
  const config = requireConfig();

  const sub = requirePositional(
    parsed,
    0,
    "<upload|inject|explain>",
    "Run `sentry-axi sourcemaps --help` for usage",
  );
  const rest = parsed.positional.slice(1);

  let argv: string[];

  if (sub === "upload") {
    const release = flagString(parsed, "release");
    if (!release) {
      throw validationError(
        "A release is required to upload sourcemaps",
        "Run `sentry-axi sourcemaps upload ./dist --release 4.2.1`",
        "Sourcemaps are keyed by release - without one, Sentry cannot match them to events",
      );
    }
    if (rest.length === 0) {
      throw validationError(
        "At least one path is required",
        "Run `sentry-axi sourcemaps upload ./dist --release <version>`",
      );
    }

    argv = buildSourcemapsUploadArgs({
      release,
      paths: rest.map(resolveOutputPath),
      ...(flagString(parsed, "url-prefix")
        ? { urlPrefix: flagString(parsed, "url-prefix")! }
        : {}),
      ...(flagString(parsed, "dist")
        ? { dist: flagString(parsed, "dist")! }
        : {}),
      strict: !flagBool(parsed, "no-strict"),
    });
  } else if (sub === "inject") {
    if (rest.length === 0) {
      throw validationError(
        "At least one path is required",
        "Run `sentry-axi sourcemaps inject ./dist`",
      );
    }
    argv = buildSourcemapsInjectArgs(rest.map(resolveOutputPath));
  } else if (sub === "explain") {
    const eventId = requirePositional(
      parsed,
      1,
      "<event-id>",
      "Run `sentry-axi events @<ref>` to get an event id",
    );
    argv = buildSourcemapsExplainArgs({ eventId });
  } else {
    throw validationError(
      `Unknown sourcemaps subcommand: ${sub}`,
      "Use one of: upload, inject, explain",
    );
  }

  const { stdout, stderr } = await runSentryCli(argv, config);

  return compose(
    toon({
      sourcemaps: {
        command: sub,
        release: flagString(parsed, "release") ?? "-",
      },
    }),
    textBlock("output", (stdout || stderr).trimEnd()),
    helpBlock(
      sub === "upload"
        ? [
            "Run `sentry-axi sourcemaps explain <event-id>` on a new event to confirm Sentry can unminify it",
            "Sourcemaps only apply to events sent AFTER the upload with the same release",
          ]
        : [
            "Run `sentry-axi sourcemaps upload <paths> --release <version>` next",
          ],
    ),
  );
}

async function handleDebugFiles(args: string[]): Promise<string> {
  const parsed = parseArgs(args, [
    ...GLOBAL_BOOLEANS,
    "include-sources",
    "wait",
  ]);
  const config = requireConfig();

  const sub = requirePositional(parsed, 0, "<upload|check>");
  const rest = parsed.positional.slice(1);

  if (rest.length === 0) {
    throw validationError(
      "At least one path is required",
      "Run `sentry-axi debugfiles upload ./build`",
    );
  }

  const argv =
    sub === "upload"
      ? buildDebugFilesUploadArgs({
          paths: rest.map(resolveOutputPath),
          includeSources: flagBool(parsed, "include-sources"),
          wait: flagBool(parsed, "wait"),
        })
      : sub === "check"
        ? buildDebugFilesCheckArgs(resolveOutputPath(rest[0]))
        : null;

  if (!argv) {
    throw validationError(
      `Unknown debugfiles subcommand: ${sub}`,
      "Use one of: upload, check",
    );
  }

  const { stdout, stderr } = await runSentryCli(argv, config);

  return compose(
    toon({ debugfiles: { command: sub, paths: rest.length } }),
    textBlock("output", (stdout || stderr).trimEnd()),
    helpBlock([
      "Run `sentry-axi issues` to check whether new events now symbolicate",
    ]),
  );
}

async function handleSendEvent(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const config = requireConfig();

  const tags: Record<string, string> = {};
  const rawTag = flagString(parsed, "tag");
  if (rawTag) {
    const colon = rawTag.indexOf(":");
    if (colon === -1) {
      throw validationError(
        `Invalid tag "${rawTag}"`,
        "Tags are key:value, e.g. --tag env:staging",
      );
    }
    tags[rawTag.slice(0, colon)] = rawTag.slice(colon + 1);
  }

  const argv = buildSendEventArgs({
    ...(flagString(parsed, "message")
      ? { message: flagString(parsed, "message")! }
      : {}),
    ...(flagString(parsed, "level")
      ? { level: flagString(parsed, "level")! }
      : {}),
    ...(flagString(parsed, "file")
      ? { file: resolveOutputPath(flagString(parsed, "file")!) }
      : {}),
    tags,
  });

  const { stdout, stderr } = await runSentryCli(argv, config);

  return compose(
    toon({ sendevent: { sent: "yes" } }),
    textBlock("output", (stdout || stderr).trimEnd()),
    helpBlock(["Run `sentry-axi issues --period 1h` to confirm it arrived"]),
  );
}

async function handleMonitor(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const config = requireConfig();

  const sub = requirePositional(parsed, 0, "run");
  if (sub !== "run") {
    throw validationError(
      `Unknown monitor subcommand: ${sub}`,
      "Use: monitor run <slug> -- <cmd>",
    );
  }

  const slug = requirePositional(parsed, 1, "<slug>");
  const command = parsed.positional.slice(2);
  if (command.length === 0) {
    throw validationError(
      "A command to run is required",
      "Run `sentry-axi monitor run <slug> -- ./scripts/job.sh`",
    );
  }

  const argv = buildMonitorRunArgs({
    slug,
    command,
    ...(flagString(parsed, "env")
      ? { environment: flagString(parsed, "env")! }
      : {}),
  });

  const { stdout, stderr } = await runSentryCli(argv, config);

  return compose(
    toon({ monitor: { slug, command: command.join(" ") } }),
    textBlock("output", (stdout || stderr).trimEnd()),
    helpBlock([
      "Check-in was recorded against the monitor - view it in Sentry Crons",
    ]),
  );
}

// --- Handlers: setup & home ---

async function handleSetup(args: string[]): Promise<string> {
  const parsed = parseArgs(args, GLOBAL_BOOLEANS);
  const sub = requirePositional(
    parsed,
    0,
    "hooks",
    "Run `sentry-axi setup hooks`",
  );

  if (sub !== "hooks") {
    throw validationError(
      `Unknown setup command: ${sub}`,
      "Run `sentry-axi setup hooks`",
    );
  }

  installHooksOrThrow();

  return compose(
    toon({ setup: "SessionStart hooks installed or already up to date" }),
    helpBlock([
      "Restart your agent session for the hook to take effect",
      "The hook surfaces the current Sentry scope and open-issue count at session start",
    ]),
  );
}

/**
 * The home view: what an agent sees when it runs `sentry-axi` bare, and what
 * the SessionStart hook prints.
 *
 * It must be **cheap and side-effect free**. It mints no refs and bumps no
 * generation - a hook that silently invalidated the agent's refs every time a
 * session started would be maddening to debug. When nothing is configured it
 * renders guidance rather than an error, because an error here would be the
 * first thing an agent ever saw from this tool.
 */
async function handleHome(): Promise<string> {
  const token = resolveToken();
  const scope = resolveScope();

  if (!token) {
    return compose(
      toon({ sentry: { authenticated: false } }),
      helpBlock([
        "Run `sentry-axi login --token <token>` to authenticate",
        "Create a token at https://sentry.io/settings/account/api/auth-tokens/ (scopes: org:read, project:read, project:write, event:read)",
        "Run `sentry-axi doctor` to see how config is being resolved",
      ]),
    );
  }

  if (!scope.org || !scope.project) {
    return compose(
      toon({
        sentry: {
          authenticated: true,
          org: scope.org ?? "not set",
          project: scope.project ?? "not set",
        },
      }),
      helpBlock([
        "Run `sentry-axi orgs` to list organizations",
        "Run `sentry-axi use <org>/<project>` to pin a scope",
      ]),
    );
  }

  // Best-effort peek at what is broken. A failure here must not make the home
  // view (and therefore every agent session start) fail.
  try {
    const api = new SentryApi({
      token,
      url: resolveApiUrl(),
      org: scope.org,
      project: scope.project,
    });
    const issues = await listIssues(api, {
      limit: 5,
      period: "24h",
      sort: "freq",
    });

    return compose(
      toon({
        sentry: {
          org: scope.org,
          project: scope.project,
          session: session(),
          unresolved24h: issues.length === 5 ? "5+" : issues.length,
        },
      }),
      issues.length > 0
        ? toon({
            top: issues.map((issue) => {
              const summary = summarizeIssue(issue);
              return {
                shortId: summary.shortId,
                level: summary.level,
                events: summary.events,
                users: summary.users,
                title: summary.title.slice(0, 70),
              };
            }),
          })
        : "",
      helpBlock([
        "Run `sentry-axi issues` to list issues with refs you can act on",
        "Then `sentry-axi stacktrace @<ref>` to see where it throws",
        "Run `sentry-axi --help` for the full command list",
      ]),
    );
  } catch {
    return compose(
      toon({
        sentry: { org: scope.org, project: scope.project, session: session() },
      }),
      helpBlock([
        "Run `sentry-axi doctor` - the scope is set but Sentry could not be reached",
        "Run `sentry-axi issues` to list issues",
      ]),
    );
  }
}

// --- Dispatch ---

/**
 * Extract the global scope flags from anywhere in argv and export them as the
 * environment variables the config layer already reads. Downstream modules then
 * need zero plumbing - exactly the trick flutter-axi plays with `--app`.
 */
export function extractGlobalFlags(argv: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--session" && i + 1 < argv.length) {
      process.env.SENTRY_AXI_SESSION = argv[++i];
    } else if (arg === "--org" && i + 1 < argv.length) {
      process.env.SENTRY_ORG = argv[++i];
    } else if (arg === "--project" && i + 1 < argv.length) {
      process.env.SENTRY_PROJECT = argv[++i];
    } else {
      out.push(arg);
    }
  }

  return out;
}

type CommandFn = (args: string[]) => Promise<string>;

const COMMANDS: Record<string, CommandFn> = {
  login: handleLogin,
  use: handleUse,
  orgs: async () => handleOrgs(),
  projects: async () => handleProjects(),
  doctor: async () => handleDoctor(),

  issues: handleIssues,
  search: handleSearch,
  issue: handleIssue,
  stacktrace: handleStacktrace,
  breadcrumbs: handleBreadcrumbs,
  tags: handleTags,
  events: handleEvents,
  event: handleEvent,

  resolve: handleResolve,
  unresolve: handleUnresolve,
  ignore: handleIgnore,
  assign: handleAssign,

  seer: handleSeer,
  suspect: handleSuspect,

  releases: handleReleases,
  release: handleRelease,
  deploy: handleDeploy,

  perf: handlePerf,

  sourcemaps: handleSourcemaps,
  debugfiles: handleDebugFiles,
  sendevent: handleSendEvent,
  monitor: handleMonitor,

  setup: handleSetup,
};

/**
 * Every command sentry-axi registers. Exported so the AXI checklist can be
 * enforced as a test rather than a promise: each name here must have a
 * `COMMAND_HELP` entry and must appear in TOP_HELP's `commands[N]:` block,
 * which is itself the block `src/skill.ts` lifts into the generated SKILL.md.
 */
export const COMMAND_NAMES: string[] = Object.keys(COMMANDS);

export type MainOptions = {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

export async function main(
  options: MainOptions | string[] = {},
): Promise<void> {
  const normalized = Array.isArray(options) ? { argv: options } : options;
  const argv = extractGlobalFlags(normalized.argv ?? process.argv.slice(2));

  await runAxiCli({
    argv,
    ...(normalized.stdout ? { stdout: normalized.stdout } : {}),
    description: HOME_DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: async () => handleHome(),
    commands: COMMANDS,
    getCommandHelp,
    renderUnknownCommand,
    formatError,
  });
}
