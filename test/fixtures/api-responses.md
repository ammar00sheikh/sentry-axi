# Captured Sentry API response shapes

Every parser in `src/` is written against the **exact** payload shapes below.
They are captured from the live Sentry API (`https://sentry.io/api/0`), trimmed
to the fields sentry-axi actually reads, and used as the source of truth for the
unit tests.

**If a Sentry API response shape changes**, re-capture it here, update the
parser, and adjust its test in the same change. Do not "fix" a parser against a
shape that is not written down — the next person will not know what it was
supposed to handle.

Capture a fresh payload with:

```sh
curl -sH "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/projects/<org>/<project>/issues/?query=is:unresolved&statsPeriod=24h" | jq '.[0]'
```

---

## `GET /projects/{org}/{project}/issues/`

Note `count` is a **string**, not a number. `culprit` is the location Sentry
guessed; `metadata.filename` is often more precise.

```json
[
  {
    "id": "4509172",
    "shortId": "FRONTEND-4F",
    "title": "TypeError: Cannot read properties of undefined (reading 'name')",
    "culprit": "app/components/UserCard(UserCard)",
    "permalink": "https://acme.sentry.io/issues/4509172/",
    "level": "error",
    "status": "unresolved",
    "substatus": "ongoing",
    "platform": "javascript",
    "isUnhandled": true,
    "count": "1247",
    "userCount": 89,
    "firstSeen": "2026-07-01T10:00:00.000Z",
    "lastSeen": "2026-07-14T09:00:00.000Z",
    "assignedTo": null,
    "metadata": {
      "type": "TypeError",
      "value": "Cannot read properties of undefined (reading 'name')",
      "filename": "app/components/UserCard.tsx",
      "function": "UserCard"
    },
    "project": { "id": "1", "slug": "frontend" }
  }
]
```

## Pagination: the `Link` header

The cursor is only worth following when `results="true"`. A `rel="next"` with
`results="false"` is the **end of the list** — following it returns an empty
page forever, which is how a naive paginator ends up in an infinite loop.

```
Link: <https://sentry.io/api/0/projects/acme/frontend/issues/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1",
      <https://sentry.io/api/0/projects/acme/frontend/issues/?&cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"
```

## `GET /issues/{id}/events/latest/`

The critical detail: **`stacktrace.frames` is ordered oldest-caller-first**, so
the frame that actually threw is the **last** element. `renderStacktrace`
reverses it, because every agent reads the first line as the culprit.

`entries[].type === "exception"` holds the chain in `data.values`, ordered
**cause-first** — the thrown exception is last there too.

```json
{
  "id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "eventID": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "groupID": "4509172",
  "title": "TypeError: Cannot read properties of undefined (reading 'name')",
  "platform": "javascript",
  "dateCreated": "2026-07-14T09:00:00.000Z",
  "release": { "version": "4.2.0" },
  "user": { "id": "1042", "email": "alice@acme.com" },
  "sdk": { "name": "sentry.javascript.react", "version": "7.100.0" },
  "entries": [
    {
      "type": "exception",
      "data": {
        "values": [
          {
            "type": "TypeError",
            "value": "Cannot read properties of undefined (reading 'name')",
            "mechanism": { "type": "onerror", "handled": false },
            "stacktrace": {
              "frames": [
                {
                  "filename": "node_modules/react-dom/cjs/react-dom.production.js",
                  "function": "renderWithHooks",
                  "lineNo": 11212,
                  "colNo": 18,
                  "inApp": false
                },
                {
                  "filename": "app/pages/Profile.tsx",
                  "function": "Profile",
                  "lineNo": 18,
                  "colNo": 5,
                  "inApp": true
                },
                {
                  "filename": "app/components/UserCard.tsx",
                  "function": "UserCard",
                  "lineNo": 42,
                  "colNo": 21,
                  "inApp": true,
                  "context": [
                    [40, "export function UserCard({ user }: Props) {"],
                    [41, "  return ("],
                    [42, "    <div className=\"card\">{user.name}</div>"],
                    [43, "  );"],
                    [44, "}"]
                  ]
                }
              ]
            }
          }
        ]
      }
    },
    {
      "type": "breadcrumbs",
      "data": {
        "values": [
          {
            "timestamp": "2026-07-14T08:59:58.100Z",
            "type": "navigation",
            "category": "navigation",
            "level": "info",
            "message": "/users -> /users/1042"
          },
          {
            "timestamp": "2026-07-14T08:59:59.400Z",
            "type": "http",
            "category": "fetch",
            "level": "info",
            "data": { "method": "GET", "url": "/api/users/1042", "status_code": 200 }
          }
        ]
      }
    }
  ]
}
```

An HTTP breadcrumb carries **no `message`** — the text has to be synthesized
from `data.method` / `data.url` / `data.status_code`, which is what
`describeCrumbData` does.

## `GET /issues/{id}/autofix/` (Seer)

The least stable shape in the API. Steps have been renamed and re-typed across
releases, and the prose lands under different keys per step type (`causes`,
`insights`, `solution`, `description`), each of which may hold strings **or**
objects with a `markdown` / `description` / `title` field.

`extractInsights` therefore walks defensively rather than matching a schema: a
shape change degrades the output, it does not throw.

```json
{
  "autofix": {
    "run_id": 90210,
    "status": "COMPLETED",
    "steps": [
      {
        "id": "root_cause_analysis",
        "type": "root_cause_analysis",
        "title": "Root cause",
        "status": "COMPLETED",
        "causes": [
          {
            "description": "`user` is undefined when the profile route renders before the fetch resolves.",
            "markdown": "The `UserCard` component reads `user.name` without a null guard. On a cold navigation, `Profile.tsx:18` renders `UserCard` with `user === undefined` because the `/api/users/:id` request has not resolved yet."
          }
        ]
      },
      {
        "id": "solution",
        "type": "solution",
        "title": "Solution",
        "status": "COMPLETED",
        "solution": [
          "Guard the render: return a skeleton while `user` is undefined, or make `Profile` suspend until the fetch resolves."
        ]
      }
    ],
    "changes": []
  }
}
```

## `GET /organizations/{org}/events/` (Discover — transactions)

Aggregate function names come back as the **literal key**, parentheses and all
(`"p95()"`), and durations are floats in milliseconds.

Note the unit mismatch that makes this payload a trap: `p50()` / `p95()` are
**milliseconds** (want one-decimal rounding), but `failure_rate()` is a **ratio
in [0,1]**. Rounding the ratio to one decimal collapses every failure rate under
5% to `0.0` — so `0.031` (3.1% of checkouts failing) would be reported as 0%.
`parseTransactions` scales it to a percentage before rounding.

```json
{
  "data": [
    {
      "transaction": "GET /api/checkout",
      "p50()": 412.5,
      "p95()": 3180.25,
      "count()": 8421,
      "failure_rate()": 0.031
    }
  ]
}
```

## `GET /organizations/{org}/stats_v2/`

Grouped by `outcome`; the quantity lives under the literal key `"sum(quantity)"`.

```json
{
  "groups": [
    { "by": { "outcome": "accepted" }, "totals": { "sum(quantity)": 14203 } },
    { "by": { "outcome": "rate_limited" }, "totals": { "sum(quantity)": 87 } },
    { "by": { "outcome": "filtered" }, "totals": { "sum(quantity)": 12 } }
  ]
}
```

## Error bodies

Sentry is not consistent here, which is why `extractApiMessage` handles all of
these. A 401 in particular can come back as an **HTML page**, and dumping markup
at an agent is worse than useless.

```json
{ "detail": "You do not have permission to perform this action." }
```

```json
{ "detail": { "message": "Invalid token", "code": "invalid-token" } }
```

```json
{ "query": ["Invalid query. Please use a valid search syntax."] }
```
