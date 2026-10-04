/**
 * evaluation0929.pewCeilingBooking.spec.ts — R2-PEW (eval-0929 round 2,
 * 2026-09-30): the served-range ledger books EXACTLY the post-edit bytes that
 * shipped.
 *
 * THE DEFECT (review P0-1). `attachAppliedReadback` booked the wide post-edit
 * window (`applied[].after`, ledger mode `edit-after`) BEFORE
 * `shedPostEditWindowsToFit` — the byte-ceiling shed a host/user ceiling
 * (`TOKENLIGHTEN_CLIENT_ID=vscode` -> 14336, or `TOKENLIGHTEN_TASK_PACK_MAX_BYTES`)
 * runs in `finishEdit` — shrank or dropped that window. The shed is not a ladder
 * rung, so the settlement widened the corroborated (shrunk) window back to the
 * booked extent, and a later `tl_read_file` of lines that never left the server was
 * answered `read.receipt {served_by:"edit-after 42-82"}`. Booking now happens
 * from the FINAL response (`bookShippedPostEditWindows`).
 *
 * Same function family, fixed with it:
 *   - P2-a  `after.range` (and the ledger total booked with it) named the phantom
 *           line past a file's final newline ("1-14" on a 13-line file). The compact
 *           ±8 proof's own `applied[].range` has the same off-by-one in v0.14.4 and
 *           is deliberately left as it was — other specs pin it.
 *   - P2-b  a bottom-to-top multi-hunk batch whose lower hunk repeats an earlier
 *           line got no window and no name for the real hunk.
 *   - P2-k  the ceiling shed measured the RAW result (every `applied[].code` echo,
 *           the `files` rows) instead of the wire form, and dropped whole windows
 *           from a response that was thousands of bytes under the ceiling.
 *
 * Sections:
 *   1. ledger exactness — for every scenario (the task's ceilings 14336 / 8192 x
 *      1-4 files, plus a tight ceiling, an unknown-client env ceiling, a ceiling
 *      below the response's own base, and the no-ceiling control), line by line,
 *      `servedRangeReceipt` answers iff the line is inside a window that is on
 *      the response.
 *   2. the same claim as a caller sees it — a read of a never-shown line returns
 *      bytes (never a receipt), a read of a shown range returns a receipt.
 *   2b. the same invariants across eight language shapes and through a handle.
 *   3. exact-fit shedding (P2-k) — the ceiling is honoured, nothing is cut that
 *      did not have to be, and the wire form (not the raw result) is measured.
 *   4. phantom line (P2-a).
 *   5. multi-hunk locate (P2-b) — every hunk is shown or named: bottom-to-top and
 *      repeated blocks, partial-line replacements, CRLF, `target:"all"`, a block
 *      too common to name, and the entry-cap guard that keeps the last hunk's
 *      window shown when two windows would merge past the cap.
 *   6. `shedPostEditWindowsToFit` unit contract (exact-fit, order, identity).
 *
 * Mutation check (recorded 2026-09-30): with the pre-fix booking restored (book
 * at attach time, no post-shed booking) 23 of the first 70 tests here fail — every
 * scenario in which a window was shrunk (sections 1 and 2) — and pass with the
 * fix; the dropped-window scenario passes either way (the funnel's settlement
 * always retracted a booking whose window carried nothing).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { servedRangeReceipt } from "../state/session.js";
import { resetAll } from "../util/session.js";
import { handleTable, shaOfText } from "../util/handles.js";
import { sliceLinesToText } from "../util/countLines.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

type ToolResult = { content: Array<{ text: string }> };
type Body = Record<string, any>;

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = shortTmpDir(homedir(), ".tl-e0929-pewcb-");
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

function parseResult(result: ToolResult): { body: Body; bytes: number } {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("tool result carried no text");
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

function parseRange(range: string): { start: number; end: number } {
  const m = range.match(/^(\d+)-(\d+)$/);
  if (m === null) throw new Error(`not a plain "N-M" range: ${range}`);
  return { start: parseInt(m[1]!, 10), end: parseInt(m[2]!, 10) };
}

// ---------------------------------------------------------------------------
// Setup — ALLOW_WRITE is a module-level const server.ts reads once from
// process.argv at import time (same constraint evaluation0929.postEditWindow
// documents): push the flag, THEN dynamically import.
// ---------------------------------------------------------------------------

let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
let shedPostEditWindowsToFit: (
  response: Record<string, unknown>,
  ceiling: number | undefined,
  wireView?: (candidate: Record<string, unknown>) => unknown,
) => Record<string, unknown>;

// This file pins the ±20 / enclosing-symbol window and its ceiling sheds,
// which TL_EFF_SLIM_EDIT=0 restores (the default since 2026-10-01 is ±3, too
// narrow to shed; effFlags.spec.ts pins that side).
const previousSlimEdit = process.env["TL_EFF_SLIM_EDIT"];

beforeAll(async () => {
  process.env["TL_EFF_SLIM_EDIT"] = "0";
  if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
  const server = await import("../server.js");
  callTool = server.callTool as typeof callTool;
  shedPostEditWindowsToFit = server.shedPostEditWindowsToFit as typeof shedPostEditWindowsToFit;
});

afterEach(() => {
  resetAll();
  handleTable.reset();
});

afterAll(() => {
  if (previousSlimEdit === undefined) delete process.env["TL_EFF_SLIM_EDIT"];
  else process.env["TL_EFF_SLIM_EDIT"] = previousSlimEdit;
  for (const ws of workspaces.splice(0)) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Run `fn` with `overrides` applied to process.env (`undefined` deletes the key), restored afterwards. */
async function withEnv<T>(overrides: Readonly<Record<string, string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures. A "padded function": line 1 is the header, step `i` sits at line
// `i + 2`, then `  return x;` and `}` (n + 3 lines, one final newline). The
// edit at step60 (line 62) gets the ±20 window 42-82 = 41 lines ~ 4.3 KiB.
// ---------------------------------------------------------------------------

const PAD = "y".repeat(60);

function paddedFn(n: number, name: string, pad: string = PAD): string {
  const lines = [`export function ${name}(x: number): number {`];
  for (let i = 0; i < n; i++) lines.push(`  const step${i} = x + ${i}; // padding line ${i} ${pad}`);
  lines.push("  return x;", "}");
  return lines.join("\n") + "\n";
}

const FN_LINES = 120 + 3;
const NAMES = ["a", "b", "c", "d"] as const;

/** The text every probe looks for in a served body: the unique marker of file line `line` (1 < line < n + 2). */
function markerOfLine(line: number): string {
  return `const step${line - 2} = `;
}

function bodiesOf(read: Body): string {
  return ((read["evidence"] as Body[] | undefined) ?? []).map((e) => (typeof e["body"] === "string" ? e["body"] : "")).join("\n");
}

interface Run {
  ws: string;
  res: Body;
  bytes: number;
  applied: Body[];
}

/** One edit per file (step60 -> step600) against fresh padded functions. */
async function editFiles(count: number, env: Readonly<Record<string, string | undefined>>): Promise<Run> {
  const ws = makeWorkspace();
  writeSource(ws, "package.json", "{\"name\":\"x\",\"type\":\"module\"}\n");
  const edits: Array<Record<string, unknown>> = [];
  for (const name of NAMES.slice(0, count)) {
    writeSource(ws, `src/${name}.ts`, paddedFn(120, `fn_${name}`));
    edits.push({ path: `src/${name}.ts`, search: "  const step60 = x + 60;", replace: "  const step60 = x + 600;" });
  }
  const { body, bytes } = parseResult(await withEnv(env, () => callTool("tl_edit_file", { cwd: ws, edits })));
  expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("edit.applied");
  return { ws, res: body, bytes, applied: (body["applied"] as Body[] | undefined) ?? [] };
}

async function readRange(ws: string, path: string, range: string): Promise<Body> {
  return parseResult(await callTool("tl_read_file", { cwd: ws, targets: [{ path, range }], content: "full" })).body;
}

/** The lines a response's `applied[].after` windows say they carry, per path. */
function shownLinesOf(applied: readonly Body[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const entry of applied) {
    const lines = new Set<number>();
    const after = entry["after"] as Body | undefined;
    if (after !== undefined) {
      const { start, end } = parseRange(after["range"] as string);
      for (let l = start; l <= end; l++) lines.add(l);
    }
    out.set(entry["path"] as string, lines);
  }
  return out;
}

/** Ledger truth, line by line: does `servedRangeReceipt` claim `line` of `path` right now? */
function ledgerClaims(ws: string, path: string, line: number): boolean {
  const text = readSource(ws, path);
  const total = text.replace(/\n$/, "").split("\n").length;
  return servedRangeReceipt(ws, path, shaOfText(text), line, line, total) !== undefined;
}

// ---------------------------------------------------------------------------
// Scenarios: a byte ceiling (or none) x a number of edited files.
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  files: number;
  env: Readonly<Record<string, string | undefined>>;
  /** What the shed is expected to have done to at least one window ("any": whatever fits, the invariants hold either way). */
  expect: "shrunk" | "dropped-all" | "any";
}

const VSCODE = { TOKENLIGHTEN_CLIENT_ID: "vscode", TOKENLIGHTEN_TASK_PACK_MAX_BYTES: undefined } as const;
const NO_CEILING = { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: undefined } as const;

/** The task's matrix: the VS Code default ceiling (14336) and a user-tuned 8192, over one to four edited files. */
const MATRIX: readonly Scenario[] = [1, 2, 3, 4].flatMap((files): Scenario[] => [
  {
    label: `VS Code default ceiling 14336, ${files} file(s)`,
    files,
    env: VSCODE,
    expect: files >= 3 ? "shrunk" : "any",
  },
  {
    label: `TOKENLIGHTEN_TASK_PACK_MAX_BYTES=8192 (VS Code), ${files} file(s)`,
    files,
    env: { TOKENLIGHTEN_CLIENT_ID: "vscode", TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "8192" },
    expect: files >= 2 ? "shrunk" : "any",
  },
]);

const SCENARIOS: readonly Scenario[] = [
  ...MATRIX,
  { label: "TOKENLIGHTEN_TASK_PACK_MAX_BYTES=8192 alone (unknown client), 3 files", files: 3, env: { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "8192" }, expect: "shrunk" },
  { label: "TOKENLIGHTEN_TASK_PACK_MAX_BYTES=3000, 3 files (little room: windows shrink to a few lines or drop)", files: 3, env: { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "3000" }, expect: "shrunk" },
  { label: "TOKENLIGHTEN_TASK_PACK_MAX_BYTES=500, 2 files (below the response without any window: every window dropped)", files: 2, env: { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "500" }, expect: "dropped-all" },
  { label: "CONTROL: no ceiling, 4 files (only the 16 KiB attach cap applies)", files: 4, env: NO_CEILING, expect: "any" },
];

// ---------------------------------------------------------------------------
// 1. Ledger exactness.
// ---------------------------------------------------------------------------

describe("R2-PEW 1: the ledger claims exactly the lines a window on the response carries", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.label, async () => {
      const run = await editFiles(scenario.files, scenario.env);
      const shown = shownLinesOf(run.applied);
      expect(run.applied.length, JSON.stringify(run.res).slice(0, 300)).toBe(scenario.files);

      // The scenario really exercised what it is named for.
      const windows = run.applied.map((entry) => entry["after"] as Body | undefined);
      if (scenario.expect === "dropped-all") {
        expect(windows.every((w) => w === undefined), "every window is dropped").toBe(true);
      } else if (scenario.expect === "shrunk") {
        const cut = windows.filter((w) => w === undefined || w["remaining"] !== undefined);
        expect(cut.length, "at least one window was shrunk or dropped by the ceiling").toBeGreaterThan(0);
      }

      for (const entry of run.applied) {
        const path = entry["path"] as string;
        const lines = shown.get(path)!;
        for (let line = 1; line <= FN_LINES; line++) {
          expect(
            ledgerClaims(run.ws, path, line),
            `${scenario.label}: ${path} line ${line} — window ${(entry["after"] as Body | undefined)?.["range"] ?? "(none)"}`,
          ).toBe(lines.has(line));
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The same claim through the read door.
// ---------------------------------------------------------------------------

describe("R2-PEW 2: a read of a never-shown line returns bytes, a read of a shown range returns a receipt", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.label}: every named/cut range is served as bytes`, async () => {
      const run = await editFiles(scenario.files, scenario.env);
      let probed = 0;
      for (const entry of run.applied) {
        const path = entry["path"] as string;
        const after = entry["after"] as Body | undefined;
        // Ranges this response did NOT put on the wire: everything a cut named,
        // or — with the window dropped whole — the region it would have covered.
        const unshown = after === undefined ? ["45-50"] : ((after["remaining"] as string[] | undefined) ?? []);
        for (const range of unshown) {
          const read = await readRange(run.ws, path, range);
          const { start, end } = parseRange(range);
          expect(read["kind"], `${path} ${range}: ${JSON.stringify(read).slice(0, 300)}`).not.toBe("read.receipt");
          for (const line of [start, end]) {
            // The last two lines of a function are `  return x;` / `}` — no unique marker; probe step lines only.
            if (line >= 2 && line <= 121) expect(bodiesOf(read), `${path} ${range} must carry line ${line}`).toContain(markerOfLine(line));
          }
          probed += 1;
        }
      }
      if (scenario.expect !== "any") expect(probed).toBeGreaterThan(0);
    });

    it(`${scenario.label}: a straddling read serves the never-shown lines as bytes`, async () => {
      const run = await editFiles(scenario.files, scenario.env);
      for (const entry of run.applied) {
        const path = entry["path"] as string;
        const after = entry["after"] as Body | undefined;
        if (after === undefined) continue;
        const { end: shownTo } = parseRange(after["range"] as string);
        const remaining = (after["remaining"] as string[] | undefined) ?? [];
        if (remaining.length === 0) continue;
        // Straddle the boundary between the last shown line and the first cut one.
        const firstCut = parseRange(remaining[0]!).start;
        if (firstCut !== shownTo + 1) continue;
        const read = await readRange(run.ws, path, `${shownTo - 1}-${firstCut + 1}`);
        expect(read["kind"], `${path}: ${JSON.stringify(read).slice(0, 300)}`).not.toBe("read.receipt");
        expect(bodiesOf(read)).toContain(markerOfLine(firstCut));
        expect(bodiesOf(read)).toContain(markerOfLine(firstCut + 1));
      }
    });

    it(`${scenario.label}: every shown window is a receipt`, async () => {
      const run = await editFiles(scenario.files, scenario.env);
      for (const entry of run.applied) {
        const after = entry["after"] as Body | undefined;
        if (after === undefined) continue;
        const read = await readRange(run.ws, entry["path"] as string, after["range"] as string);
        expect(read["kind"], `${entry["path"]} ${after["range"]}: ${JSON.stringify(read).slice(0, 300)}`).toBe("read.receipt");
        expect(String(read["receipt"]?.["served_by"])).toMatch(/^edit-after \d+-\d+ \(call #\d+\)$/);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2b. The same invariants across languages, and through a handle.
// ---------------------------------------------------------------------------

describe("R2-PEW 2b: the invariants hold for every language shape and for a handle-driven edit", () => {
  const stepLine = (lang: string, i: number): string => {
    switch (lang) {
      case "py": return `    step${i} = x + ${i}  # padding line ${i} ${PAD}`;
      case "go": return `\tstep${i} := x + ${i} // padding line ${i} ${PAD}`;
      case "java": return `    int step${i} = x + ${i}; // padding line ${i} ${PAD}`;
      case "rs": return `    let step${i} = x + ${i}; // padding line ${i} ${PAD}`;
      case "cs": return `        var step${i} = x + ${i}; // padding line ${i} ${PAD}`;
      case "kt": return `    val step${i} = x + ${i} // padding line ${i} ${PAD}`;
      case "cpp": return `  int step${i} = x + ${i}; // padding line ${i} ${PAD}`;
      default: return `  const step${i} = x + ${i}; // padding line ${i} ${PAD}`;
    }
  };
  const wrap = (lang: string, steps: string[]): string[] => {
    switch (lang) {
      case "py": return ["def compute(x):", ...steps, "    return x"];
      case "go": return ["package p", "", "func Compute(x int) int {", ...steps, "\treturn x", "}"];
      case "java": return ["public class Compute {", "  public int compute(int x) {", ...steps, "    return x;", "  }", "}"];
      case "rs": return ["pub fn compute(x: i32) -> i32 {", ...steps, "    x", "}"];
      case "cs": return ["public class Compute {", "    public int Run(int x) {", ...steps, "        return x;", "    }", "}"];
      case "kt": return ["fun compute(x: Int): Int {", ...steps, "    return x", "}"];
      case "cpp": return ["int compute(int x) {", ...steps, "  return x;", "}"];
      default: return ["export function compute(x: number): number {", ...steps, "  return x;", "}"];
    }
  };
  const LANGS: ReadonlyArray<[string, string]> = [["ts", "ts"], ["py", "py"], ["go", "go"], ["java", "java"], ["rs", "rs"], ["cs", "cs"], ["kt", "kt"], ["cpp", "cpp"]];
  const CEILING = { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "3200" } as const;

  for (const [lang, ext] of LANGS) {
    it(`${lang}: a single-file edit under a tight ceiling — the ledger claims exactly the shipped lines, the cut tail reads as bytes`, async () => {
      const ws = makeWorkspace();
      const file = `src/compute.${ext}`;
      const steps = Array.from({ length: 120 }, (_, i) => stepLine(lang, i));
      writeSource(ws, file, wrap(lang, steps).join("\n") + "\n");
      const { body, bytes } = parseResult(await withEnv(CEILING, () => callTool("tl_edit_file", {
        cwd: ws,
        edits: [{ path: file, search: "padding line 60 ", replace: "padding line 60 EDITED " }],
      })));
      expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
      expect(bytes).toBeLessThanOrEqual(3200);
      const after = (body["applied"] as Body[])[0]!["after"] as Body | undefined;
      expect(after, "a 3200-byte ceiling leaves room for a partial window").toBeDefined();
      expect(after!["remaining"], "the window was cut, its tail is named").toBeDefined();
      const shown = parseRange(after!["range"] as string);
      const total = readSource(ws, file).replace(/\n$/, "").split("\n").length;
      for (let line = 1; line <= total; line++) {
        expect(ledgerClaims(ws, file, line), `${lang} line ${line} (window ${after!["range"]})`).toBe(line >= shown.start && line <= shown.end);
      }
      const cut = parseRange((after!["remaining"] as string[])[0]!);
      const read = await readRange(ws, file, `${cut.start}-${cut.end}`);
      expect(read["kind"]).not.toBe("read.receipt");
      expect(bodiesOf(read)).toContain(readSource(ws, file).split("\n")[cut.start - 1]!);
    });
  }

  it("a handle-driven edit (symbol handle minted by a read) under a tight ceiling: same invariants, and the handle stays valid", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "package.json", "{\"name\":\"x\",\"type\":\"module\"}\n");
    writeSource(ws, "src/compute.ts", paddedFn(120, "compute"));
    const mint = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: "src/compute.ts", symbol: "compute" })).body;
    const handle = String(mint["evidence"]?.[0]?.["handle"]);
    expect(handle).toMatch(/^h[0-9a-z]+$/);
    const { body, bytes } = parseResult(await withEnv({ TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "3200" }, () => callTool("tl_edit_file", {
      cwd: ws, handle, search: "  const step60 = x + 60;", replace: "  const step60 = x + 600;",
    })));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    expect(bytes).toBeLessThanOrEqual(3200);
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    const shown = parseRange(after["range"] as string);
    for (let line = 1; line <= FN_LINES; line++) expect(ledgerClaims(ws, "src/compute.ts", line), `line ${line}`).toBe(line >= shown.start && line <= shown.end);
    // the H4 chain still holds: the handle addresses the post-edit bytes.
    const follow = parseResult(await callTool("tl_edit_file", { cwd: ws, handle, search: "  const step60 = x + 600;", replace: "  const step60 = x + 6000;" })).body;
    expect(follow["kind"], JSON.stringify(follow).slice(0, 300)).toBe("edit.applied");
  });
});

// ---------------------------------------------------------------------------
// 3. Exact-fit shedding (P2-k).
// ---------------------------------------------------------------------------

describe("R2-PEW 3: the ceiling is measured on the wire, and a window is cut only as far as it must be", () => {
  it("VS Code 14336, 3 files: the response fits, no window is dropped, and the cut is a few lines — not 4.7 KB of over-shedding", async () => {
    const run = await editFiles(3, VSCODE);
    const ceiling = 14336;
    expect(run.bytes).toBeLessThanOrEqual(ceiling);
    // One padded line is ~140 bytes on the wire: an exact-fit cut leaves the
    // response within about a line of the ceiling. The over-shedding this
    // replaces left it 4.7 KB under.
    expect(run.bytes, `response ${run.bytes} B is far under the ${ceiling} ceiling`).toBeGreaterThan(ceiling - 400);
    for (const entry of run.applied) {
      const after = entry["after"] as Body | undefined;
      expect(after, `${entry["path"]} lost its whole window although the response fits with most of it`).toBeDefined();
      const { start, end } = parseRange(after!["range"] as string);
      expect(end - start + 1, `${entry["path"]}: ${after!["range"]}`).toBeGreaterThanOrEqual(35);
    }
  });

  it("TOKENLIGHTEN_TASK_PACK_MAX_BYTES=8192, 2 files: the response fits within a line of the ceiling", async () => {
    const run = await editFiles(2, { TOKENLIGHTEN_CLIENT_ID: "vscode", TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "8192" });
    expect(run.bytes).toBeLessThanOrEqual(8192);
    expect(run.bytes).toBeGreaterThan(8192 - 400);
  });

  it("windows are shed from the LAST file back — the order the 16 KiB attach cap already uses", async () => {
    const run = await editFiles(3, VSCODE);
    const [first, second, third] = run.applied.map((entry) => entry["after"] as Body | undefined);
    expect(first?.["remaining"], "the first file keeps its whole window").toBeUndefined();
    expect(second?.["remaining"], "the second file keeps its whole window").toBeUndefined();
    expect(third?.["remaining"], "the last file's window is the one that was cut").toBeDefined();
  });

  it("a ceiling that leaves room for the first files' windows but not one line of the last drops exactly that window", async () => {
    const whole = await editFiles(3, { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: undefined });
    const third = whole.applied[2]!["after"] as Body;
    // The response without the last window: its JSON (`,"after":{...}`) removed.
    const withoutThird = whole.bytes - Buffer.byteLength(JSON.stringify(third), "utf8") - Buffer.byteLength(",\"after\":", "utf8");
    const ceiling = withoutThird + 60; // less than one ~140-byte line of the last window
    const run = await editFiles(3, { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: String(ceiling) });
    expect(run.applied[0]!["after"], "first window whole").toBeDefined();
    expect((run.applied[0]!["after"] as Body)["remaining"]).toBeUndefined();
    expect(run.applied[1]!["after"], "second window whole").toBeDefined();
    expect((run.applied[1]!["after"] as Body)["remaining"]).toBeUndefined();
    expect(run.applied[2]!["after"], "the last window is dropped whole").toBeUndefined();
    expect(run.bytes).toBeLessThanOrEqual(ceiling);
    // ...and a dropped window books nothing.
    for (let line = 42; line <= 82; line++) expect(ledgerClaims(run.ws, "src/c.ts", line)).toBe(false);
    for (let line = 42; line <= 82; line++) expect(ledgerClaims(run.ws, "src/a.ts", line)).toBe(true);
  });

  it("a ceiling sweep: the response never exceeds the ceiling once the ceiling clears the response without windows, and every cut names its tail", async () => {
    // Base = the response with no window at all (3 files under a 500-byte ceiling
    // drop everything). Sweep ceilings above it in uneven steps.
    const base = (await editFiles(3, { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "500" })).bytes;
    for (const extra of [150, 431, 1207, 2999, 5003, 9127]) {
      const ceiling = base + extra;
      const run = await editFiles(3, { TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: String(ceiling) });
      expect(run.bytes, `ceiling ${ceiling} (base ${base} + ${extra})`).toBeLessThanOrEqual(ceiling);
      const shown = shownLinesOf(run.applied);
      for (const entry of run.applied) {
        const path = entry["path"] as string;
        const after = entry["after"] as Body | undefined;
        if (after === undefined) continue;
        const { start, end } = parseRange(after["range"] as string);
        // The body is exactly the lines its range names, and a cut names its tail.
        expect((after["body"] as string).replace(/\n$/, "").split("\n").length).toBe(end - start + 1);
        if (end < 82) expect((after["remaining"] as string[])[0]).toBe(`${end + 1}-82`);
        for (let line = 1; line <= FN_LINES; line++) {
          expect(ledgerClaims(run.ws, path, line), `ceiling ${ceiling} ${path} line ${line}`).toBe(shown.get(path)!.has(line));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Phantom line (P2-a).
// ---------------------------------------------------------------------------

describe("R2-PEW 4: the wide window and the ledger never name the phantom line after a file's final newline", () => {
  function shortFile(trailingNewline: boolean, eol = "\n"): string {
    const lines = ["export const A = 1;", "export const B = 2;"];
    for (let i = 0; i < 10; i++) lines.push(`export const P${i} = ${i};`);
    lines.push("export const C = 3;");
    return lines.join(eol) + (trailingNewline ? eol : "");
  }

  for (const [label, trailingNewline, eol] of [
    ["LF file with a final newline", true, "\n"],
    ["LF file without a final newline", false, "\n"],
    ["CRLF file with a final newline", true, "\r\n"],
  ] as const) {
    it(`${label}: after.range stops at the last real line (13) and the ledger claims lines 1-13 only`, async () => {
      const ws = makeWorkspace();
      writeSource(ws, "src/r.ts", shortFile(trailingNewline, eol));
      const { body } = parseResult(await callTool("tl_edit_file", {
        cwd: ws,
        edits: [{ path: "src/r.ts", search: "export const C = 3;", replace: "export const C = 30;" }],
      }));
      expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
      const entry = (body["applied"] as Body[])[0]!;
      const range = parseRange(entry["range"] as string);
      const after = entry["after"] as Body;
      // (the compact ±8 proof's own `range` is v0.14.4 wire behavior and is deliberately left as it was)
      expect(after["range"]).toBe("1-13");
      // The text of a window that reaches the last line keeps that line's newline, as tl_read_file returns it.
      expect((after["body"] as string).endsWith(eol)).toBe(trailingNewline);
      // `slice_sha` still digests exactly the slice `range` names — byte-identical to a read of that range
      // (`sliceLinesToText` normalizes CRLF to LF, so the comparison is made on the LF variants).
      const text = readSource(ws, "src/r.ts");
      if (eol === "\n") expect(entry["slice_sha"]).toBe(shaOfText(sliceLinesToText(text, range.start, range.end)));
      // The ledger claims exactly lines 1-13 (its total is the real line count, not the phantom-inclusive one).
      for (let line = 1; line <= 13; line++) expect(ledgerClaims(ws, "src/r.ts", line), `line ${line}`).toBe(true);
    });
  }

  it("a read of the reported window is a receipt (rs10b's own shape: a small file, the whole file the window)", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "src/greeter.ts", "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [{ path: "src/greeter.ts", search: "Hello, ${name}!", replace: "Hi there, ${name}!" }],
    }));
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after["range"]).toBe("1-3");
    const read = await readRange(ws, "src/greeter.ts", "1-3");
    expect(read["kind"]).toBe("read.receipt");
    expect(String(read["receipt"]?.["served_by"])).toContain("edit-after");
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-hunk locate (P2-b): every hunk is shown or named.
// ---------------------------------------------------------------------------

describe("R2-PEW 5: every hunk of a multi-hunk batch is shown or named in `remaining`", () => {
  /** Does some range in `names` (or the shown window) cover `line`? */
  function covered(after: Body, line: number): boolean {
    const spans = [after["range"] as string, ...((after["remaining"] as string[] | undefined) ?? [])];
    return spans.some((range) => {
      const { start, end } = parseRange(range);
      return start <= line && line <= end;
    });
  }

  function markerFile(): string {
    return [
      "export const A = 1;",
      "// marker",
      "export const B = 2;",
      ...Array.from({ length: 60 }, (_, i) => `export const P${i} = ${i};`),
      "// marker",
      "export const C = 3;",
      "",
    ].join("\n");
  }

  it("bottom-to-top, the lower hunk's replace repeats an earlier line: the real hunk (line 65) is named", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "src/r.ts", markerFile());
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/r.ts", search: "export const C = 3;", replace: "// marker" },
        { path: "src/r.ts", search: "export const B = 2;", replace: "export const B = 20;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const text = readSource(ws, "src/r.ts").split("\n");
    expect(text[64]).toBe("// marker"); // the real lower hunk sits at line 65
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after, JSON.stringify(body["applied"])).toBeDefined();
    expect(covered(after, 3), "the upper hunk is shown").toBe(true);
    expect(covered(after, 65), `the lower hunk (line 65) must be shown or named: ${JSON.stringify({ range: after["range"], remaining: after["remaining"] })}`).toBe(true);
    // A named range is a range the caller can read: it comes back as bytes.
    const remaining = (after["remaining"] as string[]).find((range) => {
      const { start, end } = parseRange(range);
      return start <= 65 && 65 <= end;
    })!;
    const read = await readRange(ws, "src/r.ts", remaining);
    expect(read["kind"]).not.toBe("read.receipt");
    expect(bodiesOf(read)).toContain("export const P59 = 59;"); // line 63, inside the named window
  });

  it("three hunks bottom to top with unique texts: none is lost to the forward scan", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 260 }, (_, i) => `export const V${i} = ${i};`);
    writeSource(ws, "src/v.ts", lines.join("\n") + "\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/v.ts", search: "export const V200 = 200;", replace: "export const V200 = 2000;" },
        { path: "src/v.ts", search: "export const V100 = 100;", replace: "export const V100 = 1000;" },
        { path: "src/v.ts", search: "export const V10 = 10;", replace: "export const V10 = 110;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(covered(after, 11), "V10 (line 11) — the last hunk").toBe(true);
    expect(covered(after, 101), "V100 (line 101) — the middle hunk").toBe(true);
    expect(covered(after, 201), "V200 (line 201) — the first hunk").toBe(true);
  });

  it("CONTROL: top to bottom with unique texts — the far hunk is named exactly as before (`remaining` = its ±20 window)", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 200 }, (_, i) => `export const L${i + 1} = ${i + 1};`);
    writeSource(ws, "src/plain.ts", lines.join("\n") + "\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/plain.ts", search: "export const L10 = 10;", replace: "export const L10 = 910;" },
        { path: "src/plain.ts", search: "export const L150 = 150;", replace: "export const L150 = 9150;" },
      ],
    }));
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after["range"]).toBe("130-170");
    expect(after["remaining"]).toEqual(["1-30"]);
  });

  it("a block too common to name (more occurrences than the cap) falls back to the forward reading and still ships the chain-final window", async () => {
    const ws = makeWorkspace();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(i % 5 === 0 ? "  return null;" : `export const W${i} = ${i};`);
    writeSource(ws, "src/w.ts", lines.join("\n") + "\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/w.ts", search: "export const W101 = 101;", replace: "  return null;" },
        { path: "src/w.ts", search: "export const W251 = 251;", replace: "export const W251 = 9;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after["body"]).toContain("export const W251 = 9;");
    // The shed/booking machinery is undisturbed: what the response shows is what the ledger claims.
    const { start, end } = parseRange(after["range"] as string);
    for (let line = start; line <= end; line++) expect(ledgerClaims(ws, "src/w.ts", line)).toBe(true);
  });

  it("two hunks 40 lines apart in wide-line code: a merge would cut the LAST hunk off at the entry cap — the anchor's own window is shown, the other named without the lines already shown", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "package.json", "{\"name\":\"x\",\"type\":\"module\"}\n");
    // ~135-byte lines: one ±20 window (41 lines, ~5.5 KB) fits the 6 KiB entry cap, the 81-line union does not,
    // and the union's first 61 lines (down to the last hunk) do not fit either.
    writeSource(ws, "src/a.ts", paddedFn(400, "alpha", "y".repeat(90)));
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/a.ts", search: "  const step40 = x + 40;", replace: "  const step40 = x + 400;" },
        { path: "src/a.ts", search: "  const step80 = x + 80;", replace: "  const step80 = x + 800;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    // The last hunk (line 82) is IN the shown window...
    expect(after["body"]).toContain("const step80 = x + 800;");
    expect(after["range"]).toBe("62-102");
    // ...and the first hunk (line 42) is named — only the part of its window the shown one does not cover.
    expect(after["remaining"]).toEqual(["22-61"]);
    const shown = parseRange(after["range"] as string);
    for (const line of [22, 42, 61, 62, 82, 102, 103]) {
      expect(ledgerClaims(ws, "src/a.ts", line), `line ${line}`).toBe(line >= shown.start && line <= shown.end);
    }
  });

  it("CONTROL: the same two hunks when the merged window's cap boundary falls BELOW the last hunk — they still merge into one window (the tail is cut and named)", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "package.json", "{\"name\":\"x\",\"type\":\"module\"}\n");
    writeSource(ws, "src/a.ts", paddedFn(400, "alpha"));
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/a.ts", search: "  const step10 = x + 10;", replace: "  const step10 = x + 100;" },
        { path: "src/a.ts", search: "  const step40 = x + 40;", replace: "  const step40 = x + 400;" },
      ],
    }));
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    const shown = parseRange(after["range"] as string);
    // ~105-byte lines: the union of the two windows is 1-62 (62 lines, ~6.5 KB), so it is cut at the cap — but
    // both hunks (lines 12 and 42) sit above the cut and are shown, as they always were.
    expect(shown.start).toBe(1);
    expect(after["body"]).toContain("const step10 = x + 100;");
    expect(after["body"]).toContain("const step40 = x + 400;");
    expect(after["remaining"]).toBeDefined();
  });

  it("target:\"all\" replacing three far-apart sites (one hunk, several places): every site is shown or named", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 200 }, (_, i) => (i === 9 || i === 99 || i === 189 ? "  console.log(\"DUP\");" : `export const L${i + 1} = ${i + 1};`));
    writeSource(ws, "src/dup.ts", lines.join("\n") + "\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [{ path: "src/dup.ts", search: "console.log(\"DUP\");", replace: "console.log(\"REPLACED\");", target: "all" }],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const entry = (body["applied"] as Body[])[0]!;
    expect(entry["replaced"]).toBe(3);
    const after = entry["after"] as Body;
    for (const site of [10, 100, 190]) {
      expect(covered(after, site), `site at line ${site}: ${JSON.stringify({ range: after["range"], remaining: after["remaining"] })}`).toBe(true);
    }
    // What is shown is claimed, what is only named is not.
    const shown = parseRange(after["range"] as string);
    for (const site of [10, 100, 190]) expect(ledgerClaims(ws, "src/dup.ts", site)).toBe(site >= shown.start && site <= shown.end);
  });

  it("range-handle batch (`content` replacements, bottom range first): the other range's window is named", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 200 }, (_, i) => `export const L${i + 1} = ${i + 1};`);
    writeSource(ws, "src/plain.ts", lines.join("\n") + "\n");
    const mint = async (range: string): Promise<string> => {
      const read = parseResult(await callTool("tl_read_file", { cwd: ws, targets: [{ path: "src/plain.ts", range }], content: "full" })).body;
      return String(read["evidence"]?.[0]?.["handle"]);
    };
    const upper = await mint("10-12");
    const lower = await mint("150-152");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { handle: lower, content: "export const L150 = 9150;\nexport const L151 = 9151;\nexport const L152 = 9152;\n" },
        { handle: upper, content: "export const L10 = 910;\nexport const L11 = 911;\nexport const L12 = 912;\n" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(covered(after, 11), "the upper range").toBe(true);
    expect(covered(after, 151), `the lower range must be shown or named: ${JSON.stringify({ range: after["range"], remaining: after["remaining"] })}`).toBe(true);
  });

  it("a multi-file batch of handle-addressed search/replace items: each file's other hunk is named through its handle", async () => {
    const ws = makeWorkspace();
    const body200 = (tag: string): string => Array.from({ length: 200 }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join("\n") + "\n";
    writeSource(ws, "src/x.ts", body200("X"));
    writeSource(ws, "src/y.ts", body200("Y"));
    const handleOf = async (file: string): Promise<string> => {
      const read = parseResult(await callTool("tl_read_file", { cwd: ws, targets: [{ path: file }], content: "full" })).body;
      return String(read["evidence"]?.[0]?.["handle"]);
    };
    const hx = await handleOf("src/x.ts");
    const hy = await handleOf("src/y.ts");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { handle: hx, search: "export const X10 = 10;", replace: "export const X10 = 910;" },
        { handle: hx, search: "export const X150 = 150;", replace: "export const X150 = 9150;" },
        { handle: hy, search: "export const Y20 = 20;", replace: "export const Y20 = 920;" },
        { handle: hy, search: "export const Y170 = 170;", replace: "export const Y170 = 9170;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const applied = body["applied"] as Body[];
    const xAfter = applied.find((entry) => entry["path"] === "src/x.ts")!["after"] as Body;
    const yAfter = applied.find((entry) => entry["path"] === "src/y.ts")!["after"] as Body;
    expect(covered(xAfter, 10) && covered(xAfter, 150), JSON.stringify(xAfter["remaining"])).toBe(true);
    expect(covered(yAfter, 20) && covered(yAfter, 170), JSON.stringify(yAfter["remaining"])).toBe(true);
  });

  it("CRLF file, two distant hunks top to bottom: the earlier hunk is named (the scan matches the block's lines through their `\\r`)", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 200 }, (_, i) => `export const L${i + 1} = ${i + 1};`);
    writeSource(ws, "src/crlf.ts", lines.join("\r\n") + "\r\n");
    const { body } = parseResult(await callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/crlf.ts", search: "export const L10 = 10;", replace: "export const L10 = 910;" },
        { path: "src/crlf.ts", search: "export const L150 = 150;", replace: "export const L150 = 9150;" },
      ],
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after["range"]).toBe("130-170");
    expect(after["remaining"]).toEqual(["1-30"]);
  });

  it("one file, two hunks, a tight ceiling: the primary window shrinks, its cut tail AND the other hunk's window are named, and every named range reads as bytes", async () => {
    const ws = makeWorkspace();
    writeSource(ws, "package.json", "{\"name\":\"x\",\"type\":\"module\"}\n");
    writeSource(ws, "src/a.ts", paddedFn(400, "alpha"));
    const { body } = parseResult(await withEnv({ TOKENLIGHTEN_CLIENT_ID: undefined, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "2600" }, () => callTool("tl_edit_file", {
      cwd: ws,
      edits: [
        { path: "src/a.ts", search: "  const step60 = x + 60;", replace: "  const step60 = x + 600;" },
        { path: "src/a.ts", search: "  const step300 = x + 300;", replace: "  const step300 = x + 3000;" },
      ],
    })));
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("edit.applied");
    const after = (body["applied"] as Body[])[0]!["after"] as Body;
    expect(after, "a window fits at 2600 bytes").toBeDefined();
    const remaining = after["remaining"] as string[];
    // primary = the window around the LAST hunk (step300, line 302), cut; the other hunk's window (step60, line 62) is named.
    expect(remaining.some((r) => parseRange(r).start <= 62 && 62 <= parseRange(r).end), JSON.stringify(after["remaining"])).toBe(true);
    const shown = parseRange(after["range"] as string);
    for (let line = 1; line <= 403; line++) {
      expect(ledgerClaims(ws, "src/a.ts", line), `line ${line}`).toBe(line >= shown.start && line <= shown.end);
    }
    for (const range of remaining) {
      const read = await readRange(ws, "src/a.ts", range);
      expect(read["kind"], range).not.toBe("read.receipt");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. shedPostEditWindowsToFit unit contract.
// ---------------------------------------------------------------------------

describe("R2-PEW 6: shedPostEditWindowsToFit — exact fit, last file first, wire-measured", () => {
  const line = (n: number): string => `  L${String(n).padStart(3, "0")} ${"z".repeat(40)}`;
  function windowOf(from: number, to: number): Body {
    const lines: string[] = [];
    for (let n = from; n <= to; n++) lines.push(line(n));
    return { range: `${from}-${to}`, body: lines.join("\n") };
  }
  function response(windows: Array<[number, number] | null>): Record<string, unknown> {
    return {
      v: 1,
      kind: "edit.applied",
      core: { counts: { applied: windows.length, attempted: windows.length, reverted: 0, unproven: 0 }, paths: windows.map((_, i) => `f${i}.ts`) },
      applied: windows.map((w, i) => ({ path: `f${i}.ts`, range: "1-2", ...(w === null ? {} : { after: windowOf(w[0], w[1]) }) })),
    };
  }
  const sizeOf = (r: unknown): number => Buffer.byteLength(JSON.stringify(r), "utf8");
  const afterOf = (r: Record<string, unknown>, i: number): Body | undefined => ((r["applied"] as Body[])[i]!["after"] as Body | undefined);

  it("no ceiling, or a response already under it: the SAME object comes back", () => {
    const r = response([[1, 40]]);
    expect(shedPostEditWindowsToFit(r, undefined)).toBe(r);
    expect(shedPostEditWindowsToFit(r, sizeOf(r))).toBe(r);
    expect(shedPostEditWindowsToFit(r, sizeOf(r) + 5000)).toBe(r);
  });

  it("over the ceiling: the LAST window is cut to the largest prefix that fits (one more line would not), its tail named", () => {
    const r = response([[1, 40], [1, 40], [1, 40]]);
    const ceiling = sizeOf(r) - 900;
    const shed = shedPostEditWindowsToFit(r, ceiling);
    expect(sizeOf(shed)).toBeLessThanOrEqual(ceiling);
    expect(afterOf(shed, 0)!["remaining"], "earlier windows untouched").toBeUndefined();
    expect(afterOf(shed, 1)!["remaining"], "earlier windows untouched").toBeUndefined();
    const third = afterOf(shed, 2)!;
    const { end } = parseRange(third["range"] as string);
    expect(end).toBeLessThan(40);
    expect(third["remaining"]).toEqual([`${end + 1}-40`]);
    // Maximality: the same window with one more line is over the ceiling.
    const oneMore = JSON.parse(JSON.stringify(shed)) as Record<string, unknown>;
    const w = windowOf(1, end + 1);
    (oneMore["applied"] as Body[])[2]!["after"] = { range: w["range"], body: w["body"], remaining: [`${end + 2}-40`] };
    expect(sizeOf(oneMore)).toBeGreaterThan(ceiling);
  });

  it("a window is dropped only when not even one line of it fits; an earlier window then absorbs what is left", () => {
    const r = response([[1, 40], [1, 40]]);
    const oneWindowOnly = sizeOf(response([[1, 40], null]));
    // Room for the first window whole, and for nothing of the second.
    const shed = shedPostEditWindowsToFit(r, oneWindowOnly + 20);
    expect(afterOf(shed, 1)).toBeUndefined();
    expect(afterOf(shed, 0)!["remaining"]).toBeUndefined();
    // Room for less than the first window too: the second is dropped and the first shrinks.
    const tighter = shedPostEditWindowsToFit(r, oneWindowOnly - 500);
    expect(afterOf(tighter, 1)).toBeUndefined();
    expect(afterOf(tighter, 0)!["remaining"]).toBeDefined();
    expect(sizeOf(tighter)).toBeLessThanOrEqual(oneWindowOnly - 500);
  });

  it("a ceiling below the response with no window at all drops every window and leaves everything else untouched", () => {
    const r = response([[1, 40], [1, 40]]);
    const shed = shedPostEditWindowsToFit(r, 50);
    expect(afterOf(shed, 0)).toBeUndefined();
    expect(afterOf(shed, 1)).toBeUndefined();
    expect(shed["core"]).toEqual(r["core"]);
  });

  it("an unreadable range is dropped whole, never cut (a window that cannot say which lines it holds)", () => {
    const r = response([[1, 40]]);
    (r["applied"] as Body[])[0]!["after"] = { range: "the-whole-thing", body: (r["applied"] as Body[])[0]!["after"]["body"] };
    const shed = shedPostEditWindowsToFit(r, sizeOf(r) - 100);
    expect(afterOf(shed, 0)).toBeUndefined();
  });

  it("the wire view is what is measured: fields the projection drops do not push a fitting response over the ceiling", () => {
    const r = response([[1, 40]]);
    (r["applied"] as Body[])[0]!["code"] = "X".repeat(6000); // an internal echo the wire never carries
    const view = (candidate: Record<string, unknown>): unknown => ({
      ...candidate,
      applied: (candidate["applied"] as Body[]).map(({ code: _code, ...rest }) => rest),
    });
    const wireSize = sizeOf(view(r));
    // Raw size is over the ceiling, wire size is under it: with the view nothing is shed...
    expect(shedPostEditWindowsToFit(r, wireSize + 10, view)).toBe(r);
    // ...without it (the default view is the response itself) the same ceiling sheds.
    expect(shedPostEditWindowsToFit(r, wireSize + 10)).not.toBe(r);
    // And when the wire form IS over, the cut is measured on the wire form: exact fit, no 6 KB overshoot.
    const shed = shedPostEditWindowsToFit(r, wireSize - 700, view);
    expect(sizeOf(view(shed))).toBeLessThanOrEqual(wireSize - 700);
    expect(sizeOf(view(shed))).toBeGreaterThan(wireSize - 700 - 200);
    expect(afterOf(shed, 0)).toBeDefined();
  });

  it("JSON escaping is measured, not estimated: a body full of quotes and backslashes still fits the ceiling exactly", () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const s${i} = "a\\\\b\\"c" + '\\t';`).join("\n");
    const r: Record<string, unknown> = { applied: [{ path: "f.ts", range: "1-2", after: { range: "1-30", body } }] };
    const ceiling = sizeOf(r) - 400;
    const shed = shedPostEditWindowsToFit(r, ceiling);
    expect(sizeOf(shed)).toBeLessThanOrEqual(ceiling);
    expect(sizeOf(shed)).toBeGreaterThan(ceiling - 120);
  });
});
