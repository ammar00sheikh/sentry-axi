/**
 * Sentry Web API client.
 *
 * sentry-axi has no bridge process (Sentry is a stateless HTTPS API), so this
 * is the whole backend: every CLI invocation is a short-lived process that
 * makes one or two requests and exits.
 *
 * The client's real job is **error translation**. A raw Sentry response can be
 * a 401 with an HTML body, a 429 with a Retry-After, or a 400 whose message is
 * buried in `{detail: ...}`. None of that is actionable to an agent. Every
 * failure leaves this module as a `SentryAxiError` with a stable code and a
 * concrete next command.
 */

import { SentryAxiError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;

/** Resolve the per-request deadline, honoring `SENTRY_AXI_TIMEOUT_MS`. */
export function resolveTimeoutMs(): number {
  const raw = process.env.SENTRY_AXI_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(parsed, MIN_TIMEOUT_MS);
}

export type Query = Record<
  string,
  string | number | boolean | string[] | undefined | null
>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  /** Follow `Link: rel="next"` pages until exhausted or `limit` items. */
  paginate?: boolean;
  limit?: number;
}

/** Injected for tests; defaults to the global fetch. */
export type FetchFn = typeof fetch;

/**
 * Build a full request URL. Array query values repeat the key, which is how
 * Sentry expects multi-valued params (`?field=a&field=b`).
 */
export function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(
    `/api/0${path.startsWith("/") ? path : `/${path}`}`,
    `${base}/`,
  );

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

/**
 * Parse a Sentry `Link` header and return the next-page cursor, or null when
 * there is no further page.
 *
 * Sentry's shape (note `results="true"`, which is what actually signals that
 * the next page is non-empty - a `rel="next"` with `results="false"` is the
 * end of the list and following it returns nothing):
 *
 *   <https://sentry.io/api/0/...>; rel="previous"; results="false"; cursor="0:0:1",
 *   <https://sentry.io/api/0/...>; rel="next"; results="true"; cursor="0:100:0"
 */
export function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    if (!/rel="next"/.test(part)) continue;
    if (/results="false"/.test(part)) return null;
    const cursor = part.match(/cursor="([^"]*)"/);
    return cursor ? cursor[1] : null;
  }

  return null;
}

/**
 * Lift a human-readable message out of a Sentry error body, which may be
 * `{detail: "..."}`, `{detail: {message: "..."}}`, `{error: "..."}`, a
 * field-errors object, or plain text / HTML.
 */
export function extractApiMessage(body: unknown, status: number): string {
  if (typeof body === "string") {
    const text = body.trim();
    // An HTML error page carries no useful message - don't dump markup.
    if (text.startsWith("<") || text.length === 0) {
      return `Sentry returned HTTP ${status}`;
    }
    return text.slice(0, 300);
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    const detail = record.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }

    if (typeof record.error === "string") return record.error;

    // Field validation errors: {"query": ["Invalid syntax"]}
    const fields = Object.entries(record)
      .filter(([, v]) => Array.isArray(v) && v.length > 0)
      .map(([k, v]) => `${k}: ${(v as unknown[])[0]}`);
    if (fields.length > 0) return fields.join("; ");
  }

  return `Sentry returned HTTP ${status}`;
}

/**
 * Map an HTTP status onto a structured error with recovery suggestions. This
 * is the single place a Sentry failure becomes agent-actionable.
 */
export function errorForStatus(
  status: number,
  message: string,
  context: { retryAfter?: string | null; url?: string } = {},
): SentryAxiError {
  if (status === 401) {
    return new SentryAxiError(
      `Sentry rejected the auth token: ${message}`,
      "AUTH_INVALID",
      [
        "Run `sentry-axi login --token <token>` with a fresh token",
        "Check the token has not expired at https://sentry.io/settings/account/api/auth-tokens/",
      ],
    );
  }

  if (status === 403) {
    return new SentryAxiError(
      `Auth token lacks permission for this request: ${message}`,
      "AUTH_INVALID",
      [
        "The token needs scopes: org:read, project:read, project:write (to resolve/assign), event:read",
        "Re-issue the token with those scopes and run `sentry-axi login --token <token>`",
      ],
    );
  }

  if (status === 404) {
    return new SentryAxiError(`Not found: ${message}`, "NOT_FOUND", [
      "Run `sentry-axi projects` to confirm the org/project slugs",
      "Run `sentry-axi use <org>/<project>` to re-pin the scope",
    ]);
  }

  if (status === 429) {
    const delay = context.retryAfter
      ? `${context.retryAfter}s`
      : "a few seconds";
    return new SentryAxiError(
      `Rate limited by Sentry: ${message}`,
      "RATE_LIMITED",
      [
        `Wait ${delay} and retry the command`,
        "Narrow the window with `--period 1h` or lower `--limit` to make fewer requests",
      ],
    );
  }

  if (status >= 500) {
    return new SentryAxiError(
      `Sentry server error (${status}): ${message}`,
      "API_ERROR",
      [
        "Retry the command - 5xx from Sentry is usually transient",
        "Check https://status.sentry.io if it persists",
      ],
    );
  }

  return new SentryAxiError(
    `Sentry API error (${status}): ${message}`,
    "API_ERROR",
    ["Run `sentry-axi <command> --help` to check the arguments"],
  );
}

export class SentryApi {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs: number = resolveTimeoutMs(),
  ) {}

  get org(): string {
    return this.config.org;
  }

  get project(): string | null {
    return this.config.project;
  }

  get baseUrl(): string {
    return this.config.url;
  }

  /**
   * One request. Returns the decoded JSON body, or the raw text when the
   * response is not JSON (a few Sentry endpoints return empty 204s).
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { method = "GET", query, body } = options;

    if (options.paginate) {
      return (await this.requestAll(path, options)) as T;
    }

    const url = buildUrl(this.config.url, path, query);
    const response = await this.send(url, method, body);
    return (await this.decode(response, url)) as T;
  }

  /**
   * Follow `Link: rel="next"` until the list is exhausted or `limit` items
   * have been collected. Sentry pages at 100 by default, and an agent asking
   * for "all unresolved issues" should not have to drive the cursor itself.
   */
  async requestAll<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T[]> {
    const { method = "GET", query, body, limit = 100 } = options;

    const collected: T[] = [];
    let cursor: string | null = null;

    do {
      const url: string = buildUrl(this.config.url, path, {
        ...query,
        ...(cursor ? { cursor } : {}),
      });

      const response = await this.send(url, method, body);
      const page = (await this.decode(response, url)) as T[];

      if (!Array.isArray(page)) {
        throw new SentryAxiError(
          `Expected a list from ${path} but got a single object`,
          "API_ERROR",
          ["This is a sentry-axi bug - please report it"],
        );
      }

      collected.push(...page);
      if (collected.length >= limit) break;

      cursor = parseNextCursor(response.headers.get("link"));
    } while (cursor);

    return collected.slice(0, limit);
  }

  private async send(
    url: string,
    method: string,
    body: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SentryAxiError(
          `Request to Sentry timed out after ${this.timeoutMs}ms`,
          "TIMEOUT",
          [
            "Raise the deadline with SENTRY_AXI_TIMEOUT_MS=60000",
            "Narrow the query with `--period 1h` or a lower `--limit`",
          ],
        );
      }

      const reason = error instanceof Error ? error.message : String(error);
      throw new SentryAxiError(
        `Could not reach Sentry at ${this.config.url}: ${reason}`,
        "NETWORK_ERROR",
        [
          "Check network connectivity and any proxy settings",
          `Confirm the API URL is right (currently ${this.config.url}); set SENTRY_AXI_URL for self-hosted Sentry`,
        ],
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async decode(response: Response, url: string): Promise<unknown> {
    const text = await response.text();

    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw errorForStatus(
        response.status,
        extractApiMessage(parsed, response.status),
        {
          retryAfter: response.headers.get("retry-after"),
          url,
        },
      );
    }

    return text.length === 0 ? null : parsed;
  }
}
