/**
 * Delegation to the official `sentry-cli` binary.
 *
 * ## Why this layer exists
 *
 * Most of sentry-axi talks straight to the Sentry HTTP API. But a handful of
 * operations - sourcemap and debug-file uploads, envelope sends, cron monitor
 * check-ins - go through Sentry's **chunked upload protocol**: the client
 * blake3-hashes the artifact, negotiates chunk size with
 * `/organizations/{org}/chunk-upload/`, uploads only the chunks the server does
 * not already have, and polls an assemble endpoint. Reimplementing that in
 * TypeScript would be a large pile of subtly-wrong code whose failure mode is
 * silently-broken sourcemaps in production.
 *
 * The official `sentry-cli` already implements it correctly. So sentry-axi
 * does what flutter-axi does with `adb` / `xcrun simctl`: it treats the binary
 * as a **toolchain dependency**, builds the exact argv, and shells out.
 *
 * ## The shape (copied deliberately from flutter-axi's `device.ts`)
 *
 * Everything below the `--- Executors ---` line is a thin wrapper around an
 * injectable `exec`. Everything above it is a **pure command builder** that
 * returns exact argv and touches nothing - so the full matrix of flags is
 * unit-testable with no `sentry-cli` installed anywhere, on any platform.
 *
 * A missing binary surfaces as a structured `TOOLCHAIN_MISSING` error telling
 * the agent how to install it - never a raw ENOENT.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SentryAxiError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Injectable so the executors are testable without the real binary. */
export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    env: options.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

// --- Command builders (pure) ---

export interface SourcemapsUploadOptions {
  release: string;
  paths: string[];
  urlPrefix?: string;
  dist?: string;
  /** Rewrite + inject debug ids before upload (Sentry's recommended default). */
  inject?: boolean;
  /** Fail the command when no sourcemap is found, instead of quietly passing. */
  strict?: boolean;
}

export function buildSourcemapsUploadArgs(
  options: SourcemapsUploadOptions,
): string[] {
  const args = ["sourcemaps", "upload", "--release", options.release];

  if (options.dist) args.push("--dist", options.dist);
  if (options.urlPrefix) args.push("--url-prefix", options.urlPrefix);
  // `--strict` makes "uploaded 0 files" an error. Silently uploading nothing is
  // the single most common way sourcemaps end up broken in production, so an
  // agent-facing tool should default to loud.
  if (options.strict !== false) args.push("--strict");

  args.push(...options.paths);
  return args;
}

export function buildSourcemapsInjectArgs(paths: string[]): string[] {
  return ["sourcemaps", "inject", ...paths];
}

export interface SourcemapsExplainOptions {
  eventId: string;
}

export function buildSourcemapsExplainArgs(
  options: SourcemapsExplainOptions,
): string[] {
  return ["sourcemaps", "explain", options.eventId];
}

export interface DebugFilesUploadOptions {
  paths: string[];
  /** Include the sources so Sentry can render code context in frames. */
  includeSources?: boolean;
  wait?: boolean;
}

export function buildDebugFilesUploadArgs(
  options: DebugFilesUploadOptions,
): string[] {
  const args = ["debug-files", "upload"];
  if (options.includeSources) args.push("--include-sources");
  if (options.wait) args.push("--wait");
  args.push(...options.paths);
  return args;
}

export function buildDebugFilesCheckArgs(path: string): string[] {
  return ["debug-files", "check", path];
}

export interface SendEventOptions {
  message?: string;
  level?: string;
  /** Path to a JSON event payload file. */
  file?: string;
  tags?: Record<string, string>;
}

export function buildSendEventArgs(options: SendEventOptions): string[] {
  const args = ["send-event"];

  if (options.file) {
    args.push("--file", options.file);
  }
  if (options.message) {
    args.push("--message", options.message);
  }
  if (options.level) {
    args.push("--level", options.level);
  }
  for (const [key, value] of Object.entries(options.tags ?? {})) {
    args.push("--tag", `${key}:${value}`);
  }

  return args;
}

export interface MonitorRunOptions {
  slug: string;
  /** The command to run under the monitor, argv-style. */
  command: string[];
  environment?: string;
}

export function buildMonitorRunArgs(options: MonitorRunOptions): string[] {
  const args = ["monitors", "run", options.slug];
  if (options.environment) args.push("--environment", options.environment);
  args.push("--", ...options.command);
  return args;
}

/**
 * The environment `sentry-cli` needs. sentry-axi has already resolved auth and
 * scope through its own precedence chain (env > stored token > .sentryclirc),
 * so we pass the *resolved* values down explicitly rather than letting the
 * child re-discover them and potentially pick a different org than the one the
 * agent's other commands are using.
 */
export function buildEnv(
  config: ResolvedConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SENTRY_AUTH_TOKEN: config.token,
    SENTRY_URL: config.url,
    SENTRY_ORG: config.org,
    ...(config.project ? { SENTRY_PROJECT: config.project } : {}),
  };
}

// --- Executors ---

const INSTALL_SUGGESTIONS = [
  "Install it with `npm install -g @sentry/cli`",
  "Or run this command through npx: `npx @sentry/cli ...`",
  "Homebrew: `brew install getsentry/tools/sentry-cli`",
  "Set SENTRY_AXI_SENTRY_CLI to an explicit binary path if it is installed somewhere unusual",
];

/** The binary to invoke; overridable for unusual installs. */
export function resolveSentryCliBin(): string {
  return process.env.SENTRY_AXI_SENTRY_CLI?.trim() || "sentry-cli";
}

/**
 * Run `sentry-cli` with pre-built argv. Maps a missing binary onto
 * TOOLCHAIN_MISSING and a non-zero exit onto API_ERROR carrying the child's
 * own stderr, which is usually already actionable.
 */
export async function runSentryCli(
  args: string[],
  config: ResolvedConfig,
  exec: ExecFn = defaultExec,
): Promise<ExecResult> {
  const bin = resolveSentryCliBin();

  try {
    return await exec(bin, args, { env: buildEnv(config) });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };

    if (err.code === "ENOENT") {
      throw new SentryAxiError(
        `The official \`sentry-cli\` binary is required for this command but was not found on PATH`,
        "TOOLCHAIN_MISSING",
        INSTALL_SUGGESTIONS,
      );
    }

    const stderr = (err.stderr ?? "").trim();
    const stdout = (err.stdout ?? "").trim();
    const detail = stderr || stdout || err.message;

    throw new SentryAxiError(
      `sentry-cli ${args[0]} ${args[1] ?? ""} failed: ${detail}`.trim(),
      "API_ERROR",
      [
        `Reproduce it directly: \`${bin} ${args.join(" ")}\``,
        "Add `--log-level=debug` to that command for the full trace",
      ],
    );
  }
}

/** Best-effort version probe, used by the `doctor` command. */
export async function sentryCliVersion(
  exec: ExecFn = defaultExec,
): Promise<string | null> {
  try {
    const { stdout } = await exec(resolveSentryCliBin(), ["--version"], {
      env: process.env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
