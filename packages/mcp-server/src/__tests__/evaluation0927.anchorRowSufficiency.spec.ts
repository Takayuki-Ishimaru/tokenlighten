/**
 * evaluation0927.anchorRowSufficiency.spec.ts — an `explicit-identifier-anchor`
 * row proves its identifier's obligation only when the row is the WHOLE
 * evidence for it (orchestrator, round 4, full suite #6).
 *
 * Round 4 let identifier obligations see the anchor rows the post-
 * certification pass is about to add (so V01's `HTTP_TIMEOUT_MS` usage line no
 * longer sat beside a "missing" gap). But an anchor row on the FIRST line of a
 * longer declaration — a function's signature — then certified "Explain A and
 * B" with only B's signature sent (zoomEpochServedView.spec.ts is the
 * end-to-end fence in TypeScript). These unit cases pin the rule per shape,
 * including the ones the bracket scan alone cannot see.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { anchorRowIsWholeEvidence, FileReadCache, type TaskPackSurface } from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function check(rel: string, lines: readonly string[], line: number, symbol: string): boolean {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-anchorrow-"));
  tmpDirs.push(ws);
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n", "utf8");
  const row = { path: rel, range: `${line}-${line}`, symbol, why: "explicit-identifier-anchor", role: "unknown", handle: "h0" } as unknown as TaskPackSurface;
  return anchorRowIsWholeEvidence(row, ws, new FileReadCache());
}

describe("anchorRowIsWholeEvidence", () => {
  it("a function signature line is not the whole evidence (TypeScript)", () => {
    expect(check("src/a.ts", [
      "export function finalizeShutdownSequence(done: number, total: number): boolean {",
      "  return done >= total;",
      "}",
    ], 1, "finalizeShutdownSequence")).toBe(false);
  });

  it("an Allman-style signature whose `{` opens on the next line is not either", () => {
    expect(check("src/A.java", [
      "public boolean finalizeShutdown(int done, int total)",
      "{",
      "    return done >= total;",
      "}",
    ], 1, "finalizeShutdown")).toBe(false);
  });

  it("a Python `def` line with an indented body is not either", () => {
    expect(check("pipeline/config.py", [
      "def finalize_shutdown_sequence(done, total):",
      "    if done < total:",
      "        return False",
      "    return True",
    ], 1, "finalize_shutdown_sequence")).toBe(false);
  });

  it("the first line of a multi-line constant table is not either", () => {
    expect(check("src/retry.ts", [
      "export const RETRY_POLICY = {",
      "  503: { retry: true },",
      "};",
    ], 1, "RETRY_POLICY")).toBe(false);
  });

  it("a one-line constant declaration IS the whole evidence", () => {
    expect(check("src/config.ts", ["export const HTTP_TIMEOUT_MS = 9000;"], 1, "HTTP_TIMEOUT_MS")).toBe(true);
  });

  it("a usage line (an env-var key read inside an expression) IS the whole evidence", () => {
    expect(check("src/config.ts", [
      "export function loadOptions(env: Record<string, string | undefined>) {",
      "  return { timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? 9000) };",
      "}",
    ], 2, "HTTP_TIMEOUT_MS")).toBe(true);
  });
});
