/**
 * OS-aware path resolution for TokenLighten config / cache / state dirs.
 *
 * Canonical paths per docs/components/06-platform-support.md §1:
 *   macOS  : ~/Library/Application Support/tokenlighten/
 *   Linux  : $XDG_CONFIG_HOME/tokenlighten/ (~/.config/tokenlighten/)
 *   Windows: %APPDATA%\tokenlighten\Config\
 *
 * No env-paths dependency in v0.1 — implemented directly per spec.
 * Resolution priority (§1.4):
 *   1. per-bucket env  TOKENLIGHTEN_<BUCKET>_HOME
 *   2. umbrella env    TOKENLIGHTEN_HOME
 *   3. platform default
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { homedir } from "os";
import { join } from "path";
import { chmodSync, lstatSync, mkdirSync } from "fs";

export type Bucket = "config" | "cache" | "data" | "state" | "log" | "runtime";

const APP_NAME = "tokenlighten";

function ensurePrivateRuntimeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`TokenLighten runtime path is not a real directory: ${dir}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`TokenLighten runtime directory is not owned by the current user: ${dir}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

function platformDefault(bucket: Bucket): string {
  const home = homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support", APP_NAME);
    switch (bucket) {
      case "config":
        return appSupport;
      case "cache":
        return join(home, "Library", "Caches", APP_NAME);
      case "data":
        return appSupport;
      case "state":
        return join(appSupport, "state");
      case "log":
        return join(home, "Library", "Logs", APP_NAME);
      case "runtime": {
        const tmpdir = process.env["TMPDIR"] ?? "/tmp";
        return join(tmpdir, APP_NAME);
      }
    }
  }

  if (platform === "win32") {
    const appdata = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const localappdata =
      process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    switch (bucket) {
      case "config":
        return join(appdata, "tokenlighten", "Config");
      case "cache":
        return join(localappdata, "tokenlighten", "Cache");
      case "data":
        return join(localappdata, "tokenlighten", "Data");
      case "state":
        return join(localappdata, "tokenlighten", "State");
      case "log":
        return join(localappdata, "tokenlighten", "Logs");
      case "runtime":
        return join(localappdata, "tokenlighten", "Runtime");
    }
  }

  // Linux (XDG)
  const xdgConfig =
    process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const xdgCache =
    process.env["XDG_CACHE_HOME"] ?? join(home, ".cache");
  const xdgData =
    process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
  const xdgState =
    process.env["XDG_STATE_HOME"] ?? join(home, ".local", "state");

  switch (bucket) {
    case "config":
      return join(xdgConfig, APP_NAME);
    case "cache":
      return join(xdgCache, APP_NAME);
    case "data":
      return join(xdgData, APP_NAME);
    case "state":
      return join(xdgState, APP_NAME);
    case "log":
      return join(xdgState, APP_NAME, "log");
    case "runtime": {
      const xdgRuntime = process.env["XDG_RUNTIME_DIR"];
      if (xdgRuntime) {
        return join(xdgRuntime, APP_NAME);
      }
      // XDG spec fallback: /tmp/tokenlighten-$UID
      // We use the effective UID via process.getuid if available
      const uid =
        typeof process.getuid === "function"
          ? String(process.getuid())
          : "0";
      return join("/tmp", `${APP_NAME}-${uid}`);
    }
  }
}

/**
 * Resolve the absolute path for a given bucket, honoring env overrides.
 *
 * @param bucket          - logical bucket name
 * @param leaf            - optional filename to append
 * @param options.ensureDir - if true, mkdirSync the base directory (mode 0700 on POSIX).
 *                           Default: false. Callers that need the dir must opt in explicitly.
 */
export function resolvePath(
  bucket: Bucket,
  leaf?: string,
  options?: { ensureDir?: boolean }
): string {
  const bucketKey = bucket.toUpperCase();

  // 1. per-bucket env override
  const perBucketEnv =
    process.env[`TOKENLIGHTEN_${bucketKey}_HOME`];
  // 2. umbrella env
  const umbrellaEnv = process.env["TOKENLIGHTEN_HOME"];

  let base: string;
  if (perBucketEnv) {
    base = perBucketEnv;
  } else if (umbrellaEnv) {
    base = join(umbrellaEnv, bucket);
  } else {
    base = platformDefault(bucket);
  }

  if (options?.ensureDir) {
    // Surface errors — callers that request ensureDir should know if mkdir fails.
    if (bucket === "runtime") ensurePrivateRuntimeDir(base);
    else mkdirSync(base, { recursive: true, mode: 0o700 });
  }

  return leaf ? join(base, leaf) : base;
}

/** Canonical path to config.toml */
export function configFilePath(): string {
  return resolvePath("config", "config.toml");
}
