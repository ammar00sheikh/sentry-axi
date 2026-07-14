/**
 * Structured errors.
 *
 * Every failure path in sentry-axi surfaces as a `SentryAxiError` carrying a
 * stable machine-readable code and at least one recovery suggestion. Agents
 * branch on the code and follow the suggestion; they never have to parse a
 * stack trace or an HTML error page out of a raw HTTP response.
 */

import { AxiError } from "axi-sdk-js";

export type ErrorCode =
  /** No auth token could be resolved from env, auth file, or .sentryclirc. */
  | "AUTH_REQUIRED"
  /** A token was found but Sentry rejected it (401) or it lacks a scope (403). */
  | "AUTH_INVALID"
  /** The command needs an org/project and none is configured or inferable. */
  | "NO_PROJECT"
  /** Sentry returned 404 for the requested org, project, issue, or release. */
  | "NOT_FOUND"
  /** A `@uid` ref that was never minted in this session. */
  | "REF_NOT_FOUND"
  /** A `@uid` ref older than the retained generation window. */
  | "STALE_REF"
  /** Sentry returned 429; the suggestion carries the Retry-After delay. */
  | "RATE_LIMITED"
  /** Sentry returned 4xx/5xx that is none of the above. */
  | "API_ERROR"
  /** DNS/TLS/socket failure reaching Sentry. */
  | "NETWORK_ERROR"
  /** A request exceeded SENTRY_AXI_TIMEOUT_MS. */
  | "TIMEOUT"
  /** Seer is not enabled for the org, or the issue is not eligible. */
  | "SEER_UNAVAILABLE"
  /** The official `sentry-cli` binary is needed for this command and is absent. */
  | "TOOLCHAIN_MISSING"
  /** Bad arguments - caught before any network call. */
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class SentryAxiError extends AxiError {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly suggestions: string[] = [],
  ) {
    super(message, code, suggestions);
    this.name = "SentryAxiError";
  }
}

/** Shorthand for the overwhelmingly common "bad args" case. */
export function validationError(
  message: string,
  ...suggestions: string[]
): SentryAxiError {
  return new SentryAxiError(message, "VALIDATION_ERROR", suggestions);
}
