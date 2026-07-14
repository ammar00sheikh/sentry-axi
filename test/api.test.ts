import { describe, expect, it, vi } from "vitest";
import {
  SentryApi,
  buildUrl,
  errorForStatus,
  extractApiMessage,
  parseNextCursor,
  resolveTimeoutMs,
} from "../src/api.js";
import { SentryAxiError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";

const config: ResolvedConfig = {
  token: "sntrys_test",
  url: "https://sentry.io",
  org: "acme",
  project: "frontend",
};

/** A fetch stand-in returning a canned response. */
function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  const { status = 200, headers = {} } = init;
  // 204/205/304 are null-body statuses by spec - the Response constructor throws
  // if you hand them any body at all, even "".
  const nullBody = status === 204 || status === 205 || status === 304;
  const payload = nullBody
    ? null
    : typeof body === "string"
      ? body
      : JSON.stringify(body);

  return vi.fn(
    async () => new Response(payload, { status, headers }),
  ) as unknown as typeof fetch;
}

describe("buildUrl", () => {
  it("prefixes the API version and joins query params", () => {
    expect(buildUrl("https://sentry.io", "/organizations/", { limit: 5 })).toBe(
      "https://sentry.io/api/0/organizations/?limit=5",
    );
  });

  it("repeats array params, which is how Discover expects multiple fields", () => {
    const url = buildUrl("https://sentry.io", "/organizations/acme/events/", {
      field: ["transaction", "p95()"],
    });
    expect(url).toContain("field=transaction");
    expect(url).toContain("field=p95%28%29");
  });

  it("drops empty and nullish params instead of sending `undefined` as a value", () => {
    const url = buildUrl("https://sentry.io", "/x/", {
      a: undefined,
      b: null,
      c: "",
      d: "keep",
    });
    expect(url).toBe("https://sentry.io/api/0/x/?d=keep");
  });

  it("supports a self-hosted base URL", () => {
    expect(
      buildUrl("https://sentry.internal.acme.com", "/organizations/"),
    ).toBe("https://sentry.internal.acme.com/api/0/organizations/");
  });
});

describe("parseNextCursor", () => {
  // Sentry always emits a rel="next" link, even on the last page - it just
  // marks it results="false". A paginator that follows rel="next" blindly
  // therefore loops forever fetching empty pages.
  it("returns null when the next page is marked results=false", () => {
    const link =
      '<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBeNull();
  });

  it("returns the cursor when there really is a next page", () => {
    const link =
      '<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBe("0:100:0");
  });

  it("handles a missing header", () => {
    expect(parseNextCursor(null)).toBeNull();
    expect(parseNextCursor("")).toBeNull();
  });
});

describe("extractApiMessage", () => {
  it("reads the plain {detail} shape", () => {
    expect(
      extractApiMessage({ detail: "You do not have permission." }, 403),
    ).toBe("You do not have permission.");
  });

  it("reads the nested {detail:{message}} shape", () => {
    expect(
      extractApiMessage(
        { detail: { message: "Invalid token", code: "invalid-token" } },
        401,
      ),
    ).toBe("Invalid token");
  });

  it("reads field-validation errors", () => {
    expect(extractApiMessage({ query: ["Invalid search syntax."] }, 400)).toBe(
      "query: Invalid search syntax.",
    );
  });

  // A 401 from Sentry can be an HTML login page. Dumping markup at an agent is
  // worse than useless - it burns context and says nothing.
  it("refuses to echo an HTML error page", () => {
    const html = "<!DOCTYPE html><html><body>Login</body></html>";
    expect(extractApiMessage(html, 401)).toBe("Sentry returned HTTP 401");
  });

  it("falls back to the status when the body says nothing", () => {
    expect(extractApiMessage({}, 500)).toBe("Sentry returned HTTP 500");
    expect(extractApiMessage("", 502)).toBe("Sentry returned HTTP 502");
  });
});

describe("errorForStatus", () => {
  it("maps 401 to AUTH_INVALID with a re-login suggestion", () => {
    const error = errorForStatus(401, "Invalid token");
    expect(error.code).toBe("AUTH_INVALID");
    expect(error.suggestions.join(" ")).toContain("login");
  });

  it("maps 403 to AUTH_INVALID and names the scopes needed", () => {
    const error = errorForStatus(403, "no permission");
    expect(error.code).toBe("AUTH_INVALID");
    expect(error.suggestions.join(" ")).toContain("scopes");
  });

  it("maps 404 to NOT_FOUND", () => {
    expect(errorForStatus(404, "nope").code).toBe("NOT_FOUND");
  });

  it("maps 429 to RATE_LIMITED and surfaces the Retry-After delay", () => {
    const error = errorForStatus(429, "slow down", { retryAfter: "42" });
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.suggestions[0]).toContain("42s");
  });

  it("maps 5xx to a retryable API_ERROR", () => {
    const error = errorForStatus(503, "unavailable");
    expect(error.code).toBe("API_ERROR");
    expect(error.suggestions.join(" ")).toContain("Retry");
  });

  // The AXI contract: every failure carries at least one recovery suggestion.
  it("always attaches at least one suggestion", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      expect(errorForStatus(status, "x").suggestions.length).toBeGreaterThan(0);
    }
  });
});

describe("SentryApi.request", () => {
  it("sends the bearer token and decodes JSON", async () => {
    const fetchFn = fakeFetch([{ id: "1" }]);
    const api = new SentryApi(config, fetchFn);

    const result = await api.request("/organizations/");

    expect(result).toEqual([{ id: "1" }]);
    const [, init] = (
      fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
    ).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sntrys_test",
    );
  });

  it("throws a structured error rather than returning a failed response", async () => {
    const api = new SentryApi(
      config,
      fakeFetch({ detail: "nope" }, { status: 404 }),
    );

    await expect(api.request("/issues/1/")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("maps a network failure to NETWORK_ERROR, not an unhandled throw", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const api = new SentryApi(config, fetchFn);

    const error = await api.request("/organizations/").catch((e) => e);
    expect(error).toBeInstanceOf(SentryAxiError);
    expect(error.code).toBe("NETWORK_ERROR");
    // Self-hosted users get the wrong URL constantly - say which one we tried.
    expect(error.message).toContain("https://sentry.io");
  });

  it("maps an aborted request to TIMEOUT", async () => {
    const fetchFn = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const api = new SentryApi(config, fetchFn, 1000);

    const error = await api.request("/organizations/").catch((e) => e);
    expect(error.code).toBe("TIMEOUT");
    expect(error.suggestions.join(" ")).toContain("SENTRY_AXI_TIMEOUT_MS");
  });

  it("returns null for an empty 204 body", async () => {
    const api = new SentryApi(config, fakeFetch("", { status: 204 }));
    expect(await api.request("/issues/1/")).toBeNull();
  });
});

describe("SentryApi.requestAll", () => {
  it("follows the cursor until the list is exhausted", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify([{ id: "1" }, { id: "2" }]), {
          status: 200,
          headers: {
            link: '<https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"',
          },
        });
      }
      return new Response(JSON.stringify([{ id: "3" }]), { status: 200 });
    }) as unknown as typeof fetch;

    const api = new SentryApi(config, fetchFn);
    const result = await api.requestAll("/x/", { limit: 100 });

    expect(result).toHaveLength(3);
    expect(call).toBe(2);
  });

  it("stops at the limit rather than draining every page", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: "1" }, { id: "2" }]), {
          status: 200,
          headers: {
            link: '<https://sentry.io/api/0/x/?cursor=next>; rel="next"; results="true"; cursor="next"',
          },
        }),
    ) as unknown as typeof fetch;

    const api = new SentryApi(config, fetchFn);
    const result = await api.requestAll("/x/", { limit: 2 });

    expect(result).toHaveLength(2);
    // One page was enough - it must not have chased the (infinite) cursor.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("errors clearly when the endpoint returns an object instead of a list", async () => {
    const api = new SentryApi(config, fakeFetch({ not: "a list" }));
    await expect(api.requestAll("/x/")).rejects.toMatchObject({
      code: "API_ERROR",
    });
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults to 30s and clamps absurdly small values", () => {
    vi.stubEnv("SENTRY_AXI_TIMEOUT_MS", "");
    expect(resolveTimeoutMs()).toBe(30_000);

    vi.stubEnv("SENTRY_AXI_TIMEOUT_MS", "50");
    expect(resolveTimeoutMs()).toBe(1_000);

    vi.stubEnv("SENTRY_AXI_TIMEOUT_MS", "60000");
    expect(resolveTimeoutMs()).toBe(60_000);

    vi.stubEnv("SENTRY_AXI_TIMEOUT_MS", "garbage");
    expect(resolveTimeoutMs()).toBe(30_000);

    vi.unstubAllEnvs();
  });
});
