/**
 * runOutput.ts — the client-agnostic compressor behind `tl run` (2026-11-03).
 *
 * WHY. Paired billing of edit sessions shows that test and build output is
 * one of the largest sources of NEW tokens entering the context: a failing
 * `npx vitest run` prints its whole report, and every byte of it is billed
 * again on each following turn. `tl run -- <command>` keeps the full output
 * in a log under the workspace's private runtime directory and prints only
 * what the agent needs: every failure block, the runner's own summary and the
 * log path, bounded to a few kilobytes. Nothing here knows which agent host
 * is calling: the input is a command line plus its combined output, the
 * output a string.
 *
 * WHAT IS KEPT. Lines are RANKED, not truncated. Each recognised runner marks
 * its failure headers (tier 1), the detail that explains them — assertion
 * messages, diffs, the first stack frames (tier 2) — and its summary lines
 * (tier 3); extra frames and warnings rank below (tier 4), and a short tail
 * of the raw output last (tier 5). The byte budget is filled tier by tier,
 * so a passing line can never displace an error line, and the selected lines
 * are printed in their original order with `…` where lines were left out. An
 * unrecognised runner falls back to head + tail + the log path, and for
 * every runner a safety net ranks any failure-looking line the ranker left
 * out (`✖`, `not ok`, `FAIL`, `Error:`, `ERR_…`, `Traceback`, ...) with a
 * bounded run of its indented detail: above head and tail for an unknown
 * runner, just below the runner's own failures and summary for a known one.
 */

export type RunnerId = "vitest" | "jest" | "pytest" | "tsc" | "eslint" | "go" | "cargo" | "node-test" | "unknown";

export interface RunOutputSummaryInput {
  /** The command line as the user or hook gave it. */
  command: string;
  /** Combined stdout+stderr, in arrival order. */
  output: string;
  exitCode: number | null;
  signal?: string | null;
  /** Where the full output was written (printed verbatim). */
  logPath: string;
  /** How long the command ran; the header leaves the duration out when the host did not say. */
  durationMs?: number;
  /** Upper bound on the printed result, in UTF-8 bytes. */
  limitBytes?: number;
  /** Skips detection when the caller already knows the runner (`unknown` forces the head + tail path). */
  runner?: RunnerId;
  /**
   * Who is speaking in the first header line (default `tl run`). The Claude
   * Code PostToolUse hook (2026-11-03) names itself, since the agent ran its
   * own command and never saw `tl run`.
   */
  label?: string;
  /** Replaces the `exit N` status text when the caller knows more than a code (`interrupted`, a host's interpretation). */
  status?: string;
}

export const DEFAULT_RUN_OUTPUT_LIMIT_BYTES = 4096;
/** A single line longer than this is clipped; the log keeps it whole. */
const MAX_LINE_CHARS = 400;
const HEAD_LINES = 12;
const TAIL_LINES = 12;
const DROP = Number.POSITIVE_INFINITY;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Removes colour and cursor escapes and normalises line endings. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

/**
 * The runner whose report the output carries, judged by the output first
 * (an `npm test` line tells nothing about what ran) and the command line
 * second (an early crash may print no report at all).
 */
export function detectRunner(command: string, output: string): RunnerId {
  const sample = output.length > 200_000
    ? `${output.slice(0, 100_000)}\n${output.slice(-100_000)}`
    : output;
  const lines = sample.split("\n");
  const has = (pattern: RegExp): boolean => lines.some((line) => pattern.test(line));
  // node:test first: its spec reporter's `ℹ pass N` summary and `✖ failing
  // tests:` section, or the TAP it prints when piped (`not ok 3 - name`,
  // `# fail 1`). A bare `✔ name (12ms)` is not enough: mocha prints those too.
  if (has(/^\s*ℹ (tests|pass|fail) \d+/) || has(/^\s*✖ failing tests:/) || has(/^TAP version \d+/) || has(/^\s*(not )?ok \d+ - /) || has(/^# (pass|fail) \d+$/)) return "node-test";
  if (has(/^\s*(Test Files|Tests)\s+\d+ (failed|passed|skipped)/) || has(/^\s*RUN\s+v\d/) || has(/^\s*[⎯]{3,}/)) return "vitest";
  if (has(/^(Test Suites|Tests):\s+\d+/) || has(/^Ran all test suites/) || has(/^\s*●\s+\S/)) return "jest";
  if (has(/^={3,} .*\b(passed|failed|errors?|no tests ran)\b.* ={3,}$/) || has(/^={3,} test session starts ={3,}$/) || has(/^(FAILED|ERROR) \S+::/)) return "pytest";
  if (has(/(^|\s)error TS\d{3,}:/) || has(/^Found \d+ errors?( in \d+ files?)?\.?$/)) return "tsc";
  if (has(/^(--- (FAIL|PASS|SKIP):|=== RUN\s)/) || has(/^(ok|FAIL)\s+\S+\s+[\d.]+s/) || has(/^\?\s+\S+\s+\[no test files\]/)) return "go";
  if (has(/^test result: /) || has(/^error\[E\d+\]:/) || has(/^\s+(Compiling|Finished|Running) /) || has(/^running \d+ tests?$/)) return "cargo";
  if (has(/^\s+\d+:\d+\s+(error|warning)\s+/) || has(/^✖ \d+ problems?/)) return "eslint";
  const byCommand: ReadonlyArray<readonly [RegExp, RunnerId]> = [
    [/\bvitest\b/i, "vitest"], [/\bjest\b/i, "jest"], [/\bpytest\b/i, "pytest"], [/\btsc\b/i, "tsc"],
    [/\beslint\b/i, "eslint"], [/(^|\s)go\s+(test|build|vet)\b/i, "go"], [/\bcargo\b/i, "cargo"],
    [/\bnode\b.*\s--test\b/i, "node-test"],
  ];
  for (const [pattern, runner] of byCommand) if (pattern.test(command)) return runner;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Rankers: one per runner; a tier per line, DROP for a line the result omits.
// ---------------------------------------------------------------------------

type Ranker = (lines: readonly string[]) => number[];

/** Code-frame lines every JS runner prints under a failure (`   12|  code`, `  > 12 | code`, `      |   ^`). */
const CODE_FRAME = /^\s*>?\s*\d+\s*\|/;
const CODE_FRAME_CARET = /^\s*\|?\s*[\^~]+\s*$/;
const DETAIL_CAP = 30;
const FRAME_CAP = 3;

function rankVitest(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const summary = /^\s*(Test Files|Tests|Errors|Type Errors|Start at|Duration)\s+\S/;
  const separator = /^\s*[⎯─]{3,}/;
  const failHeader = /^\s*FAIL\s+\S/;
  const failedTest = /^\s*[×✗]\s+\S/;
  const frame = /^\s*❯\s+\S+:\d+/;
  const errorStart = /^\s*(\w*Error\b|Unhandled (Rejection|Error)|Vitest caught \d+)/;
  let inBlock = false;
  let frames = 0;
  let details = 0;
  lines.forEach((line, index) => {
    if (summary.test(line)) { tiers[index] = 3; inBlock = false; return; }
    if (separator.test(line)) { inBlock = false; return; }
    if (failHeader.test(line) || (!inBlock && errorStart.test(line))) {
      tiers[index] = 1; inBlock = true; frames = 0; details = 0; return;
    }
    if (failedTest.test(line)) { tiers[index] = 4; return; }
    if (!inBlock || line.trim() === "" || CODE_FRAME.test(line) || CODE_FRAME_CARET.test(line)) return;
    if (frame.test(line)) { frames += 1; tiers[index] = frames <= FRAME_CAP ? 2 : 4; return; }
    details += 1;
    tiers[index] = details <= DETAIL_CAP ? 2 : 4;
  });
  return tiers;
}

function rankJest(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const failFile = /^\s*FAIL\s+\S/;
  const passFile = /^\s*PASS\s+\S/;
  const bullet = /^\s*●\s+\S/;
  const summary = /^(Test Suites|Tests|Snapshots|Time):\s|^Ran all test suites/;
  const frame = /^\s+at\s+\S/;
  const failedTest = /^\s*✕\s+\S/;
  let inBlock = false;
  let frames = 0;
  let details = 0;
  lines.forEach((line, index) => {
    if (summary.test(line)) { tiers[index] = 3; inBlock = false; return; }
    if (failFile.test(line)) { tiers[index] = 1; inBlock = false; return; }
    if (passFile.test(line)) { inBlock = false; return; }
    if (bullet.test(line)) { tiers[index] = 1; inBlock = true; frames = 0; details = 0; return; }
    if (failedTest.test(line)) { tiers[index] = 4; return; }
    if (!inBlock || line.trim() === "" || CODE_FRAME.test(line) || CODE_FRAME_CARET.test(line)) return;
    if (frame.test(line)) { frames += 1; tiers[index] = frames <= FRAME_CAP ? 2 : 4; return; }
    details += 1;
    tiers[index] = details <= DETAIL_CAP ? 2 : 4;
  });
  return tiers;
}

function rankPytest(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const finalLine = /^={3,} .*\b(passed|failed|errors?|skipped|no tests ran)\b.* ={3,}$/;
  const section = /^={3,}\s.*\s={3,}$/;
  const testHeader = /^_{3,}\s.*\s_{3,}$/;
  const shortSummary = /^(FAILED|ERROR)\s+\S/;
  const collected = /^collected \d+ items?/;
  const assertion = /^E\s/;
  const location = /^\S+:\d+:\s*\w*(Error|Exception|Failed|Warning)?/;
  let inBlock = false;
  let details = 0;
  lines.forEach((line, index) => {
    if (finalLine.test(line)) { tiers[index] = 3; inBlock = false; return; }
    if (section.test(line)) { inBlock = false; return; }
    if (collected.test(line)) { tiers[index] = 3; return; }
    if (testHeader.test(line)) { tiers[index] = 1; inBlock = true; details = 0; return; }
    if (shortSummary.test(line)) { tiers[index] = 1; inBlock = false; return; }
    if (!inBlock || line.trim() === "") return;
    if (assertion.test(line) || line.startsWith(">") || location.test(line)) { tiers[index] = 2; return; }
    details += 1;
    tiers[index] = details <= DETAIL_CAP ? 2 : 4;
  });
  return tiers;
}

function rankTsc(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const error = /(^|\s)error TS\d+:|^error TS\d+:/;
  const found = /^Found \d+ errors?/;
  let continuation = -1;
  lines.forEach((line, index) => {
    if (error.test(line)) { tiers[index] = 1; continuation = 0; return; }
    if (found.test(line)) { tiers[index] = 3; continuation = -1; return; }
    if (continuation >= 0 && /^\s+\S/.test(line)) {
      continuation += 1;
      tiers[index] = continuation <= 6 ? 2 : 4;
      return;
    }
    if (line.trim() !== "") continuation = -1;
  });
  return tiers;
}

function rankEslint(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const problem = /^\s+\d+:\d+\s+(error|warning)\s+/;
  const summary = /^✖ \d+ problems?|^\d+ errors? and \d+ warnings? potentially fixable|^Oops! Something went wrong!/;
  let header = -1;
  let crash = -1;
  lines.forEach((line, index) => {
    if (summary.test(line)) {
      tiers[index] = line.startsWith("Oops") ? 1 : 3;
      if (line.startsWith("Oops")) crash = 0;
      header = -1;
      return;
    }
    const match = problem.exec(line);
    if (match !== null) {
      const tier = match[1] === "error" ? 1 : 4;
      tiers[index] = tier;
      if (header >= 0) tiers[header] = Math.min(tiers[header]!, tier);
      return;
    }
    if (crash >= 0 && line.trim() !== "") { crash += 1; tiers[index] = crash <= 10 ? 2 : 4; return; }
    if (line.trim() === "") { header = -1; return; }
    if (!/^\s/.test(line)) header = index;
  });
  return tiers;
}

function rankGo(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const failTest = /^\s*--- FAIL:/;
  const otherTest = /^\s*--- (PASS|SKIP|BENCH):|^=== (RUN|PAUSE|CONT|NAME)/;
  const panic = /^panic:/;
  const packageFail = /^FAIL\s+\S+/;
  const packageOk = /^(ok|PASS|FAIL)(\s|$)/;
  const buildHeader = /^# \S+/;
  const compileError = /^\S+\.go:\d+(:\d+)?:\s/;
  const noTests = /\[no test files\]/;
  let inBlock = false;
  let details = 0;
  // With `-v`, a test's log lines come BEFORE its `--- FAIL`/`--- PASS` line
  // (after `=== RUN`); they are held here until the verdict says whose they are.
  let pending: number[] = [];
  lines.forEach((line, index) => {
    if (failTest.test(line)) {
      tiers[index] = 1; inBlock = true; details = 0;
      for (const held of pending) { details += 1; tiers[held] = details <= 20 ? 2 : 4; }
      pending = [];
      return;
    }
    if (panic.test(line) || buildHeader.test(line)) {
      tiers[index] = 1; inBlock = true; details = 0; pending = []; return;
    }
    if (otherTest.test(line) || noTests.test(line)) { inBlock = false; pending = []; return; }
    if (packageFail.test(line)) { tiers[index] = 1; inBlock = false; pending = []; return; }
    if (packageOk.test(line)) { tiers[index] = 3; inBlock = false; pending = []; return; }
    if (compileError.test(line)) { tiers[index] = 1; return; }
    if (line.trim() === "") return;
    if (!inBlock) { if (/^\s/.test(line)) pending.push(index); return; }
    details += 1;
    tiers[index] = details <= 20 ? 2 : 4;
  });
  return tiers;
}

function rankCargo(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const error = /^error(\[E\d+\])?:/;
  const warning = /^warning(\[\w+\])?:/;
  const stdoutHeader = /^---- .* ----$/;
  const failedTest = /^test \S+ \.\.\. FAILED$/;
  const passedTest = /^test \S+ \.\.\. (ok|ignored)$/;
  const result = /^test result: /;
  const running = /^running \d+ tests?/;
  const failuresList = /^failures:$/;
  const progress = /^\s+(Compiling|Finished|Running|Doc-tests|Checking|Downloading|Updating) /;
  let block: "error" | "warning" | "list" | undefined;
  let details = 0;
  lines.forEach((line, index) => {
    if (line.trim() === "") { block = undefined; return; }
    if (error.test(line) || stdoutHeader.test(line)) { tiers[index] = 1; block = "error"; details = 0; return; }
    if (warning.test(line)) { tiers[index] = 4; block = "warning"; details = 0; return; }
    if (failedTest.test(line)) { tiers[index] = 1; block = undefined; return; }
    if (result.test(line) || running.test(line)) { tiers[index] = 3; block = undefined; return; }
    if (failuresList.test(line)) { tiers[index] = 4; block = "list"; return; }
    if (passedTest.test(line) || progress.test(line)) { block = undefined; return; }
    if (block === "error") { details += 1; tiers[index] = details <= 15 ? 2 : 4; return; }
    if (block === "warning") { details += 1; if (details <= 6) tiers[index] = 4; return; }
    if (block === "list") tiers[index] = 4;
  });
  return tiers;
}

/**
 * node:test, both reporters. Spec (TTY default, `--test-reporter=spec`):
 * `✖ name (0.7ms)` headers — inline in the run, and again under
 * `✖ failing tests:` where the error block follows — with the detail
 * indented deeper than the header; `ℹ tests/pass/fail/… N` summaries. TAP
 * (what `node --test` prints when piped): `not ok N - name` with its
 * indented YAML block, `ok N - name` to drop, `# pass N` / `# fail N`
 * summaries. A block ends at the first non-blank line indented no deeper
 * than its header, so a sibling test inside a suite never counts as detail.
 */
function rankNodeTest(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  const specFail = /^\s*✖\s+\S.*\(\d+(\.\d+)?ms\)\s*$/;
  const specOther = /^\s*[✔✓▶﹣]\s/;
  const specSummary = /^\s*ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;
  const failingHeader = /^\s*✖ failing tests:/;
  const location = /^test at \S+:\d+:\d+$/;
  const tapNotOk = /^\s*not ok \d+/;
  const tapOk = /^\s*ok \d+/;
  const tapSummary = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d/;
  const frame = /^\s+at\s+\S/;
  // TAP YAML keys that say nothing about why the test failed; `location:` is
  // useful but long, so it ranks after the error, code and values.
  const tapBookkeeping = /^(---|\.\.\.|duration_ms:|type:|failureType:)/;
  let headerIndent = -1;
  let tapBlock = false;
  let stackIndent = -1;
  let frames = 0;
  let details = 0;
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    if (headerIndent >= 0 && indentOf(line) > headerIndent) {
      if (tapBlock) {
        const key = line.trim();
        // The lines of a YAML `stack: |-` block are frames without the `at`.
        if (stackIndent >= 0 && indentOf(line) > stackIndent) { frames += 1; tiers[index] = frames <= FRAME_CAP ? 2 : 4; return; }
        stackIndent = -1;
        if (key.startsWith("stack:")) { stackIndent = indentOf(line); tiers[index] = 2; return; }
        if (tapBookkeeping.test(key)) { tiers[index] = 4; return; }
        if (key.startsWith("location:")) { tiers[index] = 2.5; return; }
      }
      if (frame.test(line)) { frames += 1; tiers[index] = frames <= FRAME_CAP ? 2 : 4; return; }
      details += 1;
      tiers[index] = details <= DETAIL_CAP ? 2 : 4;
      return;
    }
    headerIndent = -1;
    if (specFail.test(line) || tapNotOk.test(line)) {
      tiers[index] = 1; headerIndent = indentOf(line); tapBlock = tapNotOk.test(line); stackIndent = -1; frames = 0; details = 0; return;
    }
    if (specSummary.test(line) || tapSummary.test(line)) { tiers[index] = 3; return; }
    if (failingHeader.test(line)) { tiers[index] = 4; return; }
    if (location.test(line)) { tiers[index] = 2; return; }
    if (specOther.test(line) || tapOk.test(line)) return;
  });
  // The spec reporter prints each failing test twice: inline (older Node
  // versions with its error below it), then with its error under `✖ failing
  // tests:`. The inline copy and its detail drop to tier 4, so a single
  // failure counts (and costs) once when the budget is tight.
  const section = lines.findIndex((line) => failingHeader.test(line));
  if (section >= 0) {
    const repeated = new Set<string>();
    for (let index = section + 1; index < lines.length; index++) {
      if (tiers[index] === 1 && specFail.test(lines[index]!)) repeated.add(lines[index]!.trim());
    }
    for (let index = 0; index < section; index++) {
      if (tiers[index] !== 1 || !repeated.has(lines[index]!.trim())) continue;
      tiers[index] = 4;
      const indent = indentOf(lines[index]!);
      for (let detail = index + 1; detail < section && (lines[detail]!.trim() === "" || indentOf(lines[detail]!) > indent); detail++) {
        if (tiers[detail] === 2) tiers[detail] = 4;
      }
    }
  }
  return tiers;
}

/** Head + tail. The tail ranks first: an unknown tool's verdict is usually its last lines. */
function rankUnknown(lines: readonly string[]): number[] {
  const tiers = new Array<number>(lines.length).fill(DROP);
  let kept = 0;
  for (let index = 0; index < lines.length && kept < HEAD_LINES; index++) {
    if (lines[index]!.trim() === "") continue;
    tiers[index] = 4;
    kept += 1;
  }
  kept = 0;
  for (let index = lines.length - 1; index >= 0 && kept < TAIL_LINES; index--) {
    if (lines[index]!.trim() === "") continue;
    tiers[index] = Math.min(tiers[index]!, 3);
    kept += 1;
  }
  return tiers;
}

const RANKERS: Readonly<Record<RunnerId, Ranker>> = {
  vitest: rankVitest,
  jest: rankJest,
  pytest: rankPytest,
  tsc: rankTsc,
  eslint: rankEslint,
  go: rankGo,
  cargo: rankCargo,
  "node-test": rankNodeTest,
  unknown: rankUnknown,
};

// ---------------------------------------------------------------------------
// Safety net: a failure is a failure whatever printed it (2026-11-03, after a
// `node --test` run was classified unknown and its tail of noise lines
// displaced the one `✖` and its AssertionError).
// ---------------------------------------------------------------------------

/** Failure markers that only count at the start of a line (after indentation). */
const FAILURE_AT_START = /^\s*(?:[✖✘×✗]\s|not ok\b|panic:|error(?:\[\w+\])?:|\S+:\d+(?::\d+)?:\s+(?:fatal )?error\b)/;
/**
 * Failure words that count anywhere in a line: upper-case `FAIL`/`FAILED`/
 * `FAILURE`/`ERROR` (`--- FAIL:`, `> Task :test FAILED`, `[ERROR]`), a
 * capitalised `…Error:` (`TypeError:`, `AssertionError [ERR_ASSERTION]:`),
 * `AssertionError`, `error TS1234:`, a Node `ERR_…` code and a Python traceback.
 */
const FAILURE_ANYWHERE = /\b(?:FAIL(?:ED|URE)?|ERROR)\b|\b(?:[A-Z]\w*)?Error\b(?:\s\[[^\]]+\])?:|\bAssertionError\b|\berror TS\d+:|\bERR_[A-Z0-9_]+\b|Traceback \(most recent call last\)/;
/** `ℹ fail 1`, `# fail 1`: a runner's own count line, worth keeping even when the runner is unknown. */
const COUNT_LINE = /^\s*(?:ℹ|#)\s*(?:tests|suites|pass|fail|failed|passed|duration_ms)\b/;
const STACK_FRAME = /^\s+at\s+\S/;
/** Detail lines kept under one rescued failure line; stack frames past FRAME_CAP do not count. */
const NET_DETAIL_CAP = 12;

/** True for a line that looks like a failure in any runner's vocabulary. */
export function looksLikeFailure(line: string): boolean {
  return FAILURE_AT_START.test(line) || FAILURE_ANYWHERE.test(line);
}

/**
 * Ranks failure-looking lines the ranker left out, with the indented detail
 * under each (at most NET_DETAIL_CAP lines plus FRAME_CAP stack frames).
 *
 * An unknown runner's rescued lines take tiers 1 and 2, above its head and
 * tail (tiers 3-4), so no amount of output before or after a failure can
 * crowd it out. A recognised runner keeps its own tiers; what it dropped is
 * rescued at tiers 3.5/3.6, below its failure blocks and summary (a passing
 * test's `console.error` output must not push the real failure out) and
 * above its extra frames, warnings and tail.
 */
function applyFailureSafetyNet(lines: readonly string[], tiers: number[], recognised: boolean): void {
  const headerTier = recognised ? 3.5 : 1;
  const detailTier = recognised ? 3.6 : 2;
  let detailLeft = 0;
  let framesLeft = 0;
  let headerIndent = -1;
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const indent = line.length - line.trimStart().length;
    const eligible = !recognised || tiers[index] === DROP;
    if (detailLeft > 0 && indent > headerIndent) {
      if (STACK_FRAME.test(line)) {
        if (framesLeft > 0 && eligible) tiers[index] = Math.min(tiers[index]!, detailTier);
        framesLeft -= 1;
        return;
      }
      if (eligible) tiers[index] = Math.min(tiers[index]!, detailTier);
      detailLeft -= 1;
      return;
    }
    detailLeft = 0;
    if (!eligible) return;
    if (looksLikeFailure(line)) {
      tiers[index] = Math.min(tiers[index]!, headerTier);
      headerIndent = indent;
      detailLeft = NET_DETAIL_CAP;
      framesLeft = FRAME_CAP;
    } else if (COUNT_LINE.test(line)) {
      tiers[index] = Math.min(tiers[index]!, 3);
    }
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Candidate { index: number; text: string; tier: number }

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function statusOf(exitCode: number | null, signal: string | null | undefined): string {
  if (exitCode !== null) return `exit ${exitCode}`;
  return signal ? `killed by ${signal}` : "exit unknown";
}

/**
 * Fills the budget tier by tier (then in file order inside a tier). Once a
 * line of some tier does not fit, no line of a LOWER-ranked tier is added any
 * more, so a tail or summary line can never take the room an error line
 * needed; shorter lines of the same tier may still fit.
 */
function select(candidates: readonly Candidate[], budget: number): { chosen: Candidate[]; omittedFailureLines: number } {
  const ordered = [...candidates].sort((a, b) => a.tier - b.tier || a.index - b.index);
  const chosen: Candidate[] = [];
  let used = 0;
  let cutoffTier = DROP;
  let omittedFailureLines = 0;
  for (const candidate of ordered) {
    if (candidate.tier > cutoffTier) { if (candidate.tier === 1) omittedFailureLines += 1; continue; }
    const cost = bytesOf(candidate.text) + 1;
    if (used + cost > budget) {
      cutoffTier = Math.min(cutoffTier, candidate.tier);
      if (candidate.tier === 1) omittedFailureLines += 1;
      continue;
    }
    used += cost;
    chosen.push(candidate);
  }
  return { chosen, omittedFailureLines };
}

/**
 * `…` marks left-out lines; a gap of blank lines only is closed up silently.
 * `contentBefore[i]` counts the non-blank lines before line i.
 */
function render(header: readonly string[], chosen: readonly Candidate[], footer: readonly string[], contentBefore: readonly number[]): string {
  const body: string[] = [];
  const inOrder = [...chosen].sort((a, b) => a.index - b.index);
  let previous = -1;
  for (const candidate of inOrder) {
    if (previous >= 0 && contentBefore[candidate.index]! > contentBefore[previous + 1]!) body.push("…");
    body.push(candidate.text);
    previous = candidate.index;
  }
  return [...header, ...body, ...footer].join("\n") + "\n";
}

/**
 * The bounded result `tl run` prints: two header lines (status, runner,
 * command; log path and size), then the ranked selection in original order,
 * then — when failure headers had to be left out — one line saying how many.
 */
export function compressRunOutput(input: RunOutputSummaryInput): string {
  const limit = Math.max(512, input.limitBytes ?? DEFAULT_RUN_OUTPUT_LIMIT_BYTES);
  const text = stripAnsi(input.output);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const runner = input.runner ?? detectRunner(input.command, text);
  const tiers = RANKERS[runner](lines);
  applyFailureSafetyNet(lines, tiers, runner !== "unknown");
  // A passing run has no failure block to show, so a short tail rides along
  // when there is room: the last lines a human would glance at. A failing
  // run gets exactly what its ranker kept; the tail would only re-admit the
  // code frames and passing lines it dropped. (The unknown ranker already
  // ranks its own head and tail.)
  if (input.exitCode === 0 && runner !== "unknown") {
    let tail = 0;
    for (let index = lines.length - 1; index >= 0 && tail < TAIL_LINES; index--) {
      if (lines[index]!.trim() === "") continue;
      tiers[index] = Math.min(tiers[index]!, 5);
      tail += 1;
    }
  }
  const candidates: Candidate[] = [];
  lines.forEach((line, index) => {
    if (Number.isFinite(tiers[index])) candidates.push({ index, text: clip(line), tier: tiers[index]! });
  });
  const failureHeaders = candidates.filter((candidate) => candidate.tier === 1).length;
  // The command itself is not repeated: the caller just issued it, and the log's
  // first line carries it for anyone reading the file later.
  const duration = input.durationMs !== undefined ? ` after ${formatDuration(input.durationMs)}` : "";
  const header = [
    `${input.label ?? "tl run"}: ${input.status ?? statusOf(input.exitCode, input.signal)}${duration} (${runner})`,
    `full log: ${input.logPath} (${bytesOf(input.output)} bytes, ${lines.length} lines`
      + `${failureHeaders > 0 ? `, ${failureHeaders} failure header${failureHeaders === 1 ? "" : "s"}` : ""})`,
  ];
  const headerBytes = bytesOf(header.join("\n")) + 1;
  // Room for the gap markers and the omitted-failures line is taken off the
  // budget up front; the loop below trims if a long run of markers overshoots.
  const reserve = failureHeaders > 0 ? 80 : 40;
  let { chosen, omittedFailureLines } = select(candidates, Math.max(0, limit - headerBytes - reserve));
  const footerFor = (omitted: number): string[] =>
    omitted > 0 ? [`… ${omitted} more failure line${omitted === 1 ? "" : "s"} in the log`] : [];
  const contentBefore = new Array<number>(lines.length + 1).fill(0);
  lines.forEach((line, index) => { contentBefore[index + 1] = contentBefore[index]! + (line.trim() === "" ? 0 : 1); });
  let result = render(header, chosen, footerFor(omittedFailureLines), contentBefore);
  while (bytesOf(result) > limit && chosen.length > 0) {
    // Drop the least important chosen line (highest tier, then latest).
    let drop = 0;
    for (let i = 1; i < chosen.length; i++) {
      const a = chosen[i]!;
      const b = chosen[drop]!;
      if (a.tier > b.tier || (a.tier === b.tier && a.index > b.index)) drop = i;
    }
    if (chosen[drop]!.tier === 1) omittedFailureLines += 1;
    chosen = chosen.filter((_, i) => i !== drop);
    result = render(header, chosen, footerFor(omittedFailureLines), contentBefore);
  }
  return result;
}
