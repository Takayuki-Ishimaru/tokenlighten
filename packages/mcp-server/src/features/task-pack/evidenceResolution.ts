/**
 * evidenceResolution.ts — P1 evidence completion (DESIGN-v0.10 D7).
 *
 * A multi-concern fix pack tells the caller WHERE each bug is. It does not tell
 * it WHAT SAYS SO. Live (2026-08-02 T05c, three independent reps): the first
 * pack certified prepared/complete with every fault site content-served, and
 * the solver then spent 13-22 pre-edit TL calls hunting the same three
 * authorities — the governing contract section, a called API's declared
 * semantics, and the pinning test assert. One rep literal-searched `## 7.6`.
 * The pack had served CONTRACT.md as an 83-byte sliver at line 1514; the
 * governing section was at line 1018.
 *
 * This module resolves, per concern anchor, candidate DECISION-AUTHORITY
 * evidence in three provenance-labeled CLASSES with NO fixed ranking (D7):
 *
 *   behavioral            a test assert referencing the anchor's symbols
 *   normative.prose       a doc SECTION whose HEADING matches an anchor
 *   normative.declaration the declaring header of a symbol the fault site calls
 *   runtime-observation   descoped this wave (Q5) — reported as skipped
 *
 * NO fixed ranking is a correctness requirement, not a preference: T10-style
 * tasks make the doc normative, and stale tests exist (T04 authority
 * inversion). The caller must see class labels and decide; the server must not.
 *
 * NEUTRALITY (D7's automatic-reject rule). Every input is either derived from
 * the caller's own query or structural. There is no domain vocabulary here, and
 * none may be added — evidenceResolution.spec.ts test 11 pins that a workspace
 * of machine-generated nonsense identifiers behaves identically.
 *
 * TWO ABSOLUTE PERFORMANCE RULES (spec §6.1):
 *   1. NEVER call findReferences. It walks the whole repo with fullRecall and
 *      runs tree-sitter per file, with no cache — the same shape as the
 *      pathless-locate path that measured 74.1s cold on 2026-07-31.
 *   2. NEVER trigger an index build. A cold index means "skip this class".
 * Both are enforced statically on this module's import list by tests 7 and 8,
 * because a runtime spy on a function we simply never import passes vacuously.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isTestPath } from "@tokenlighten/skeleton-engine";

import { loadGraphIndex } from "../../graph/index.js";
import {
  fuzzyHeadingScore,
  isMarkdownPath,
  parseMarkdownHeadings,
  type MarkdownHeading,
} from "../../util/markdownSections.js";
import { assertionRefs } from "../../util/verificationPack.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type EvidenceClass = "behavioral" | "normative" | "runtime-observation";
export type EvidenceSubclass = "prose" | "declaration";

/** One resolved authority slice, always provenance-labeled. */
export interface EvidenceSlice {
  class: EvidenceClass;
  subclass?: EvidenceSubclass;
  /** Workspace-relative, POSIX separators. */
  path: string;
  /** "A-B", 1-based inclusive file lines. */
  range: string;
  /** `<rule>:<matched>` — same shape as a pack surface's `why`. */
  why: string;
  /** The anchor tokens/symbols that produced the match. */
  matched: string[];
  bytes: number;
  /** normative.prose only: the heading score that cleared the floor. */
  score?: number;
  /** Already covered by the D4 served-range ledger — the caller holds it. */
  already_served: boolean;
  /** Survived the per-class/per-concern caps; precision is defined on these. */
  selected: boolean;
  /** The slice body. Feeds the conflict detector; NEVER written to the log. */
  text: string;
}

/** What the resolver needs to know about one concern. Query-derived only. */
export interface ConcernAnchors {
  id: string;
  /** Significant tokens of the concern's own query clause. */
  tokens: string[];
  /** Symbols and file basenames of the concern's served fault sites. */
  symbols: string[];
  /** Identifiers the served fault-site bodies call. */
  callees: string[];
  /** Workspace-relative paths of the concern's served fault sites. */
  surfacePaths: string[];
}

export interface ConcernEvidence {
  id: string;
  anchor_tokens: string[];
  anchor_symbols: string[];
  anchor_callees: string[];
  resolved: EvidenceSlice[];
  class_counts: Record<string, number>;
  class_skipped: Record<string, string>;
}

export interface EvidenceCost {
  ms_total: number;
  ms_behavioral: number;
  ms_normative_prose: number;
  ms_normative_decl: number;
  ms_runtime_obs: number;
  budget_exhausted: boolean;
  docs_parsed: number;
  docs_memo_hits: number;
  graph_index: "warm" | "cold" | "absent";
  /** MUST stay 0. A non-zero value is a defect, not a slow path. */
  references_walks: number;
}

export interface EvidenceResolution {
  concerns: ConcernEvidence[];
  wouldServe: {
    slice_count: number;
    bytes: number;
    trimmed_count: number;
  };
  cost: EvidenceCost;
}

export interface EvidenceCaps {
  slicesPerClassPerConcern: number;
  bytesPerConcern: number;
  bytesTotal: number;
  normativeSliceMaxBytes: number;
  anchorSymbolsPerConcern: number;
  anchorCalleesPerConcern: number;
  docFilesScanned: number;
  testFilesScanned: number;
  /** Ancestor directories probed upward from a fault site (never a walk). */
  ancestorDepth: number;
  /** Wall-clock tripwire. Structural caps are primary; this should never fire. */
  budgetMs: number;
}

/** Mirrors READINESS_PROBE_MAX_SURFACES=2 and ~1/12 of MAX_TASK_PACK_BYTES. */
export const EVIDENCE_DEFAULT_CAPS: EvidenceCaps = {
  slicesPerClassPerConcern: 2,
  bytesPerConcern: 2048,
  bytesTotal: 6144,
  normativeSliceMaxBytes: 1024,
  anchorSymbolsPerConcern: 4,
  anchorCalleesPerConcern: 4,
  docFilesScanned: 8,
  testFilesScanned: 8,
  ancestorDepth: 6,
  budgetMs: 80,
};

/** Doc/source files above this are not authority slices; skip rather than read. */
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;
/** Lines of leading comment absorbed above a declaration. */
const DECL_DOC_COMMENT_MAX_LINES = 12;
/** Heading match floor. Below this a doc contributes nothing (never-empty trap). */
const HEADING_SCORE_FLOOR = 0.72;
/** Lines of a test file's assert window kept as the behavioral slice. */
const ASSERT_WINDOW_RADIUS = 4;
/** How far into a source file we look for its import/include lines. */
const IMPORT_SCAN_LINES = 60;

// ---------------------------------------------------------------------------
// Heading memo (the only new cache; keyed path+mtime+size, LRU-bounded)
// ---------------------------------------------------------------------------

interface HeadingMemoEntry {
  mtimeMs: number;
  size: number;
  headings: MarkdownHeading[];
  lines: string[];
}
const HEADING_MEMO_MAX = 64;
const _headingMemo = new Map<string, HeadingMemoEntry>();

// ---------------------------------------------------------------------------
// Small bounded IO
// ---------------------------------------------------------------------------

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function readBounded(abs: string): string | undefined {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) return undefined;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

function listDir(abs: string): fs.Dirent[] {
  try {
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Directories from each fault site upward to the workspace root, deduped.
 * This is the ONLY filesystem discovery this module does: O(ancestors) readdir
 * calls, never a recursive walk.
 */
function ancestorDirs(
  workspace: string,
  relPaths: readonly string[],
  depth: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of relPaths) {
    let dir = path.dirname(path.resolve(workspace, rel));
    for (let i = 0; i <= depth; i++) {
      if (!dir.startsWith(workspace)) break;
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
      if (dir === workspace) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

class Budget {
  private readonly start: number;
  exhausted = false;
  constructor(private readonly now: () => number, private readonly limitMs: number) {
    this.start = now();
  }
  /** True once the tripwire has fired. Structural caps are the real bound. */
  check(): boolean {
    if (this.exhausted) return true;
    if (this.now() - this.start > this.limitMs) this.exhausted = true;
    return this.exhausted;
  }
}

// ---------------------------------------------------------------------------
// Class: behavioral
// ---------------------------------------------------------------------------

function collectTestFiles(
  workspace: string,
  anchors: ConcernAnchors,
  caps: EvidenceCaps,
): string[] {
  const found: string[] = [];
  const push = (rel: string): void => {
    const posix = toPosix(rel);
    if (!isTestPath(posix)) return;
    if (found.includes(posix)) return;
    if (found.length < caps.testFilesScanned) found.push(posix);
  };
  for (const dir of ancestorDirs(workspace, anchors.surfacePaths, caps.ancestorDepth)) {
    for (const entry of listDir(dir)) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(workspace, abs);
      if (rel.startsWith("..")) continue;
      if (entry.isFile()) {
        push(rel);
      } else if (entry.isDirectory() && isTestPath(`${toPosix(rel)}/x`)) {
        // A test DIRECTORY one level down: its files are the candidates.
        for (const inner of listDir(abs)) {
          if (!inner.isFile()) continue;
          push(path.relative(workspace, path.join(abs, inner.name)));
        }
      }
      if (found.length >= caps.testFilesScanned) break;
    }
    if (found.length >= caps.testFilesScanned) break;
  }
  return found;
}

function resolveBehavioral(
  workspace: string,
  anchors: ConcernAnchors,
  caps: EvidenceCaps,
  budget: Budget,
): EvidenceSlice[] {
  const out: EvidenceSlice[] = [];
  // An assert names IDENTIFIERS, never a filename. A fault-site surface
  // frequently carries no `symbol` at all (its whole file is the surface), so
  // the identifiers it CALLS are the load-bearing anchors here — dropping them
  // silently zeroed this class on exactly the shape P1 exists for (a
  // multi-concern fix pack whose surfaces are whole files).
  const symbols = [...anchors.symbols, ...anchors.callees]
    .filter((anchor) => !anchor.includes("."))
    .filter((anchor, index, all) => anchor.length > 0 && all.indexOf(anchor) === index)
    .slice(0, caps.anchorSymbolsPerConcern);
  if (symbols.length === 0) return out;
  for (const rel of collectTestFiles(workspace, anchors, caps)) {
    if (budget.check()) break;
    const content = readBounded(path.resolve(workspace, rel));
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (const symbol of symbols) {
      // One anchor at a time so each hit can name the anchor that produced it.
      const refs = assertionRefs([{ rel, role: "test", content }], [symbol]);
      const first = refs[0];
      if (first === undefined) continue;
      const line = Number(first.slice(first.lastIndexOf(":") + 1));
      if (!Number.isFinite(line) || line < 1) continue;
      const start = Math.max(1, line - ASSERT_WINDOW_RADIUS);
      const end = Math.min(lines.length, line + ASSERT_WINDOW_RADIUS);
      const text = lines.slice(start - 1, end).join("\n");
      if (out.some((s) => s.path === rel && s.range === `${start}-${end}`)) continue;
      out.push({
        class: "behavioral",
        path: rel,
        range: `${start}-${end}`,
        why: `assert-window:${symbol}`,
        matched: [symbol],
        bytes: Buffer.byteLength(text, "utf8"),
        already_served: false,
        selected: false,
        text,
      });
      break; // one slice per test file keeps the candidate set honest
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Class: normative.prose
// ---------------------------------------------------------------------------

/** Bounds the depth-2 descent so a wide ancestor can never become a walk. */
const MAX_DOC_SUBDIR_PROBES = 24;

function collectDocFiles(
  workspace: string,
  anchors: ConcernAnchors,
  caps: EvidenceCaps,
): string[] {
  const found: string[] = [];
  const ancestors = ancestorDirs(workspace, anchors.surfacePaths, caps.ancestorDepth);
  const add = (abs: string): boolean => {
    const rel = toPosix(path.relative(workspace, abs));
    if (rel.startsWith("..") || !isMarkdownPath(rel)) return false;
    if (!found.includes(rel)) found.push(rel);
    return found.length >= caps.docFilesScanned;
  };

  // Depth 1: docs that sit beside the code (the common case — a project-root
  // CONTRACT.md / README.md next to the module that violates it).
  const subdirs: string[] = [];
  for (const dir of ancestors) {
    for (const entry of listDir(dir)) {
      const abs = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (add(abs)) return found;
      } else if (entry.isDirectory() && subdirs.length < MAX_DOC_SUBDIR_PROBES) {
        subdirs.push(abs);
      }
    }
  }
  // Depth 2: docs collected under a directory beside the code (docs/, doc/,
  // spec/, …). Chosen structurally — ANY single subdirectory is probed for
  // markdown rather than matching a name list, because a name list is exactly
  // the fixture vocabulary D7 rejects. Still bounded, still never recursive.
  for (const dir of subdirs) {
    for (const entry of listDir(dir)) {
      if (!entry.isFile()) continue;
      if (add(path.join(dir, entry.name))) return found;
    }
  }
  return found;
}

function headingsOf(
  workspace: string,
  rel: string,
  cost: EvidenceCost,
): HeadingMemoEntry | undefined {
  const abs = path.resolve(workspace, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) return undefined;
  const memo = _headingMemo.get(abs);
  if (memo !== undefined && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    cost.docs_memo_hits += 1;
    return memo;
  }
  const content = readBounded(abs);
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/);
  const entry: HeadingMemoEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    headings: parseMarkdownHeadings(content),
    lines,
  };
  cost.docs_parsed += 1;
  _headingMemo.delete(abs);
  if (_headingMemo.size >= HEADING_MEMO_MAX) {
    const oldest = _headingMemo.keys().next().value;
    if (oldest !== undefined) _headingMemo.delete(oldest);
  }
  _headingMemo.set(abs, entry);
  return entry;
}

/** Normalize a heading or anchor for lexical comparison. */
function normalizeLabelLocal(value: string): string {
  return value.toLowerCase().replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
}

function resolveNormativeProse(
  workspace: string,
  anchors: ConcernAnchors,
  caps: EvidenceCaps,
  budget: Budget,
  cost: EvidenceCost,
): EvidenceSlice[] {
  const out: EvidenceSlice[] = [];
  const symbols = anchors.symbols.slice(0, caps.anchorSymbolsPerConcern);
  const tokens = anchors.tokens.map(normalizeLabelLocal).filter((t) => t.length >= 3);
  if (symbols.length === 0 && tokens.length < 2) return out;

  for (const rel of collectDocFiles(workspace, anchors, caps)) {
    if (budget.check()) break;
    const doc = headingsOf(workspace, rel, cost);
    if (doc === undefined) continue;

    let best: { heading: MarkdownHeading; score: number; matched: string } | undefined;
    for (const heading of doc.headings) {
      const target = normalizeLabelLocal(heading.text);
      if (target.length === 0) continue;
      // (a) a symbol / basename the heading names.
      for (const symbol of symbols) {
        const query = normalizeLabelLocal(symbol);
        if (query.length < 3) continue;
        // A heading that literally names a FILE is unambiguous ("### 7.6
        // `<control/mixer.hpp>`" names mixer.hpp) — substring is proof.
        // A bare module stem is not: "limiter" appears inside plenty of
        // headings that are not about it, so it goes through the containment
        // ratio instead, which rewards "## 8 Limiter" (7/9) and rejects a
        // passing mention inside a long heading.
        const score = query.includes(".") && target.includes(query)
          ? 1
          : fuzzyHeadingScore(query, target);
        if (score < HEADING_SCORE_FLOOR) continue;
        if (best === undefined || score > best.score) {
          best = { heading, score, matched: symbol };
        }
      }
      // (b) two or more distinct query tokens in one heading.
      if (best === undefined) {
        const hits = tokens.filter((t) => target.includes(t));
        if (hits.length >= 2) best = { heading, score: HEADING_SCORE_FLOOR, matched: hits.join("+") };
      }
    }
    // THE NEVER-EMPTY TRAP: no match means NO evidence. similarHeadingTexts
    // would have returned the document's leading headings here; accepting that
    // would manufacture irrelevant normative evidence on every pack.
    if (best === undefined) continue;

    const start = best.heading.line;
    const end = Math.max(start, best.heading.endLine);
    let text = doc.lines.slice(start - 1, end).join("\n");
    if (Buffer.byteLength(text, "utf8") > caps.normativeSliceMaxBytes) {
      text = Buffer.from(text, "utf8").slice(0, caps.normativeSliceMaxBytes).toString("utf8");
    }
    out.push({
      class: "normative",
      subclass: "prose",
      path: rel,
      range: `${start}-${end}`,
      why: `heading-match:${best.matched}`,
      matched: [best.matched],
      bytes: Buffer.byteLength(text, "utf8"),
      score: Number(best.score.toFixed(2)),
      already_served: false,
      selected: false,
      text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Class: normative.declaration
// ---------------------------------------------------------------------------

/**
 * Quoted relative paths in a source file's head — `#include "…"`, `import …
 * from "…"`, `require("…")`. Structural: any quoted string that looks like a
 * relative path, no language keyword list.
 */
function localImportTargets(workspace: string, rel: string): string[] {
  const content = readBounded(path.resolve(workspace, rel));
  if (content === undefined) return [];
  const head = content.split(/\r?\n/, IMPORT_SCAN_LINES).join("\n");
  const out: string[] = [];
  const dir = path.dirname(path.resolve(workspace, rel));
  for (const m of head.matchAll(/["'<]([./A-Za-z0-9_\-]+\.[A-Za-z0-9_]{1,4})[">']/g)) {
    const raw = m[1]!;
    for (const base of [dir, workspace]) {
      const abs = path.resolve(base, raw);
      if (!abs.startsWith(workspace)) continue;
      const candidate = toPosix(path.relative(workspace, abs));
      if (!out.includes(candidate) && fs.existsSync(abs)) out.push(candidate);
    }
  }
  return out;
}

/** The declaration line for `callee` plus the comment block directly above it. */
function declarationSlice(
  workspace: string,
  rel: string,
  callee: string,
): { range: string; text: string } | undefined {
  const content = readBounded(path.resolve(workspace, rel));
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/);
  const decl = new RegExp(`(?:^|[^A-Za-z0-9_])${callee}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!decl.test(line)) continue;
    // A declaration, not a call: ends with `;` or opens a body on the same line.
    if (!/[;{]\s*$/.test(line.trim())) continue;
    let start = i + 1;
    let scanned = 0;
    for (let j = i - 1; j >= 0 && scanned < DECL_DOC_COMMENT_MAX_LINES; j--, scanned++) {
      const above = lines[j]!.trim();
      if (above.length === 0) break;
      if (/^(?:\/\/|\/\*|\*|#)/.test(above) || above.endsWith("*/")) {
        start = j + 1;
        if (/^\/\*/.test(above)) break;
        continue;
      }
      break;
    }
    const end = i + 1;
    return { range: `${start}-${end}`, text: lines.slice(start - 1, end).join("\n") };
  }
  return undefined;
}

function resolveNormativeDeclaration(
  workspace: string,
  anchors: ConcernAnchors,
  caps: EvidenceCaps,
  budget: Budget,
  cost: EvidenceCost,
): EvidenceSlice[] {
  const out: EvidenceSlice[] = [];
  const callees = anchors.callees.slice(0, caps.anchorCalleesPerConcern);
  if (callees.length === 0) return out;

  // Preferred: the graph index, O(1) when warm. NEVER built here — an absent
  // index means this class contributes nothing from that route.
  const graph = loadGraphIndex(workspace);
  cost.graph_index = graph === undefined ? "absent" : "warm";

  const ownPaths = new Set(anchors.surfacePaths.map(toPosix));
  const candidateHeaders: string[] = [];
  for (const rel of anchors.surfacePaths) {
    for (const target of localImportTargets(workspace, rel)) {
      if (!ownPaths.has(target) && !candidateHeaders.includes(target)) {
        candidateHeaders.push(target);
      }
    }
  }

  for (const callee of callees) {
    if (budget.check()) break;
    let hit: { rel: string; range: string; text: string } | undefined;

    const located = graph?.definition(callee);
    if (located !== undefined) {
      const rel = toPosix(located.path);
      if (!ownPaths.has(rel)) {
        const slice = declarationSlice(workspace, rel, callee);
        if (slice !== undefined) hit = { rel, ...slice };
      }
    }
    if (hit === undefined) {
      for (const rel of candidateHeaders) {
        const slice = declarationSlice(workspace, rel, callee);
        if (slice !== undefined) { hit = { rel, ...slice }; break; }
      }
    }
    if (hit === undefined) continue;
    if (out.some((s) => s.path === hit!.rel && s.range === hit!.range)) continue;
    out.push({
      class: "normative",
      subclass: "declaration",
      path: hit.rel,
      range: hit.range,
      why: `callee-declaration:${callee}`,
      matched: [callee],
      bytes: Buffer.byteLength(hit.text, "utf8"),
      already_served: false,
      selected: false,
      text: hit.text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function parseRange(range: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (m === null) return [1, 1];
  return [Number(m[1]), Number(m[2])];
}

function overlapsServed(
  slice: EvidenceSlice,
  servedSpans: ((relPath: string) => Array<[number, number]>) | undefined,
): boolean {
  if (servedSpans === undefined) return false;
  const [start, end] = parseRange(slice.range);
  return servedSpans(slice.path).some(([a, b]) => a <= start && b >= end);
}

/** Stable key for deterministic ordering (test 5 pins reproducibility). */
function orderKey(slice: EvidenceSlice): string {
  const rank = slice.class === "behavioral" ? 0 : slice.class === "normative" ? 1 : 2;
  return `${rank}:${slice.subclass ?? ""}:${slice.path}:${slice.range}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function resolveEvidence(args: {
  workspace: string;
  concerns: readonly ConcernAnchors[];
  /** D4 served-range ledger adapter: spans the caller already holds. */
  servedSpans?: (relPath: string) => Array<[number, number]>;
  /** Injectable clock (tests drive the tripwire). */
  now?: () => number;
  caps?: Partial<EvidenceCaps>;
}): EvidenceResolution {
  const caps: EvidenceCaps = { ...EVIDENCE_DEFAULT_CAPS, ...(args.caps ?? {}) };
  const now = args.now ?? Date.now;
  const workspace = path.resolve(args.workspace);
  const cost: EvidenceCost = {
    ms_total: 0,
    ms_behavioral: 0,
    ms_normative_prose: 0,
    ms_normative_decl: 0,
    ms_runtime_obs: 0,
    budget_exhausted: false,
    docs_parsed: 0,
    docs_memo_hits: 0,
    graph_index: "absent",
    references_walks: 0,
  };
  const wallStart = Date.now();
  const budget = new Budget(now, caps.budgetMs);

  const concerns: ConcernEvidence[] = [];
  let bytesTotal = 0;
  let sliceCount = 0;
  let trimmedCount = 0;

  for (const anchors of args.concerns) {
    const resolved: EvidenceSlice[] = [];
    const classSkipped: Record<string, string> = {
      // Q5: no logging/observability detector exists in either package, and
      // building one is a named follow-up. The key stays so the shape is
      // honest and the gap is visible in every record.
      "runtime-observation": "not-implemented",
    };

    if (!budget.check()) {
      const t0 = Date.now();
      resolved.push(...resolveBehavioral(workspace, anchors, caps, budget));
      cost.ms_behavioral += Date.now() - t0;
    }
    if (!budget.check()) {
      const t0 = Date.now();
      resolved.push(...resolveNormativeProse(workspace, anchors, caps, budget, cost));
      cost.ms_normative_prose += Date.now() - t0;
    }
    if (!budget.check()) {
      const t0 = Date.now();
      resolved.push(...resolveNormativeDeclaration(workspace, anchors, caps, budget, cost));
      cost.ms_normative_decl += Date.now() - t0;
    }
    if (cost.graph_index === "absent" && anchors.callees.length > 0) {
      classSkipped["normative.declaration-graph"] = "cold-index";
    }

    resolved.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

    // Selection: per-class cap, then the per-concern and global byte budgets.
    const perClass = new Map<string, number>();
    let concernBytes = 0;
    for (const slice of resolved) {
      slice.already_served = overlapsServed(slice, args.servedSpans);
      const key = `${slice.class}:${slice.subclass ?? ""}`;
      const used = perClass.get(key) ?? 0;
      const effectiveBytes = slice.already_served ? 0 : slice.bytes;
      const fits = used < caps.slicesPerClassPerConcern
        && concernBytes + effectiveBytes <= caps.bytesPerConcern
        && bytesTotal + effectiveBytes <= caps.bytesTotal;
      if (!fits) { trimmedCount += 1; continue; }
      slice.selected = true;
      perClass.set(key, used + 1);
      concernBytes += effectiveBytes;
      bytesTotal += effectiveBytes;
      sliceCount += 1;
    }

    const classCounts: Record<string, number> = {
      behavioral: 0, normative: 0, "runtime-observation": 0,
    };
    for (const slice of resolved) classCounts[slice.class] = (classCounts[slice.class] ?? 0) + 1;

    concerns.push({
      id: anchors.id,
      anchor_tokens: anchors.tokens,
      anchor_symbols: anchors.symbols,
      anchor_callees: anchors.callees,
      resolved,
      class_counts: classCounts,
      class_skipped: classSkipped,
    });
  }

  cost.budget_exhausted = budget.exhausted;
  cost.ms_total = Date.now() - wallStart;
  return {
    concerns,
    wouldServe: { slice_count: sliceCount, bytes: bytesTotal, trimmed_count: trimmedCount },
    cost,
  };
}

/** Test hook: drop the heading memo so a fresh workspace starts cold. */
export function resetEvidenceMemoForTest(): void {
  _headingMemo.clear();
}
