/**
 * evaluation0929.postEditWindow.spec.ts — V15-PEW (v0.15.0 mechanism,
 * USER-approved 2026-09-29; measure-v015/REPORT.md's PEW row).
 *
 * WHAT THIS PINS. `tl_edit_file` -> `edit.applied.applied[].after`: an additive
 * per-file WIDE post-edit window (±20 lines, extended to the enclosing symbol
 * when that fits, capped at 6 KiB/hunk and 16 KiB/response — the variant that
 * met the "read-backs not down >=50%" kill criterion at ±20, not ±5), sitting
 * beside — never replacing — the existing compact `code`/`head`/`slice_sha`
 * proof (server.ts's `attachAppliedReadback`, W2 "compact by default").
 *
 * Sections:
 *   1. single hunk — window present, byte-honest, old ±8 fields untouched.
 *   2. multiple hunks in one file — overlapping padded windows MERGE; distant
 *      ones stay separate and the non-primary one is named in `remaining`.
 *   3. multi-file batch — each file gets its own window.
 *   4. enclosing-symbol extension — widens past the ±20 pad when it fits.
 *   5. caps -> `remaining`, never a silent cut (per-hunk 6 KiB, per-response
 *      16 KiB, first-come-first-served across files like `code`'s own cap).
 *   6. served-range ledger booking — a later `tl_read_file`/`tl_edit_file` of the
 *      same lines this epoch finds them already served.
 *   7. ceiling-driven shed order — `after` is the first thing a caller/host
 *      byte ceiling cuts, never the kit/core (unit-level: `editSideEffect.ts`
 *      gives `edit.applied` ZERO shed rungs by design, so this is proven
 *      against the dedicated function, not smuggled onto that ladder).
 *   8. `edit.rolled_back`/`edit.state_unknown` never carry `after` — by TYPE
 *      (`RollbackFileState` has no such member) and re-proven at the
 *      projector against adversarial after-shaped noise.
 *   9. `target:"all"` multi-match still gets a window.
 *   10. archive/artifact edits are unaffected (no `lines`/`total_lines` shape
 *       for `attachAppliedReadback` to key on).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import JSZip from "jszip";

import { projectEditBody } from "../protocol/editFamily.js";
import { servedRangeReceipt } from "../state/session.js";
import { resetAll } from "../util/session.js";
import { handleTable, shaOfText } from "../util/handles.js";
import type { Kind } from "@tokenlighten/types";

type ToolResult = { content: Array<{ text: string }> };
type Body = Record<string, any>;

const workspaces: string[] = [];

function makeWorkspace(tag: string): string {
  const ws = mkdtempSync(join(homedir(), `.tl-e0929-pew-${tag}-`));
  workspaces.push(ws);
  return ws;
}

function writeSource(workspace: string, relPath: string, content: string): void {
  const abs = join(workspace, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function readSource(workspace: string, relPath: string): string {
  return readFileSync(join(workspace, relPath), "utf8");
}

function shaOfFile(workspace: string, relPath: string): string {
  return shaOfText(readSource(workspace, relPath));
}

function parseResult(result: ToolResult): Body {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("tool result carried no text");
  return JSON.parse(text) as Body;
}

/** N plain, independently-addressable lines: `export const L1 = 1;` .. `LN`. */
function plainLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `export const L${i + 1} = ${i + 1};`);
}

function plainFile(n: number): string {
  return plainLines(n).join("\n") + "\n";
}

function appliedEntries(body: Body): Body[] {
  return Array.isArray(body["applied"]) ? (body["applied"] as Body[]) : [];
}

function entryFor(body: Body, path: string): Body | undefined {
  return appliedEntries(body).find((entry) => entry["path"] === path);
}

function parseRange(range: string): { start: number; end: number } {
  const m = range.match(/^(\d+)-(\d+)$/);
  if (m === null) throw new Error(`not a plain "N-M" range: ${range}`);
  return { start: parseInt(m[1]!, 10), end: parseInt(m[2]!, 10) };
}

// ---------------------------------------------------------------------------
// Setup — ALLOW_WRITE is a module-level const server.ts reads once from
// process.argv at import time (same constraint routeByteMeasurement.spec.ts
// and artifactEditServerIntegration.spec.ts document): push the flag, THEN
// dynamically import, so this file's tl_edit_file calls are not write-refused.
// ---------------------------------------------------------------------------

let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
let shedPostEditWindowsToFit: (
  response: Record<string, unknown>,
  ceiling: number | undefined,
) => Record<string, unknown>;

// This file pins the ±20 / enclosing-symbol window TL_EFF_SLIM_EDIT=0
// restores (the default since 2026-10-01 is ±3; effFlags.spec.ts pins it).
const previousSlimEdit = process.env["TL_EFF_SLIM_EDIT"];

beforeAll(async () => {
  process.env["TL_EFF_SLIM_EDIT"] = "0";
  if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
  const server = await import("../server.js");
  callTool = server.callTool as typeof callTool;
  shedPostEditWindowsToFit = server.shedPostEditWindowsToFit as typeof shedPostEditWindowsToFit;
});

afterAll(() => {
  if (previousSlimEdit === undefined) delete process.env["TL_EFF_SLIM_EDIT"];
  else process.env["TL_EFF_SLIM_EDIT"] = previousSlimEdit;
});

afterEach(() => {
  resetAll();
  handleTable.reset();
  for (const ws of workspaces.splice(0)) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Single hunk.
// ---------------------------------------------------------------------------

describe("PEW 1: single hunk — after present, honest, additive to the ±8 proof", () => {
  it("carries a ±20 window around the edited line, and leaves range/code (±8) exactly as before", async () => {
    const ws = makeWorkspace("single");
    writeSource(ws, "src/plain.ts", plainFile(60));
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "src/plain.ts",
      search: "export const L30 = 30;",
      replace: "export const L30 = 999;",
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/plain.ts")!;
    // The pre-existing ±8 proof is UNCHANGED by this feature.
    expect(entry["range"]).toBe("22-38");
    expect(typeof entry["slice_sha"]).toBe("string");

    expect(entry["after"], JSON.stringify(entry)).toBeDefined();
    const after = entry["after"] as Body;
    expect(after["range"]).toBe("10-50");
    expect(after["body"]).toContain("L30 = 999;");
    expect(after["remaining"]).toBeUndefined();
    // Honest disk truth: the SAME sha `slice_sha` is bound to.
    const fileText = readSource(ws, "src/plain.ts");
    const { start, end } = parseRange(after["range"] as string);
    const expectedBody = fileText.split("\n").slice(start - 1, end).join("\n");
    expect(after["body"]).toBe(expectedBody);
  });

  it("RECALL CONTROL: a create keeps its own terminal proof and carries no `after` (the body IS what the caller just sent)", async () => {
    const ws = makeWorkspace("create");
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [{ path: "src/new.ts", create: true, content: "export const FRESH = 1;\n" }],
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/new.ts")!;
    expect(entry["after"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple hunks in one file — merge vs. remaining.
// ---------------------------------------------------------------------------

describe("PEW 2: several hunks in one file — overlapping windows merge, distant ones name each other in `remaining`", () => {
  it("two hunks close enough that their ±20 windows overlap collapse into ONE shown window covering both", async () => {
    const ws = makeWorkspace("merge-close");
    writeSource(ws, "src/plain.ts", plainFile(80));
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/plain.ts", search: "export const L10 = 10;", replace: "export const L10 = 910;" },
        { path: "src/plain.ts", search: "export const L35 = 35;", replace: "export const L35 = 935;" },
      ],
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/plain.ts")!;
    const after = entry["after"] as Body;
    expect(after, JSON.stringify(entry)).toBeDefined();
    expect(after["remaining"]).toBeUndefined();
    const { start, end } = parseRange(after["range"] as string);
    // Padded windows are [1,30] (line 10) and [15,55] (line 35): they
    // overlap (15<=30+1) and merge to their union.
    expect(start).toBe(1);
    expect(end).toBe(55);
    expect(after["body"]).toContain("L10 = 910;");
    expect(after["body"]).toContain("L35 = 935;");
  });

  it("two hunks far enough apart keep separate windows: the primary anchors the chain's final span, the other rides `remaining`", async () => {
    const ws = makeWorkspace("merge-far");
    writeSource(ws, "src/plain.ts", plainFile(200));
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/plain.ts", search: "export const L10 = 10;", replace: "export const L10 = 910;" },
        { path: "src/plain.ts", search: "export const L150 = 150;", replace: "export const L150 = 9150;" },
      ],
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/plain.ts")!;
    // The chain's own final span (`range`/`lines`, ±8) anchors on the LAST
    // hunk (line 150) — applyEditsMulti.ts's documented merge behaviour.
    expect(entry["range"]).toBe("142-158");
    const after = entry["after"] as Body;
    expect(after, JSON.stringify(entry)).toBeDefined();
    const { start, end } = parseRange(after["range"] as string);
    expect(start).toBe(130);
    expect(end).toBe(170);
    expect(after["body"]).toContain("L150 = 9150;");
    expect(after["body"]).not.toContain("L10 = 910;");
    // The far hunk is NAMED, not silently dropped.
    expect(after["remaining"]).toEqual(["1-30"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-file batch.
// ---------------------------------------------------------------------------

describe("PEW 3: multi-file batch — every file gets its own window", () => {
  it("edits[] across two files: both applied[] entries carry after", async () => {
    const ws = makeWorkspace("multifile");
    writeSource(ws, "src/a.ts", plainFile(50));
    writeSource(ws, "src/b.ts", plainFile(50));
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/a.ts", search: "export const L5 = 5;", replace: "export const L5 = 505;" },
        { path: "src/b.ts", search: "export const L40 = 40;", replace: "export const L40 = 4040;" },
      ],
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const a = entryFor(res, "src/a.ts")!;
    const b = entryFor(res, "src/b.ts")!;
    expect((a["after"] as Body)?.["body"]).toContain("L5 = 505;");
    expect((b["after"] as Body)?.["body"]).toContain("L40 = 4040;");
  });
});

// ---------------------------------------------------------------------------
// 4. Enclosing-symbol extension.
// ---------------------------------------------------------------------------

describe("PEW 4: enclosing-symbol extension — widens past ±20 when the whole symbol still fits the per-hunk cap", () => {
  it("an edit deep inside a function wider than the ±20 pad gets the WHOLE function, not just the pad", async () => {
    const ws = makeWorkspace("enclosing");
    const branchCount = 50;
    const lines: string[] = ["export function useLimit(status: number, tries: number): boolean {"];
    for (let i = 0; i < branchCount; i++) {
      lines.push(`  if (status === ${2000 + i} && tries > ${i % 7}) { return status > tries; }`);
    }
    lines.push("  return false;");
    lines.push("}");
    const functionEndLine = lines.length; // "}" — the last line of the function
    lines.push("export const DONE = true;"); // forces the extractor's endLine estimate to stop at the "}" above, not EOF
    writeSource(ws, "src/wide.ts", lines.join("\n") + "\n");

    const editIndex = 25; // a middle branch, well inside the function
    const targetLine = lines[editIndex]!;
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "src/wide.ts",
      search: targetLine,
      replace: targetLine.replace("return status > tries;", "return status >= tries;"),
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/wide.ts")!;
    const after = entry["after"] as Body;
    expect(after, JSON.stringify(entry)).toBeDefined();
    expect(after["range"]).toBe(`1-${functionEndLine}`);
    expect(after["body"]).toContain("export function useLimit");
    expect(after["body"]).toContain("return false;");
    // The trailing declaration OUTSIDE the function must not ride along —
    // proves this is the SYMBOL's span, not an accidental whole-file serve.
    expect(after["body"]).not.toContain("DONE");
  });
});

// ---------------------------------------------------------------------------
// 5. Caps -> remaining, never a silent cut.
// ---------------------------------------------------------------------------

describe("PEW 5: per-hunk and per-response caps shed to `remaining`, never silently", () => {
  it("a window whose own text exceeds the 6 KiB per-hunk cap ships a byte-bounded prefix and names the cut tail", async () => {
    const ws = makeWorkspace("cap-entry");
    // 200-byte-ish lines so the ±20/41-line window comfortably exceeds 6 KiB.
    const wide = (i: number) => `  const fixtureLine${i} = "${"pad".repeat(60)}"; // line ${i}`;
    const lines = Array.from({ length: 120 }, (_, i) => wide(i + 1));
    lines[59] = 'export const TARGET = "before";';
    writeSource(ws, "src/cap.ts", lines.join("\n") + "\n");
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "src/cap.ts",
      search: 'export const TARGET = "before";',
      replace: 'export const TARGET = "after-edit";',
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/cap.ts")!;
    const after = entry["after"] as Body;
    expect(after, JSON.stringify(entry)).toBeDefined();
    expect(Buffer.byteLength(after["body"] as string, "utf8")).toBeLessThanOrEqual(6 * 1024);
    expect(after["remaining"]).toBeDefined();
    const { end: shownEnd } = parseRange(after["range"] as string);
    const [firstRemaining] = after["remaining"] as string[];
    expect(parseRange(firstRemaining!).start).toBe(shownEnd + 1);
  });

  it("the 16 KiB per-response total sheds LATER files first-come-first-served, same rule `code`'s own cap already applies", async () => {
    const ws = makeWorkspace("cap-total");
    const wide = (i: number) => `  const fixtureLine${i} = "${"pad".repeat(60)}";`;
    const fileNames = ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"];
    const edits: Array<Record<string, unknown>> = [];
    for (const name of fileNames) {
      const lines = Array.from({ length: 120 }, (_, i) => wide(i + 1));
      lines[59] = `export const TARGET_${name} = "before";`;
      writeSource(ws, name, lines.join("\n") + "\n");
      edits.push({
        path: name,
        search: `export const TARGET_${name} = "before";`,
        replace: `export const TARGET_${name} = "after";`,
      });
    }
    const res = parseResult(await callTool("tl_edit_file", { cwd: ws, edits }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    let totalAfterBytes = 0;
    for (const name of fileNames) {
      const after = entryFor(res, name)?.["after"] as Body | undefined;
      if (after !== undefined) totalAfterBytes += Buffer.byteLength(after["body"] as string, "utf8");
    }
    expect(totalAfterBytes).toBeLessThanOrEqual(16 * 1024);
    // At least the LAST file's window was reduced or dropped relative to the
    // first's — the shed order is first-come-first-served across files.
    const firstAfter = entryFor(res, fileNames[0]!)?.["after"] as Body | undefined;
    const lastAfter = entryFor(res, fileNames[fileNames.length - 1]!)?.["after"] as Body | undefined;
    const firstBytes = firstAfter !== undefined ? Buffer.byteLength(firstAfter["body"] as string, "utf8") : 0;
    const lastBytes = lastAfter !== undefined ? Buffer.byteLength(lastAfter["body"] as string, "utf8") : 0;
    expect(lastBytes).toBeLessThanOrEqual(firstBytes);
  });
});

// ---------------------------------------------------------------------------
// 6. Served-range ledger booking.
// ---------------------------------------------------------------------------

describe("PEW 6: the after window is booked in the served-range ledger exactly like a read", () => {
  it("servedRangeReceipt finds the after window's exact span already served, sha-bound to the post-edit file", async () => {
    const ws = makeWorkspace("ledger");
    writeSource(ws, "src/plain.ts", plainFile(60));
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "src/plain.ts",
      search: "export const L30 = 30;",
      replace: "export const L30 = 999;",
    }));
    const entry = entryFor(res, "src/plain.ts")!;
    const after = entry["after"] as Body;
    const { start, end } = parseRange(after["range"] as string);
    const sha = shaOfFile(ws, "src/plain.ts");
    const totalLines = readSource(ws, "src/plain.ts").split("\n").length;
    const receipt = servedRangeReceipt(ws, "src/plain.ts", sha, start, end, totalLines);
    expect(receipt, "the after window must already be in the served-range ledger").toBeDefined();
  });

  it("a follow-up tl_read_file of the same lines this epoch answers a receipt, not a fresh body", async () => {
    const ws = makeWorkspace("ledger-read");
    writeSource(ws, "src/plain.ts", plainFile(60));
    const editRes = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "src/plain.ts",
      search: "export const L30 = 30;",
      replace: "export const L30 = 999;",
    }));
    const after = entryFor(editRes, "src/plain.ts")!["after"] as Body;
    const { start, end } = parseRange(after["range"] as string);
    process.env["TL_RECEIPT_COVERAGE"] = "1";
    try {
      const readRes = parseResult(await callTool("tl_read_file", {
        cwd: ws,
        mode: "slice",
        path: "src/plain.ts",
        range: `${start}-${end}`,
      }));
      expect(readRes["kind"], JSON.stringify(readRes)).toBe("read.receipt");
    } finally {
      delete process.env["TL_RECEIPT_COVERAGE"];
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Ceiling-driven shed order (unit-level: shedPostEditWindowsToFit itself).
// ---------------------------------------------------------------------------

describe("PEW 7: under a byte ceiling, `after` sheds before anything editSideEffect.ts protects", () => {
  function fakeAppliedResponse(afterBodyBytes: number): Record<string, unknown> {
    return {
      v: 1,
      kind: "edit.applied",
      core: {
        counts: { applied: 1, attempted: 1, reverted: 0, unproven: 0 },
        paths: ["src/big.ts"],
        workspace: { fingerprint: "sha256:aaaa", scope: "served-evidence", evidence_files: 1, inventory_files: 0, inventory_complete: false },
      },
      applied: [{
        path: "src/big.ts",
        range: "1-500",
        slice_sha: "sha256:bbbb",
        after: { range: "1-500", body: "L".repeat(afterBodyBytes) },
      }],
      // Stands in for the verification kit — never touched by the shed.
      verification: { surfaces: [{ path: "src/big.ts.test.ts", role: "test", code: "K".repeat(2000) }] },
    };
  }

  it("no ceiling declared: unchanged (the local caps already bound `after`)", () => {
    const response = fakeAppliedResponse(4000);
    expect(shedPostEditWindowsToFit(response, undefined)).toBe(response);
  });

  it("already under ceiling: unchanged", () => {
    const response = fakeAppliedResponse(200);
    const result = shedPostEditWindowsToFit(response, 100_000);
    expect(result).toEqual(response);
  });

  it("over ceiling: `after` shrinks first, verification kit and core survive untouched", () => {
    const response = fakeAppliedResponse(8000);
    const ceiling = 4000; // well under this response's ~10 KB unshed size
    const result = shedPostEditWindowsToFit(response, ceiling);
    expect(result["verification"]).toEqual(response["verification"]);
    expect(result["core"]).toEqual(response["core"]);
    const shedEntry = (result["applied"] as Body[])[0]!;
    const after = shedEntry["after"] as Body | undefined;
    if (after !== undefined) {
      expect((after["body"] as string).length).toBeLessThan(8000);
      expect(after["remaining"]).toBeDefined();
    }
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(response), "utf8"),
    );
  });

  it("ceiling so tight even the kit alone exceeds it: `after` is dropped entirely, but the kit is still never touched (honest, not a global guarantee)", () => {
    const response = fakeAppliedResponse(500);
    const ceiling = 50; // smaller than `verification` alone — cannot be met by shedding `after`
    const result = shedPostEditWindowsToFit(response, ceiling);
    expect(result["verification"]).toEqual(response["verification"]);
    const shedEntry = (result["applied"] as Body[])[0]!;
    expect(shedEntry).not.toHaveProperty("after");
  });
});

// ---------------------------------------------------------------------------
// 8. edit.rolled_back / edit.state_unknown never carry `after`.
// ---------------------------------------------------------------------------

describe("PEW 8: edit.rolled_back / edit.state_unknown never carry `after`", () => {
  it("edit.rolled_back's projection drops adversarial after-shaped noise at every level", () => {
    const body: Record<string, unknown> = {
      ok: false,
      code: "rollback-failed",
      rollback: [
        {
          path: "src/a.ts",
          state: "rolled-back",
          expected_sha: "sha256:aaaa",
          // Adversarial: nothing in RollbackFileState declares `after`.
          after: { range: "1-5", body: "MUST NOT APPEAR" },
        },
      ],
      recovery: "reverted src/a.ts",
      after: { range: "1-1", body: "MUST NOT APPEAR EITHER" },
    };
    const projected = projectEditBody("edit.rolled_back" as Kind, body, "/ws");
    expect(JSON.stringify(projected)).not.toContain("MUST NOT APPEAR");
    const attempted = projected["attempted"] as Array<Record<string, unknown>>;
    expect(attempted[0]).not.toHaveProperty("after");
  });

  it("edit.state_unknown's projection drops the same adversarial noise", () => {
    const body: Record<string, unknown> = {
      ok: false,
      workspace_state: "workspace-state-unknown",
      rollback: [
        { path: "src/a.ts", state: "restore-failed", stuck_sha: "sha256:cccc", after: { range: "1-5", body: "MUST NOT APPEAR" } },
      ],
      recovery: "manual repair needed",
      after: { range: "1-1", body: "MUST NOT APPEAR EITHER" },
    };
    const projected = projectEditBody("edit.state_unknown" as Kind, body, "/ws");
    expect(JSON.stringify(projected)).not.toContain("MUST NOT APPEAR");
    const affected = projected["affected"] as Array<Record<string, unknown>>;
    expect(affected[0]).not.toHaveProperty("after");
  });
});

// ---------------------------------------------------------------------------
// 9. target:"all" multi-match.
// ---------------------------------------------------------------------------

describe("PEW 9: target:\"all\" multi-match still gets a post-edit window", () => {
  it("a replace-all edit carries BOTH `replaced` and `after`", async () => {
    const ws = makeWorkspace("target-all");
    const content = Array.from({ length: 20 }, () => 'console.log("DUP");').join("\n") + "\n";
    writeSource(ws, "src/dup.ts", content);
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [{ path: "src/dup.ts", search: 'console.log("DUP");', replace: 'console.log("REPLACED");', target: "all" }],
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    const entry = entryFor(res, "src/dup.ts")!;
    expect(entry["replaced"]).toBe(20);
    expect(entry["after"], JSON.stringify(entry)).toBeDefined();
    expect((entry["after"] as Body)["body"]).toContain("REPLACED");
  });
});

// ---------------------------------------------------------------------------
// 10. Archive/artifact edits unaffected.
// ---------------------------------------------------------------------------

describe("PEW 10: archive/artifact edits carry no `after` anywhere", () => {
  it("a zip member replace has no lines/total_lines shape for attachAppliedReadback to key on, so no after rides the response", async () => {
    const ws = makeWorkspace("zip");
    type TestZip = { file(name: string, content: string): unknown; generateAsync(o: { type: "nodebuffer" }): Promise<Buffer> };
    const zip = new JSZip() as unknown as TestZip;
    zip.file("readme.txt", "hello world\n");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(join(ws, "bundle.zip"), bytes);
    const res = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      path: "bundle.zip",
      artifact: { kind: "zip", members: [{ action: "replace", member: "readme.txt", content: "goodbye world\n" }] },
    }));
    expect(res["kind"], JSON.stringify(res)).toBe("edit.applied");
    expect(JSON.stringify(res)).not.toContain('"after"');
  });
});
