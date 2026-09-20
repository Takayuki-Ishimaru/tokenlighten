import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { readInstallRecord, resolveInstallHome } from "./installHome.js";

export interface StableLauncher {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
  source:
    | "managed-shim"
    | "npm-global"
    | "bare-workspace"
    | "bundled-runtime"
    | "electron-runtime";
}

export interface StableLauncherOptions {
  /** TokenLighten machine-install home (DESIGN-v0.14-mcp-only-install.md
   * §4.1). Defaults to `resolveInstallHome()`. This is now the basis for
   * `managedLauncherPath` — `homeDir` only feeds `legacyLauncherPath` (the
   * pre-v0.14.3 `~/.tokenlighten/bin` shim location, kept for a later
   * migration, not implemented this wave). */
  installHome?: string;
  /** Legacy OS-home basis for the pre-v0.14.3 `~/.tokenlighten/bin` shim. */
  homeDir?: string;
  platform?: NodeJS.Platform;
  cliPath?: string;
  electronPath?: string;
  /** Runtime executable tried FIRST by the generated human shim — the
   * bundled `bin/node`(.exe), or (with `runtimeIsElectron`) a borrowed
   * Electron binary. Never spawned directly by hosts; this only affects
   * the human-facing shim script's own fallback order. */
  runtimePath?: string;
  runtimeIsElectron?: boolean;
  pathEnv?: string;
  allowBareFallback?: boolean;
}

function usableRegularFile(path: string | undefined): path is string {
  if (!path || !existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function cmdValue(value: string): string {
  return value.replace(/%/g, "%%").replace(/"/g, '""').replace(/[\r\n]/g, "");
}

/** Current (v0.14.3+) location of the human-facing shim:
 * `<installHome>/bin/tl` (`tl.cmd` on Windows). Hosts never spawn this —
 * design §4.1: "the shim serves humans only". */
export function managedLauncherPath(
  options: Pick<StableLauncherOptions, "installHome" | "platform"> = {},
): string {
  const platform = options.platform ?? process.platform;
  const home = options.installHome ?? resolveInstallHome();
  return join(home, "bin", platform === "win32" ? "tl.cmd" : "tl");
}

/** Pre-v0.14.3 shim location (`~/.tokenlighten/bin/tl`), kept for the design
 * §4.6 C7 migration (parse the legacy shim, re-point managed entries, then
 * replace it with a forwarder). Not implemented this wave; never written by
 * this module going forward — exported only so a later migration pass has a
 * stable name for "where the old one used to live". */
export function legacyLauncherPath(
  options: Pick<StableLauncherOptions, "homeDir" | "platform"> = {},
): string {
  const platform = options.platform ?? process.platform;
  return join(
    options.homeDir ?? homedir(),
    ".tokenlighten",
    "bin",
    platform === "win32" ? "tl.cmd" : "tl",
  );
}

function runtimeInvocationPosix(runtimeVar: string, recordedVar: string, isElectron: boolean): string {
  return isElectron
    ? `ELECTRON_RUN_AS_NODE=1 exec "${runtimeVar}" "${recordedVar}" "$@"`
    : `exec "${runtimeVar}" "${recordedVar}" "$@"`;
}

// Unified fallback order (design §2 fact-check correction + §4.1): recorded
// runtime -> TOKENLIGHTEN_CLI_PATH+node -> recorded CLI+node -> recorded
// Electron -> global tl. Both shims share this order now; previously POSIX
// tried Electron before the global-tl fallback while Windows tried the
// reverse (launcher.ts:74-81 vs :106-117 pre-v0.14.3).
function posixShim(
  cliPath: string | undefined,
  electronPath: string | undefined,
  runtimePath: string | undefined,
  runtimeIsElectron: boolean,
): string {
  const recorded = cliPath ? shellQuote(cliPath) : "''";
  const electron = electronPath ? shellQuote(electronPath) : "''";
  const runtime = runtimePath ? shellQuote(runtimePath) : "''";
  return `#!/bin/sh
set -eu
TL_RECORDED=${recorded}
TL_RUNTIME=${runtime}
if [ -n "$TL_RUNTIME" ] && [ -x "$TL_RUNTIME" ] && [ -n "$TL_RECORDED" ] && [ -f "$TL_RECORDED" ]; then
  ${runtimeInvocationPosix("$TL_RUNTIME", "$TL_RECORDED", runtimeIsElectron)}
fi
if [ -n "\${TOKENLIGHTEN_CLI_PATH:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    exec node "$TOKENLIGHTEN_CLI_PATH" "$@"
  fi
fi
if [ -n "$TL_RECORDED" ] && [ -f "$TL_RECORDED" ] && command -v node >/dev/null 2>&1; then
  exec node "$TL_RECORDED" "$@"
fi
TL_ELECTRON=${electron}
if [ -n "$TL_ELECTRON" ] && [ -x "$TL_ELECTRON" ] && [ -n "$TL_RECORDED" ] && [ -f "$TL_RECORDED" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$TL_ELECTRON" "$TL_RECORDED" "$@"
fi
TL_GLOBAL="$(command -v tl 2>/dev/null || true)"
if [ -n "$TL_GLOBAL" ] && [ "$TL_GLOBAL" != "$0" ]; then
  exec "$TL_GLOBAL" "$@"
fi
echo "TokenLighten launcher cannot find a working CLI. Reinstall TokenLighten or set TOKENLIGHTEN_CLI_PATH." >&2
exit 127
`;
}

function windowsShim(
  cliPath: string | undefined,
  electronPath: string | undefined,
  runtimePath: string | undefined,
  runtimeIsElectron: boolean,
): string {
  const recorded = cmdValue(cliPath ?? "");
  const electron = cmdValue(electronPath ?? "");
  const runtime = cmdValue(runtimePath ?? "");
  const runtimeElectronLine = runtimeIsElectron ? "  set ELECTRON_RUN_AS_NODE=1\n" : "";
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "TL_RECORDED=${recorded}"
set "TL_RUNTIME=${runtime}"
if defined TL_RUNTIME if exist "%TL_RUNTIME%" if defined TL_RECORDED if exist "%TL_RECORDED%" (
${runtimeElectronLine}  "%TL_RUNTIME%" "%TL_RECORDED%" %*
  exit /b !ERRORLEVEL!
)
if defined TOKENLIGHTEN_CLI_PATH (
  where node >nul 2>nul
  if not errorlevel 1 (
    node "%TOKENLIGHTEN_CLI_PATH%" %*
    exit /b !ERRORLEVEL!
  )
)
if defined TL_RECORDED if exist "%TL_RECORDED%" (
  where node >nul 2>nul
  if not errorlevel 1 (
    node "%TL_RECORDED%" %*
    exit /b !ERRORLEVEL!
  )
)
set "TL_ELECTRON=${electron}"
if defined TL_ELECTRON if exist "%TL_ELECTRON%" if defined TL_RECORDED if exist "%TL_RECORDED%" (
  set ELECTRON_RUN_AS_NODE=1
  "%TL_ELECTRON%" "%TL_RECORDED%" %*
  exit /b !ERRORLEVEL!
)
for /f "delims=" %%I in ('where tl 2^>nul') do (
  if /I not "%%~fI"=="%~f0" (
    call "%%~fI" %*
    exit /b !ERRORLEVEL!
  )
)
echo TokenLighten launcher cannot find a working CLI. Reinstall TokenLighten or set TOKENLIGHTEN_CLI_PATH. 1>&2
exit /b 127
`;
}

export function writeManagedLauncher(options: StableLauncherOptions = {}): StableLauncher {
  const platform = options.platform ?? process.platform;
  const target = managedLauncherPath(options);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) {
    throw new Error(`Refusing to write a launcher through a symlink: ${parent}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked launcher: ${target}`);
  }

  const defaultCli = process.argv[1] && isAbsolute(process.argv[1])
    ? process.argv[1]
    : process.argv[1]
      ? resolve(process.argv[1])
      : undefined;
  const cliPath = usableRegularFile(options.cliPath)
    ? resolve(options.cliPath)
    : usableRegularFile(defaultCli)
      ? resolve(defaultCli)
      : undefined;
  const electronPath = usableRegularFile(options.electronPath)
    ? resolve(options.electronPath)
    : process.env["ELECTRON_RUN_AS_NODE"] === "1" && usableRegularFile(process.execPath)
      ? resolve(process.execPath)
      : undefined;
  const runtimePath = usableRegularFile(options.runtimePath)
    ? resolve(options.runtimePath)
    : undefined;
  const runtimeIsElectron = runtimePath !== undefined && options.runtimeIsElectron === true;
  const body = platform === "win32"
    ? windowsShim(cliPath, electronPath, runtimePath, runtimeIsElectron)
    : posixShim(cliPath, electronPath, runtimePath, runtimeIsElectron);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, body, {
      encoding: "utf8",
      mode: platform === "win32" ? 0o600 : 0o700,
      flag: "wx",
    });
    if (platform !== "win32") chmodSync(temporary, 0o700);
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) {
        unlinkSync(temporary);
      }
    } catch {
      // Preserve the original error; cleanup is best-effort for our unique temp.
    }
    throw error;
  }
  return { command: target, argsPrefix: [], env: {}, source: "managed-shim" };
}

export function findExecutableOnPath(
  name: string,
  options: Pick<StableLauncherOptions, "pathEnv" | "platform"> = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const extensions = platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (options.pathEnv ?? process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
      if (usableRegularFile(candidate)) return resolve(candidate);
      const originalCase = join(directory, `${name}${extension}`);
      if (usableRegularFile(originalCase)) return resolve(originalCase);
    }
  }
  return undefined;
}

/** True machine identity when `tl install` has run: `install.json`'s
 * `identity` is the single source of truth (design §4.6 C1) — `command` is
 * the runtime, `argsPrefix` is `[<installHome>/bin/tl.js]`, both unchanged
 * across an upgrade, so callers never re-derive host args from scratch.
 * Falls back to today's shim-writing behavior (no install record yet — a
 * source checkout that never ran `tl install --dev`) otherwise. */
export function peekStableLauncher(options: StableLauncherOptions = {}): StableLauncher | undefined {
  const installHome = options.installHome ?? resolveInstallHome();
  const record = readInstallRecord(installHome);
  if (!record) return undefined;
  return {
    command: record.identity.command,
    argsPrefix: [...record.identity.argsPrefix],
    env: { ...record.identity.env },
    source: record.runtime.source === "electron:vscode" ? "electron-runtime" : "bundled-runtime",
  };
}

/** True machine identity when `tl install` has run: `install.json`'s
 * `identity` is the single source of truth (design §4.6 C1) — `command` is
 * the runtime, `argsPrefix` is `[<installHome>/bin/tl.js]`, both unchanged
 * across an upgrade, so callers never re-derive host args from scratch.
 * Falls back to today's shim-writing behavior (no install record yet — a
 * source checkout that never ran `tl install --dev`) otherwise. */
export function resolveStableLauncher(options: StableLauncherOptions = {}): StableLauncher {
  const peeked = peekStableLauncher(options);
  if (peeked) return peeked;
  try {
    return writeManagedLauncher(options);
  } catch (error) {
    const globalTl = findExecutableOnPath(
      process.platform === "win32" ? "tl" : "tl",
      options,
    );
    const managed = managedLauncherPath(options);
    if (globalTl && resolve(globalTl) !== resolve(managed)) {
      return { command: globalTl, argsPrefix: [], env: {}, source: "npm-global" };
    }
    if (options.allowBareFallback) {
      return { command: "tl", argsPrefix: [], env: {}, source: "bare-workspace" };
    }
    throw new Error(
      `Unable to create the stable TokenLighten launcher: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
