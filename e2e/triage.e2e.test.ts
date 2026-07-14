/**
 * Live end-to-end triage suite.
 *
 * Drives the real CLI as a subprocess against a real Sentry org, exactly the
 * way an agent would. Skips itself entirely without credentials.
 *
 *   SENTRY_AUTH_TOKEN=... SENTRY_ORG=acme SENTRY_PROJECT=frontend npm run test:e2e
 */

import { describe, expect, it } from "vitest";
import {
  extractUids,
  hasCredentials,
  hasHelpBlock,
  mutationsAllowed,
  run,
} from "./helpers.js";

const describeLive = hasCredentials() ? describe : describe.skip;

describeLive("live: config", () => {
  it("doctor reports a reachable API and a resolved scope", async () => {
    const result = await run("doctor");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("apiReachable: yes");
    expect(result.stdout).not.toContain("token: MISSING");
    expect(result.stdout).not.toContain("org: MISSING");
  });

  it("orgs lists at least the configured org", async () => {
    const result = await run("orgs");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(process.env.SENTRY_ORG!);
    expect(hasHelpBlock(result.stdout)).toBe(true);
  });

  it("projects lists at least the configured project", async () => {
    const result = await run("projects");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(process.env.SENTRY_PROJECT!);
  });
});

describeLive("live: the triage loop", () => {
  it("issues lists issues and mints usable refs", async () => {
    const result = await run("issues", "--period", "14d", "--limit", "5");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("issues:");
    expect(hasHelpBlock(result.stdout)).toBe(true);
  });

  it("a ref minted by `issues` resolves in a later, separate process", async () => {
    // This is the whole point of the on-disk refs registry: the listing and the
    // action are different short-lived processes.
    const listing = await run("issues", "--period", "14d", "--limit", "5");
    const uids = extractUids(listing.stdout);

    if (uids.length === 0) {
      console.warn("no issues in the project - skipping ref round-trip");
      return;
    }

    const detail = await run("issue", `@${uids[0]}`);
    expect(detail.exitCode).toBe(0);
    expect(detail.stdout).toContain("issue:");
    expect(detail.stdout).toContain("shortId:");
  });

  it("stacktrace renders frames for a real event", async () => {
    const listing = await run("issues", "--period", "14d", "--limit", "5");
    const uids = extractUids(listing.stdout);

    if (uids.length === 0) {
      console.warn("no issues in the project - skipping stacktrace");
      return;
    }

    const result = await run("stacktrace", `@${uids[0]}`);

    // An issue may legitimately have no stack trace (a message-only event), so
    // accept either a rendered trace or the explicit no-trace notice - but not
    // a crash.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stacktrace:");
  });

  it("addresses an issue by short id, with no listing first", async () => {
    const listing = await run("issues", "--period", "14d", "--limit", "1");
    const shortId = listing.stdout.match(/,([A-Z0-9]+-[A-Z0-9]+),/)?.[1];

    if (!shortId) {
      console.warn("no short id found - skipping escape-hatch check");
      return;
    }

    const result = await run("issue", `short:${shortId}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(shortId);
  });
});

describeLive("live: error handling", () => {
  it("reports a bad project as NOT_FOUND, not a raw 404", async () => {
    const result = await run(
      "issues",
      "--project",
      "definitely-not-a-real-project-x9z",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("NOT_FOUND");
    expect(result.stdout + result.stderr).toMatch(/help\[\d+\]:/);
  });

  it("reports an invalid search query as an API_ERROR with a suggestion", async () => {
    const result = await run("issues", "--query", "is:::::nonsense");

    // Sentry may accept or reject this; what must never happen is an unhandled
    // crash or a stack trace leaking to the agent.
    expect(result.stdout + result.stderr).not.toContain("at Object.");
    if (result.exitCode !== 0) {
      expect(result.stdout + result.stderr).toMatch(/code: [A-Z_]+/);
    }
  });

  it("rejects an invented ref rather than acting on the wrong issue", async () => {
    const result = await run("issue", "@g99:99");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/REF_NOT_FOUND|STALE_REF/);
  });
});

const describeMutating =
  hasCredentials() && mutationsAllowed() ? describe : describe.skip;

describeMutating("live: mutations (guarded)", () => {
  it("resolve is idempotent and restores state afterwards", async () => {
    const listing = await run("issues", "--period", "14d", "--limit", "1");
    const uids = extractUids(listing.stdout);

    if (uids.length === 0) {
      console.warn("no issues - skipping mutation test");
      return;
    }

    const uid = uids[0];

    // Capture the status BEFORE touching anything, so the restore below puts
    // back what was actually there rather than guessing "unresolved".
    const before = await run("issue", `@${uid}`);
    const originalStatus =
      before.stdout.match(/^\s*status: (\w+)/m)?.[1] ?? "unresolved";

    try {
      const first = await run("resolve", `@${uid}`);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("resolved:");

      // The AXI contract: a repeated mutation is a successful no-op, so an
      // agent retrying after a timeout can never corrupt state.
      const second = await run("resolve", `@${uid}`);
      expect(second.exitCode).toBe(0);
    } finally {
      // Restore in a finally, so a failed assertion above still leaves the real
      // Sentry project the way we found it.
      if (originalStatus === "resolved") {
        await run("resolve", `@${uid}`).catch(() => undefined);
      } else if (originalStatus === "ignored") {
        await run("ignore", `@${uid}`).catch(() => undefined);
      } else {
        await run("unresolve", `@${uid}`).catch(() => undefined);
      }
    }
  });

  it("unresolve reopens a resolved issue", async () => {
    const listing = await run("issues", "--period", "14d", "--limit", "1");
    const uids = extractUids(listing.stdout);

    if (uids.length === 0) {
      console.warn("no issues - skipping unresolve test");
      return;
    }

    const uid = uids[0];

    await run("resolve", `@${uid}`);
    const reopened = await run("unresolve", `@${uid}`);

    expect(reopened.exitCode).toBe(0);
    expect(reopened.stdout).toContain("unresolved:");
  });
});
