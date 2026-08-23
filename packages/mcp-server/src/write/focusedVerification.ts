/**
 * focusedVerification.ts — V11-06 Known-Local Fast Path v2: Focused
 * Verification.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-06 実装内容: "Focused Verification
 * としてpost SHA、parse、replacement count、changed-line cap、unexpected
 * surface、format delta、必要時file lintを同一responseで行う。" This module
 * computes every one of those checks, COMPOSED FROM EXISTING BUILDING BLOCKS
 * rather than reinventing them:
 *
 *   - "changed-line cap" IS `write/blastRadius.ts`'s existing
 *     `measureBlastRadius` — the same shrink/replaced-ratio threshold that
 *     already gates whole-file-scale single hunks elsewhere in the write
 *     path, reused rather than re-thresholded.
 *   - "parse check" IS `symbols/collectSymbols.ts`'s `collectSymbolsChecked`
 *     — the PI-06 parser-proven machinery the plan explicitly names ("PI-06
 *     parser-proven symbolとV11-01 impact signalsを利用する").
 *   - "post SHA" reuses `util/handles.ts`'s `shaOfText`, the same digest
 *     convention every other staleness/precondition check in this codebase
 *     already uses.
 *
 * DEVIATION E-8 (DESIGN-v0.11-expansion-plan-reconciliation.md §4): waves A/B
 * add ZERO new wire fields. None of `tools/searchReplaceEdit.ts`'s
 * `SearchReplaceEditResult` fields correspond to "did the parse check pass" or
 * "was the diff confined to the fingerprinted window" — there is no existing
 * field to piggyback these onto at that seam, so EVERY check produced here is
 * TRACE-ONLY for wave B (`FocusedVerificationCheck` results are meant to be
 * logged via `util/trace.ts`, never spread into a tool response). Whether any
 * of them earns a real wire field is an explicit wave-C decision through the
 * protocol-v1 freeze procedure.
 */

import { computeLineDelta } from "../util/lineDelta.js";
import { shaOfText } from "../util/handles.js";
import { languageForPathWithContent } from "../util/languages.js";
import { collectSymbolsChecked, symbolCollectorSupports } from "../symbols/collectSymbols.js";
import type { TreeSitterPaths } from "../skeleton/types.js";
import { measureBlastRadius } from "./blastRadius.js";
import { countAnchorOccurrences, FINGERPRINT_WINDOW_CHARS } from "./targetFingerprint.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface FocusedVerificationCheck {
  readonly name:
    | "replacement-count"
    | "changed-line-cap"
    | "unexpected-surface"
    | "format-delta"
    | "post-sha"
    | "parse-check";
  readonly ok: boolean;
  readonly detail: string;
  /** True when the check had nothing to verify (e.g. no post-write read supplied, or the language has no tree-sitter grammar) — never counts against `allPassed`. */
  readonly skipped?: true;
}

export interface FocusedVerificationReport {
  readonly checks: readonly FocusedVerificationCheck[];
  /** True iff every non-skipped check passed. */
  readonly allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Individual checks — each independently callable and independently testable.
// ---------------------------------------------------------------------------

/** "replacement count == expected" — an independent re-confirmation of the selector's own uniqueness check, via a DIFFERENT code path (this module never imports write/editSelector.ts). */
export function verifyReplacementCount(input: {
  readonly beforeText: string;
  readonly anchorText: string;
  readonly expectedReplacementCount: number;
}): FocusedVerificationCheck {
  const actual = countAnchorOccurrences(input.beforeText, input.anchorText);
  return {
    name: "replacement-count",
    ok: actual === input.expectedReplacementCount,
    detail: `expected ${input.expectedReplacementCount} occurrence(s) before the edit, found ${actual}`,
  };
}

/** "changed-line cap" — reuses write/blastRadius.ts's existing single-hunk threshold. `measureBlastRadius` returning null means the edit is a normal, bounded hunk (its OWN definition of "did not balloon"). */
export function verifyChangedLineCap(input: {
  readonly beforeText: string;
  readonly anchorText: string;
  readonly replacementText: string;
}): FocusedVerificationCheck {
  const delta = computeLineDelta(input.beforeText, input.anchorText, input.replacementText);
  const oldSpanEnd = delta.startLine + delta.removed - 1;
  const measure = measureBlastRadius({
    fileText: input.beforeText,
    spanStart: delta.startLine,
    spanEnd: oldSpanEnd,
    replacementText: input.replacementText,
  });
  return measure === null
    ? { name: "changed-line-cap", ok: true, detail: "edit stays within blastRadius's normal single-hunk bounds" }
    : {
        name: "changed-line-cap",
        ok: false,
        detail: `edit replaces ${measure.replacedLines}/${measure.fileLines} lines (${measure.replacedPercent}%), shrinking the file ${measure.shrinkPercent}% — exceeds blastRadius single-hunk bounds`,
      };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefixLimit: number): number {
  const max = Math.min(a.length, b.length) - prefixLimit;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** "unexpected-surface check (changes confined to the fingerprinted region)" — compares the common prefix/suffix of before/after text against the fingerprint's own window, with no dependency on a diff library. */
export function verifyChangeConfinement(input: {
  readonly beforeText: string;
  readonly afterText: string;
  /** Char offsets (into `beforeText`) of the fingerprinted span. */
  readonly spanStart: number;
  readonly spanEnd: number;
}): FocusedVerificationCheck {
  const windowStart = Math.max(0, input.spanStart - FINGERPRINT_WINDOW_CHARS);
  const windowEnd = Math.min(input.beforeText.length, input.spanEnd + FINGERPRINT_WINDOW_CHARS);

  const prefixLen = commonPrefixLength(input.beforeText, input.afterText);
  const suffixLen = commonSuffixLength(input.beforeText, input.afterText, prefixLen);
  const changeStart = prefixLen;
  const changeEndInBefore = Math.max(changeStart, input.beforeText.length - suffixLen);

  const confined = changeStart >= windowStart && changeEndInBefore <= windowEnd;
  return {
    name: "unexpected-surface",
    ok: confined,
    detail: confined
      ? "the diff is confined to the fingerprinted region"
      : `the diff spans before-text offsets [${changeStart}, ${changeEndInBefore}), which escapes the fingerprinted window [${windowStart}, ${windowEnd})`,
  };
}

/** "format delta (whitespace-only drift detection)" — disclosure-only, never fails the report: it exists to LABEL a whitespace-only change, not to block one. */
export function verifyFormatDelta(input: {
  readonly anchorText: string;
  readonly replacementText: string;
}): FocusedVerificationCheck {
  const strip = (text: string): string => text.replace(/\s+/g, "");
  const changed = input.anchorText !== input.replacementText;
  const formatOnly = changed && strip(input.anchorText) === strip(input.replacementText);
  return {
    name: "format-delta",
    ok: true,
    detail: !changed
      ? "search and replace text are identical"
      : formatOnly
        ? "edit is whitespace-only — no non-whitespace token changed"
        : "edit changes non-whitespace content",
  };
}

/** "post SHA matches expectation" — closes the loop on write/atomicWrite.ts's rename: confirms what is ACTUALLY on disk, not merely what the write intended. Skipped when the caller supplies no fresh post-write read. */
export function verifyPostSha(input: {
  readonly expectedAfterText: string;
  readonly postReadText: string | undefined;
}): FocusedVerificationCheck {
  if (input.postReadText === undefined) {
    return { name: "post-sha", ok: true, skipped: true, detail: "no post-write read supplied" };
  }
  const expected = shaOfText(input.expectedAfterText);
  const actual = shaOfText(input.postReadText);
  return {
    name: "post-sha",
    ok: expected === actual,
    detail: expected === actual ? "on-disk content matches the intended write" : `on-disk sha ${actual} does not match the intended write's ${expected}`,
  };
}

export interface ParseCheckOptions {
  readonly treeSitterPaths?: TreeSitterPaths;
  /** Injectable for tests; defaults to the real collector. */
  readonly collect?: typeof collectSymbolsChecked;
}

/** "parse check (tree-sitter where grammar exists)" — reuses PI-06's collectSymbolsChecked/symbolCollectorSupports exactly as the plan directs. Skipped (not failed) for a path/content with no tree-sitter grammar. */
export async function verifyParseCheck(
  input: { readonly path: string; readonly afterText: string },
  options: ParseCheckOptions = {},
): Promise<FocusedVerificationCheck> {
  const language = languageForPathWithContent(input.path, input.afterText);
  if (language === undefined || !symbolCollectorSupports(language)) {
    return {
      name: "parse-check",
      ok: true,
      skipped: true,
      detail: language === undefined ? "no known language for this path" : `no tree-sitter grammar for "${language}"`,
    };
  }
  const collect = options.collect ?? collectSymbolsChecked;
  const attempt = await collect(input.afterText, language, options.treeSitterPaths ?? {});
  return {
    name: "parse-check",
    ok: attempt.parserAvailable,
    detail: attempt.parserAvailable
      ? `parses cleanly as ${language} (${attempt.symbols.length} top-level declaration(s) found)`
      : `the tree-sitter grammar for "${language}" failed to load or parse the post-edit content`,
  };
}

// ---------------------------------------------------------------------------
// Composed report
// ---------------------------------------------------------------------------

export interface FocusedVerificationInput {
  readonly path: string;
  readonly beforeText: string;
  /** The content the edit intended to produce (in-memory, pre-write). */
  readonly afterText: string;
  readonly anchorText: string;
  readonly replacementText: string;
  readonly expectedReplacementCount: number;
  /** Char offsets (into `beforeText`) of the fingerprinted span. */
  readonly spanStart: number;
  readonly spanEnd: number;
  /** A fresh read taken AFTER the write landed, when the caller performed one. */
  readonly postReadText?: string;
}

export interface RunFocusedVerificationOptions extends ParseCheckOptions {
  readonly skipParseCheck?: boolean;
}

/** Runs every focused-verification check and reports whether the (non-skipped) set all passed. Trace-only this wave — see this file's header, deviation E-8. */
export async function runFocusedVerification(
  input: FocusedVerificationInput,
  options: RunFocusedVerificationOptions = {},
): Promise<FocusedVerificationReport> {
  const checks: FocusedVerificationCheck[] = [
    verifyReplacementCount({
      beforeText: input.beforeText,
      anchorText: input.anchorText,
      expectedReplacementCount: input.expectedReplacementCount,
    }),
    verifyChangedLineCap({
      beforeText: input.beforeText,
      anchorText: input.anchorText,
      replacementText: input.replacementText,
    }),
    verifyChangeConfinement({
      beforeText: input.beforeText,
      afterText: input.afterText,
      spanStart: input.spanStart,
      spanEnd: input.spanEnd,
    }),
    verifyFormatDelta({ anchorText: input.anchorText, replacementText: input.replacementText }),
    verifyPostSha({ expectedAfterText: input.afterText, postReadText: input.postReadText }),
  ];

  if (options.skipParseCheck !== true) {
    checks.push(await verifyParseCheck({ path: input.path, afterText: input.afterText }, options));
  }

  const allPassed = checks.every((check) => check.ok || check.skipped === true);
  return { checks, allPassed };
}
