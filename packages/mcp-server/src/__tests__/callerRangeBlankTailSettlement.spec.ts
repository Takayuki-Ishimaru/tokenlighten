/**
 * callerRangeBlankTailSettlement.spec.ts — GATE-A item 1 (v0.14.3
 * improvement-plan fix wave, 2026-09-21): `settleCallerRangeDelivery`
 * (readCodeTaskPack.ts) must never count a trailing blank/whitespace-only
 * source line, or a requested end beyond the file's CURRENT length, as
 * "undelivered" content.
 *
 * THE REGRESSION THIS GUARDS. FIX-A1 added `settleCallerRangeDelivery` to
 * state `U = R - S` (requested lines minus lines actually shipped) against
 * the FINAL emitted body, so a caller-named ranged/whole-file target never
 * silently drops real lines. Its `deliveredEnd` is derived by mapping the
 * served body's DISPLAY line count back to a source line
 * (`sourceLineAfterDisplayLines`). That mapping cannot tell "a real line
 * beyond it was cut" from "every line beyond it is blank, so joining the
 * body's lines with a newline produced the exact same bytes as if they had
 * never been there" — `["a", ""].join("\n")` is byte-identical to
 * `["a"].join("\n") + "\n"`. CONFIRMED by the orchestrator (in-process probe,
 * tree vs clean HEAD `03002d8c`), fixture = a 141-line `calc.ts` whose line
 * 141 is BLANK (content ends `}\n\n`):
 *   `read_file {query:"Explain what calc.ts does.", targets:[{path:"calc.ts"}],
 *    content:"auto", task:{epoch:"new",profile:"answer"}, budget:{bytes:60000}}`
 *   clean HEAD -> `act.answer` (obligations `surface-content`), evidence
 *     `calc.ts:1-141`, no `remaining`.
 *   pre-fix tree -> `discover`, `gaps:[{code:"missing-evidence",
 *     refs:["surface-content"]}]`, `next` for `calc.ts:141-141` (a line that
 *     serves empty), evidence `calc.ts:1-141` with `remaining:["141-141"]`.
 * The same blind spot also affected a requested end past EOF, since a
 * caller-ranged surface's `range` can still land on an EOF-adjacent blank
 * line after upstream clamping.
 *
 * THE FIX (readCodeTaskPack.ts, `trailingBlankOrMissingTrimmedEnd` +
 * `settleCallerRangeDelivery`). After computing the same `deliveredEnd` as
 * before, the ceiling of any would-be `remaining_ranges` entry is trimmed
 * back — once, directly against the CURRENT source, reusing the same
 * `readCached`/`countLines` primitives the rest of this file already uses —
 * past any line that is beyond the file's real current length or is
 * blank/whitespace-only. If that trim consumes the entire gap, nothing is
 * missing at all (the surface settles exactly as trimToCap/construction left
 * it). This is chosen over re-deriving `deliveredEnd` a second time from
 * rendered display text (the ORIGINAL source of the ambiguity): the fix asks
 * the one source of truth that can actually answer "is there a real byte
 * here" — the file itself — rather than trying to out-guess `join` from its
 * own output. The change stays widening-only per the function's own doc
 * comment: the newly computed span can only be smaller than or equal to the
 * old `${deliveredEnd + 1}-${requestedEnd}`, never larger, and an entry
 * another pass already wrote is still never narrowed.
 *
 * WHAT THIS FILE SWEEPS. File endings that make the blank-tail/EOF question
 * concrete (a plain blank last line, CRLF, two consecutive blank lines, a
 * whitespace-only line, a file of nothing but blank lines, a doc-elided body
 * ending in a blank line, plus two controls that must NOT change behavior:
 * no blank ending, and no trailing newline at all) crossed with the caller
 * target shapes the brief calls out (whole-file named, ranged ending exactly
 * at EOF, ranged past EOF, ranged in the middle) and two budgets (generous,
 * and tight-but-above-the-task-pack floor), under both the default config and
 * the VS Code config (gutter-rendered bodies, `TL_ANSWER_LINE_GUTTER`'s
 * trigger). Oracle: whenever nothing but blank/nonexistent lines sit in the
 * requested window beyond what was delivered, the response must be a
 * TERMINAL, complete state — no leftover `remaining` on that surface, no
 * `next` chasing a line that would serve empty — matching what clean HEAD
 * `03002d8c` already did for every one of these shapes (verified directly,
 * in-process, against `~/.cache/tokenlighten-ab/wt-head`; HEAD predates
 * `settleCallerRangeDelivery` entirely, so it never had this failure mode).
 * The "ranged-in-the-middle" shape and the tight-budget cells where a real,
 * non-blank cut exists (a huge file over a small budget) are included only
 * as internal-consistency controls — the genuinely-partial matrix itself is
 * `rangedDeliveryCompleteness.spec.ts`'s job, not this file's.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";

const WORKSPACE_PREFIX = ".tl-gateA-blanktail-";
const createdWorkspaces: string[] = [];

function mkWs(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), WORKSPACE_PREFIX)));
  createdWorkspaces.push(dir);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterAll(() => {
  for (const dir of createdWorkspaces) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VSCODE_ENV: Readonly<Record<string, string>> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
  TL_TURN_ECONOMY: "1",
  TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
};

async function withEnv<T>(overrides: Readonly<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/** 135 numbered `const` lines + a 5-line `total()` function (lines 136-140). Every fixture appends its own ending from line 141 on. */
function baseLines(): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= 135; i++) lines.push(`export const value${i} = ${i};`);
  lines.push("export function total(): number {");
  lines.push("  let sum = 0;");
  lines.push("  for (const n of [1, 2, 3]) sum += n;");
  lines.push("  return sum;");
  lines.push("}"); // line 140
  return lines;
}

interface FileEnding {
  name: string;
  /** Never affected by this fix — the file's ending has no blank/whitespace tail, so behavior before and after must be identical. */
  control: boolean;
  build: () => { content: string; totalLines: number };
}

const FILE_ENDINGS: readonly FileEnding[] = [
  {
    name: "blank-last-line",
    control: false,
    build: () => {
      const lines = baseLines();
      lines.push(""); // line 141, blank — the exact orchestrator repro shape
      return { content: lines.join("\n") + "\n", totalLines: 141 };
    },
  },
  {
    name: "crlf-blank-last-line",
    control: false,
    build: () => {
      const lines = baseLines();
      lines.push("");
      return { content: lines.join("\r\n") + "\r\n", totalLines: 141 };
    },
  },
  {
    name: "two-trailing-blank-lines",
    control: false,
    build: () => {
      const lines = baseLines();
      lines.push("", ""); // lines 141-142, both blank
      return { content: lines.join("\n") + "\n", totalLines: 142 };
    },
  },
  {
    name: "trailing-whitespace-only-line",
    control: false,
    build: () => {
      const lines = baseLines();
      lines.push("   \t  "); // line 141: whitespace, not literally ""
      return { content: lines.join("\n") + "\n", totalLines: 141 };
    },
  },
  {
    name: "doc-elided-body-blank-last-line",
    control: false,
    build: () => {
      const lines: string[] = [];
      for (let i = 1; i <= 100; i++) lines.push(`export const value${i} = ${i};`);
      lines.push("/**");
      for (let i = 1; i <= 30; i++) lines.push(` * doc line ${i}, long enough for the block to be worth eliding.`);
      lines.push(" */");
      lines.push("export function total(): number {");
      lines.push("  let sum = 0;");
      lines.push("  return sum;");
      lines.push("}");
      lines.push(""); // blank last line
      return { content: lines.join("\n") + "\n", totalLines: lines.length };
    },
  },
  {
    name: "all-blank-file",
    control: false,
    // 200 lines (not 10) so this ending stays compatible with every target
    // shape below, several of which use fixed offsets (100, 10-60) that a
    // shorter file would turn into an inverted/nonsensical range — a fixture
    // bug, not a fact about the implementation under test.
    build: () => ({ content: "\n".repeat(200), totalLines: 200 }),
  },
  {
    name: "CONTROL-no-blank-ending",
    control: true,
    build: () => {
      const lines = baseLines();
      lines.push("export const done = true;"); // line 141, real content
      return { content: lines.join("\n") + "\n", totalLines: 141 };
    },
  },
  {
    name: "CONTROL-no-trailing-newline",
    control: true,
    build: () => {
      const lines = baseLines();
      lines.push("export const done = true;");
      return { content: lines.join("\n"), totalLines: 141 }; // no final \n at all
    },
  },
];

interface TargetShape {
  name: string;
  target: (totalLines: number) => { path: string; range?: string };
}

const TARGET_SHAPES: readonly TargetShape[] = [
  { name: "whole-file-named", target: () => ({ path: "calc.ts" }) },
  { name: "ranged-ending-at-eof", target: (n) => ({ path: "calc.ts", range: `100-${n}` }) },
  { name: "ranged-beyond-eof", target: (n) => ({ path: "calc.ts", range: `100-${n + 400}` }) },
  { name: "ranged-in-the-middle", target: () => ({ path: "calc.ts", range: "10-60" }) },
];

const BUDGETS: readonly { name: string; bytes: number }[] = [
  { name: "generous", bytes: 60000 },
  { name: "tight-but-valid", bytes: 6500 },
];

const CONFIGS: readonly { name: string; env: Readonly<Record<string, string>> }[] = [
  { name: "default", env: {} },
  { name: "vscode", env: VSCODE_ENV },
];

/** True iff every source line in `[start, end]` (1-based, inclusive, clamped to `totalLines`) is blank/whitespace-only, or the window is past EOF/empty. */
function isAllBlankOrPastEof(content: string, start: number, end: number, totalLines: number): boolean {
  const clampedEnd = Math.min(end, totalLines);
  if (start > clampedEnd) return true;
  const lines = content.split(/\r?\n/);
  for (let n = start; n <= clampedEnd; n += 1) {
    if ((lines[n - 1] ?? "").trim() !== "") return false;
  }
  return true;
}

interface WireResponse {
  kind?: string;
  decision?: { kind?: string; next?: unknown };
  evidence?: Array<{ path?: string; range?: string; remaining?: unknown; note?: unknown }>;
  note?: unknown;
}

async function readCalcTs(
  env: Readonly<Record<string, string>>,
  ws: string,
  target: { path: string; range?: string },
  budgetBytes: number,
): Promise<WireResponse | undefined> {
  const res = await withEnv(env, () =>
    callTool("read_file", {
      query: "Explain what calc.ts does.",
      targets: [target],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: budgetBytes },
      cwd: ws,
    }),
  );
  const wrapped = res as { content: Array<{ text: string }> };
  const parsed = JSON.parse(wrapped.content[0]!.text) as WireResponse;
  return parsed;
}

describe("GATE-A item 1 — a blank tail or an EOF overrun never counts as undelivered", () => {
  for (const config of CONFIGS) {
    for (const budget of BUDGETS) {
      for (const ending of FILE_ENDINGS) {
        for (const shape of TARGET_SHAPES) {
          const label = `${config.name}/${budget.name}/${ending.name}/${shape.name}`;
          it(label, async () => {
            const { content, totalLines } = ending.build();
            const ws = mkWs();
            writeFile(ws, "calc.ts", content);
            const target = shape.target(totalLines);
            const parsed = await readCalcTs(config.env, ws, target, budget.bytes);

            if (parsed?.kind === "refusal") return; // e.g. budget-below-minimum: not this item's concern

            const evidence = parsed?.evidence ?? [];
            const surface = evidence.find((e) => e.path === "calc.ts");
            expect(surface, `${label}: expected calc.ts evidence`).toBeDefined();

            // Determine the requested window this target names, so the oracle
            // below is computed the same way regardless of shape.
            const requestedRange = /^(\d+)-(\d+)$/.exec(target.range ?? `1-${totalLines}`);
            expect(requestedRange, `${label}: fixture produced an unparsable range`).not.toBeNull();
            const winEnd = Number(requestedRange![2]);

            // How far the surface's own served range already reaches (its
            // `range` may already be EOF-clamped upstream of this fix).
            const servedRangeMatch = /^(\d+)-(\d+)$/.exec(String(surface?.range ?? ""));
            const servedEnd = servedRangeMatch ? Number(servedRangeMatch[2]) : winEnd;
            const gapStart = Math.min(servedEnd, winEnd) + 1;

            if (isAllBlankOrPastEof(content, gapStart, winEnd, totalLines)) {
              // Nothing real sits beyond whatever the surface's range already
              // covers: this must be a TERMINAL, complete state.
              expect(
                surface?.remaining,
                `${label}: expected no remaining, got ${JSON.stringify(surface?.remaining)}`,
              ).toBeUndefined();
              expect(parsed?.decision?.kind, `${label}: expected a terminal decision`).toBe("act.answer");
              expect(parsed?.decision?.next, `${label}: expected no next`).toBeUndefined();
            }
            // Cells where real content genuinely remains (e.g. a huge file
            // over a tight budget) are a DIFFERENT class this file does not
            // assert past evidence being present — rangedDeliveryCompleteness
            // .spec.ts and the R1/R2 guards own that matrix.
          });
        }
      }
    }
  }

  // Explicit, easy-to-find pins for the orchestrator's exact confirmed repro
  // and its beyond-EOF sibling, matching the language of the brief verbatim.
  it("PINNED REPRO: 141-line calc.ts, blank line 141, whole-file named target -> act.answer (was discover)", async () => {
    const lines = baseLines();
    lines.push("");
    const content = lines.join("\n") + "\n";
    const ws = mkWs();
    writeFile(ws, "calc.ts", content);
    const parsed = await readCalcTs({}, ws, { path: "calc.ts" }, 60000);
    expect(parsed?.decision?.kind).toBe("act.answer");
    expect(parsed?.decision?.next).toBeUndefined();
    const surface = parsed?.evidence?.find((e) => e.path === "calc.ts");
    expect(surface?.range).toBe("1-141");
    expect(surface?.remaining).toBeUndefined();
  });

  it("PINNED: range 100-500 on the same 141-line file settles fully, no next for 142-500, no loop", async () => {
    const lines = baseLines();
    lines.push("");
    const content = lines.join("\n") + "\n";
    const ws = mkWs();
    writeFile(ws, "calc.ts", content);
    const parsed = await readCalcTs({}, ws, { path: "calc.ts", range: "100-500" }, 60000);
    expect(parsed?.decision?.kind).toBe("act.answer");
    expect(parsed?.decision?.next).toBeUndefined();
    const surface = parsed?.evidence?.find((e) => e.path === "calc.ts");
    // The surface's own served range is EOF-clamped upstream of this fix.
    expect(surface?.range).toBe("100-141");
    expect(surface?.remaining).toBeUndefined();
  });
});
