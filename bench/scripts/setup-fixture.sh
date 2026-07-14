#!/usr/bin/env bash
# Seed the deterministic error fixture the benchmark triages.
#
# The flutter-axi harness this is ported from generates a counter app; there is
# no local app here — the "fixture" is a Sentry project containing a known set
# of errors. This script emits them through the Sentry envelope endpoint with
# explicit fingerprints, so every issue's title, event count, user count,
# release, stack trace, breadcrumbs and tags are ground truth the grading hints
# in config/tasks.yaml can be written against.
#
# Seeded issues (see config/tasks.yaml for how they are used):
#   1. TypeError  "Cannot read properties of undefined (reading 'total')"
#      12 events / 8 users / src/checkout/cart.js / release 4.2.0 / breadcrumbs
#   2. TimeoutError "payment gateway did not respond within 30s"
#      9 events / 9 users / src/payments/gateway.py / release 4.1.0
#   3. NullPointerException "session token was null"
#      3 events / 3 users / com/example/auth/Session.java / release 4.1.0
#   4. RateLimitExceeded "429 from upstream"
#      2 events / 1 user  / src/api/client.ts / release 4.1.0
#   5. ImageDecodeError "unsupported chunk"
#      1 event  / 1 user  / src/media/decode.rs / release 4.1.0
# Plus three transactions: GET /checkout (~3.2s), GET /api/search (~0.4s),
# GET /home (~0.12s).
#
# Most-events (1) and most-users (2) are deliberately different issues.
#
# SAFETY
#   This script writes real events into a real Sentry project. It refuses to
#   run unless SENTRY_BENCH_ORG/SENTRY_BENCH_PROJECT name the target explicitly
#   AND SENTRY_BENCH_DSN's project id resolves, through the Sentry API, to that
#   same project. It never reads the ambient SENTRY_ORG/SENTRY_PROJECT or a
#   `sentry-axi use` scope, so a shell pinned to production cannot become the
#   target by accident. Point it at a dedicated throwaway project.
#
# USAGE
#   export SENTRY_AUTH_TOKEN=...      # org:read, project:read, project:write
#   export SENTRY_BENCH_ORG=acme
#   export SENTRY_BENCH_PROJECT=axi-bench
#   export SENTRY_BENCH_DSN='https://<key>@o123.ingest.sentry.io/456'
#   bench/scripts/setup-fixture.sh [--force]
#
# Idempotent: exits early if the fixture is already present, unless --force.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

: "${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN must be set (scopes: org:read, project:read, project:write)}"
: "${SENTRY_BENCH_ORG:?SENTRY_BENCH_ORG must name the throwaway bench org}"
: "${SENTRY_BENCH_PROJECT:?SENTRY_BENCH_PROJECT must name the throwaway bench project - never a production project}"
: "${SENTRY_BENCH_DSN:?SENTRY_BENCH_DSN must be the ingest DSN of the bench project}"

API_URL="${SENTRY_URL:-https://sentry.io}"
API_URL="${API_URL%/}"
FIXTURE_TAG="v1"

# --- Parse the DSN: https://<key>@<host>/<project_id> ---
dsn_rest="${SENTRY_BENCH_DSN#*://}"
DSN_PROTO="${SENTRY_BENCH_DSN%%://*}"
DSN_KEY="${dsn_rest%%@*}"
dsn_hostpath="${dsn_rest#*@}"
DSN_HOST="${dsn_hostpath%%/*}"
DSN_PROJECT_ID="${dsn_hostpath##*/}"

if [ -z "$DSN_KEY" ] || [ -z "$DSN_HOST" ] || [ -z "$DSN_PROJECT_ID" ]; then
  echo "SENTRY_BENCH_DSN is not a valid DSN: expected https://<key>@<host>/<project_id>" >&2
  exit 1
fi

ENVELOPE_URL="$DSN_PROTO://$DSN_HOST/api/$DSN_PROJECT_ID/envelope/"

api() {
  curl -sS -f -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$@"
}

# --- Safety: the DSN must belong to the named bench project ---
echo "Verifying $SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT owns DSN project id $DSN_PROJECT_ID..."
keys_json="$(api "$API_URL/api/0/projects/$SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT/keys/")"
if ! printf '%s' "$keys_json" | grep -q "\"$DSN_KEY\""; then
  echo "REFUSING TO SEED: SENTRY_BENCH_DSN's public key is not a key of $SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT." >&2
  echo "The DSN and the bench project must be the same project, or events would land somewhere unintended." >&2
  exit 1
fi
echo "  DSN belongs to the bench project."

# --- Idempotency: already seeded? ---
existing="$(api --get --data-urlencode "query=bench_fixture:$FIXTURE_TAG" --data-urlencode "statsPeriod=90d" \
  "$API_URL/api/0/projects/$SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT/issues/" | grep -o '"id"' | wc -l | tr -d ' ')"
if [ "$existing" -ge 5 ] && [ "$FORCE" -eq 0 ]; then
  echo "Fixture already seeded ($existing issues tagged bench_fixture:$FIXTURE_TAG). Use --force to re-emit."
  exit 0
fi

NOW="$(date -u +%s)"
hex32() { LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 32; }
hex16() { LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 16; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z; }

sent=0

# send_envelope <item_type> <payload_json>
send_envelope() {
  local item_type="$1" payload="$2" event_id sent_at
  event_id="$(hex32)"
  sent_at="$(iso "$NOW")"
  payload="${payload/__EVENT_ID__/$event_id}"

  {
    printf '{"event_id":"%s","sent_at":"%s"}\n' "$event_id" "$sent_at"
    printf '{"type":"%s","content_type":"application/json"}\n' "$item_type"
    printf '%s\n' "$payload"
  } | curl -sS -f -X POST "$ENVELOPE_URL" \
        -H "Content-Type: application/x-sentry-envelope" \
        -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=sentry-axi-bench/1.0, sentry_key=$DSN_KEY" \
        --data-binary @- > /dev/null
  sent=$((sent + 1))
}

# Breadcrumb trail attached to every event of the top (TypeError) issue.
BREADCRUMBS='"breadcrumbs":{"values":[
  {"type":"navigation","category":"navigation","level":"info","message":"navigated to /cart","data":{"from":"/","to":"/cart"}},
  {"type":"user","category":"ui.click","level":"info","message":"clicked button \"Checkout\""},
  {"type":"http","category":"xhr","level":"info","message":"GET /api/cart","data":{"method":"GET","url":"/api/cart","status_code":200}},
  {"type":"http","category":"xhr","level":"error","message":"POST /api/checkout","data":{"method":"POST","url":"/api/checkout","status_code":500}}
]},'

# error_event <fingerprint> <platform> <release> <type> <value> <frames_json> <user_n> <ts> <breadcrumbs_or_empty>
error_event() {
  local fp="$1" platform="$2" release="$3" etype="$4" evalue="$5" frames="$6" user_n="$7" ts="$8" crumbs="${9:-}"
  send_envelope event "$(cat <<JSON
{
  "event_id": "__EVENT_ID__",
  "timestamp": $ts,
  "platform": "$platform",
  "level": "error",
  "logger": "bench",
  "release": "$release",
  "environment": "production",
  "fingerprint": ["$fp"],
  "server_name": "bench-fixture",
  "tags": {
    "bench_fixture": "$FIXTURE_TAG",
    "browser": "Chrome",
    "browser.name": "Chrome",
    "os": "Windows",
    "os.name": "Windows"
  },
  "user": {
    "id": "bench-user-$user_n",
    "username": "bench-user-$user_n",
    "email": "bench-user-$user_n@example.com",
    "ip_address": "203.0.113.$user_n"
  },
  $crumbs
  "exception": {
    "values": [
      {
        "type": "$etype",
        "value": "$evalue",
        "mechanism": {"type": "generic", "handled": false},
        "stacktrace": {"frames": $frames}
      }
    ]
  }
}
JSON
)"
}

# transaction <name> <op> <duration_seconds> <ts>
transaction() {
  local name="$1" op="$2" dur="$3" ts="$4" start
  start="$(awk -v t="$ts" -v d="$dur" 'BEGIN{printf "%.3f", t - d}')"
  send_envelope transaction "$(cat <<JSON
{
  "event_id": "__EVENT_ID__",
  "type": "transaction",
  "transaction": "$name",
  "transaction_info": {"source": "url"},
  "start_timestamp": $start,
  "timestamp": $ts,
  "platform": "javascript",
  "release": "4.2.0",
  "environment": "production",
  "tags": {"bench_fixture": "$FIXTURE_TAG"},
  "contexts": {
    "trace": {
      "trace_id": "$(hex32)",
      "span_id": "$(hex16)",
      "op": "$op",
      "status": "ok"
    }
  },
  "spans": []
}
JSON
)"
}

CART_FRAMES='[
  {"filename":"src/app/main.js","abs_path":"/app/src/app/main.js","function":"handleSubmit","module":"app.main","lineno":118,"colno":5,"in_app":true},
  {"filename":"src/checkout/checkout.js","abs_path":"/app/src/checkout/checkout.js","function":"submitOrder","module":"checkout.checkout","lineno":77,"colno":11,"in_app":true},
  {"filename":"src/checkout/cart.js","abs_path":"/app/src/checkout/cart.js","function":"calculateTotal","module":"checkout.cart","lineno":42,"colno":19,"in_app":true,"context_line":"  return cart.items.reduce((sum, i) => sum + i.total, 0);"}
]'

GATEWAY_FRAMES='[
  {"filename":"src/payments/service.py","abs_path":"/srv/src/payments/service.py","function":"charge","module":"payments.service","lineno":63,"in_app":true},
  {"filename":"src/payments/gateway.py","abs_path":"/srv/src/payments/gateway.py","function":"post_authorization","module":"payments.gateway","lineno":118,"in_app":true,"context_line":"    resp = self._session.post(url, json=payload, timeout=30)"}
]'

SESSION_FRAMES='[
  {"filename":"com/example/api/Handler.java","function":"handle","module":"com.example.api.Handler","lineno":54,"in_app":true},
  {"filename":"com/example/auth/Session.java","function":"currentUser","module":"com.example.auth.Session","lineno":91,"in_app":true,"context_line":"    return token.getSubject();"}
]'

CLIENT_FRAMES='[
  {"filename":"src/api/client.ts","abs_path":"/app/src/api/client.ts","function":"request","module":"api.client","lineno":205,"colno":13,"in_app":true,"context_line":"    throw new RateLimitExceeded(res.status);"}
]'

DECODE_FRAMES='[
  {"filename":"src/media/decode.rs","abs_path":"/app/src/media/decode.rs","function":"decode_png","module":"media::decode","lineno":312,"in_app":true,"context_line":"    return Err(ImageDecodeError::UnsupportedChunk(kind));"}
]'

echo "Seeding fixture into $SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT (project id $DSN_PROJECT_ID)..."

# 1. TypeError — most EVENTS (12 across 8 users). Only issue in release 4.2.0.
#    User 8 owns the most recent event (oldest offsets are emitted first).
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  case "$i" in
    1|9)  user=1 ;;
    2|10) user=2 ;;
    3|11) user=3 ;;
    4|12) user=4 ;;
    5)    user=5 ;;
    6)    user=6 ;;
    7)    user=7 ;;
    8)    user=8 ;;
  esac
  # The last event emitted must be the most recent AND belong to bench-user-8.
  if [ "$i" -eq 12 ]; then user=8; fi
  ts=$((NOW - (13 - i) * 600))
  error_event "bench-checkout-typeerror" javascript "4.2.0" \
    "TypeError" "Cannot read properties of undefined (reading 'total')" \
    "$CART_FRAMES" "$user" "$ts" "$BREADCRUMBS"
done

# 2. TimeoutError — most USERS (9 events, one per distinct user). Fewer events
#    than the TypeError above (12) but more distinct users than its 8, which is
#    what makes "most frequent" and "most users affected" different answers.
for u in 1 2 3 4 5 6 7 8 9; do
  ts=$((NOW - (10 - u) * 900))
  error_event "bench-payment-timeout" python "4.1.0" \
    "TimeoutError" "payment gateway did not respond within 30s" \
    "$GATEWAY_FRAMES" "$((u + 10))" "$ts"
done

# 3. NullPointerException — 3 events / 3 users
for u in 1 2 3; do
  ts=$((NOW - u * 1800))
  error_event "bench-auth-npe" java "4.1.0" \
    "NullPointerException" "session token was null" \
    "$SESSION_FRAMES" "$((u + 20))" "$ts"
done

# 4. RateLimitExceeded — 2 events / 1 user
for i in 1 2; do
  ts=$((NOW - i * 2400))
  error_event "bench-api-ratelimit" javascript "4.1.0" \
    "RateLimitExceeded" "429 from upstream" \
    "$CLIENT_FRAMES" 30 "$ts"
done

# 5. ImageDecodeError — 1 event / 1 user
error_event "bench-media-decode" rust "4.1.0" \
  "ImageDecodeError" "unsupported chunk" \
  "$DECODE_FRAMES" 31 "$((NOW - 3000))"

# Transactions for the performance task.
for i in 1 2 3 4 5; do
  transaction "GET /checkout"   "http.server" 3.2   "$((NOW - i * 300))"
  transaction "GET /api/search" "http.server" 0.4   "$((NOW - i * 300))"
  transaction "GET /home"       "http.server" 0.12  "$((NOW - i * 300))"
done

echo "Sent $sent envelopes. Sentry ingests asynchronously — allow ~30s before running the benchmark."
echo "Verify with: sentry-axi use $SENTRY_BENCH_ORG/$SENTRY_BENCH_PROJECT && sentry-axi issues"
