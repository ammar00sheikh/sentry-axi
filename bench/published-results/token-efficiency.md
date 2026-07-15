# Token efficiency — measured

This is a **real, reproducible measurement** taken against a live Sentry
instance on 2026-07-15. It is not the full agent-task study (that lives in
[`bench/`](../README.md) and is still pending — see the note at the bottom).

## What it measures

The AXI thesis is that the same backend data costs an agent far fewer tokens
when delivered as sentry-axi's rendered output than as the raw payload it is
derived from. So for three representative operations we captured, for the
**same underlying data**:

- what **sentry-axi** prints (the text an agent actually reads — TOON metadata,
  the rendered stack trace, the `help[N]:` block), and
- the **raw Sentry Web API JSON** for the same objects (what a raw-JSON MCP
  tool, or an agent given direct API access, would consume).

Both sides were tokenized with the `gpt-tokenizer` o200k encoder (a documented
proxy — no exact public Claude tokenizer exists; the ratio is what matters and
it is stable across encoders).

## Results

Target: a real .NET project (`haramcore`), 24 unresolved issues over 14 days,
and one issue's latest event carrying an 11-frame stack trace.

| Operation                       | Raw API tokens | sentry-axi tokens | Reduction |
| ------------------------------- | -------------: | ----------------: | --------: |
| List issues (24 issues)         |         12,239 |             1,608 |   **87%** |
| Issue detail + top tags         |          1,747 |               350 |   **80%** |
| Stack trace (1 event, 11 frames)|         12,775 |               641 |   **95%** |
| **Total**                       |     **26,761** |         **2,599** |   **90%** |

**The raw payloads cost 10.3× the tokens of sentry-axi's output** for the same
information.

The stack trace is the extreme case (95%) and the most important one: a single
Sentry event is ~42KB of JSON — every frame carries `vars`, source `context`,
module paths, instruction addresses, and a dozen redundant id fields. sentry-axi
reverses the frames, collapses the library noise, and prints the app-code frames
an engineer can act on. The list case (87%) is TOON's tabular encoding doing its
job: field names stated once in a header instead of repeated on every object.

## Reproduce it

```sh
export SENTRY_AUTH_TOKEN=... SENTRY_AXI_URL=https://your-instance
sentry-axi use <org>/<project>

BASE="$SENTRY_AXI_URL/api/0"
IID=$(curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "$BASE/projects/<org>/<project>/issues/?query=is:unresolved&statsPeriod=14d&limit=25" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

# sentry-axi output (what the agent reads)
sentry-axi issues --period 14d --limit 25      > axi_issues.txt
sentry-axi stacktrace id:$IID                   > axi_stacktrace.txt

# raw API JSON (same data, unrendered)
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "$BASE/projects/<org>/<project>/issues/?query=is:unresolved&statsPeriod=14d&limit=25" > raw_issues.json
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "$BASE/issues/$IID/events/latest/" > raw_event.json

# tokenize both with any tokenizer, e.g. gpt-tokenizer's o200k encoder
```

## What this does NOT measure

This is **output token efficiency only** — input tokens per operation. It is the
core of the AXI claim, but it is not the whole story flutter-axi's study tells.
The full agent-task benchmark — end-to-end **turns, cost, wall-clock, and task
success rate** for an agent driving sentry-axi versus the raw Sentry MCP server,
scored by an LLM judge — is implemented in [`bench/`](../README.md) but has not
been run yet, because it executes mutating tasks (`resolve`, `assign`) and so
requires a dedicated throwaway Sentry project, which does not exist yet. When it
runs, its numbers land beside this file.
