#!/usr/bin/env bash
# A full triage flow, the way an agent actually walks it.
#
# Each command's output ends with the next command to run, so an agent following
# the `help[N]:` hints ends up doing exactly this without being told to.
#
#   SENTRY_AUTH_TOKEN=... ./examples/triage-flow.sh acme/frontend
set -euo pipefail

SCOPE="${1:-}"
if [ -z "$SCOPE" ]; then
  echo "usage: $0 <org>/<project>" >&2
  exit 1
fi

axi() { sentry-axi "$@"; }

echo "── 0. Confirm auth, scope, and connectivity ─────────────────"
axi use "$SCOPE"
axi doctor

echo
echo "── 1. What is broken? (mints @g1:N refs) ────────────────────"
# --sort user ranks by people affected, not raw event count. These routinely
# name DIFFERENT issues - a noisy retry loop can out-count a real outage.
axi issues --sort user --period 24h --limit 10

echo
echo "── 2. Where does the top issue throw? ───────────────────────"
# Refs are passed back exactly as printed. --context pulls the source lines
# around the crashing frame so you can read the bug without opening the repo.
axi stacktrace @g1:1 --context

echo
echo "── 3. What led up to it? ────────────────────────────────────"
axi breadcrumbs @g1:1

echo
echo "── 4. Is it isolated to one release / browser / customer? ───"
axi tags @g1:1

echo
echo "── 5. Let Sentry's AI diagnose the root cause ───────────────"
# Starts a Seer run and polls it to completion - one command, not a poll loop.
axi seer @g1:1

echo
echo "── 6. Which commit introduced it, and who wrote it? ─────────"
axi suspect @g1:1

echo
echo "── 7. Is it happening in other projects too? ────────────────"
axi search "is:unresolved TypeError" --period 7d

echo
echo "────────────────────────────────────────────────────────────"
echo "Now fix the code. Once the fix is deployed:"
echo
echo "  sentry-axi resolve @g1:1 --in-next-release"
echo
echo "(--in-next-release makes Sentry reopen the issue automatically if it"
echo " recurs before the fix actually ships. Undo any of it with"
echo " \`sentry-axi unresolve @g1:1\`.)"
