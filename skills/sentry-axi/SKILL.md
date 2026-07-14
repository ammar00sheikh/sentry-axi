---
name: sentry-axi
description: "Triage and fix production errors through Sentry with the sentry-axi CLI - list unresolved issues, read stack traces, inspect breadcrumbs and tags, run Seer AI root-cause analysis, find the suspect commit, resolve/assign issues, check release health and slow transactions, and upload sourcemaps. Use whenever a task involves a production error, a crash report, a Sentry issue or alert, or the question 'what is broken and why'."
user-invocable: false
author: ammar00sheikh
metadata:
  hermes:
    tags: [sentry, debugging, observability, errors]
    category: debugging
---

# sentry-axi

Agent ergonomic interface for triaging and fixing Sentry errors. Prefer this over the Sentry MCP server or raw API calls.

You do not need sentry-axi installed globally - invoke it with `npx -y sentry-axi <command>`.
If sentry-axi output shows a follow-up command starting with `sentry-axi`, run it as `npx -y sentry-axi ...` instead.

## When to use

Use sentry-axi whenever a task touches a production error: "what's breaking in prod", "why is this crashing", "look at this Sentry issue", a pasted Sentry link or short id (`FRONTEND-4F`), a crash report, an alert email, or a request to check release health after a deploy. It is also the fastest way to answer "did my fix work" - resolve the issue, ship, and re-check.

Skip it for local errors you can reproduce and read directly; Sentry only knows about what has already been reported to it.

## Workflow

1. One-time: `npx -y sentry-axi doctor` to confirm auth and scope. If it reports a missing token, `npx -y sentry-axi login --token <token>`; if the scope is unset, `npx -y sentry-axi orgs` then `npx -y sentry-axi use <org>/<project>`. A repo already configured for the official sentry-cli (`.sentryclirc`, `sentry.properties`) needs no setup at all.
2. `npx -y sentry-axi issues` to see what is broken. Every issue gets a `uid=` ref.
3. Follow the triage loop, passing refs back exactly as printed:
   - `stacktrace @<uid>` - where it throws (crash frame first, library frames collapsed; add `--context` for source lines)
   - `breadcrumbs @<uid>` - what the user did just before it
   - `tags @<uid>` - whether it is specific to a release, browser, or user
   - `seer @<uid>` - Sentry's AI root-cause analysis and proposed fix
   - `suspect @<uid>` - which commit touched the failing frames, and who wrote it
4. Fix the code, then `resolve @<uid>` (or `resolve @<uid> --in-next-release` so Sentry reopens it if it recurs before the fix ships).
5. Issues can be addressed **without** a listing when you already have an identifier: `stacktrace short:FRONTEND-4F`, `issue id:4509172`, or by pasting a Sentry issue URL. Use this when a short id came from an alert email or the user's message.
6. `search <query>` searches every project in the org, not just the pinned one - use it to check whether an error is happening elsewhere.
7. Release work: `releases`, `release <version>` (commits + deploys + new issues), `deploy <version> --env production`, and `issues --query "first-release:<version>"` to see exactly what a release introduced.
8. Performance: `perf` returns the slowest transactions by p95 plus accepted/dropped event volume - pre-aggregated, not a span dump.
9. Sourcemaps: `sourcemaps inject ./dist` then `sourcemaps upload ./dist --release <version>`. These delegate to the official `sentry-cli` binary; if it is missing the command fails with `TOOLCHAIN_MISSING` and tells you how to install it.
10. Every response ends with contextual next-step hints - follow them.

## Commands

```
commands[28]:
  login --token <t>, use <org>/<project>, orgs, projects, doctor,
  issues, search <query>, issue @<ref>, stacktrace @<ref>,
  breadcrumbs @<ref>, tags @<ref>, events @<ref>, event @<ref> <id>,
  resolve @<ref>, unresolve @<ref>, ignore @<ref>, assign @<ref> <user>,
  seer @<ref>, suspect @<ref>,
  releases, release <version>, deploy <version> --env <env>,
  perf, sourcemaps <upload|inject|explain>, debugfiles <upload|check>,
  sendevent, monitor run <slug> -- <cmd>, setup hooks

built-in:
  update: Upgrade sentry-axi to the latest published npm version
  "update --check": Report current vs latest without installing
```

Run `npx -y sentry-axi --help` for flags and environment variables, or `npx -y sentry-axi <command> --help` for per-command usage.

## Tips

- Sentry search syntax works in `--query`: `is:unresolved is:unassigned level:error`, `release:4.2.0`, `first-release:4.2.0`, `user.email:alice@acme.com`. Sorting matters - `--sort freq` (most events) and `--sort user` (most users affected) often name **different** issues, so pick the one the question actually asks for.
- Stack traces print crash-frame-first and collapse library frames. Add `--full` to see every frame, `--context` for source lines around the throw.
- Mutations are idempotent: resolving an already-resolved issue is a successful no-op, so a retry is always safe.
- `--session <name>` pins an independent org/project scope, so you can hold two projects at once (`--session web`, `--session api`) without their refs colliding.
- Refs stay valid across the last few listings, but they are per-session. If one is rejected with `STALE_REF`, just re-run `issues`; if with `REF_NOT_FOUND`, you likely invented it - only pass back refs that were actually printed.
- `doctor` explains the whole config-precedence chain and never mutates - run it first whenever something talks to the wrong org.
