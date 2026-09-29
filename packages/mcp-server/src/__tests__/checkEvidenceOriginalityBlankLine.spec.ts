/**
 * checkEvidenceOriginalityBlankLine.spec.ts — round-2 evaluation finding P2-13.
 *
 * The wire convention (util/countLines.ts's `sliceLinesToText`, the shared range-serving primitive):
 * a served `body` is the claimed lines joined by "\n". A window whose LAST claimed line is itself
 * blank therefore naturally ends in "\n" — that "\n" is the separator before the blank line, not a
 * decorative extra. The ONE case with a genuinely EXTRA trailing "\n" is `sliceLinesToText`'s own
 * EOF-restoration rule: a range reaching the file's real last line, whose served last line is
 * NON-blank, gets the source file's own trailing newline re-appended.
 *
 * `checkEvidenceOriginality` used to unconditionally strip ONE trailing "\n" before splitting,
 * conflating the two cases: for a window ending on a genuinely blank line, that strip silently
 * swallowed the blank last line and flagged the item as fabricated (finding: "body for 71-120 (line
 * 120 blank) is 49 lines + '\n' ... the V07 checker flags 13 rows"). The fix narrows the strip to only
 * the EOF-restoration shape.
 */
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkEvidenceOriginality } from "./helpers/evaluation0927Scenarios.js";
import type { ChainResult, Hop } from "./helpers/qualityFirstScenarios.js";

const workspaceDirs = new Set<string>();

afterEach(() => {
  for (const dir of workspaceDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  workspaceDirs.clear();
});

function mkWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-v07bl-")));
  workspaceDirs.add(dir);
  return dir;
}

function chainOf(evidence: Array<Record<string, unknown>>): ChainResult {
  const hop: Hop = { hopIndex: 0, call: { tool: "read_file", arguments: {} }, response: { evidence }, textBytes: 0, nextSource: "none" };
  return { hops: [hop], final: hop.response, capped: false };
}

describe("checkEvidenceOriginality — blank-last-line windows (P2-13)", () => {
  it("a window ending on a genuinely blank line (mid-file, no EOF restoration) is not flagged", () => {
    const ws = mkWorkspace();
    const rel = "src/blank.ts";
    // Lines: 1..5 numbered, line 6 blank, 7..10 numbered, line 11 blank (EOF).
    const lines = ["line 1", "line 2", "line 3", "line 4", "line 5", "", "line 7", "line 8", "line 9", "line 10", ""];
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n");

    // range 4-6: lines "line 4", "line 5", "" — reaches neither EOF nor a
    // decorative extra newline; body is exactly those three lines joined.
    const body = ["line 4", "line 5", ""].join("\n");
    const chain = chainOf([{ path: rel, range: "4-6", body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("a window reaching the file's real EOF on a blank last line, wire body ends in exactly one '\\n', is not flagged", () => {
    const ws = mkWorkspace();
    const rel = "src/blank-eof.ts";
    const lines = ["line 1", "line 2", "line 3", "line 4", ""]; // 5 logical lines, last one blank
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n");

    // range 3-5 reaches the real EOF (5 lines total). Per sliceLinesToText,
    // since the last served line ("") is already blank, `joined` already
    // ends in "\n" and NO extra decorative newline is appended: the wire
    // body is exactly "line 3\nline 4\n" (three elements when split: "line
    // 3", "line 4", "").
    const body = ["line 3", "line 4", ""].join("\n");
    const chain = chainOf([{ path: rel, range: "3-5", body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("a window reaching real EOF on a NON-blank last line still tolerates sliceLinesToText's one decorative trailing newline", () => {
    const ws = mkWorkspace();
    const rel = "src/nonblank-eof.ts";
    const lines = ["line 1", "line 2", "line 3"]; // 3 logical lines, last one non-blank
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n");

    // range 2-3 reaches real EOF; sliceLinesToText restores the file's own
    // trailing newline since the served last line ("line 3") is non-blank:
    // wire body is "line 2\nline 3\n" (a genuinely EXTRA trailing "\n").
    const body = "line 2\nline 3\n";
    const chain = chainOf([{ path: rel, range: "2-3", body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("regression control: a body that fabricates a blank last line as non-blank is still flagged", () => {
    const ws = mkWorkspace();
    const rel = "src/blank-fab.ts";
    const lines = ["line 1", "line 2", ""];
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n");

    // range 1-3's real last line is blank, but this body invents content for it.
    const body = ["line 1", "line 2", "FABRICATED"].join("\n");
    const chain = chainOf([{ path: rel, range: "1-3", body }]);

    const violations = checkEvidenceOriginality(chain, ws, "t");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.firstDifferingLine).toBe(3);
  });

  it("regression control: dropping the genuinely blank last line entirely (short body, no remaining disclosed) is still flagged", () => {
    const ws = mkWorkspace();
    const rel = "src/blank-drop.ts";
    const lines = ["line 1", "line 2", ""];
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), lines.join("\n") + "\n");

    // Body claims range 1-3 but only ships 2 lines' worth of content with no
    // trailing "\n" at all and no `remaining` disclosure for line 3.
    const body = "line 1\nline 2";
    const chain = chainOf([{ path: rel, range: "1-3", body }]);

    const violations = checkEvidenceOriginality(chain, ws, "t");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("not verbatim source");
  });
});
