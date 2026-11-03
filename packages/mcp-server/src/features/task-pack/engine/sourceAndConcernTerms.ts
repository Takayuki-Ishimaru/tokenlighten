// sourceAndConcernTerms — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { TaskPackSurface } from "../model.js";
import { LITERAL_SURFACE_DUTY_MANIFEST_BASENAMES } from "./changeAndReadinessEvidence2.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isAuxiliaryTreePath } from "./queryIntent3.js";
import { parseSurfaceSpan } from "./packState2.js";
import { scanLiteral } from "../../search/find/findText.js";

export function evidenceSurfacesForPath(priorEvidence: readonly TaskPackSurface[], relPath: string): TaskPackSurface[] {
  return priorEvidence.filter((surface) => surface.path === relPath && hasServedCode(surface));
}

export function servedPathSet(priorEvidence: readonly TaskPackSurface[]): Set<string> {
  return new Set(priorEvidence.filter(hasServedCode).map((surface) => surface.path));
}

/** Workspace files whose basename resolves a bare filename term (never fabricated — only real `universe` entries). */
export function fileTermCandidatePaths(workspace: string, universe: FindTextUniverse, term: string): string[] {
  if (!term.includes("/") && !term.includes("\\")) {
    const direct = path.join(workspace, term);
    try {
      if (fs.statSync(direct).isFile()) return [term];
    } catch { /* fall through to a universe scan */ }
  }
  const lowerTerm = term.toLowerCase();
  // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository): the
  // product's file first, a `bench/fixtures/…` or test copy of the same
  // basename after it — the request-item engine takes these in order, and the
  // alphabetical walk put the synthetic project's copy ahead of the real one.
  return productPathsFirst(universe.files
    .filter((f) => f.relPath.toLowerCase() === lowerTerm || path.basename(f.relPath).toLowerCase() === lowerTerm)
    .map((f) => f.relPath));
}

/**
 * The product-tree paths of `paths` when there are any, else `paths` as given.
 * A basename the question names once means ONE file: when the product has it,
 * a `bench/fixtures/…`, test or example copy of the same name is not a second
 * candidate for that name (`isAuxiliaryTreePath`); a workspace whose every copy
 * is auxiliary keeps them all, so recall is never reduced.
 */
export function productPathsFirst(paths: readonly string[]): string[] {
  const product = paths.filter((p) => !isAuxiliaryTreePath(p));
  return product.length > 0 ? product : [...paths];
}

/** Root-level manifest files actually present, for a `definition` item naming no explicit file term. */
export function manifestCandidatePaths(workspace: string): string[] {
  const out: string[] = [];
  for (const name of LITERAL_SURFACE_DUTY_MANIFEST_BASENAMES) {
    try {
      if (fs.statSync(path.join(workspace, name)).isFile()) out.push(name);
    } catch { /* not present */ }
  }
  return out;
}

/** Files where `identifier` is DECLARED (function/class/const/...), falling back to every literal occurrence if no declaration-shaped line exists. */
/** A line declaring `identifier` (function/class/const/...) — shared by declarationCandidatePaths' candidate scan and declarationRangeInFile's brace/indent fallback anchor below. */
export function declarationLineRegex(identifier: string): RegExp {
  return new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var|struct|fn|func|def)\\s+${escapeRegExp(identifier)}\\b`,
  );
}

export function declarationCandidatePaths(
  workspace: string,
  universe: FindTextUniverse,
  identifier: string,
  contentCache?: ScanContentCache,
): string[] {
  const matches = scanLiteral(identifier, workspace, { files: universe.files, ...(contentCache ? { contentCache } : {}) });
  const declRe = declarationLineRegex(identifier);
  const declPaths = new Set<string>();
  const anyPaths = new Set<string>();
  for (const match of matches) {
    anyPaths.add(match.path);
    if (match.text !== undefined && declRe.test(match.text)) declPaths.add(match.path);
  }
  return declPaths.size > 0 ? [...declPaths].sort() : [...anyPaths].sort();
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 R1 false-completion fix (2026-09-07, P1): line-range coverage.
//
// `proveRequestItem`'s decision arm used to credit a candidate definition
// site as soon as ANY content was served for its PATH (`servedPathSet` /
// `served.has(p)`) — a range:"1-20" prefix read of a ~35-line function whose
// real decision logic sits in its last lines was enough. Design §4.2:
// satisfaction requires the window backing the point (here, the
// identifier's OWN declaration/implementation body) to actually be on the
// wire — never a path-level "already read" flag. These helpers compute the
// union of a path's genuinely served line spans (see epochServedEvidence's
// own comma-joined multi-range `TaskPackSurface.range` for cross-pack
// carried-forward evidence, and content_completeness:"partial"'s
// remaining_ranges for a same-pack body-stripped/centered-trimmed surface —
// both are respected here, mirroring isWholeAuthoritySurface's own
// partial-awareness) and check it against the identifier's resolved
// declaration range.
// ---------------------------------------------------------------------------

export interface LineSpan { start: number; end: number; }

/** Parse ONE OR MORE comma-joined "N-M" spans. `epochServedEvidence` joins a path's several same-epoch ledger ranges into one comma-separated `range` string; every other surface producer emits exactly one "N-M" segment, which this also accepts (a single-piece split). Malformed pieces are skipped, never thrown. */
export function parseSurfaceSpans(range: string | undefined): LineSpan[] {
  if (range === undefined) return [];
  const out: LineSpan[] = [];
  for (const piece of range.split(",")) {
    const parsed = parseSurfaceSpan(piece);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** Merge overlapping/adjacent spans into a sorted, non-overlapping list. */
export function mergeLineSpans(spans: readonly LineSpan[]): LineSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

/** Subtract `holes` from `span`, returning the remaining covered sub-spans (0, 1, or 2+ pieces). */
export function subtractLineSpans(span: LineSpan, holes: readonly LineSpan[]): LineSpan[] {
  let pieces: LineSpan[] = [span];
  for (const hole of holes) {
    const next: LineSpan[] = [];
    for (const piece of pieces) {
      if (hole.end < piece.start || hole.start > piece.end) { next.push(piece); continue; }
      if (hole.start > piece.start) next.push({ start: piece.start, end: Math.min(hole.start - 1, piece.end) });
      if (hole.end < piece.end) next.push({ start: Math.max(hole.end + 1, piece.start), end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.start <= p.end);
}

/**
 * Every line span actually served across `surfaces` (already filtered to one
 * path by the caller, e.g. via `evidenceSurfacesForPath`) — DESIGN-v0.15
 * §4.2's "現在のsource revisionに対応した窓". A `content_completeness:
 * "partial"` surface contributes its `range` MINUS `remaining_ranges` —
 * mirrors `isWholeAuthoritySurface`'s own partial-awareness — never the full
 * nominal range a body-stripped/centered-trimmed surface merely claims. A
 * surface with an unparseable/absent `range` contributes nothing (the safe
 * direction: never credited as covering anything).
 */
export function servedLineSpansOf(surfaces: readonly TaskPackSurface[]): LineSpan[] {
  const out: LineSpan[] = [];
  for (const surface of surfaces) {
    const spans = parseSurfaceSpans(surface.range);
    if (spans.length === 0) continue;
    if (surface.content_completeness === "partial") {
      const holes = (surface.remaining_ranges ?? []).flatMap((r) => parseSurfaceSpans(r));
      for (const span of spans) out.push(...subtractLineSpans(span, holes));
    } else {
      out.push(...spans);
    }
  }
  return mergeLineSpans(out);
}

/** True when `target` has no line left uncovered by `spans` (already merged, non-overlapping). */
export function lineSpansCover(spans: readonly LineSpan[], target: LineSpan): boolean {
  return spans.some((span) => span.start <= target.start && span.end >= target.end);
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 R1 false-completion fix continued (2026-09-07, P1 review
// finding): the ORIGINAL `braceOrIndentBalancedDeclarationExtent` counted
// every literal `{`/`}` CHARACTER with no lexical context at all — a `}`
// inside a string literal (reported repro: `const closing = String("}");`
// as a decision function's own FIRST statement) was miscounted as the
// function's closing brace, truncating the computed range to just that one
// statement. A served `range:"1-20"` prefix then trivially "covered" the
// (wrongly short) computed range and the pack reached `act.answer` without
// ever serving the real decision at the function's tail — see
// explorationContinuationFixtures.ts's "decision-at-function-tail-brace-in-
// string" fixture and requestItemCompletion.spec.ts's matching regression.
//
// `lexicalDeclarationExtent` — the brace/indent lexer those repros kept
// defeating — is DELETED (2026-09-07 P1 ruling; see its tombstone comment
// below `regexLiteralCloseIndex`). `isRegexLiteralStartAt`/
// `regexLiteralCloseIndex` survive only as the RELATION arm's lexical
// helpers (`isInsideRegexLiteralAt`), where a wrong answer cannot bound a
// declaration or close a point on its own. `isEscapedAt` (below, shared
// with `isInsideQuotesAt`) is reused rather than re-implemented.
// ---------------------------------------------------------------------------

/**
 * True when a `/` at `line[index]` most likely opens a REGEX LITERAL rather
 * than a division operator: the character preceding it (skipping
 * whitespace) is an operator, `(`, `,`, `=`, `:`, `;`, an opening bracket, or
 * the line ends in a keyword a regex may legally follow (`return`,
 * `typeof`, `case`, ...). A `/` after an identifier, digit, `)`, or `]` is
 * division, never a regex start. Deliberately conservative: a missed regex
 * just leaves its `/.../ ` characters lexed as ordinary code, which can only
 * WIDEN a computed extent — never narrow one below the true declaration, so
 * getting this heuristic wrong is safe in the direction that matters here.
 * Shared with `isCallOrImportOccurrence` below (design §4.1's relation proof)
 * so a regex-literal mention of a producer identifier is never mistaken for
 * a call/import occurrence either.
 */
/**
 * Keywords after which a `/` can only start a regex literal (no operand can
 * precede the `/`). Checked as a WHOLE preceding token — the P1 follow-up
 * (2026-09-07) was exactly `return /}/.test(...)`: the old code inspected only
 * the character before the `/`, saw `return`'s trailing `n` (an identifier
 * character), classified the `/` as division, and then counted the `}` inside
 * the regex as the function's closing brace.
 */
export const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "case", "instanceof", "in", "of", "yield", "throw", "new",
  "delete", "void", "else", "do", "await",
]);

/**
 * Keywords whose parenthesised CONDITION a `/` may directly follow as a
 * regex literal: `if (x) /re/.test(x)` is a regex, while `foo(x) / 2` is
 * division. P1 follow-up (2026-09-07), reported form 1: the old code
 * classified EVERY `)` as "a value just ended, so `/` is division" and then
 * counted the `}` inside `/}/ ` as a closing brace.
 */
export const REGEX_PRECEDING_CONDITION_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);

/**
 * Index of the last character of the token preceding `index` on `line`,
 * skipping whitespace AND whole `/* ... *\/` block comments — P1 follow-up
 * (2026-09-07), reported form 2: `return /* probe *\/ /}/.test(x)` hid the
 * `return` keyword from a scan that only skipped whitespace. Returns -1 when
 * nothing but whitespace/comments precedes `index`. A `// ...` line comment
 * needs no handling here: everything after it IS comment, so no code
 * position can follow one on the same line.
 */
export function previousTokenEndIndex(line: string, index: number): number {
  let i = index - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(line[i]!)) i--;
    if (i >= 1 && line[i] === "/" && line[i - 1] === "*") {
      const open = line.lastIndexOf("/*", i - 2);
      if (open < 0) return -1;
      i = open - 1;
      continue;
    }
    return i;
  }
}

/**
 * True when the `)` at `closeIndex` closes an `if`/`while`/`for`/`with`
 * CONDITION — matched back to its own `(` by paren depth, then the token
 * before that `(` must be one of those keywords as a whole word. Naive about
 * parens inside string/regex literals on the same line (same documented
 * "conservative heuristic" scope as `isInsideQuotesAt` above): a wrong
 * answer here can only mis-lex a `/` on one line, never widen or narrow a
 * PROOF — declaration ranges come from the AST alone (see
 * `declarationRangeInFile` below).
 */
export function closesControlFlowCondition(line: string, closeIndex: number): boolean {
  let depth = 0;
  let i = closeIndex;
  for (; i >= 0; i--) {
    const ch = line[i]!;
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i < 0 || depth !== 0) return false;
  const before = previousTokenEndIndex(line, i);
  if (before < 0) return false;
  const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(line.slice(0, before + 1));
  if (word === null) return false;
  const wordStart = before + 1 - word[1]!.length;
  if (wordStart > 0 && /[A-Za-z0-9_$.]/.test(line[wordStart - 1]!)) return false;
  return REGEX_PRECEDING_CONDITION_KEYWORDS.has(word[1]!);
}

export function isRegexLiteralStartAt(line: string, index: number): boolean {
  const i = previousTokenEndIndex(line, index);
  if (i < 0) return true;
  const prevChar = line[i]!;
  if (/[A-Za-z0-9_$]/.test(prevChar)) {
    // An identifier-shaped token ends right before the `/`. A value
    // (identifier, number, `obj.prop`) makes it division; one of the
    // keywords above makes it a regex. The keyword must be a whole word
    // (not `x.return`, not `myreturn`).
    const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(line.slice(0, i + 1));
    if (word === null) return false;
    const wordStart = i + 1 - word[1]!.length;
    if (wordStart > 0 && /[A-Za-z0-9_$.]/.test(line[wordStart - 1]!)) return false;
    return REGEX_PRECEDING_KEYWORDS.has(word[1]!);
  }
  if (prevChar === ")") return closesControlFlowCondition(line, i);
  if (prevChar === "]") return false;
  if ("(,=:;!&|?+-*%^~{[".includes(prevChar)) return true;
  return false;
}

/**
 * Index of the unescaped closing `/` of a regex literal opening at
 * `line[start]` (character-class contents `[...]` are skipped whole, since a
 * literal `/` inside a class does not close the regex). Returns
 * `line.length` when unterminated on this line (defensive only — real code
 * always closes a regex literal on the line it opens).
 */
export function regexLiteralCloseIndex(line: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") { i += 2; continue; }
    if (ch === "[") { inClass = true; i++; continue; }
    if (ch === "]") { inClass = false; i++; continue; }
    if (ch === "/" && !inClass) return i;
    i++;
  }
  return line.length;
}

/**
 * DESIGN-v0.15 R1 P1 ruling (2026-09-07): `lexicalDeclarationExtent` — a
 * hand-written brace/indent lexer that used to run as the always-computed
 * FALLBACK declaration-range source here, merged "wider wins" with the AST —
 * IS DELETED. Three separate reports produced the same class of defect
 * against it (a `}` inside a string; `return /}/`; then `if (x) /}/` and a
 * block comment between `return` and the regex), each one truncating a
 * ~35-line function to a couple of lines, which a short prefix read then
 * trivially "covered" — a false completion. Patching the lexer's Nth trap
 * only postpones the (N+1)th: design §4.1/§4.2 require that an unobtainable
 * relation is never filled in by guesswork and that anything the analysis
 * cannot establish is reported as UNCONFIRMED. So the lexer is gone from the
 * proof path entirely and `declarationRangeInFile` below answers with the
 * AST or with "unresolved" — never with an estimate.
 *
 * `isRegexLiteralStartAt`/`regexLiteralCloseIndex` above survive because
 * `isInsideRegexLiteralAt` (the relation arm's call/import scanner) still
 * uses them; they bound no declaration and prove nothing on their own.
 */

/**
 * What the AST — and ONLY the AST — can say about `identifier`'s own
 * declaration/implementation body in `relPath`'s CURRENT content.
 * DESIGN-v0.15 R1 P1 ruling (2026-09-07).
 *
 * - `{source:"ast", span}`: tree-sitter genuinely resolved `identifier` in
 *   THIS file during the async pre-pass (`resolveDecisionAstRanges` below —
 *   `collectSymbols`, a real parse), clamped to the file's own logical line
 *   count. `proveRequestItem` requires the served windows to cover `span`.
 * - `{source:"unresolved"}`: no grammar for this file's language, the parse
 *   found no such declaration, the candidate fell outside the pre-pass'
 *   bound, no prewalk context is active at all (a caller that bypasses
 *   `buildTaskPack`'s ALS wrapper, as several readiness specs do with
 *   synthetic results), or the file cannot be read. The declaration range is
 *   then UNCONFIRMED — never estimated. `proveRequestItem` proves such a
 *   candidate only from WHOLE-FILE coverage, which bounds any declaration
 *   range without trusting a heuristic.
 *
 * There is deliberately no third, "best effort" answer: the deleted
 * `lexicalDeclarationExtent` (see its tombstone comment above) was exactly
 * that, and it produced three separate false completions.
 */
export type DeclarationResolution =
  | { source: "ast"; span: LineSpan }
  | { source: "unresolved" };
