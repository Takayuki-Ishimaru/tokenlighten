#!/usr/bin/env node
// scripts/build-install-bundle.mjs — Phase A of DESIGN-v0.14-mcp-only-install.md
// (§4.1 artifacts/landing zone, §4.5 release touchpoints, §4.6 C2 landing
// zone). Self-contained Node ESM (builtins only, no new dependencies).
//
// Builds, per requested platform, dist-install/tokenlighten-<ver>-<platform>/
// (the CLI bundle from bundle-cli.mjs's exported bundleCli(), a
// checksum-verified official Node.js runtime, the approved LICENSE,
// THIRD_PARTY_NOTICES.md, a short README-INSTALL.md, and the tl-setup /
// tl-setup.cmd entry points) plus a matching .tgz (and, for win-x64, a .zip
// when the system `zip` binary is available).
//
// The Node runtime is downloaded from nodejs.org, verified against its own
// published SHASUMS256.txt, and only `bin/node` (or `node.exe`) plus the
// distribution's LICENSE are extracted, via the system `tar` (bsdtar reads
// .zip and .tar.xz on macOS; tar.exe on modern Windows does too). Downloaded
// archives and their extracted runtime files are cached under
// --node-cache (default ~/.cache/tokenlighten-build/node), keyed by Node
// version + platform, so a re-run (or a test that pre-populates the cache)
// never re-downloads or re-extracts unnecessarily.
//
// Usage:
//   node scripts/build-install-bundle.mjs --platform <plat>[,...]|all \
//     --license <absolute-approved-license-file> \
//     [--node-version <x.y.z>] [--node-cache <dir>] [--no-download] \
//     [--out <dist-install dir>]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleCli } from "../packages/vscode-extension/scripts/bundle-cli.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const NODE_LTS_VERSION = "24.21.0";
export const DEFAULT_NODE_CACHE = join(homedir(), ".cache", "tokenlighten-build", "node");
export const DEFAULT_OUT_ROOT = join(ROOT, "dist-install");
export const PLATFORMS = ["win-x64", "darwin-arm64", "darwin-x64", "linux-x64"];

const NODE_ARCHIVE_EXT = {
  "win-x64": "zip",
  "darwin-arm64": "tar.gz",
  "darwin-x64": "tar.gz",
  "linux-x64": "tar.xz",
};

const TL_SETUP_SH = `#!/bin/sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/runtime/node" "$DIR/tl-cli.js" install --source "$DIR" "$@"
`;

const TL_SETUP_CMD = `@echo off
setlocal
"%~dp0runtime\\node.exe" "%~dp0tl-cli.js" install --source "%~dp0." %*
exit /b %ERRORLEVEL%
`;

/**
 * The platform data directory `tl install` stages this archive's machine
 * install under by default (mirrors packages/cli/src/paths.ts's
 * `platformDefault("data")` — kept as a literal display string here rather
 * than importing that module, since this script must stay runnable before
 * @tokenlighten/cli is built). Redirected by `--home <dir>` /
 * `TOKENLIGHTEN_HOME` at install time; README-INSTALL.md says so.
 */
function dataHomeDisplay(platform) {
  if (platform.startsWith("darwin")) return "~/Library/Application Support/tokenlighten";
  if (platform.startsWith("win")) return String.raw`%LOCALAPPDATA%\tokenlighten\Data`;
  return "~/.local/share/tokenlighten";
}

/**
 * The absolute, always-runnable `tl install <args>` invocation for a machine
 * install rooted at `home` — never a bare `tl`, since nothing in this
 * install flow puts `<home>/bin` on PATH (R2). Windows has no single
 * executable shim to invoke directly; it runs the CJS launcher under the
 * staged runtime explicitly.
 */
function absoluteTlInstallCommand(platform, home, args) {
  if (platform.startsWith("win")) {
    return `"${home}\\bin\\node.exe" "${home}\\bin\\tl.js" install ${args}`;
  }
  return `"${home}/bin/tl" install ${args}`;
}

function buildReadmeInstallMd(platform) {
  const home = dataHomeDisplay(platform);
  const rollbackCmd = absoluteTlInstallCommand(platform, home, "--use <version>");
  const uninstallCmd = absoluteTlInstallCommand(platform, home, "--uninstall");
  const windowsUninstallNote = platform.startsWith("win")
    ? " On Windows, a file still open in a running AI host cannot be removed immediately; the uninstaller retries in the background for about a minute after that host closes."
    : "";
  // Verified in a real Windows 11 session (2026-09-18): a double-click on the
  // Explorer-extracted, download-marked script raises the standard
  // "Open File - Security Warning" (unknown publisher), never a SmartScreen
  // block; a terminal launch raises nothing.
  const windowsRunNote = platform.startsWith("win")
    ? "\n     Run it from a terminal (Command Prompt or PowerShell) opened in this folder. Double-clicking\n     \`tl-setup.cmd\` works too, but Windows first shows its standard security warning for a downloaded\n     script from an unknown publisher; choose Run."
    : "";
  return `# TokenLighten install

1. Download the archive for your platform and extract it anywhere.
2. Run the setup script with the path to your workspace:
   - macOS/Linux: \`./tl-setup <workspace>\`
   - Windows: \`tl-setup <workspace>\`${windowsRunNote}
3. Upgrade: download the newer archive and run \`tl-setup\` again.
4. Roll back to a version already staged on this machine (typically the one
   you just upgraded from):
   \`${rollbackCmd}\`
5. Uninstall (removes the machine install and TokenLighten-managed host
   registrations and, from every workspace this install set up,
   TokenLighten's managed guide blocks and managed MCP entries; your own
   content and other servers' entries stay untouched):${windowsUninstallNote}
   \`${uninstallCmd}\`

\`${home}\` above is this platform's default install directory; it moves if
\`--home <dir>\` or \`TOKENLIGHTEN_HOME\` redirected it at install time.
`;
}

function fail(message) {
  throw new Error("build-install-bundle: " + message);
}

function regularFile(pathname, label) {
  if (!existsSync(pathname) || !lstatSync(pathname).isFile()) fail(label + " must be a regular file: " + pathname);
}

function isOutsideRoot(pathname) {
  const fromRoot = relative(ROOT, pathname);
  return fromRoot === ".." || fromRoot.startsWith(".." + sep);
}

/**
 * Mirrors prepare-public-release.mjs's `approvedLicensePath` fail-closed
 * rules: the supplied path must be absolute, must exist as a regular file,
 * must resolve (including through symlinks) to somewhere outside this
 * repository, and must not be byte-identical to the checked-in root
 * LICENSE. Throws (never returns) on any violation.
 */
export function validateLicenseArg(license) {
  if (!license) fail("--license is required");
  if (!isAbsolute(license)) fail("--license must be an absolute path");
  const supplied = resolve(license);
  if (!existsSync(supplied)) fail("--license path does not exist: " + supplied);
  const canonical = realpathSync(supplied);
  if (!isOutsideRoot(supplied) || !isOutsideRoot(canonical)) fail("--license must resolve to a path outside this repository");
  regularFile(canonical, "--license");
  const licenseText = readFileSync(canonical, "utf8");
  const currentLicense = readFileSync(join(ROOT, "LICENSE"), "utf8");
  if (licenseText === currentLicense) fail("--license must not reuse the checked-in root LICENSE");
  return canonical;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/build-install-bundle.mjs --platform <plat>|all --license <absolute-file> [options]

Options:
  --platform <name>         One of ${PLATFORMS.join(", ")}, or "all". Repeatable.
  --license <path>          REQUIRED. Absolute path to an approved license file
                             outside this repository (not the root LICENSE).
  --node-version <x.y.z>    Node.js version to embed (default ${NODE_LTS_VERSION}).
  --node-cache <dir>        Download/extraction cache (default ${DEFAULT_NODE_CACHE}).
  --no-download             Fail if the cache lacks the archive (never fetch).
  --out <dir>               Output root (default ${DEFAULT_OUT_ROOT}).
  --no-zip                  Skip the win-x64 .zip asset deliberately. Without
                             this flag, win-x64 requires a working \`zip\`
                             binary on the build host and fails closed if one
                             isn't available.
  -h, --help                Print this help and exit 0.
`);
}

export function parseArgs(argv) {
  const options = {
    platforms: [],
    license: undefined,
    nodeVersion: NODE_LTS_VERSION,
    nodeCache: DEFAULT_NODE_CACHE,
    noDownload: false,
    outRoot: DEFAULT_OUT_ROOT,
    noZip: false,
    help: false,
  };
  let i = 0;
  const next = (name) => {
    i += 1;
    const value = argv[i];
    if (value === undefined) fail(name + " requires a value");
    return value;
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--platform") {
      const value = next("--platform");
      if (value === "all") options.platforms.push(...PLATFORMS);
      else if (PLATFORMS.includes(value)) options.platforms.push(value);
      else fail(`unknown --platform: ${value} (expected one of ${PLATFORMS.join(", ")}, or "all")`);
    } else if (arg === "--license") options.license = next("--license");
    else if (arg === "--node-version") options.nodeVersion = next("--node-version");
    else if (arg === "--node-cache") options.nodeCache = resolve(next("--node-cache"));
    else if (arg === "--no-download") options.noDownload = true;
    else if (arg === "--out") options.outRoot = resolve(next("--out"));
    else if (arg === "--no-zip") options.noZip = true;
    else fail("unknown argument " + JSON.stringify(arg));
  }
  options.platforms = [...new Set(options.platforms)];
  return options;
}

function nodeBinaryName(platform) {
  return platform.startsWith("win") ? "node.exe" : "node";
}

function nodeArchiveFilename(platform, nodeVersion) {
  return `node-v${nodeVersion}-${platform}.${NODE_ARCHIVE_EXT[platform]}`;
}

function nodeReleaseDirName(platform, nodeVersion) {
  return `node-v${nodeVersion}-${platform}`;
}

function extractedRuntimeDir(nodeCacheDir, nodeVersion, platform) {
  return join(nodeCacheDir, "extracted", `v${nodeVersion}`, platform);
}

function archiveCacheDir(nodeCacheDir, nodeVersion) {
  return join(nodeCacheDir, "archives", `v${nodeVersion}`);
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) fail(`download failed (${response.status} ${response.statusText}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);
}

/** Verifies archivePath's SHA-256 against the entry for expectedFilename inside shasumsPath. Throws on any mismatch or missing entry. Returns the verified hash. */
export function verifyChecksum(archivePath, shasumsPath, expectedFilename) {
  const shasums = readFileSync(shasumsPath, "utf8");
  // Match the exact filename FIELD (last whitespace-separated token, minus
  // SHASUMS256.txt's optional leading "*" binary-mode marker) — not
  // `endsWith`, which would also accept a longer filename that merely ends
  // in the expected one (e.g. "evil-node-v1.0.0-linux-x64.tar.xz").
  const line = shasums.split("\n").find((l) => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 2) return false;
    const filenameField = fields[fields.length - 1].replace(/^\*/, "");
    return filenameField === expectedFilename;
  });
  if (!line) fail(`SHASUMS256.txt has no entry for ${expectedFilename}`);
  const expectedHash = line.trim().split(/\s+/)[0].toLowerCase();
  const actualHash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualHash !== expectedHash) {
    fail(`checksum mismatch for ${expectedFilename}: expected ${expectedHash}, got ${actualHash}`);
  }
  return actualHash;
}

/**
 * Extracts just the node binary + LICENSE member out of a downloaded Node.js
 * distribution archive. `.tar.gz`/`.tar.xz` (macOS/Linux) always go through
 * the system `tar`. The win-x64 archive is a `.zip`, which only bsdtar (not
 * GNU tar, the Linux default) can read — so on a `.zip` whose `tar`
 * extraction fails, fall back to `unzip -q`; if neither tool can produce the
 * members, fail with a message naming both so the operator knows what to
 * install (see release-checklist.md: "build the win-x64 archive on a host
 * with bsdtar or unzip").
 */
export function extractNodeRuntime({ archivePath, platform, nodeVersion, extractedDir }) {
  const releaseDir = nodeReleaseDirName(platform, nodeVersion);
  const memberBin = `${releaseDir}/${platform.startsWith("win") ? "node.exe" : "bin/node"}`;
  const memberLicense = `${releaseDir}/LICENSE`;
  const tmpDir = mkdtempSync(join(tmpdir(), "tl-node-extract-"));
  try {
    const isZip = archivePath.endsWith(".zip");
    const tarResult = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir, memberBin, memberLicense], { encoding: "utf8" });
    const tarOk = !tarResult.error && tarResult.status === 0;
    if (!tarOk) {
      if (!isZip) {
        fail(`tar extraction failed for ${archivePath}: ${tarResult.error?.message ?? tarResult.stderr ?? tarResult.stdout ?? "unknown error"}`);
      }
      const unzipResult = spawnSync("unzip", ["-q", archivePath, memberBin, memberLicense, "-d", tmpDir], { encoding: "utf8" });
      if (unzipResult.error || unzipResult.status !== 0) {
        fail(
          `extracting ${archivePath} failed with both tar (${tarResult.error?.message ?? tarResult.stderr ?? tarResult.stdout ?? "unknown error"}) ` +
            `and unzip (${unzipResult.error?.message ?? unzipResult.stderr ?? unzipResult.stdout ?? "unknown error"}) — ` +
            `install bsdtar or unzip on this host to extract a .zip archive`,
        );
      }
    }
    mkdirSync(extractedDir, { recursive: true });
    const extractedBin = join(tmpDir, ...memberBin.split("/"));
    const extractedLicense = join(tmpDir, ...memberLicense.split("/"));
    // lstat (not existsSync/statSync, which follow symlinks and would report
    // a symlink-to-nowhere as "missing" instead of "present but a symlink")
    // — this both proves the member landed at all AND refuses it if it is a
    // symlink, before any byte is ever copied out of the archive.
    for (const extractedMember of [extractedBin, extractedLicense]) {
      let memberStat;
      try {
        memberStat = lstatSync(extractedMember);
      } catch {
        fail(`extraction did not produce the expected members for ${archivePath}`);
      }
      if (memberStat.isSymbolicLink()) {
        fail(`refusing to copy a symlink member from the Node.js distribution archive: ${extractedMember}`);
      }
    }
    copyFileSync(extractedBin, join(extractedDir, nodeBinaryName(platform)));
    copyFileSync(extractedLicense, join(extractedDir, "LICENSE"));
    chmodSync(join(extractedDir, nodeBinaryName(platform)), 0o755);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Resolves the Node.js runtime for one platform+version, using the
 * per-version+platform cache. Cache layers, checked in order:
 *   1. extracted/<v><platform>/{node|node.exe,LICENSE} — used as-is if
 *      present (this is what a test pre-populates to exercise archive
 *      assembly without any network access or real extraction).
 *   2. archives/<v>/{filename,SHASUMS256.txt} — verified via SHA-256, then
 *      extracted into layer 1.
 *   3. Neither present: download both (unless --no-download, which fails
 *      closed instead).
 */
export async function ensureNodeRuntime({ platform, nodeVersion, nodeCacheDir, noDownload }) {
  const extractedDir = extractedRuntimeDir(nodeCacheDir, nodeVersion, platform);
  const nodeBinaryPath = join(extractedDir, nodeBinaryName(platform));
  const nodeLicensePath = join(extractedDir, "LICENSE");
  if (existsSync(nodeBinaryPath) && existsSync(nodeLicensePath)) {
    return { nodeBinaryPath, nodeLicensePath, source: "extracted-cache" };
  }

  const archDir = archiveCacheDir(nodeCacheDir, nodeVersion);
  const archiveFilename = nodeArchiveFilename(platform, nodeVersion);
  const archivePath = join(archDir, archiveFilename);
  const shasumsPath = join(archDir, "SHASUMS256.txt");

  if (!existsSync(archivePath) || !existsSync(shasumsPath)) {
    if (noDownload) fail(`--no-download set and the cache lacks ${archiveFilename} (or SHASUMS256.txt) under ${archDir}`);
    mkdirSync(archDir, { recursive: true });
    const base = `https://nodejs.org/dist/v${nodeVersion}/`;
    await downloadFile(base + archiveFilename, archivePath);
    await downloadFile(base + "SHASUMS256.txt", shasumsPath);
  }

  verifyChecksum(archivePath, shasumsPath, archiveFilename);
  extractNodeRuntime({ archivePath, platform, nodeVersion, extractedDir });
  if (!existsSync(nodeBinaryPath) || !existsSync(nodeLicensePath)) {
    fail(`extraction did not produce expected files under ${extractedDir}`);
  }
  return { nodeBinaryPath, nodeLicensePath, source: "downloaded" };
}

/**
 * Assembles one platform's tokenlighten-<ver>-<platform>/ tree under
 * outRoot: the CLI bundle (via bundleFn, default the real bundleCli — a
 * test may inject a stub that writes fixture files instead of running
 * esbuild), the runtime binary + its license, the approved LICENSE,
 * THIRD_PARTY_NOTICES.md, README-INSTALL.md, and the tl-setup / tl-setup.cmd
 * entry points. Returns the created directory's path and basename.
 */
export async function assembleArchiveDir({
  platform,
  version,
  outRoot,
  licensePath,
  nodeBinaryPath,
  nodeLicensePath,
  bundleFn = bundleCli,
}) {
  const dirName = `tokenlighten-${version}-${platform}`;
  const platformDir = join(outRoot, dirName);
  rmSync(platformDir, { recursive: true, force: true });
  mkdirSync(platformDir, { recursive: true });

  await bundleFn({ outDir: platformDir });

  // tl-cli.js is an esbuild CJS bundle (require() calls) sitting directly at
  // the archive root with no package.json of its own. Without one, Node's
  // module-type resolution walks up from wherever the archive happens to be
  // extracted looking for the nearest package.json's "type" — which, if the
  // archive is ever extracted under (or built directly into, as this script
  // does by default) a tree whose own package.json declares "type":"module"
  // (this very monorepo's root package.json does), misreads tl-cli.js as ESM
  // and fails with "ReferenceError: require is not defined in ES module
  // scope" — reproduced and fixed during the 2026-09-13 real-archive
  // verification run. Pin it explicitly so the archive is self-contained
  // regardless of where it lands.
  writeFileSync(
    join(platformDir, "package.json"),
    JSON.stringify({ name: "tokenlighten-install", private: true, type: "commonjs" }, null, 2) + "\n",
  );

  const runtimeDir = join(platformDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const nodeBinName = nodeBinaryName(platform);
  copyFileSync(nodeBinaryPath, join(runtimeDir, nodeBinName));
  chmodSync(join(runtimeDir, nodeBinName), 0o755);
  copyFileSync(nodeLicensePath, join(runtimeDir, "LICENSE-node"));

  copyFileSync(licensePath, join(platformDir, "LICENSE"));
  copyFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), join(platformDir, "THIRD_PARTY_NOTICES.md"));
  writeFileSync(join(platformDir, "README-INSTALL.md"), buildReadmeInstallMd(platform));

  const setupShPath = join(platformDir, "tl-setup");
  writeFileSync(setupShPath, TL_SETUP_SH);
  chmodSync(setupShPath, 0o755);
  writeFileSync(join(platformDir, "tl-setup.cmd"), TL_SETUP_CMD);

  return { platformDir, dirName };
}

function sha256File(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

/**
 * Packs the assembled directory into a .tgz (always) and, for win-x64, a
 * .zip — REQUIRED (fails closed) unless `noZip` is set, since
 * getting-started.md/release-docs promise a win-x64 `.zip` asset and a
 * silently-skipped one would ship one fewer asset than documented. Returns
 * the list of produced archive paths. `spawnFn` is injectable so tests can
 * simulate an unavailable/failing `zip` binary without touching PATH or
 * running a real archiver.
 */
export function packArchive({ outRoot, dirName, platform, noZip = false, spawnFn = spawnSync }) {
  const tgzPath = join(outRoot, `${dirName}.tgz`);
  rmSync(tgzPath, { force: true });
  // macOS copyfile metadata becomes visible AppleDouble files on Linux/Windows.
  // Ship only the payload; code signatures embedded in the runtime stay intact.
  const tarResult = spawnFn("tar", ["czf", tgzPath, "-C", outRoot, dirName], {
    encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (tarResult.error || tarResult.status !== 0) {
    fail(`tar packing failed for ${dirName}: ${tarResult.error?.message ?? tarResult.stderr ?? tarResult.stdout ?? "unknown error"}`);
  }
  const produced = [tgzPath];

  if (platform === "win-x64" && !noZip) {
    const zipProbe = spawnFn("zip", ["-v"], { encoding: "utf8" });
    if (zipProbe.error) {
      fail(
        `win-x64 requires a .zip asset but the system \`zip\` binary is not available ` +
          `(pass --no-zip to skip it deliberately): ${zipProbe.error.message}`,
      );
    }
    const zipPath = join(outRoot, `${dirName}.zip`);
    rmSync(zipPath, { force: true });
    const zipResult = spawnFn("zip", ["-r", zipPath, dirName], { cwd: outRoot, encoding: "utf8" });
    if (zipResult.error || zipResult.status !== 0) {
      fail(
        `zip packing failed for ${dirName}: ${zipResult.error?.message ?? zipResult.stderr ?? zipResult.stdout ?? "unknown error"} ` +
          `(pass --no-zip to skip the .zip asset deliberately)`,
      );
    }
    produced.push(zipPath);
  }
  return produced;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (options.platforms.length === 0) fail(`--platform is required (one of ${PLATFORMS.join(", ")}, or "all", repeatable)`);
  const licensePath = validateLicenseArg(options.license);
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  mkdirSync(options.outRoot, { recursive: true });

  const produced = [];
  for (const platform of options.platforms) {
    process.stdout.write(`build-install-bundle: building ${platform} (node v${options.nodeVersion})...\n`);
    const { nodeBinaryPath, nodeLicensePath, source } = await ensureNodeRuntime({
      platform,
      nodeVersion: options.nodeVersion,
      nodeCacheDir: options.nodeCache,
      noDownload: options.noDownload,
    });
    process.stdout.write(`  node runtime: ${source}\n`);
    const { platformDir, dirName } = await assembleArchiveDir({
      platform,
      version,
      outRoot: options.outRoot,
      licensePath,
      nodeBinaryPath,
      nodeLicensePath,
    });
    const archives = packArchive({ outRoot: options.outRoot, dirName, platform, noZip: options.noZip });
    produced.push(...archives);
    process.stdout.write(`  assembled: ${platformDir}\n`);
    for (const archive of archives) process.stdout.write(`  archive: ${archive}\n`);
  }

  process.stdout.write("\nSHA256SUMS:\n");
  for (const archive of produced) {
    process.stdout.write(`${sha256File(archive)}  ${archive.split(sep).pop()}\n`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`build-install-bundle: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
