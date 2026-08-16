/**
 * pathTraversal.spec.ts — P0 security: path-traversal guards.
 *
 * Covers:
 *   - small_file with path="../outside.txt" returns reason="path-outside-workspace"
 *   - small_file via symlink pointing outside workspace returns same refusal
 *   - remove-duplicate-branch intent with escaping path refuses
 *   - append-union-member intent with escaping path refuses
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { buildSmallFile } from "../tools/readCodeSmallFile.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";
import { applyRemoveDuplicateBranch } from "../intents/removeDuplicateBranch.js";
import { applyAppendUnionMember } from "../intents/appendUnionMember.js";
import { unsafeGuardedWorkspaceRootForTests } from "../write/guardedWorkspace.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-pt-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  handleTable.reset();
  resetAll();
});

// ---------------------------------------------------------------------------
// small_file path traversal
// ---------------------------------------------------------------------------

describe("small_file — path traversal guard", () => {
  it('returns reason="path-outside-workspace" for "../outside.txt"', async () => {
    const wsDir = mkDir("pt-smallfile");
    const outsideDir = mkDir("pt-outside");
    writeFile(outsideDir, "secret.txt", "secret content");

    const result = await buildSmallFile(wsDir, "../" + path.basename(outsideDir) + "/secret.txt");

    expect("ok" in result).toBe(true);
    const refusal = result as { ok: false; reason: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toBe("path-outside-workspace");
  });

  it("refuses symlink that resolves outside workspace", async () => {
    const wsDir = mkDir("pt-symlink-ws");
    const outsideDir = mkDir("pt-symlink-out");

    writeFile(outsideDir, "secret.txt", "supersecret");
    writeFile(wsDir, "inside.ts", "export const x = 1;\n");

    const linkPath = path.join(wsDir, "link.ts");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), linkPath);

    const result = await buildSmallFile(wsDir, "link.ts");

    expect("ok" in result).toBe(true);
    const refusal = result as { ok: false; reason: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toBe("path-outside-workspace");
  });
});

// ---------------------------------------------------------------------------
// remove-duplicate-branch traversal
// ---------------------------------------------------------------------------

describe("remove-duplicate-branch — path traversal guard", () => {
  it('refuses with reason="path-outside-workspace" for escaping path', async () => {
    const wsDir = mkDir("pt-rdb-ws");
    const outsideDir = mkDir("pt-rdb-out");

    writeFile(outsideDir, "target.ts", [
      "if (x === 'A') {",
      "  return 'same';",
      "} else if (x === 'B') {",
      "  return 'same';",
      "}",
    ].join("\n") + "\n");

    const escaping = "../" + path.basename(outsideDir) + "/target.ts";

    const result = await applyRemoveDuplicateBranch(
      escaping,
      undefined,
      unsafeGuardedWorkspaceRootForTests(wsDir),
      true,
      "h1",
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("path-outside-workspace");
  });
});

// ---------------------------------------------------------------------------
// append-union-member traversal
// ---------------------------------------------------------------------------

describe("append-union-member — path traversal guard", () => {
  it('refuses with reason="path-outside-workspace" for escaping path', async () => {
    const wsDir = mkDir("pt-aum-ws");
    const outsideDir = mkDir("pt-aum-out");

    writeFile(outsideDir, "types.ts", 'export type Status = "OPEN" | "CLOSED";\n');

    const escaping = "../" + path.basename(outsideDir) + "/types.ts";

    const result = await applyAppendUnionMember(
      escaping,
      "Status",
      "STALLED",
      unsafeGuardedWorkspaceRootForTests(wsDir),
      true,
      "h1",
      "ts",
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("path-outside-workspace");
  });
});
