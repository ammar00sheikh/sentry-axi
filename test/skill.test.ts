import { describe, expect, it } from "vitest";
import {
  createSkillMarkdown,
  extractCommandsBlock,
  SKILL_AUTHOR,
  SKILL_DESCRIPTION,
} from "../src/skill.js";

describe("extractCommandsBlock", () => {
  const block = extractCommandsBlock();

  it("actually finds a commands block in TOP_HELP", () => {
    // The block is *extracted* from the CLI's own help rather than duplicated,
    // which is what stops SKILL.md and `--help` from drifting apart. A regex
    // that silently stopped matching would ship an empty Commands section.
    expect(block.length).toBeGreaterThan(0);
    expect(block.startsWith("commands[")).toBe(true);
    expect(block.split("\n").length).toBeGreaterThan(1);
  });

  it("carries the real command names an agent has to type", () => {
    for (const command of ["issues", "stacktrace", "seer", "resolve", "perf"]) {
      expect(block).toContain(command);
    }
  });

  it("does not swallow the flags block that follows it", () => {
    // The regex stops at the first non-indented line. If it over-matched, the
    // skill's Commands fence would contain the flags and environment sections.
    expect(block).not.toContain("flags[");
    expect(block).not.toContain("SENTRY_AUTH_TOKEN");
  });

  it("is trimmed of trailing blank lines", () => {
    expect(block).toBe(block.trimEnd());
  });
});

describe("createSkillMarkdown", () => {
  const markdown = createSkillMarkdown();
  const frontmatter = markdown.split("---\n")[1];

  it("opens with a fenced YAML frontmatter block", () => {
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown.indexOf("\n---\n", 4)).toBeGreaterThan(0);
  });

  it("declares name, description, and author", () => {
    expect(frontmatter).toContain("name: sentry-axi");
    expect(frontmatter).toContain(`author: ${SKILL_AUTHOR}`);
    expect(frontmatter).toMatch(/^description: ".+"$/m);
  });

  it("quotes the description so its colons cannot break the YAML", () => {
    // The trigger string contains `:` and `-`. Emitting it bare would make the
    // frontmatter unparseable and the skill would never load at all - a failure
    // that is completely invisible until an agent needs it.
    const line = frontmatter
      .split("\n")
      .find((l) => l.startsWith("description:"))!;
    expect(line).toBe(`description: ${JSON.stringify(SKILL_DESCRIPTION)}`);
    expect(JSON.parse(line.slice("description: ".length))).toBe(
      SKILL_DESCRIPTION,
    );
  });

  it("carries the hermes metadata the skill registry indexes on", () => {
    expect(frontmatter).toContain(
      "tags: [sentry, debugging, observability, errors]",
    );
    expect(frontmatter).toContain("category: debugging");
    expect(frontmatter).toContain("user-invocable: false");
  });

  it("embeds the commands block extracted from TOP_HELP", () => {
    expect(markdown).toContain(extractCommandsBlock());
    // ...inside a fence, so the agent does not read it as prose.
    expect(markdown).toContain("```\ncommands[");
  });

  it("documents the SDK built-ins that runAxiCli appends at runtime", () => {
    // These never appear in TOP_HELP, so an agent reading only the skill would
    // otherwise not know `update` exists.
    expect(markdown).toContain("built-in:");
    expect(markdown).toContain("update:");
  });

  it("rewrites invocations to `npx -y sentry-axi`", () => {
    // The skill is loaded by agents that have never installed sentry-axi. A
    // bare `sentry-axi issues` would be a command-not-found on step one, and
    // `-y` is what keeps npx from stopping to ask for confirmation.
    expect(markdown).toContain("npx -y sentry-axi <command>");
    expect(markdown).toContain("npx -y sentry-axi doctor");
    expect(markdown).toContain("npx -y sentry-axi issues");
    // And it tells the agent to rewrite the follow-ups the CLI prints, which
    // are emitted as bare `sentry-axi ...` by suggestions.ts.
    expect(markdown).toContain("run it as `npx -y sentry-axi ...` instead");
  });

  it("teaches the ref contract and the triage loop", () => {
    for (const fragment of [
      "stacktrace @<uid>",
      "seer @<uid>",
      "suspect @<uid>",
      "resolve @<uid>",
      "short:FRONTEND-4F",
      "STALE_REF",
      "TOOLCHAIN_MISSING",
    ]) {
      expect(markdown).toContain(fragment);
    }
  });

  it("is deterministic, so `build-skill --check` in CI cannot flap", () => {
    expect(createSkillMarkdown()).toBe(markdown);
  });
});
