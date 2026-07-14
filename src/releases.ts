/**
 * Releases, deploys, and suspect commits.
 *
 * The agent-valuable question here is not "list my releases" - it is **"what
 * shipped right before this started breaking, and which commit is to blame"**.
 * `firstRelease` on an issue plus the release's commit list answers that in one
 * command, which is why `release --for-issue` exists.
 */

import type { SentryApi } from "./api.js";
import { validationError } from "./errors.js";

export interface SentryRelease {
  version: string;
  shortVersion?: string;
  ref?: string | null;
  url?: string | null;
  dateCreated?: string;
  dateReleased?: string | null;
  commitCount?: number;
  deployCount?: number;
  authors?: Array<{ name?: string; email?: string }>;
  newGroups?: number;
  projects?: Array<{ slug?: string }>;
  lastDeploy?: {
    name?: string;
    environment?: string;
    dateFinished?: string;
  } | null;
}

export interface SentryDeploy {
  id?: string;
  name?: string | null;
  environment?: string;
  dateStarted?: string | null;
  dateFinished?: string;
  url?: string | null;
}

export interface SentryCommit {
  id: string;
  message?: string;
  dateCreated?: string;
  author?: { name?: string; email?: string } | null;
  repository?: { name?: string } | null;
}

export async function listReleases(
  api: SentryApi,
  limit = 20,
): Promise<SentryRelease[]> {
  // Org-wide on purpose: releases are an org-level concept and are routinely
  // shared across projects, so scoping this to the pinned project would hide
  // the very release an agent is looking for.
  return api.request<SentryRelease[]>(`/organizations/${api.org}/releases/`, {
    query: { per_page: Math.min(limit, 100) },
    paginate: true,
    limit,
  });
}

export async function getRelease(
  api: SentryApi,
  version: string,
): Promise<SentryRelease> {
  return api.request<SentryRelease>(
    `/organizations/${api.org}/releases/${encodeURIComponent(version)}/`,
  );
}

export async function getReleaseCommits(
  api: SentryApi,
  version: string,
  limit = 20,
): Promise<SentryCommit[]> {
  return api.request<SentryCommit[]>(
    `/organizations/${api.org}/releases/${encodeURIComponent(version)}/commits/`,
    { paginate: true, limit },
  );
}

export async function listDeploys(
  api: SentryApi,
  version: string,
  limit = 20,
): Promise<SentryDeploy[]> {
  return api.request<SentryDeploy[]>(
    `/organizations/${api.org}/releases/${encodeURIComponent(version)}/deploys/`,
    { paginate: true, limit },
  );
}

/**
 * Suspect commits for an issue: the commits Sentry has already correlated with
 * the stack frames. This is the single highest-signal thing Sentry knows that
 * an agent cannot derive from the code alone.
 */
export interface SuspectCommit {
  commit: SentryCommit;
  author?: { name?: string; email?: string } | null;
}

export async function getSuspectCommits(
  api: SentryApi,
  issueId: string,
): Promise<SuspectCommit[]> {
  const committers = await api.request<{
    committers?: Array<{
      author?: { name?: string; email?: string };
      commits?: SentryCommit[];
    }>;
  }>(`/issues/${encodeURIComponent(issueId)}/committers/`);

  const out: SuspectCommit[] = [];
  for (const committer of committers?.committers ?? []) {
    for (const commit of committer.commits ?? []) {
      out.push({ commit, author: committer.author ?? null });
    }
  }
  return out;
}

/** A release version must be non-empty and free of path separators. */
export function validateVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed.length === 0) {
    throw validationError(
      "Release version is required",
      "Run `sentry-axi releases` to list existing versions",
    );
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw validationError(
      `Invalid release version "${trimmed}": slashes are not allowed`,
      "Sentry release versions are opaque strings, commonly a git SHA or a semver tag",
    );
  }
  return trimmed;
}

export interface CreateReleaseOptions {
  version: string;
  projects: string[];
  ref?: string;
  url?: string;
}

/** Idempotent: re-creating an existing release updates it rather than failing. */
export async function createRelease(
  api: SentryApi,
  options: CreateReleaseOptions,
): Promise<SentryRelease> {
  return api.request<SentryRelease>(`/organizations/${api.org}/releases/`, {
    method: "POST",
    body: {
      version: validateVersion(options.version),
      projects: options.projects,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.url ? { url: options.url } : {}),
    },
  });
}

export async function finalizeRelease(
  api: SentryApi,
  version: string,
): Promise<SentryRelease> {
  return api.request<SentryRelease>(
    `/organizations/${api.org}/releases/${encodeURIComponent(validateVersion(version))}/`,
    { method: "PUT", body: { dateReleased: new Date().toISOString() } },
  );
}

export async function createDeploy(
  api: SentryApi,
  version: string,
  environment: string,
  name?: string,
): Promise<SentryDeploy> {
  return api.request<SentryDeploy>(
    `/organizations/${api.org}/releases/${encodeURIComponent(validateVersion(version))}/deploys/`,
    {
      method: "POST",
      body: {
        environment,
        ...(name ? { name } : {}),
        dateFinished: new Date().toISOString(),
      },
    },
  );
}
