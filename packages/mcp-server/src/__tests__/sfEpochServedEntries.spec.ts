/**
 * sfEpochServedEntries.spec.ts — FX-K (round-15 finding 5).
 *
 * THE DRIFT. `epochServedSurfaceEntries` EMULATES the served-surface log write
 * that used to happen before the contract build: it hands the contract this
 * pack's own candidate surfaces explicitly, because the real write now happens
 * after the trim/seam (FX-J, ratified shape B). Round-15 checked the emulation
 * term by term and found one residual difference, in REFRESH semantics rather
 * than in output:
 *
 *   - what it emulates: `recordServedSurfaces` rewrote each of this pack's own
 *     paths with a FRESH fingerprint, so the `queryServedSurfaces` that follows
 *     revalidated them trivially and left them in place;
 *   - what it did: `queryServedSurfaces` ran FIRST, and its revalidation is
 *     DESTRUCTIVE — an entry whose `<size>:<mtimeMs>` no longer matches is
 *     deleted from `entries` AND spliced out of `order`. The booking pass then
 *     re-appends it, at the END of `order`.
 *
 * `order` is consulted by exactly one reader — FIFO eviction at
 * MAX_LOGGED_PATHS — so the drift changes WHICH path is evicted first once a
 * task epoch has logged more than 512 paths. Case 1 below constructs that
 * difference against `packServeLog`'s own API, and shows it is confined to
 * eviction: `queryServedSurfaces` sorts its output by `servedAt`, so the
 * entries it returns are identical either way.
 *
 * THE FIX (chosen over documenting the drift). The destructive read is
 * avoidable: every pending path is supplied from the pack's own candidate list
 * and was already filtered out of the logged half, so excluding it from the
 * query is OUTPUT-IDENTICAL and leaves the log entry exactly where the
 * historical refresh left it. Revalidation is per-path independent, so
 * skipping one entry cannot change another's verdict. Case 2 pins the shape.
 *
 * WHAT FAILS WITHOUT THE FIX. Case 2 (the emulation still queries unfiltered
 * and post-filters). Case 1 passes before and after: it is a property of
 * `packServeLog`, and it is what makes the drift worth avoiding.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearServedSurfaces,
  queryServedSurfaces,
  recordServedSurfaces,
} from "../util/packServeLog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(
  path.resolve(HERE, "../features/task-pack/readCodeTaskPack.ts"),
  "utf8",
);

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      clearServedSurfaces(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** MAX_LOGGED_PATHS in packServeLog.ts — not exported; mirrored here on purpose. */
const MAX_LOGGED_PATHS = 512;
const EPOCH = ["pricing", "checkout", "handler"];

function mkLogWorkspace(tag: string, count: number): { dir: string; paths: string[] } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-entries-${tag}-`)));
  tmpDirs.push(dir);
  const paths: string[] = [];
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const rel = `src/f${String(i).padStart(4, "0")}.ts`;
    fs.writeFileSync(path.join(dir, rel), `export const V${i} = ${i};\n`, "utf8");
    paths.push(rel);
  }
  return { dir, paths };
}

const record = (dir: string, paths: readonly string[]): void => {
  recordServedSurfaces(dir, dir, paths.map((p) => ({ path: p, role: "domain" })), EPOCH);
};
const loggedPaths = (dir: string): string[] =>
  queryServedSurfaces(dir, dir, { epochTokens: EPOCH }).map((entry) => entry.path);

describe("FX-K: the served-log emulation's refresh semantics", () => {
  it("the drift is real and is confined to FIFO eviction order — the entries returned are identical", () => {
    // Both arms: a full log, then the same path re-served after its file
    // changed on disk. Arm A refreshes BEFORE consulting (what the pre-FX-J
    // log write did); arm B consults first (what the emulation would do
    // without the exclusion), which deletes and re-appends the entry.
    const survivors: string[][] = [];
    const contents: string[][] = [];
    for (const arm of ["refresh-first", "consult-first"] as const) {
      const { dir, paths } = mkLogWorkspace(arm, MAX_LOGGED_PATHS + 1);
      const filled = paths.slice(0, MAX_LOGGED_PATHS);
      record(dir, filled);
      // The re-served path's file changes, so its stored fingerprint goes stale.
      const reserved = filled[0]!;
      fs.writeFileSync(path.join(dir, reserved), "export const V0 = 99;\nexport const W0 = 1;\n", "utf8");

      if (arm === "refresh-first") {
        record(dir, [reserved]);
      } else {
        // The destructive consult: this read DELETES the stale entry. The
        // emulation re-supplies the same path from its own pending list, so
        // the CONSUMER's list is unaffected; the booking pass then re-records
        // it, which is where the two arms converge on content and diverge on
        // `order`.
        loggedPaths(dir);
        record(dir, [reserved]);
      }
      contents.push(loggedPaths(dir));
      // One more NEW path pushes the log past the cap: whichever path sits at
      // the head of `order` is evicted.
      record(dir, [paths[MAX_LOGGED_PATHS]!]);
      survivors.push(loggedPaths(dir));
    }
    // The reader-visible content is the same in both arms...
    expect(contents[1], "queryServedSurfaces sorts by servedAt — its output cannot see `order`")
      .toEqual(contents[0]);
    // ...but the eviction victim is NOT: refresh-first keeps the re-served
    // path at the head and evicts it; consult-first moved it to the tail.
    expect(survivors[0]).not.toContain("src/f0000.ts");
    expect(survivors[1]).toContain("src/f0000.ts");
    expect(survivors[1]).not.toContain("src/f0001.ts");
  }, 120000);

  it("`epochServedSurfaceEntries` excludes its own pending paths from the query instead of post-filtering", () => {
    const start = SOURCE.search(/^function epochServedSurfaceEntries\(/m);
    expect(start, "epochServedSurfaceEntries must exist").toBeGreaterThan(-1);
    const rest = SOURCE.slice(start + 1);
    const end = rest.search(/^(?:export )?(?:async |declare )?(?:function |const |let |class |interface |type |\/\*\*|\/\/ ---)/m);
    const body = end === -1 ? rest : rest.slice(0, end);

    // The query that CAN consult (and therefore destroy) this pack's own
    // entries must carry the exclusion.
    expect(body, "the pending paths must be excluded from the log query").toMatch(
      /queryServedSurfaces\(workspace, workspace, \{\s*epochTokens,\s*excludePaths: new Set\(byPath\.keys\(\)\),\s*\}\)/,
    );
    // The old post-filter is what made the destructive read look harmless.
    expect(body, "no post-filter may stand in for the exclusion")
      .not.toMatch(/logged\.filter\(/);
    // With no pending surfaces the function must still be `queryServedSurfaces`
    // verbatim — the early return proves it takes no exclusion in that case.
    expect(body).toMatch(
      /if \(pending === undefined \|\| pending\.length === 0\) \{\s*return queryServedSurfaces\(workspace, workspace, \{ epochTokens \}\);\s*\}/,
    );
  });
});
