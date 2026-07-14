/**
 * The sentry-cli delegation layer: exact argv assertions through the pure
 * builders, so the whole flag matrix is covered with no `sentry-cli` installed
 * anywhere - the same shape flutter-axi's device.test.ts uses for adb/simctl.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDebugFilesCheckArgs,
  buildDebugFilesUploadArgs,
  buildEnv,
  buildMonitorRunArgs,
  buildSendEventArgs,
  buildSourcemapsExplainArgs,
  buildSourcemapsInjectArgs,
  buildSourcemapsUploadArgs,
  resolveSentryCliBin,
  runSentryCli,
  sentryCliVersion,
  type ExecFn,
} from "../src/sentrycli.js";
import { SentryAxiError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";

const CONFIG: ResolvedConfig = {
  token: "sntrys_token",
  url: "https://sentry.io",
  org: "acme",
  project: "frontend",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildSourcemapsUploadArgs", () => {
  it("defaults to --strict", () => {
    // Uploading zero sourcemaps *succeeds* by default in sentry-cli, and that
    // silent no-op is the single most common way production traces end up
    // unminified. An agent-facing tool has to be loud about it.
    expect(
      buildSourcemapsUploadArgs({ release: "4.2.0", paths: ["./dist"] }),
    ).toEqual([
      "sourcemaps",
      "upload",
      "--release",
      "4.2.0",
      "--strict",
      "./dist",
    ]);
  });

  it("omits --strict only when explicitly disabled", () => {
    expect(
      buildSourcemapsUploadArgs({
        release: "4.2.0",
        paths: ["./dist"],
        strict: false,
      }),
    ).toEqual(["sourcemaps", "upload", "--release", "4.2.0", "./dist"]);
  });

  it("emits dist, url-prefix, and multiple paths in order", () => {
    expect(
      buildSourcemapsUploadArgs({
        release: "4.2.0",
        dist: "ios-1234",
        urlPrefix: "~/static/js",
        paths: ["./dist", "./build"],
      }),
    ).toEqual([
      "sourcemaps",
      "upload",
      "--release",
      "4.2.0",
      "--dist",
      "ios-1234",
      "--url-prefix",
      "~/static/js",
      "--strict",
      "./dist",
      "./build",
    ]);
  });

  it("keeps paths last, after every flag", () => {
    // sentry-cli treats trailing operands as paths; a flag emitted after them
    // would be parsed as another path and the upload would quietly widen.
    const args = buildSourcemapsUploadArgs({
      release: "4.2.0",
      dist: "d",
      paths: ["./dist"],
    });
    expect(args[args.length - 1]).toBe("./dist");
  });
});

describe("buildSourcemapsInjectArgs / buildSourcemapsExplainArgs", () => {
  it("injects debug ids into every given path", () => {
    expect(buildSourcemapsInjectArgs(["./dist", "./build"])).toEqual([
      "sourcemaps",
      "inject",
      "./dist",
      "./build",
    ]);
  });

  it("explains a single event id", () => {
    expect(
      buildSourcemapsExplainArgs({
        eventId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      }),
    ).toEqual(["sourcemaps", "explain", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"]);
  });
});

describe("buildDebugFilesUploadArgs / buildDebugFilesCheckArgs", () => {
  it("uploads with no optional flags by default", () => {
    expect(buildDebugFilesUploadArgs({ paths: ["./symbols"] })).toEqual([
      "debug-files",
      "upload",
      "./symbols",
    ]);
  });

  it("adds --include-sources and --wait when asked", () => {
    expect(
      buildDebugFilesUploadArgs({
        paths: ["./symbols"],
        includeSources: true,
        wait: true,
      }),
    ).toEqual([
      "debug-files",
      "upload",
      "--include-sources",
      "--wait",
      "./symbols",
    ]);
  });

  it("checks one path", () => {
    expect(buildDebugFilesCheckArgs("./app.dSYM")).toEqual([
      "debug-files",
      "check",
      "./app.dSYM",
    ]);
  });
});

describe("buildSendEventArgs", () => {
  it("sends a message with a level", () => {
    expect(
      buildSendEventArgs({ message: "deploy smoke test", level: "info" }),
    ).toEqual([
      "send-event",
      "--message",
      "deploy smoke test",
      "--level",
      "info",
    ]);
  });

  it("sends a payload file and repeats --tag per pair", () => {
    expect(
      buildSendEventArgs({
        file: "./event.json",
        tags: { env: "staging", release: "4.2.0" },
      }),
    ).toEqual([
      "send-event",
      "--file",
      "./event.json",
      "--tag",
      "env:staging",
      "--tag",
      "release:4.2.0",
    ]);
  });

  it("emits just the subcommand when nothing is set", () => {
    expect(buildSendEventArgs({})).toEqual(["send-event"]);
  });
});

describe("buildMonitorRunArgs", () => {
  it("puts `--` before the wrapped command", () => {
    // Everything after `--` belongs to the child process. Without the
    // separator, the child's own flags (`--silent` here) would be parsed by
    // sentry-cli, which would either error or - worse - accept them.
    expect(
      buildMonitorRunArgs({
        slug: "nightly-build",
        command: ["npm", "run", "build", "--silent"],
      }),
    ).toEqual([
      "monitors",
      "run",
      "nightly-build",
      "--",
      "npm",
      "run",
      "build",
      "--silent",
    ]);
  });

  it("places --environment before the separator", () => {
    expect(
      buildMonitorRunArgs({
        slug: "nightly",
        environment: "production",
        command: ["./run.sh"],
      }),
    ).toEqual([
      "monitors",
      "run",
      "nightly",
      "--environment",
      "production",
      "--",
      "./run.sh",
    ]);
  });
});

describe("buildEnv", () => {
  it("passes the resolved token, url, org, and project down to the child", () => {
    // sentry-axi has already walked its own precedence chain (env > stored
    // token > .sentryclirc). If the child were left to re-discover scope, it
    // could pick a *different* org than the one the agent's other commands are
    // using, and upload sourcemaps into the wrong project.
    const env = buildEnv(CONFIG, { PATH: "/usr/bin" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      SENTRY_AUTH_TOKEN: "sntrys_token",
      SENTRY_URL: "https://sentry.io",
      SENTRY_ORG: "acme",
      SENTRY_PROJECT: "frontend",
    });
  });

  it("omits SENTRY_PROJECT for an org-wide scope", () => {
    // An empty SENTRY_PROJECT is not the same as an absent one - sentry-cli
    // would treat "" as a project slug and 404.
    const env = buildEnv({ ...CONFIG, project: null }, {});
    expect("SENTRY_PROJECT" in env).toBe(false);
  });

  it("overrides an inherited SENTRY_ORG rather than deferring to it", () => {
    const env = buildEnv(CONFIG, { SENTRY_ORG: "someone-else" });
    expect(env.SENTRY_ORG).toBe("acme");
  });
});

describe("resolveSentryCliBin", () => {
  it("defaults to sentry-cli on PATH, honoring the override", () => {
    expect(resolveSentryCliBin()).toBe("sentry-cli");
    vi.stubEnv("SENTRY_AXI_SENTRY_CLI", "  /opt/bin/sentry-cli  ");
    expect(resolveSentryCliBin()).toBe("/opt/bin/sentry-cli");
  });

  it("ignores a blank override", () => {
    vi.stubEnv("SENTRY_AXI_SENTRY_CLI", "   ");
    expect(resolveSentryCliBin()).toBe("sentry-cli");
  });
});

describe("runSentryCli", () => {
  it("passes the built argv and env to exec and returns its output", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: "ok", stderr: "" }));
    const args = buildSourcemapsInjectArgs(["./dist"]);

    const result = await runSentryCli(args, CONFIG, exec);

    expect(result.stdout).toBe("ok");
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, passedArgs, options] = exec.mock.calls[0];
    expect(bin).toBe("sentry-cli");
    expect(passedArgs).toEqual(["sourcemaps", "inject", "./dist"]);
    expect(options.env.SENTRY_AUTH_TOKEN).toBe("sntrys_token");
    expect(options.env.SENTRY_ORG).toBe("acme");
  });

  it("maps ENOENT onto TOOLCHAIN_MISSING with install instructions", async () => {
    // A raw ENOENT tells an agent nothing it can act on. The whole point of
    // treating sentry-cli as a toolchain dependency is that a missing binary
    // comes back as a code plus the command that fixes it.
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("spawn sentry-cli ENOENT"), {
        code: "ENOENT",
      });
    };

    const error = await runSentryCli(
      ["sourcemaps", "upload"],
      CONFIG,
      exec,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SentryAxiError);
    const err = error as SentryAxiError;
    expect(err.code).toBe("TOOLCHAIN_MISSING");
    expect(err.message).not.toContain("ENOENT");
    expect(err.suggestions.length).toBeGreaterThan(0);
    expect(err.suggestions.join("\n")).toContain("npm install -g @sentry/cli");
  });

  it("maps a non-zero exit onto API_ERROR carrying the child's stderr", async () => {
    // sentry-cli's own stderr is usually already actionable ("no sourcemaps
    // found"); swallowing it and printing "command failed" would destroy the
    // only useful signal in the failure.
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("Command failed"), {
        code: 1,
        stdout: "",
        stderr: "error: no sourcemaps found in ./dist\n",
      });
    };

    const error = (await runSentryCli(
      ["sourcemaps", "upload", "--release", "4.2.0", "./dist"],
      CONFIG,
      exec,
    ).catch((e: unknown) => e)) as SentryAxiError;

    expect(error).toBeInstanceOf(SentryAxiError);
    expect(error.code).toBe("API_ERROR");
    expect(error.message).toContain("no sourcemaps found in ./dist");
    // The agent must be able to reproduce the failure itself, verbatim.
    expect(error.suggestions[0]).toContain(
      "sentry-cli sourcemaps upload --release 4.2.0 ./dist",
    );
  });

  it("falls back to stdout, then the error message, when stderr is empty", async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("boom"), {
        code: 2,
        stderr: "",
        stdout: "",
      });
    };
    const error = (await runSentryCli(
      ["debug-files", "check"],
      CONFIG,
      exec,
    ).catch((e: unknown) => e)) as SentryAxiError;
    expect(error.message).toContain("boom");
  });
});

describe("sentryCliVersion", () => {
  it("returns the trimmed version string", async () => {
    const exec: ExecFn = async () => ({
      stdout: "sentry-cli 2.42.1\n",
      stderr: "",
    });
    expect(await sentryCliVersion(exec)).toBe("sentry-cli 2.42.1");
  });

  it("returns null instead of throwing when the binary is absent", async () => {
    // `doctor` probes for the binary; a missing sentry-cli is a reportable fact
    // there, not a failure - most sentry-axi commands never need it.
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(await sentryCliVersion(exec)).toBeNull();
  });
});
