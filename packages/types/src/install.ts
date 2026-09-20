// TokenLighten machine-install record — DESIGN-v0.14-mcp-only-install.md
// §4.1/§4.2/§4.6 (C1 "single source of truth"). This is the persisted shape
// of `<installHome>/install.json`; every entry point (archive `tl install`,
// the VS Code extension's `--from-extension`, a source checkout's `--dev`)
// reads it first and derives every host/workspace entry it writes from it.

import type { ToolSurface } from "./mcp.js";

/** How this machine install was staged. */
export type InstallSource = "archive" | "vsix" | "source";

/** Where the recorded `identity.command` actually comes from. */
export type InstallRuntimeSource = "bundled-node" | "electron:vscode" | "system-node";

export type InstallWritePosture = "allow-write" | "read-only";

/** Guide-block density; mirrors `@tokenlighten/agents-md`'s `GuideProfile`
 * without a cross-package dependency (this package stays foundational). */
export type InstallGuideProfile = "full" | "medium" | "compact";

export interface InstallRuntime {
  /** Absolute path to the runtime executable (bundled node, or the borrowed
   * Electron binary for `installed_by: "vsix"`). */
  command: string;
  /** Extra env the runtime itself needs (e.g. `ELECTRON_RUN_AS_NODE: "1"`). */
  env?: Record<string, string>;
  source: InstallRuntimeSource;
}

/** The version-independent host/allowlist identity — R3: `command` +
 * `argsPrefix` never change across an upgrade, only `app/<version>` moves. */
export interface InstallIdentity {
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string>;
}

export type InstallHostMechanism =
  | "vendor-cli"
  | "config-file"
  | "workspace-file"
  | "snippet";

export interface InstallHostEntry {
  client: string;
  mechanism: InstallHostMechanism;
  state: string;
  file?: string;
}

export interface InstallWorkspaceEntry {
  root: string;
  files: readonly string[];
  guide_block: boolean;
}

/** One staged version's launch entry, recorded so `--use <version>` can
 * re-point `bin/tl.js` at the EXACT entry that version was staged with
 * instead of re-deriving it from the CURRENT record's `installed_by` (the
 * pre-fix bug: a source/`--dev` record made `--use` treat every version's
 * `app/<version>` as a bare directory import, including archive/vsix
 * versions that need `<dir>/tl-cli.js`). `entry` is `<dir>/tl-cli.js` for
 * `installed_by: "archive" | "vsix"`, and the checkout's
 * `packages/cli/dist/index.js` for `installed_by: "source"` (`--dev`). */
export interface InstallAppEntry {
  version: string;
  dir: string;
  entry: string;
}

export interface InstallRecord {
  schemaVersion: 1;
  version: string;
  installed_by: InstallSource;
  runtime: InstallRuntime;
  identity: InstallIdentity;
  write_posture: InstallWritePosture;
  tool_surface?: ToolSurface;
  guide_profile?: InstallGuideProfile;
  hosts: readonly InstallHostEntry[];
  workspaces: readonly InstallWorkspaceEntry[];
  /** Every version this install home has ever staged, keyed by `version`.
   * Optional for backward compatibility with `install.json` written before
   * this field existed — `--use` falls back to directory heuristics for a
   * version absent from this array. */
  apps?: readonly InstallAppEntry[];
  installed_at: string;
  source_dir: string;
}
