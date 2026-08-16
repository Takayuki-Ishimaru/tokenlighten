// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// cli.ts — spawn wrapper for the 'tl' binary.
//
// Design rules:
//   - shell:false; args as array (no PATH injection).
//   - Prefer the packaged or bundled CLI; fall back to 'tl' on PATH.
//   - 30s timeout (skeleton build can be slow on large repos).
//   - ENOENT → return code:null, stderr:'tl not found' (no UI prompt here).

import crossSpawn from "cross-spawn";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const SPAWN_TIMEOUT_MS = 30_000;

export interface CliInvocation {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
}

/**
 * The packaged .vsix's own zero-install CLI: dist/tl-cli.js, built by
 * packages/vscode-extension/scripts/bundle-cli.mjs and placed next to this
 * extension's own dist/extension.js — checked first (see resolution order
 * below) so a packaged install never needs node_modules or a `tl` on PATH.
 * Resolved __dirname-relative (matching bundledCliScript()'s style below)
 * so it naturally targets wherever THIS compiled file actually runs from:
 * dist/ once bundled into extension.js (dev F5 or a packaged install
 * alike), src/ under vitest — where dist/tl-cli.js never exists, so this
 * correctly falls through to bundledCliScript() and preserves today's dev
 * behavior when the packaged bundle hasn't been built.
 */
function packagedCliScript(): string | undefined {
  const candidate = join(__dirname, "tl-cli.js");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Dev-only fallback: resolve @tokenlighten/cli's real dist/index.js via the
 * workspace's own node_modules (present under F5 / npm workspace
 * hoisting). Not reachable from a packaged .vsix — `vsce package
 * --no-dependencies` ships no node_modules (see bundle-cli.mjs's header
 * comment for why), which is exactly the packaged-build-only defect
 * packagedCliScript() above exists to fix.
 */
function bundledCliScript(): string | undefined {
  try {
    const require = createRequire(join(__dirname, "extension.js"));
    const packageJson = require.resolve("@tokenlighten/cli/package.json");
    return join(dirname(packageJson), "dist", "index.js");
  } catch {
    return undefined;
  }
}

export function getCliInvocation(): CliInvocation {
  // Resolution order: (1) packaged dist/tl-cli.js — the zero-install path a
  // real .vsix ships; (2) node_modules dist/index.js — dev/F5, unchanged;
  // (3) `tl` on PATH — last resort, same graceful message as before.
  const packaged = packagedCliScript();
  if (packaged) {
    return {
      command: process.execPath,
      argsPrefix: [packaged],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const bundled = bundledCliScript();
  if (bundled) {
    return {
      command: process.execPath,
      argsPrefix: [bundled],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: "tl", argsPrefix: [], env: {} };
}

export function getCliPath(): string {
  return getCliInvocation().command;
}

export function getMcpLaunchConfig(args: readonly string[]): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const invocation = getCliInvocation();
  return {
    command: invocation.command,
    args: [...invocation.argsPrefix, ...args],
    env: invocation.env,
  };
}

/** Return the version reported by the resolved TL CLI, or undefined if unavailable. */
export function getTlVersion(): string | undefined {
  try {
    const invocation = getCliInvocation();
    const syncOptions = {
      timeout: 2000,
      env: { ...process.env, ...invocation.env },
    };
    const result = crossSpawn.sync(
      invocation.command,
      [...invocation.argsPrefix, "--version"],
      syncOptions,
    );
    const available = result.status === 0
      || result.error === undefined && result.status !== null;
    if (!available) return undefined;

    const streams = result as typeof result & { stdout?: unknown; stderr?: unknown };
    const output = `${String(streams.stdout ?? "")}\n${String(streams.stderr ?? "")}`.trim();
    const semver = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    return semver?.[1] ?? (output.split(/\r?\n/, 1)[0]?.trim() || "unknown");
  } catch {
    return undefined;
  }
}

/** Synchronously check if the TL CLI is available. */
export function findTlBinary(): boolean {
  return getTlVersion() !== undefined;
}

export async function spawnTl(
  args: string[],
  options?: { cwd?: string },
): Promise<SpawnResult> {
  const invocation = getCliInvocation();
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // cross-spawn safely resolves npm's Windows .cmd shims while preserving
    // array-based arguments and shell:false.
    const spawnOptions = {
      shell: false as const,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...invocation.env },
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    };
    const proc = crossSpawn(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      spawnOptions,
    );

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve({ stdout, stderr, code: null });
    }, SPAWN_TIMEOUT_MS);

    proc.on("close", (code) => {
      if (!timedOut) { clearTimeout(timer); resolve({ stdout, stderr, code }); }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.code === "ENOENT" ? "tl not found" : err.message, code: null });
    });
  });
}
