/**
 * Argument parsing.
 *
 * Deliberately tiny and dependency-free. AXI commands are `<bin> <command>
 * <positionals> --flags`, and the SDK has already peeled off the command, so
 * all that is left is splitting flags from positionals.
 *
 * Boolean flags must be declared up front. Without that, `--full @g1:2` would
 * swallow the ref as `--full`'s value, and the agent would get a baffling
 * "missing issue" error instead of the snapshot it asked for.
 */

import { validationError } from "./errors.js";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(
  args: string[],
  booleanFlags: readonly string[] = [],
): ParsedArgs {
  const booleans = new Set(booleanFlags);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    // `--` ends flag parsing; the rest is a verbatim argv (used by `monitor run`).
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const name = arg.slice(2);
    if (booleans.has(name)) {
      flags[name] = true;
      continue;
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw validationError(
        `Flag --${name} needs a value`,
        `Run \`sentry-axi <command> --help\` to see the accepted flags`,
      );
    }

    flags[name] = value;
    i++;
  }

  return { positional, flags };
}

/** Read a flag as a string, or undefined when absent. */
export function flagString(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

/** Read a flag as a positive integer, validating before any network call. */
export function flagInt(
  parsed: ParsedArgs,
  name: string,
  fallback: number,
): number {
  const raw = flagString(parsed, name);
  if (raw === undefined) return fallback;

  const parsedInt = Number.parseInt(raw, 10);
  if (Number.isNaN(parsedInt) || parsedInt <= 0) {
    throw validationError(
      `Flag --${name} must be a positive integer (got "${raw}")`,
      `Example: --${name} ${fallback}`,
      "Run `sentry-axi <command> --help` to see the accepted flags",
    );
  }

  return parsedInt;
}

/** The first positional, or a structured error naming what was expected. */
export function requirePositional(
  parsed: ParsedArgs,
  index: number,
  what: string,
  ...suggestions: string[]
): string {
  const value = parsed.positional[index];
  if (value === undefined || value.trim().length === 0) {
    throw validationError(`Missing required argument: ${what}`, ...suggestions);
  }
  return value;
}
