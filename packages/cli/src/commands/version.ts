/**
 * tl version — print package version from package.json
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const BUILD_STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f]{8,64}$/;

export function serverBuildId(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const serverEntry = require.resolve("@tokenlighten/mcp-server");
    try {
      const stamp = readFileSync(join(dirname(serverEntry), ".build-stamp"), "utf8").trim();
      if (BUILD_STAMP_RE.test(stamp)) return stamp;
    } catch {
      // VSIX bundles have no sibling stamp; use the same stat fingerprint as the server.
    }
    const stat = statSync(serverEntry);
    return stat.mtime.toISOString() + "-" + stat.size;
  } catch {
    return undefined;
  }
}

export function formatVersionWithBuild(version: string, build: string | undefined): string {
  if (!build) return version;
  const stampedHash = /-([0-9a-f]{8,64})$/i.exec(build)?.[1];
  const build8 = (stampedHash
    ?? createHash("sha256").update(build, "utf8").digest("hex")).slice(0, 8).toLowerCase();
  return version + "+" + build8;
}

export function runVersion(): void {
  let version = "unknown";
  try {
    // require.resolve keeps source, installed-package, and VSIX bundle layouts aligned.
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tokenlighten/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch {
    // Keep the command usable even when package metadata is damaged.
  }
  process.stdout.write(formatVersionWithBuild(version, serverBuildId()) + "\n");
}
