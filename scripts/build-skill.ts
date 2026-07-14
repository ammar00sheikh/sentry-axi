#!/usr/bin/env tsx
/**
 * Generate skills/sentry-axi/SKILL.md from src/skill.ts. `--check` verifies the
 * committed file is current (CI guard) without writing.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "skills", "sentry-axi", "SKILL.md");

const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  const actual = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : "";
  if (actual !== expected) {
    process.stderr.write(
      "skills/sentry-axi/SKILL.md is stale - run `npm run build:skill`\n",
    );
    process.exit(1);
  }
  process.stdout.write("SKILL.md is up to date\n");
  process.exit(0);
}

mkdirSync(dirname(skillPath), { recursive: true });
writeFileSync(skillPath, expected);
process.stdout.write(`Wrote ${skillPath}\n`);
