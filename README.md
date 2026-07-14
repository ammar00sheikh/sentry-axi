<h1 align="center">sentry-axi</h1>

<p align="center">
  <a href="https://github.com/ammar00sheikh/sentry-axi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ammar00sheikh/sentry-axi/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/ammar00sheikh/sentry-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://github.com/ammar00sheikh/sentry-axi/actions/workflows/release-please.yml/badge.svg" /></a>
  <a href="#"><img alt="Sentry" src="https://img.shields.io/badge/sentry-SaaS%20%7C%20self--hosted-blue?style=flat-square" /></a>
</p>

<h3 align="center">The most agent-ergonomic way to triage Sentry errors</h3>

`sentry-axi` wraps the [Sentry API](https://docs.sentry.io/api/) with an [AXI](https://github.com/kunchenguid/axi)-compliant CLI, plus a delegation layer to the official [`sentry-cli`](https://docs.sentry.io/cli/) for everything that needs Sentry's chunked-upload protocol.

- **Token-efficient**: TOON-encoded output and pre-rendered stack traces, instead of the 50-200KB of JSON a raw Sentry event actually is
- **Combined operations**: one command lists, mints refs, and suggests the next step; `seer` starts a run *and* polls it to completion
- **Contextual suggestions**: every response ends with the actual next commands, refs already filled in
- **Built for the triage loop**: `issues` -> `stacktrace` -> `seer`/`suspect` -> `resolve`
- **Everything the official CLI does**: releases, deploys, sourcemaps, debug files, cron monitors
- **Multi-project native**: named sessions hold independent org/project scopes at once

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add ammar00sheikh/sentry-axi --skill sentry-axi -g
```

The skill (generated from the CLI's own guidance) teaches your agent when and how to use sentry-axi; it loads on demand when the agent recognizes a production-error task.

Then authenticate and pin a scope:

```sh
sentry-axi login --token <token>       # or just set SENTRY_AUTH_TOKEN
sentry-axi use acme/frontend
sentry-axi issues
```

If the repo is **already set up for the official sentry-cli** (a `.sentryclirc` or `sentry.properties` with an org/project), sentry-axi picks that up automatically and you can skip both steps.

Create a token at <https://sentry.io/settings/account/api/auth-tokens/> with scopes `org:read`, `project:read`, `project:write`, `event:read`.

Requirements: Node >= 20. The official `sentry-cli` binary is optional — only sourcemap and debug-file uploads need it, and sentry-axi tells you if it is missing.

## What the Agent Sees

```sh
$ sentry-axi issues
issues:
  project: acme/frontend
  query: is:unresolved
  period: 24h
  sort: freq
  found: 3
  generation: g1
results[3]{uid,shortId,level,events,users,age,title,culprit}:
  g1:1,FRONTEND-4F,error,1.2k,89,3h,"TypeError: Cannot read properties of undefined (reading 'name')",app/components/UserCard
  g1:2,FRONTEND-2A,error,310,204,1d,"TimeoutError: payment gateway did not respond",src/payments/gateway.py
  g1:3,FRONTEND-9C,warning,88,12,6h,"Network request failed",app/lib/fetch
help[4]:
  Run `sentry-axi stacktrace @g1:1` to see where FRONTEND-4F throws
  Run `sentry-axi issue @g1:1` for full detail (tags, counts, first/last seen)
  Run `sentry-axi seer @g1:1` for AI root-cause analysis
  Narrow with Sentry search syntax: `sentry-axi issues --query "is:unresolved is:unassigned level:error"`

$ sentry-axi stacktrace @g1:1
issue:
  uid: "g2:1"
  shortId: FRONTEND-4F
  event: a1b2c3d4e5f6...
  release: 4.2.0
  when: 3h
stacktrace:
TypeError: Cannot read properties of undefined (reading 'name')  [unhandled]
  > UserCard at app/components/UserCard.tsx:42
    Profile at app/pages/Profile.tsx:18
  ... 2 library frames
help[4]:
  Run `sentry-axi seer @g2:1` to have Sentry's AI diagnose the root cause
  Run `sentry-axi suspect @g2:1` to find the commit that introduced it
  ...
```

Note the `>` on the first frame. Sentry stores frames **oldest-caller-first**, so the frame that actually threw is last in the payload — sentry-axi reverses them, because an agent reads the first line as the culprit. Library frames collapse to one line so the app code stays readable; `--full` shows them all, `--context` adds source lines around the throw.

Refs carry a `g<N>:` generation prefix. Unlike its sibling [flutter-axi](https://github.com/ammar00sheikh/flutter-axi), refs here stay valid across re-listings (a Sentry issue id is immutable, so `@g1:3` cannot come to mean a different issue), and issues can always be addressed without a listing at all:

```sh
sentry-axi stacktrace short:FRONTEND-4F         # straight from an alert email
sentry-axi issue https://acme.sentry.io/issues/4509172/
```

## The Triage Loop

```sh
sentry-axi issues                      # what is broken (mints refs)
sentry-axi stacktrace @g1:1 --context  # where it throws, with source lines
sentry-axi breadcrumbs @g1:1           # what the user did just before
sentry-axi tags @g1:1                  # is it one release? one browser? one customer?
sentry-axi seer @g1:1                  # Sentry's AI root-cause analysis
sentry-axi suspect @g1:1               # which commit touched those frames, and who wrote it
sentry-axi resolve @g1:1               # ...once you have shipped the fix
```

`--sort freq` (most events) and `--sort user` (most users affected) routinely name **different** issues. Pick the one the question actually asks.

## Releases, Deploys, and Sourcemaps

```sh
sentry-axi releases
sentry-axi release 4.2.0                                  # commits + deploys + new issues
sentry-axi issues --query "first-release:4.2.0"           # exactly what this release introduced

sentry-axi release new 4.2.1 --ref $(git rev-parse HEAD)
sentry-axi sourcemaps inject ./dist
sentry-axi sourcemaps upload ./dist --release 4.2.1
sentry-axi deploy 4.2.1 --env production
```

Sourcemap and debug-file commands delegate to the official `sentry-cli`, which implements Sentry's chunked-upload protocol. `upload` defaults to `--strict`, so uploading **zero** files is a loud error rather than a silent success — a silently-empty upload is the most common reason unminified stack traces never show up.

## Performance

```sh
sentry-axi perf                          # slowest transactions by p95 + accepted/dropped volume
sentry-axi perf --period 7d --limit 20
```

Pre-aggregated: a ranked table, not a span dump.

## Multi-Project

One session = one org/project scope. Add `--session <name>` to any command:

```sh
sentry-axi --session web use acme/frontend
sentry-axi --session api use acme/backend
sentry-axi --session api issues
```

Each session keeps its own scope and its own refs, so they never collide.

## How It Works

```
sentry-axi CLI  (axi-sdk-js: TOON output, structured errors, suggestions)
  ├─► Sentry HTTP API  ─►  issues, events, stack traces, Seer, releases, perf
  └─► official sentry-cli  ─►  sourcemap / debug-file uploads (chunked upload protocol)
```

Every invocation is a short-lived process: resolve config, make one or two requests, render, exit.

**There is no bridge process.** Its siblings ([flutter-axi](https://github.com/ammar00sheikh/flutter-axi), [chrome-devtools-axi](https://github.com/kunchenguid/chrome-devtools-axi)) run a detached daemon holding a persistent MCP session, because a running app or browser is long-lived and stateful. Sentry is a stateless HTTPS API — there is nothing to keep alive, so all of that complexity is simply absent.

### Does it use MCP?

**No — and that is the point.**

Sentry ships an official [remote MCP server](https://mcp.sentry.dev). sentry-axi is an alternative to it, not a wrapper around it: agents use it through plain shell commands, with no MCP configuration at all. That is the [AXI](https://github.com/kunchenguid/axi) thesis — that a CLI with pre-rendered, token-efficient output beats the same capability delivered as MCP tools, because the agent stops paying for tool schemas and raw JSON payloads it has to reduce itself.

The [`bench/`](bench/) harness exists to *test* that claim rather than assert it, by running the same triage tasks through both interfaces and comparing tokens, cost, turns, and success rate.

## Benchmarks

The harness in [`bench/`](bench/) replicates the [axi](https://github.com/kunchenguid/axi) methodology: real Sentry triage tasks run through both `sentry-axi` and Sentry's official remote MCP server, with an LLM judge scoring task success against a live Sentry project.

**No results are published yet.** They will be committed here after a full `matrix` run, from [`bench/published-results/`](bench/published-results/). This README will not carry a comparison table until those numbers come from an actual run — see [`bench/README.md`](bench/README.md) for the methodology and its fairness caveats (notably: mutating tasks like `resolve` snapshot and restore issue state between repeats, and the benchmark refuses to run against anything but a dedicated throwaway project).

## Other Ways to Install

### Curl installer

```sh
curl -fsSL https://raw.githubusercontent.com/ammar00sheikh/sentry-axi/main/install.sh | bash
```

Clones into `~/.sentry-axi/cli` (override with `SENTRY_AXI_HOME`), builds, and links `sentry-axi` onto PATH. Re-running updates the install.

### From source

```sh
git clone https://github.com/ammar00sheikh/sentry-axi.git
cd sentry-axi
npm install
npm run build
npm link        # puts `sentry-axi` on PATH
```

### Session hook

Want the current Sentry scope and open-issue count fed into every agent session, instead of loading on demand?

```sh
sentry-axi setup hooks
```

Installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode**. **Restart your agent session afterwards.** Development entrypoints (`npm run dev`) are guarded from accidental hook installation.

## Self-Hosted Sentry

```sh
export SENTRY_AXI_URL=https://sentry.internal.acme.com
```

Everything else is identical. `sentry-axi doctor` reports the resolved URL, token, and scope — and where each value came from.

## Development

```sh
npm install
npm test          # unit suite (no network needed)
npm run test:e2e  # live suite, needs SENTRY_AUTH_TOKEN + a real org/project
npm run build     # compile to dist/
```

Architecture notes for coding agents: [`AGENTS.md`](AGENTS.md). Contribution conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Limitations

- `suspect` (suspect commits) needs the repository linked to Sentry and commits associated with releases; without that Sentry has nothing to correlate and the command says so.
- `seer` needs Seer enabled for the org; if it is not, the command fails with `SEER_UNAVAILABLE` rather than a raw 4xx.
- `perf` needs performance monitoring enabled on the project; a project with no transaction data reports that explicitly instead of an empty table.
- Sourcemap and debug-file uploads require the official `sentry-cli` binary (`npm i -g @sentry/cli`). Everything else works without it.
