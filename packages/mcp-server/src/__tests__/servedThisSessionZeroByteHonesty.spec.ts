/**
 * servedThisSessionZeroByteHonesty.spec.ts — FX-O2 (ruling (s), 2026-09-03,
 * round-17 finding 7a / INV-G row 14).
 *
 * THE MEASURED DEFECT (`r16_w.mts`, re-run at round-17 HEAD): `find BEFORE
 * [["src/pricing_5.ts",false]]` -> a `read_file` on that path sheds to a
 * ZERO-BYTE `refusal/cap-exceeded` -> `find AFTER [["src/pricing_5.ts",true]]`.
 * `servedFindEscalation.ts`'s per-file `served_this_session` flag was sourced
 * purely from `getReadPaths` (`state/session.ts`'s `readPaths` Set), which
 * `recordReadPath` writes UNCONDITIONALLY at each of server.ts's many read
 * call sites — with no staging or retraction of its own, unlike the
 * served-range ledger FX-N gave `recordServedRange`/`settleServedCallBookings`.
 * A call that shed to zero bytes still left its path in `readPaths` forever,
 * so `served_this_session:true` — a field whose OWN NAME promises bytes were
 * served — fired for a path this session never actually put a single byte
 * of on the wire.
 *
 * THE FIX (`servedFindEscalation.ts`'s `isGenuinelyServed`): a file counts as
 * served only when it is BOTH addressed (`getReadPaths`) AND the honest,
 * FX-N-settled served-range ledger has some genuinely corroborated span for
 * it (`servedPathProvenance(...) !== undefined`, i.e. `state.spans.length >
 * 0`). No `protocol/envelope.ts`/`emit.ts` change was needed for this one —
 * the existing settled ledger already answers the question correctly; this
 * fix only stops IGNORING it at the one place that mattered.
 *
 * NOT the same axis as the C3 line-level check (`lines_held`,
 * `servedFindMatchLinesOutsideServed`) a few lines below in the same module:
 * a genuine partial/doc-sliver serve (SOME bytes shipped, just not at the
 * matched line) must keep `served_this_session:true` — see
 * `servedFindRecovery.spec.ts`'s C3 suite, byte-for-byte unaffected by this
 * fix (its own CONTRACT.md-sliver scenario is reproduced as the control case
 * below). Only a TRUE zero-byte address — nothing ever staged, or staged and
 * then retracted at settlement — must now read `false`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFindResponse } from "../features/search/find/findText.js";
import { applyServedFindProtocol } from "../features/search/find/servedFindEscalation.js";
import { handleTable } from "../util/handles.js";
import { recordReadPath, recordServedRange, resetAll } from "../state/session.js";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-served-honesty-${tag}-`)));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, relPath: string, content: string): void {
  const abs = path.join(ws, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  handleTable.reset();
  resetAll();
});

afterEach(() => {
  handleTable.reset();
  resetAll();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("FX-O2 finding 7a — served_this_session must not survive a zero-byte address", () => {
  it("a path merely ADDRESSED (recordReadPath) with NO corroborated served span never gets served_this_session:true — the r16_w/r17_s zero-byte-refusal shape", () => {
    const ws = mkWorkspace("zero-byte");
    writeFile(ws, "src/pricing_5.ts", "export const PRICE = 5;\nexport const TAX = 0.07;\n");
    // Exactly what a call that sheds to a zero-byte refusal leaves behind:
    // the path is ADDRESSED (recordReadPath fires unconditionally at many
    // server.ts call sites) but NO byte of the file was ever staged/
    // corroborated (recordServedRange never ran, or ran and was retracted).
    recordReadPath(ws, "src/pricing_5.ts");

    const response = buildFindResponse({ query: "PRICE", path: "src/pricing_5.ts" }, ws);
    const outcome = applyServedFindProtocol(response, ws, { action: "find", query: "PRICE", path: "src/pricing_5.ts" });

    const files = outcome.body["files"] as Array<Record<string, unknown>> | undefined;
    expect(files, JSON.stringify(outcome.body)).toBeDefined();
    const file = files!.find((f) => f["path"] === "src/pricing_5.ts");
    expect(file, JSON.stringify(files)).toBeDefined();
    expect(
      file!["served_this_session"],
      "a refusal that shipped zero bytes must never be reported as served",
    ).not.toBe(true);
  });

  it("CONTROL: a path that is BOTH addressed and genuinely served (a real recordServedRange span) keeps served_this_session:true — the ordinary, unbroken case", () => {
    const ws = mkWorkspace("genuinely-served");
    const content = "export const PRICE = 5;\nexport const TAX = 0.07;\n";
    writeFile(ws, "src/pricing_ok.ts", content);
    const totalLines = content.split("\n").length - 1;
    recordReadPath(ws, "src/pricing_ok.ts");
    recordServedRange(ws, "src/pricing_ok.ts", "sha-pricing-ok", 1, totalLines, totalLines);

    const response = buildFindResponse({ query: "PRICE", path: "src/pricing_ok.ts" }, ws);
    const outcome = applyServedFindProtocol(response, ws, { action: "find", query: "PRICE", path: "src/pricing_ok.ts" });

    const files = outcome.body["files"] as Array<Record<string, unknown>> | undefined;
    const file = files!.find((f) => f["path"] === "src/pricing_ok.ts");
    expect(file!["served_this_session"], "a genuinely served path must still read true").toBe(true);
  });

  it("CONTROL: a doc-sliver serve (real bytes shipped, just not at the matched line) still keeps FILE-level served_this_session:true — this fix must not collapse it into the LINE-level lines_held check", () => {
    const ws = mkWorkspace("sliver");
    const TOTAL = 40;
    const MATCH_LINE = 10;
    const lines: string[] = [];
    for (let i = 1; i <= TOTAL; i++) lines.push(i === MATCH_LINE ? "needle_token here" : `filler ${i}`);
    writeFile(ws, "docs/BIG.md", lines.join("\n") + "\n");
    recordReadPath(ws, "docs/BIG.md");
    // Only the LAST line was ever put on the wire (a doc-sliver serve) — real
    // bytes shipped, none of them the matched line.
    recordServedRange(ws, "docs/BIG.md", "sha-sliver", TOTAL, TOTAL, TOTAL);

    const response = buildFindResponse({ query: "needle_token", path: "docs/BIG.md" }, ws);
    const outcome = applyServedFindProtocol(response, ws, { action: "find", query: "needle_token", path: "docs/BIG.md" });

    const files = outcome.body["files"] as Array<Record<string, unknown>> | undefined;
    const file = files!.find((f) => f["path"] === "docs/BIG.md");
    expect(file, JSON.stringify(outcome.body)).toBeDefined();
    expect(file!["served_this_session"], "file-level provenance IS true — a real, non-zero serve happened").toBe(true);
    expect(file!["lines_held"], "line-level residency is honestly false").toBe(false);
  });
});
