/**
 * Contextual next-step suggestions.
 *
 * Every response ends with a `help[N]:` block. These are not generic docs -
 * they are the *specific* next commands for the state the agent is now in,
 * with refs already substituted in, so the agent copies back the exact printed
 * form instead of composing one and getting the generation prefix wrong.
 *
 * The ordering encodes the triage loop sentry-axi is built around:
 *   issues -> stacktrace (why) -> seer / suspect (who) -> resolve (done)
 */

export interface SuggestedIssue {
  uid: string;
  shortId?: string;
  title?: string;
  unhandled?: boolean;
}

export interface SuggestionContext {
  command: string;
  /** Issues minted by this command, most important first. */
  issues?: SuggestedIssue[];
  /** Active session name when not "default" - carried into suggestions. */
  session?: string;
  /** Set when the issue in question already has a Seer run available. */
  seerAvailable?: boolean;
  /** Set when the command produced no results at all. */
  empty?: boolean;
  /**
   * Set when the project has **never** received an event (Sentry's
   * `firstEvent` is null) - which is a completely different problem from "no
   * issues matched your query", and needs completely different advice.
   */
  projectNeverReceivedEvents?: boolean;
  /** The scope the empty listing was run against, so advice can name it. */
  project?: string;
  /** The window and query that came back empty, so we never re-suggest them. */
  period?: string;
  query?: string;
}

export function getSuggestions(ctx: SuggestionContext): string[] {
  // Carry the session selector forward so multi-project suggestions stay scoped.
  const scoped =
    ctx.session && ctx.session !== "default" ? ` --session ${ctx.session}` : "";
  const cli = `sentry-axi${scoped}`;

  const issues = ctx.issues ?? [];
  const top = issues[0];
  const lines: string[] = [];

  // An empty result is a dead end unless we say how to widen the search - this
  // is the single most common place an agent gets stuck and gives up.
  if (ctx.empty) {
    if (ctx.command === "issues" || ctx.command === "search") {
      // "No issues matched" and "this project has never received an event" look
      // identical in the response but need opposite advice. Widening the window
      // on a project with no SDK wired up will never find anything, and an agent
      // told to widen will keep widening. Sentry knows which case this is
      // (`firstEvent`), so say it.
      if (ctx.projectNeverReceivedEvents) {
        const name = ctx.project ? ` "${ctx.project}"` : "";
        return [
          `The project${name} has never received an event - this is not an empty result, it is an unconfigured project`,
          "Widening the window will not help. Check that the Sentry SDK is installed and the DSN is set in the app",
          `Run \`${cli} projects\` to switch to a project that has events (the hasEvents column)`,
          `Run \`${cli} sendevent --message "wiring test"\` to confirm the DSN works once you have set it`,
        ];
      }

      // Never re-suggest the exact window or query that just came back empty -
      // that is how an agent ends up running the same command twice and
      // concluding the tool is broken.
      const out: string[] = [];
      if (ctx.period !== "14d") {
        out.push(`Run \`${cli} issues --period 14d\` to widen the time window`);
      }
      if (ctx.query && ctx.query !== "is:unresolved" && ctx.query !== "") {
        out.push(
          `Run \`${cli} issues --query "is:unresolved"\` to drop the extra filters in "${ctx.query}"`,
        );
      }
      out.push(
        `Run \`${cli} issues --query "" --period 14d\` to include resolved and ignored issues too`,
        `Run \`${cli} projects\` to confirm you are pointed at the right project`,
      );
      return out;
    }
    return [`Run \`${cli} issues\` to see what is currently broken`];
  }

  switch (ctx.command) {
    case "issues":
    case "search": {
      if (top) {
        const label = top.shortId ? `${top.shortId} ` : "";
        lines.push(
          `Run \`${cli} stacktrace @${top.uid}\` to see where ${label}throws`,
        );
        lines.push(
          `Run \`${cli} issue @${top.uid}\` for full detail (tags, counts, first/last seen)`,
        );
        lines.push(
          `Run \`${cli} seer @${top.uid}\` for AI root-cause analysis`,
        );
      }
      lines.push(
        `Narrow with Sentry search syntax: \`${cli} issues --query "is:unresolved is:unassigned level:error"\``,
      );
      break;
    }

    case "issue": {
      if (top) {
        lines.push(
          `Run \`${cli} stacktrace @${top.uid}\` to see the failing frames`,
        );
        lines.push(
          `Run \`${cli} breadcrumbs @${top.uid}\` to see what happened before the crash`,
        );
        lines.push(
          `Run \`${cli} suspect @${top.uid}\` to see which commits touched those frames`,
        );
      }
      break;
    }

    case "stacktrace": {
      if (top) {
        lines.push(
          `Run \`${cli} seer @${top.uid}\` to have Sentry's AI diagnose the root cause`,
        );
        lines.push(
          `Run \`${cli} suspect @${top.uid}\` to find the commit that introduced it`,
        );
        lines.push(
          `Run \`${cli} breadcrumbs @${top.uid}\` for the events leading up to the throw`,
        );
        lines.push(
          `Add \`--context\` to include source lines around the crashing frame`,
        );
      }
      break;
    }

    case "seer": {
      if (top) {
        lines.push(
          `Run \`${cli} stacktrace @${top.uid} --context\` to read the failing code yourself`,
        );
        lines.push(
          `Once you have shipped a fix, run \`${cli} resolve @${top.uid}\``,
        );
      }
      break;
    }

    case "suspect": {
      if (top) {
        lines.push(
          `Run \`${cli} resolve @${top.uid} --in-next-release\` if the fix is already merged`,
        );
        lines.push(
          `Run \`${cli} assign @${top.uid} <email>\` to assign it to the commit author`,
        );
      }
      break;
    }

    case "resolve":
    case "ignore":
    case "assign": {
      lines.push(`Run \`${cli} issues\` to see what is still open`);
      break;
    }

    case "breadcrumbs":
    case "tags":
    case "events": {
      if (top) {
        lines.push(
          `Run \`${cli} stacktrace @${top.uid}\` to see the failing frames`,
        );
        lines.push(`Run \`${cli} resolve @${top.uid}\` once it is fixed`);
      }
      break;
    }

    case "perf": {
      lines.push(
        `Run \`${cli} perf --period 7d\` to compare against a longer window`,
      );
      lines.push(
        `Run \`${cli} issues --query "is:unresolved"\` to see the errors behind a slow endpoint`,
      );
      break;
    }

    case "releases": {
      lines.push(
        `Run \`${cli} release <version>\` for its commits, deploys, and new issues`,
      );
      lines.push(
        `Run \`${cli} issues --query "first-release:<version>"\` to see what a release introduced`,
      );
      break;
    }

    case "projects":
    case "orgs": {
      lines.push(
        `Run \`${cli} use <org>/<project>\` to pin a scope for later commands`,
      );
      break;
    }

    default:
      lines.push(`Run \`${cli} issues\` to see what is currently broken`);
  }

  // Teach the escape hatch - it works even with no refs in play, which matters
  // when the agent is pasting a short id straight out of a Sentry alert email.
  if (issues.length > 0) {
    lines.push(
      `Issues can also be addressed directly, without a ref: \`${cli} stacktrace short:<SHORT-ID>\` or \`id:<numeric id>\``,
    );
  }

  // Backstop. Most branches above only emit lines when an issue was passed in,
  // so a caller that renders a detail view without one would otherwise produce a
  // response with an empty help block - the exact dead end this module exists to
  // prevent. Never return nothing.
  if (lines.length === 0) {
    lines.push(`Run \`${cli} issues\` to see what is currently broken`);
  }

  return lines;
}
