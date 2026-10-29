import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clauseRecoveryInventoryIsBounded } from "../features/task-pack/readCodeTaskPack.js";
import { enumerateFindTextUniverse } from "../features/search/find/findText.js";

const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-clause-budget-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "main.ts"), "export const ready = true;\n");
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("clause recovery bounded inventory proof", () => {
  it("counts documentation and manifests in the same byte bound as code", () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
    fs.writeFileSync(path.join(dir, "README.md"), "# Small project\n");
    const small = enumerateFindTextUniverse(dir);
    expect(small.files.map((file) => file.relPath)).toContain("README.md");
    expect(clauseRecoveryInventoryIsBounded(small)).toBe(true);
    fs.writeFileSync(path.join(dir, "README.md"), "x".repeat(1024 * 1024));
    // Even a reused inventory must stat current sizes; this cannot become a
    // small-code-only bypass for an expensive documentation search.
    expect(clauseRecoveryInventoryIsBounded(small)).toBe(false);
  });

  it("rejects partial scopes, omissions, missing files, and too many files", () => {
    const dir = workspace();
    const universe = enumerateFindTextUniverse(dir);
    expect(clauseRecoveryInventoryIsBounded({ ...universe, scopes: ["src"] })).toBe(false);
    for (const omission of ["oversize", "gitignored", "unreadable_dirs", "symlinks"] as const) {
      expect(clauseRecoveryInventoryIsBounded({ ...universe, omissions: { ...universe.omissions, [omission]: 1 } })).toBe(false);
    }
    expect(clauseRecoveryInventoryIsBounded({ ...universe, files: Array(129).fill(universe.files[0]) })).toBe(false);
    fs.unlinkSync(path.join(dir, "main.ts"));
    expect(clauseRecoveryInventoryIsBounded(universe)).toBe(false);
  });
});
