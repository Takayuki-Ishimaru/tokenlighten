// TokenLighten machine-install layout — DESIGN-v0.14-mcp-only-install.md §4.1.
//
// `<installHome>` is TokenLighten's existing platform *data* bucket
// (`resolvePath("data")`, already honoring TOKENLIGHTEN_HOME /
// TOKENLIGHTEN_DATA_HOME) unless the caller passes an explicit `--home`
// override. This module owns the layout helpers and the atomic
// read/write of `install.json` (the single source of truth — design §4.6 C1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InstallAppEntry, InstallRecord, InstallWorkspaceEntry } from "@tokenlighten/types";
import { makeTmpPath, retryRename } from "./atomicWrite.js";
import { resolvePath } from "./paths.js";

export interface InstallHomeOptions {
  home?: string;
}

/** Resolve the machine-install home directory: `--home` override, else the
 * platform `data` bucket (which itself honors TOKENLIGHTEN_HOME /
 * TOKENLIGHTEN_DATA_HOME). Never ensures the directory exists — callers that
 * are about to write call `mkdirSync` themselves alongside their own atomic
 * write. */
export function resolveInstallHome(options: InstallHomeOptions = {}): string {
  return options.home ? resolve(options.home) : resolvePath("data");
}

/**
 * DESIGN-v0.14-mcp-only-install.md §4.6 C9 (portability): true only when the
 * effective install home is the platform *default* data bucket — no `--home`
 * override AND neither `TOKENLIGHTEN_HOME` nor `TOKENLIGHTEN_DATA_HOME` is
 * set. Workspace files may then reference the install home with a
 * host-supported variable form (`${userHome}`, `${env:LOCALAPPDATA}`, ...)
 * because every teammate's default resolves to the same logical location;
 * a custom home is inherently machine-specific and stays absolute.
 */
export function isDefaultInstallHome(options: InstallHomeOptions = {}): boolean {
  if (options.home) return false;
  if (process.env["TOKENLIGHTEN_HOME"]) return false;
  if (process.env["TOKENLIGHTEN_DATA_HOME"]) return false;
  // paths.ts's platformDefault() only consults XDG_DATA_HOME on the "Linux
  // (XDG)" branch (i.e. neither darwin nor win32) — mirror that exactly so
  // a Linux user with a custom XDG data dir isn't misreported as "default"
  // (the predicate would otherwise say true while the resolved data bucket
  // is actually elsewhere).
  if (
    process.platform !== "darwin"
    && process.platform !== "win32"
    && process.env["XDG_DATA_HOME"]
  ) {
    return false;
  }
  return true;
}

export function installBinDir(home: string): string {
  return join(home, "bin");
}

export function installAppRoot(home: string): string {
  return join(home, "app");
}

export function installAppDir(home: string, version: string): string {
  return join(installAppRoot(home), version);
}

export function installRecordPath(home: string): string {
  return join(home, "install.json");
}

export function installNodePath(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(installBinDir(home), platform === "win32" ? "node.exe" : "node");
}

/** The 3-line indirection shim every install regenerates — `require`/`import`
 * target for the current `app/<version>`. This is what host identities and
 * the human shim both point `argsPrefix`/`cliPath` at. */
export function installCliJsPath(home: string): string {
  return join(installBinDir(home), "tl.js");
}

export function readInstallRecord(home: string): InstallRecord | undefined {
  const target = installRecordPath(home);
  if (!existsSync(target)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<InstallRecord>;
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) return undefined;
    if (typeof parsed.version !== "string" || !parsed.identity || typeof parsed.identity !== "object") {
      return undefined;
    }
    return parsed as InstallRecord;
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(home: string, record: InstallRecord): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = installRecordPath(home);
  const tmp = makeTmpPath(target);
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  retryRename(tmp, target);
}

/** Upsert one workspace's entry (matched by `root`) into a record's
 * `workspaces[]`, preserving every other entry. Pure — callers persist the
 * returned record themselves via `writeInstallRecord`. */
export function upsertInstallWorkspace(
  record: InstallRecord,
  entry: InstallWorkspaceEntry,
): InstallRecord {
  const rest = record.workspaces.filter((existing) => existing.root !== entry.root);
  return {
    ...record,
    workspaces: [...rest, entry].sort((left, right) => left.root.localeCompare(right.root)),
  };
}

/** Upsert one staged version's launch entry (matched by `version`) into a
 * record's `apps[]`, preserving every other entry. Pure — callers persist
 * the returned record themselves via `writeInstallRecord`. */
export function upsertInstallApp(
  record: InstallRecord,
  entry: InstallAppEntry,
): InstallRecord {
  const rest = (record.apps ?? []).filter((existing) => existing.version !== entry.version);
  return {
    ...record,
    apps: [...rest, entry].sort((left, right) => left.version.localeCompare(right.version)),
  };
}
