import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeCodexConfigUpdate as computeAxiCodexConfigUpdate,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  shouldInstallHooksForNodeAxiExecPath,
} from "axi-sdk-js";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface HookSettings {
  hooks?: {
    SessionStart?: HookGroup[];
    [event: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
}

export interface HookTarget {
  path: string;
}

const HOOK_MARKER = "sentry-axi";

/**
 * Only install hooks from packaged or installed entrypoints. A development
 * entrypoint (`npm run dev`) must never self-register, or a contributor's
 * working copy quietly becomes every agent session's Sentry hook.
 */
export function shouldInstallHooksForExecPath(execPath: string): boolean {
  return shouldInstallHooksForNodeAxiExecPath(execPath, {
    marker: HOOK_MARKER,
    binaryNames: [HOOK_MARKER],
    distEntrypoints: ["dist/bin/sentry-axi.js"],
  });
}

/** Hook installation targets for supported agents. */
export function getHookTargets(): HookTarget[] {
  const home = homedir();
  return [
    { path: join(home, ".claude", "settings.json") },
    { path: join(home, ".codex", "hooks.json") },
    { path: join(home, ".codex", "config.toml") },
  ];
}

/**
 * Pure: compute the hook update for agent settings. Works for both Claude Code
 * (settings.json) and Codex CLI (hooks.json). Returns [updatedSettings, changed].
 */
export function computeHookUpdate(
  settings: HookSettings,
  execPath: string,
): [HookSettings, boolean] {
  return computeSessionStartHookUpdate(settings, {
    marker: HOOK_MARKER,
    command: execPath,
    timeoutSeconds: 10,
  }) as [HookSettings, boolean];
}

/** Pure: ensure Codex hooks are enabled in config.toml. */
export function computeCodexConfigUpdate(content: string): [string, boolean] {
  return computeAxiCodexConfigUpdate(content);
}

/** Idempotently install session hooks into all supported agents. */
export function installHooks(): void {
  try {
    installHooksOrThrow();
  } catch {
    // Best-effort - never fail the CLI over hook installation.
  }
}

export function installHooksOrThrow(): void {
  const errors: string[] = [];

  installSessionStartHooks({
    marker: HOOK_MARKER,
    timeoutSeconds: 10,
    shouldInstall: shouldInstallHooksForExecPath,
    onError: (message) => {
      errors.push(message);
    },
  });

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
