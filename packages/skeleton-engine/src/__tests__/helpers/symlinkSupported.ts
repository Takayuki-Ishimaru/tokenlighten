// symlinkSupported.ts — probes, once per process, whether this OS/
// filesystem/privilege level can create a symlink. Windows without
// Developer Mode (and without an elevated/admin process) raises EPERM;
// everywhere else — and a Windows box WITH Developer Mode enabled — this
// succeeds. A real probe rather than a `process.platform === "win32"`
// string check, so specs gated on this still run (and prove something) on
// a Windows CI box that has Developer Mode on.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached: boolean | undefined;

export function symlinkSupported(): boolean {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), "tl-symlink-probe-"));
  try {
    const target = join(dir, "target");
    const link = join(dir, "link");
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    cached = true;
  } catch {
    cached = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
