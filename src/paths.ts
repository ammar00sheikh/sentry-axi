import { isAbsolute, resolve } from "node:path";

/**
 * Resolve caller-supplied output paths (trace dumps, event payload files,
 * sourcemap directories) against the invoking CLI's current directory.
 * Absolute paths pass through unchanged. This is the single chokepoint for
 * every path that arrives from an agent, so output can always report back the
 * absolute location it actually wrote.
 */
export function resolveOutputPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}
