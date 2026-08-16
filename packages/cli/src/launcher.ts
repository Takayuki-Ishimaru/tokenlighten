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

export interface StableLauncher {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
  source: "managed-shim" | "npm-global" | "bare-workspace";
}

export interface StableLauncherOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  cliPath?: string;
  electronPath?: string;
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

export function managedLauncherPath(
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

function posixShim(cliPath: string | undefined, electronPath: string | undefined): string {
  const recorded = cliPath ? shellQuote(cliPath) : "''";
  const electron = electronPath ? shellQuote(electronPath) : "''";
  return `#!/bin/sh
set -eu
if [ -n "\${TOKENLIGHTEN_CLI_PATH:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    exec node "$TOKENLIGHTEN_CLI_PATH" "$@"
  fi
fi
TL_RECORDED=${recorded}
if [ -n "$TL_RECORDED" ] && [ -f "$TL_RECORDED" ] && command -v node >/dev/null 2>&1; then
  exec node "$TL_RECORDED" "$@"
fi
TL_GLOBAL="$(command -v tl 2>/dev/null || true)"
if [ -n "$TL_GLOBAL" ] && [ "$TL_GLOBAL" != "$0" ]; then
  exec "$TL_GLOBAL" "$@"
fi
TL_ELECTRON=${electron}
if [ -n "$TL_ELECTRON" ] && [ -x "$TL_ELECTRON" ] && [ -n "$TL_RECORDED" ] && [ -f "$TL_RECORDED" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$TL_ELECTRON" "$TL_RECORDED" "$@"
fi
echo "TokenLighten launcher cannot find a working CLI. Reinstall TokenLighten or set TOKENLIGHTEN_CLI_PATH." >&2
exit 127
`;
}

function windowsShim(cliPath: string | undefined, electronPath: string | undefined): string {
  const recorded = cmdValue(cliPath ?? "");
  const electron = cmdValue(electronPath ?? "");
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
if defined TOKENLIGHTEN_CLI_PATH (
  where node >nul 2>nul
  if not errorlevel 1 (
    node "%TOKENLIGHTEN_CLI_PATH%" %*
    exit /b !ERRORLEVEL!
  )
)
set "TL_RECORDED=${recorded}"
if defined TL_RECORDED if exist "%TL_RECORDED%" (
  where node >nul 2>nul
  if not errorlevel 1 (
    node "%TL_RECORDED%" %*
    exit /b !ERRORLEVEL!
  )
)
for /f "delims=" %%I in ('where tl 2^>nul') do (
  if /I not "%%~fI"=="%~f0" (
    call "%%~fI" %*
    exit /b !ERRORLEVEL!
  )
)
set "TL_ELECTRON=${electron}"
if defined TL_ELECTRON if exist "%TL_ELECTRON%" if defined TL_RECORDED if exist "%TL_RECORDED%" (
  set ELECTRON_RUN_AS_NODE=1
  "%TL_ELECTRON%" "%TL_RECORDED%" %*
  exit /b !ERRORLEVEL!
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
  const body = platform === "win32"
    ? windowsShim(cliPath, electronPath)
    : posixShim(cliPath, electronPath);
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

export function resolveStableLauncher(options: StableLauncherOptions = {}): StableLauncher {
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
