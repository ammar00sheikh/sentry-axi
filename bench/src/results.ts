import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Clear previous results for the given conditions, keeping results from other conditions. */
export function clearResults(resultsDir: string, conditionIds: string[]): void {
  mkdirSync(resultsDir, { recursive: true });

  const resultsPath = join(resultsDir, "results.jsonl");
  if (!existsSync(resultsPath)) {
    writeFileSync(resultsPath, "");
    return;
  }

  try {
    const kept = readFileSync(resultsPath, "utf-8")
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        const r = JSON.parse(l);
        return !conditionIds.includes(r.condition);
      })
      .join("\n");
    writeFileSync(resultsPath, kept ? kept + "\n" : "");
  } catch {
    writeFileSync(resultsPath, "");
  }
}
