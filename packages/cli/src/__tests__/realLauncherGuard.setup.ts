// realLauncherGuard.setup.ts — vitest setupFiles module.
//
// S3 (v0.14.3 pre-release fix wave, 2026-09-17): some packages/cli spec ran
// resolveStableLauncher()/writeManagedLauncher() in-process with DEFAULT
// options (no isolated installHome/homeDir/TOKENLIGHTEN_HOME), so it wrote
// TokenLighten's REAL per-user managed launcher shim on the machine running
// the suite — e.g. on macOS, `~/Library/Application Support/tokenlighten/
// bin/tl` got overwritten with a vitest worker's own tinypool path recorded
// as the CLI. On a machine with a real TokenLighten install this breaks the
// user's `tl` command every time the suite runs.
//
// B5 (same wave, 2026-09-18): `tl install`'s workspace loop now also calls
// recordWorkspaceSetup() (workspace.ts), which defaults to configFilePath()
// — the developer's REAL config.toml, holding (among other things) the
// workspace registry `tl workspace status`/`list` read — whenever a spec
// forgets to inject an isolated registryPath. Watching that file here too
// catches the same class of leak for the registry, not just the launcher.
//
// This module is the regression guard for that class of bug: it snapshots
// the real launcher paths AND the real config.toml before a spec file's
// tests run, and fails the file loudly if any of them changed afterward. It
// computes the paths with the exact same paths.ts-backed helpers the
// product uses (managedLauncherPath()/legacyLauncherPath()/configFilePath()
// with DEFAULT options — no override — since that is exactly what a leaking
// call site would resolve to), and it only ever READS them: no write, no
// delete, no restore. If this guard trips, fix the offending spec (an
// isolated installHome/homeDir/registryPath, or TOKENLIGHTEN_HOME + HOME
// env isolation for a call site with no dependency-injection seam) — never
// this file.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { legacyLauncherPath, managedLauncherPath } from "../launcher.js";
import { configFilePath } from "../paths.js";

// Content hash ALONE is not enough: writeManagedLauncher() derives the shim
// body from process.argv[1], which resolves to the same tinypool worker
// entry point on every run in a given environment, so a rewrite can be
// byte-identical to what was already there. mtimeMs (renameSync always
// bumps it, even for identical bytes) is what actually catches a rewrite —
// hashing the content on top only strengthens the signal when mtime is
// somehow preserved (e.g. a future implementation using utimes).
function fingerprint(path: string): string {
  try {
    const stat = statSync(path);
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `mtime:${stat.mtimeMs}:sha256:${hash}`;
  } catch {
    return "absent";
  }
}

// This module runs for EVERY spec file of every package (it is wired into
// the repo-root vitest config), so resolving a watched path must never be
// able to fail a spec by itself: a host where a default path cannot be
// resolved (no HOME, exotic CI sandbox) simply has nothing to watch.
function watched(label: string, resolvePath: () => string): { label: string; path: string }[] {
  try {
    return [{ label, path: resolvePath() }];
  } catch {
    return [];
  }
}

const WATCHED = [
  ...watched("managed launcher (managedLauncherPath)", () => managedLauncherPath()),
  ...watched("legacy launcher (legacyLauncherPath)", () => legacyLauncherPath()),
  ...watched("workspace registry config (configFilePath)", () => configFilePath()),
  // The one vendor-owned file TokenLighten writes DIRECTLY (config-file host
  // writer; every other host goes through its vendor CLI, which specs mock).
  // Found rewritten on the developer's real machines on 2026-09-18 by a spec
  // that isolated TOKENLIGHTEN_HOME but not the OS home. Resolved here, at
  // module load, before any spec-level HOME/USERPROFILE override.
  ...watched("Copilot CLI MCP config (~/.copilot/mcp-config.json)", () => join(homedir(), ".copilot", "mcp-config.json")),
];

let baseline: string[] = [];

beforeAll(() => {
  baseline = WATCHED.map((entry) => fingerprint(entry.path));
});

afterAll(() => {
  WATCHED.forEach((entry, index) => {
    const after = fingerprint(entry.path);
    const before = baseline[index] ?? "absent";
    if (after !== before) {
      throw new Error(
        "Test isolation leak (S3/B5, v0.14.3 pre-release fix wave): this spec "
          + `file changed the developer's REAL ${entry.label} at ${entry.path} `
          + `(was ${before}, now ${after}). Some code under test reached `
          + "resolveStableLauncher()/writeManagedLauncher() or recordWorkspaceSetup() "
          + "— directly, or via registerClients/activateClients/setClientProfile/"
          + "runWorkspace/runClients/performInstall's workspace loop — without an "
          + "isolated installHome/homeDir/registryPath or TOKENLIGHTEN_HOME override. "
          + "Fix the test's isolation, never this guard.",
      );
    }
  });
});
