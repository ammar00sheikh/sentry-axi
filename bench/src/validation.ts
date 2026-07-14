import type { ConditionDef } from "./types.js";

/** Split a compound shell command into individual segments. */
function splitShellSegments(command: string): string[] {
  // Split on newlines, &&, ||, and ; — then strip leading env assignments
  return command
    .split(/\n|&&|\|\||;/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ""));
}

function matchesCommandPrefix(command: string, prefix: string): boolean {
  const candidates = prefix.includes(" ") ? [prefix] : [prefix, `npx ${prefix}`];
  return splitShellSegments(command).some((seg) =>
    candidates.some((c) => seg === c || seg.startsWith(`${c} `)),
  );
}

export function validateCommandPolicy(
  condition: Pick<ConditionDef, "id" | "command_policy">,
  commandLog: string[],
  rawOutput?: string,
): string | null {
  const policy = condition.command_policy;
  if (!policy) return null;

  const requiredPrefixes = policy.require_any_prefix ?? [];
  if (requiredPrefixes.length > 0) {
    const matched = commandLog.some((command) =>
      requiredPrefixes.some((prefix) => matchesCommandPrefix(command, prefix)),
    );
    if (!matched) {
      // Fallback: scan raw output for required prefix (handles sub-agent usage
      // where the Agent tool delegates the work to a sub-agent)
      const rawMatched = rawOutput
        ? requiredPrefixes.some((prefix) => {
            const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // Check Bash command fields or Agent tool prompts referencing the tool
            return new RegExp(`"command"\\s*:\\s*"[^"]*${escaped}[\\s"]`).test(rawOutput)
              || new RegExp(`"prompt"\\s*:\\s*"[^"]*${escaped}[\\s"]`).test(rawOutput);
          })
        : false;
      if (!rawMatched) {
        return `Invalid run for ${condition.id}: no Bash command used a required command prefix (${requiredPrefixes.join(", ")}).`;
      }
    }
  }

  const forbiddenPrefixes = policy.forbid_any_prefix ?? [];
  if (forbiddenPrefixes.length > 0) {
    const offending = commandLog.find((command) =>
      forbiddenPrefixes.some((prefix) => matchesCommandPrefix(command, prefix)),
    );
    if (offending) {
      return `Invalid run for ${condition.id}: forbidden command detected: ${offending}`;
    }
  }

  // Substring rules catch the interpreter-shaped escape hatches a prefix rule
  // misses (a python/node one-liner that hits the Sentry REST API directly).
  const forbiddenSubstrings = policy.forbid_substrings ?? [];
  if (forbiddenSubstrings.length > 0) {
    const offending = commandLog.find((command) =>
      forbiddenSubstrings.some((substring) => command.includes(substring)),
    );
    if (offending) {
      return `Invalid run for ${condition.id}: forbidden command detected: ${offending}`;
    }
  }

  return null;
}
