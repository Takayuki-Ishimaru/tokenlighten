/**
 * servedRangeBookingHonesty.spec.ts — eval-0927 §6.1 Defect 1 (2026-09-27,
 * INT-R wave): "prior" must never claim unshipped lines.
 *
 * THE DEFECT, CONFIRMED LIVE (pre-fix, on the working tree AND on the
 * v0.14.3-era candidate build `~/.cache/tokenlighten-ab/candidate/tl-cli.js`).
 * A query-bearing `read.task_pack` response cut down to the caller's
 * `budget.bytes` shortens one or more surfaces — `body` carries only part of
 * the surface's declared `range`, and the surface's OWN `remaining` names the
 * unshipped rest. The NEXT call that asks for exactly those disclosed
 * `remaining` windows came back `prior: "<handle> — already served this
 * session (...); resident in your context"`, with NO body — a false
 * "already served" claim for bytes that were never on the wire.
 *
 * ROOT CAUSE. `residentBodyIndex`/`residentSurfaceKeys` (readCodeTaskPack.ts)
 * index a captured pack's surfaces by their DECLARED `range` verbatim,
 * ignoring `content_completeness`/`remaining_ranges` — so a surface captured
 * with `range:"1-40"` but shipped only lines 1-20 (`remaining_ranges:
 * ["21-40"]`) still indexed key `path\u00001-40` as fully resident. A LATER
 * request for exactly the never-shipped `21-40` window then matched by
 * SUBSUMPTION in `applyResidentFileDedup`
 * (`entry.span.start <= start && entry.span.end >= end`) and was answered
 * with a body-less `code_unchanged` pointer. `applyResidentFileDedup`
 * already refuses to STRIP a partial surface's OWN body one loop below
 * (`if (surf.content_completeness === "partial") continue;`) — this was the
 * missing other half: refusing to grant a FUTURE surface residency FROM one.
 *
 * THE FIX. Both functions now skip a captured surface whose own serve was
 * disclosed-partial, the same way `applyResidentFileDedup` already does for
 * its own pack's surfaces.
 *
 * Repro scripts used during investigation (both pre-fix, both fixed by this
 * change): `probe-prior2.mts` (the exact two-call sequence below) and
 * `probe-prior.mts` (the full budgeted facet chain over ten constant
 * tables, replicated as this file's "full facet chain" case).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  followNextToEnd,
  startDevServer,
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { stripAnswerLineGutter } from "../protocol/lineGutter.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

/** Ten module-level constant tables + a reader — the exact shape that
 *  triggered the live repro: several independent multi-line surfaces of ONE
 *  file, each large enough that a shared `budget.bytes` shortens it. */
const HEAVY_TABLES = Array.from({ length: 10 }, (_, i) => `LEVEL_TABLE_${i}`);
const QUERY = "Which values does resolveLevel read by default?";
const BUDGET_BYTES = 7000;

function tableConst(name: string, rows: number): string {
  const body = Array.from({ length: rows }, (_, i) => `  row${i}: "entry-${i}-of-${name.toLowerCase()}",`).join("\n");
  return `export const ${name} = {\n${body}\n};\n`;
}

/** Writes the fixture: ten 40-row constant tables (each big enough to clear
 *  `RESIDENT_DEDUP_MIN_BYTES`, 512 B) plus a small reader function. */
function buildLevelsWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "p", version: "1.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  let tables = "";
  for (const name of HEAVY_TABLES) tables += `${tableConst(name, 40)}\n`;
  const reader = `export function resolveLevel(key: string): unknown {\n  return ${HEAVY_TABLES.map((n) => `(${n} as Record<string, unknown>)[key]`).join(" ?? ")};\n}\n`;
  fs.writeFileSync(path.join(root, "src/levels.ts"), `${tables}${reader}`, "utf8");
}

/** The unshipped "<start>-<end>" windows an evidence entry discloses for its OWN declared range, if any. */
function remainingWindowsOf(entry: Record<string, unknown>): string[] {
  const remaining = entry["remaining"];
  return Array.isArray(remaining) ? remaining.filter((r): r is string => typeof r === "string") : [];
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`served-range booking honesty: a shed surface's remaining windows stay unserved (config=${config})`, () => {
    let ws: string;
    let server: ServerHandle;

    beforeAll(async () => {
      ws = fs.realpathSync(shortTmpDir(HOME, `.tl-bookhonesty-${config}-`));
      buildLevelsWorkspace(ws);
      server = startDevServer(ws, config);
      await server.initialize();
    }, 60_000);

    afterAll(async () => {
      await server.kill();
      try {
        await rmDirWithRetry(ws);
      } catch {
        /* best-effort cleanup */
      }
    });

    it("a query-bearing batch shortened by budget.bytes: re-reading exactly the disclosed remaining windows returns bodies, never `prior`", async () => {
      const lane = `query-remaining-${config}`;
      const targets = [
        { path: "src/levels.ts", range: "1-40" },
        { path: "src/levels.ts", range: "44-83" },
        { path: "src/levels.ts", range: "87-126" },
      ];
      const first = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
        lane,
        budget: { bytes: BUDGET_BYTES },
        targets,
      });
      const firstEvidence: Array<Record<string, unknown>> = Array.isArray(first.body?.evidence) ? first.body.evidence : [];
      const shed = firstEvidence.filter((e) => remainingWindowsOf(e).length > 0);
      expect(
        shed.length,
        `expected budget.bytes:${BUDGET_BYTES} to shorten at least one of the three targets: ${JSON.stringify(first.body)}`,
      ).toBeGreaterThan(0);

      const remainingTargets = shed.flatMap((e) =>
        remainingWindowsOf(e).map((range) => ({ path: e["path"] as string, range })));
      expect(remainingTargets.length).toBeGreaterThan(0);

      const second = await server.callTool("tl_read_file", {
        query: QUERY,
        cwd: ws,
        lane,
        budget: { bytes: BUDGET_BYTES },
        targets: remainingTargets,
      });
      // A query-bearing pack may legitimately widen `evidence` past the exact
      // targets named (e.g. a readiness-falsification counterexample row) —
      // this test's own contract is only about the EXACT windows requested,
      // matched by (path,range), never about the response's total row count.
      const secondEvidence: Array<Record<string, unknown>> = Array.isArray(second.body?.evidence) ? second.body.evidence : [];
      for (const requested of remainingTargets) {
        const entry = secondEvidence.find((e) => e["path"] === requested.path && e["range"] === requested.range);
        expect(entry, `no evidence row addressed the requested remaining window ${requested.path}:${requested.range}: `
          + `${JSON.stringify(second.body)}`).toBeDefined();
        expect(
          entry?.["prior"],
          `remaining window ${requested.path}:${requested.range} was never shipped but came back \`prior\`: `
            + `${JSON.stringify(entry)}`,
        ).toBeUndefined();
        expect(
          typeof entry?.["body"],
          `remaining window ${requested.path}:${requested.range} must carry a real body, not a pointer: `
            + `${JSON.stringify(entry)}`,
        ).toBe("string");
      }
    }, 45_000);

    it("control: a plain targets batch (no query) shortened by the same budget also serves its remaining windows on re-read", async () => {
      // No `query` at all — the control case for the test above. This shape
      // never populates `residentBodyIndex`'s cross-pack index in the first
      // place (`tokenizeForEpoch("")` is empty, and that function returns
      // early on an empty epoch-token list), so it was never able to exhibit
      // the defect either before or after this fix — pinned here so a future
      // change to that early-return cannot silently start exhibiting it.
      const lane = `plain-remaining-${config}`;
      const targets = [
        { path: "src/levels.ts", range: "1-40" },
        { path: "src/levels.ts", range: "44-83" },
        { path: "src/levels.ts", range: "87-126" },
      ];
      const first = await server.callTool("tl_read_file", {
        cwd: ws,
        lane,
        budget: { bytes: BUDGET_BYTES },
        targets,
      });
      const firstEvidence: Array<Record<string, unknown>> = Array.isArray(first.body?.evidence) ? first.body.evidence : [];
      const shed = firstEvidence.filter((e) => remainingWindowsOf(e).length > 0);
      expect(shed.length, `expected at least one shortened target: ${JSON.stringify(first.body)}`).toBeGreaterThan(0);

      const remainingTargets = shed.flatMap((e) =>
        remainingWindowsOf(e).map((range) => ({ path: e["path"] as string, range })));

      const second = await server.callTool("tl_read_file", {
        cwd: ws,
        lane,
        budget: { bytes: BUDGET_BYTES },
        targets: remainingTargets,
      });
      const secondEvidence: Array<Record<string, unknown>> = Array.isArray(second.body?.evidence) ? second.body.evidence : [];
      for (const entry of secondEvidence) {
        expect(typeof entry["body"], `plain remaining-window re-read must serve a body: ${JSON.stringify(entry)}`)
          .toBe("string");
      }
    }, 45_000);

    it("control: a genuine re-read of an ALREADY fully-shipped window keeps its `prior`/receipt behaviour", async () => {
      // A whole 40-row table, generously budgeted — big enough to clear
      // `RESIDENT_DEDUP_MIN_BYTES` (512 B) and guaranteed to ship whole,
      // never shortened. Re-reading the exact same window must still be
      // recognized as resident: this fix must narrow WHICH surfaces grant
      // residency (partial ones), never turn off residency for a surface
      // that genuinely shipped whole.
      // Second call is an explicit-targets zoom bound to the SAME task handle
      // (the proven "hop0 -> hop1" shape `repackMonotonicitySpawned.spec.ts`
      // already relies on), never a second independent query-driven build —
      // a fresh `query`-only re-build is free to widen its own candidate set
      // (facet completion adding a surface neither call named explicitly),
      // which is a different, unrelated mechanism this control must not
      // depend on either way.
      const lane = `genuine-prior-${config}`;
      const range = "1-40";
      const first = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
        lane,
        budget: { bytes: 50_000 },
        targets: [{ path: "src/levels.ts", range }],
      });
      const firstEvidence: Array<Record<string, unknown>> = Array.isArray(first.body?.evidence) ? first.body.evidence : [];
      const firstEntry = firstEvidence.find((e) => e["path"] === "src/levels.ts" && e["range"] === range);
      expect(typeof firstEntry?.["body"], `the table must ship whole: ${JSON.stringify(first.body)}`).toBe("string");
      expect(remainingWindowsOf(firstEntry ?? {}).length, "the table must not be shortened").toBe(0);
      const taskHandle = first.body?.task?.id;
      expect(typeof taskHandle, `hop0 must mint a task handle: ${JSON.stringify(first.body)}`).toBe("string");

      const second = await server.callTool("tl_read_file", {
        targets: [{ path: "src/levels.ts", range }],
        task: { handle: taskHandle },
        cwd: ws,
        lane,
        budget: { bytes: 50_000 },
      });
      // A single-target re-read that is FULLY resident collapses to a compact
      // top-level `read.receipt` (no `evidence[]` at all) rather than an
      // `evidence[]` entry carrying `prior` — both are the SAME "already
      // served, no body" fact; accept either shape.
      const receiptKind = typeof second.body?.receipt?.receipt === "string" ? second.body.receipt.receipt : undefined;
      const secondEvidence: Array<Record<string, unknown>> = Array.isArray(second.body?.evidence) ? second.body.evidence : [];
      const secondEntry = secondEvidence.find((e) => e["path"] === "src/levels.ts" && e["range"] === range);
      const priorClaim = receiptKind ?? (typeof secondEntry?.["prior"] === "string" ? secondEntry["prior"] : undefined);
      expect(
        typeof priorClaim,
        `an exact re-read of an already fully-shipped window must be recognized as resident: `
          + `${JSON.stringify(second.body)}`,
      ).toBe("string");
    }, 45_000);

    it("the full facet chain never books a never-shipped line as `prior`, and certifies act.answer only once every table's lines are shipped", async () => {
      const lane = `facet-chain-${config}`;
      const chain = await followNextToEnd(
        server,
        {
          tool: "tl_read_file",
          arguments: { query: QUERY, task: { epoch: "new", profile: "answer" }, cwd: ws, lane, budget: { bytes: BUDGET_BYTES } },
        },
        { cwd: ws, hopCap: 14, maxQrefRepacks: 0 },
      );

      const shipped = new Map<string, Set<number>>();
      const violations: string[] = [];
      for (const hop of chain.hops) {
        const evidence: Array<Record<string, unknown>> = Array.isArray(hop.response?.evidence) ? hop.response.evidence : [];
        for (const entry of evidence) {
          const range = String(entry["range"] ?? "");
          const match = /^(\d+)-(\d+)$/.exec(range);
          if (match === null) continue;
          const start = Number(match[1]);
          const end = Number(match[2]);
          const entryPath = String(entry["path"] ?? "");
          if (typeof entry["body"] === "string") {
            const lineCount = stripAnswerLineGutter(entry["body"]).replace(/\n$/, "").split("\n").length;
            const set = shipped.get(entryPath) ?? new Set<number>();
            for (let line = start; line < start + lineCount; line++) set.add(line);
            shipped.set(entryPath, set);
          } else if (typeof entry["prior"] === "string") {
            const set = shipped.get(entryPath) ?? new Set<number>();
            const missing: number[] = [];
            for (let line = start; line <= end; line++) if (!set.has(line)) missing.push(line);
            if (missing.length > 0) {
              violations.push(
                `${entryPath}:${range} claims \`prior\` over ${missing.length} never-shipped line(s) `
                  + `(${missing[0]}..${missing[missing.length - 1]})`,
              );
            }
          }
        }
      }

      expect(
        violations,
        `never-shipped \`prior\` claims found across the facet chain: ${JSON.stringify(violations)}`,
      ).toEqual([]);
      expect(chain.capped, `the facet chain must converge within the hop cap: ${JSON.stringify(chain.final)}`).toBe(false);
      expect(
        chain.final?.decision?.kind,
        `the facet chain's terminal decision must be act.answer once every table's lines are shipped: `
          + `${JSON.stringify(chain.final)}`,
      ).toBe("act.answer");
    }, 60_000);
  });
}
