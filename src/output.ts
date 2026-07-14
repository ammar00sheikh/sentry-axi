/**
 * Output composition.
 *
 * An AXI response is a sequence of blocks: TOON-encoded metadata, optional
 * free-text blocks (stack traces, Seer prose - things a table would mangle),
 * and a trailing `help[N]:` block of next steps.
 *
 * TOON's tabular array encoding is what actually buys the token savings:
 *
 *     issues[2]{uid,shortId,level,events,users,age,title}:
 *       g1:1,FRONTEND-4F,error,1.2k,89,3h,"TypeError: undefined is not an object"
 *       g1:2,FRONTEND-2A,warning,310,12,1d,"Network request failed"
 *
 * The field names are stated once in the header instead of being repeated on
 * every row the way JSON does. For a 25-issue listing that is the difference
 * between ~400 tokens and ~4,000.
 *
 * `help` is rendered by hand rather than through the encoder: TOON would inline
 * a string array onto one comma-separated line, and suggestions need to be one
 * per line to stay copy-pasteable.
 */

import { encode } from "@toon-format/toon";

export type Block = string | undefined | null;

/** TOON-encode a structured block. */
export function toon(value: Record<string, unknown>): string {
  return encode(value);
}

/** The trailing next-steps block. Empty suggestions render nothing. */
export function helpBlock(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  const lines = suggestions.map((line) => `  ${line}`).join("\n");
  return `help[${suggestions.length}]:\n${lines}`;
}

/** A labelled free-text block, e.g. `stacktrace:` followed by the frames. */
export function textBlock(label: string, body: string): string {
  return `${label}:\n${body}`;
}

/** Join blocks, dropping empties, with exactly one newline between them. */
export function compose(...blocks: Block[]): string {
  return blocks
    .filter((block): block is string => Boolean(block && block.trim()))
    .join("\n");
}

/** Note that output was capped, and how to see the rest. */
export function truncationNote(truncated: number): string {
  if (truncated <= 0) return "";
  return toon({
    truncated: `${truncated} more lines - re-run with --full to see them`,
  });
}
