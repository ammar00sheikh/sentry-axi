/**
 * Shared helpers for the live e2e suite.
 *
 * These tests hit a **real Sentry org**. They are gated on `SENTRY_AUTH_TOKEN`
 * and skip themselves entirely when it is absent, so `npm test` and CI never
 * need credentials.
 *
 * They are also **read-only by default**. A mutating test (resolve/assign)
 * changes real state in a real project, so it only runs when
 * `SENTRY_E2E_ALLOW_MUTATIONS=1` is set explicitly, and it restores what it
 * touched. Do not remove that guard: someone will eventually run this against
 * a production project.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = join(here, "..", "dist", "bin", "sentry-axi.js");

export function hasCredentials(): boolean {
  return Boolean(
    process.env.SENTRY_AUTH_TOKEN?.trim() &&
    process.env.SENTRY_ORG?.trim() &&
    process.env.SENTRY_PROJECT?.trim(),
  );
}

export function mutationsAllowed(): boolean {
  return process.env.SENTRY_E2E_ALLOW_MUTATIONS === "1";
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the built CLI exactly as an agent would - as a subprocess. */
export async function run(...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, ...args],
      {
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      exitCode: err.code ?? 1,
    };
  }
}

/**
 * Pull the uids out of a listing's TOON table. Rows look like:
 *   g1:1,FRONTEND-4F,error,1.2k,89,3h,"...","..."
 */
export function extractUids(stdout: string): string[] {
  const uids: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^"?(g\d+:\d+)"?,/);
    if (match) uids.push(match[1]);
  }
  return uids;
}

/** Every AXI response ends with a help block - assert the contract holds live. */
export function hasHelpBlock(stdout: string): boolean {
  return /^help\[\d+\]:$/m.test(stdout);
}
