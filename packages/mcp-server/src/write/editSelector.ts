/**
 * editSelector.ts — V11-06 Known-Local Fast Path v2: Edit Representation
 * Selector.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-06 実装内容: "Edit Representation
 * Selectorを `unique literal -> bounded range -> symbol body -> structured
 * scalar -> orchestrated fallback` の順にする". Given an edit request's shape
 * (the `search` text the caller wants to anchor on, plus whatever scoping
 * hints are already available — a line range, a resolved symbol body, a
 * structured-config key path) and the target file's CURRENT text, this module
 * tries increasingly scoped/structured strategies, in that fixed order, and
 * stops at the first one that narrows `search` to EXACTLY ONE occurrence.
 *
 * IT NEVER APPLIES ANYTHING. `selectEditRepresentation` returns a
 * `{representation, rationale, fingerprint}` selection (plus the plumbing an
 * apply step needs: `anchorText`/`spanStart`/`spanEnd`) — the caller hands
 * that straight to the EXISTING apply machinery (`write/textEdit.ts`
 * `applySingleEdit`, `write/rangeEdit.ts`, …), which still runs its own
 * preconditions (unique-match, expected-hash, …) unchanged. This module is a
 * pre-flight decision, not a second write path.
 *
 * AMBIGUOUS MATCH ⇒ REFUSE, NEVER AUTO-PICK (受入基準: "ambiguous matchの自動
 * 選択0件"). When `search` occurs zero or 2+ times at every scope this module
 * knows how to try, `selectEditRepresentation` returns `ok:false` with a
 * `reason` fit for `TL_TRACE` — it never guesses which occurrence the caller
 * meant, and it never falls back to picking "the first one".
 *
 * PURE. No filesystem access. Occurrence counting mirrors
 * `write/textEdit.ts`'s exact (non-normalized) matching — this module
 * deliberately does NOT layer on that file's escape/indentation RECOVERY
 * heuristics: a selector deciding which representation to trust is a
 * different job from the apply-time typo-recovery `applySingleEdit` already
 * owns, and duplicating recovery here would let two independently-evolving
 * "did this really match" answers drift apart.
 */

import { computeTargetFingerprint, countAnchorOccurrences, type TargetFingerprint } from "./targetFingerprint.js";

// ---------------------------------------------------------------------------
// Representations, in the plan's fixed priority order
// ---------------------------------------------------------------------------

export const EDIT_REPRESENTATION_ORDER = [
  "unique-literal",
  "bounded-range",
  "symbol-body",
  "structured-scalar",
  "orchestrated-fallback",
] as const;

export type EditRepresentationKind = (typeof EDIT_REPRESENTATION_ORDER)[number];

// ---------------------------------------------------------------------------
// Hints — whatever scoping information the caller already has in hand. Every
// field is optional: a caller with only {path, search} (searchReplaceEdit's
// own shape) still gets the "unique literal" strategy; a caller that also
// resolved a symbol body or a structured key gets the deeper strategies too.
// ---------------------------------------------------------------------------

export interface RangeHint {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface SymbolHint {
  readonly name: string;
  readonly kind?: string;
  /** Char offsets (into `fileText`) of the symbol's declaration body. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly normalizedSignature?: string;
}

export interface StructuredScalarHint {
  /** Dot-separated config key path, e.g. "compilerOptions.strict". Only the LAST segment is used to locate candidate lines (a cheap, bounded scan — not a real structured-document parse); nesting is disambiguated by requiring the search text to match in exactly ONE candidate, same as every other strategy here. */
  readonly keyPath: string;
}

export interface SelectorHints {
  readonly range?: RangeHint;
  readonly symbol?: SymbolHint;
  readonly structuredScalar?: StructuredScalarHint;
}

export interface SelectEditRepresentationInput {
  readonly path: string;
  readonly fileText: string;
  readonly search: string;
  readonly hints?: SelectorHints;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface EditSelection {
  readonly representation: EditRepresentationKind;
  /** Human-readable, and the exact string a caller should feed to TL_TRACE (受入基準: "selector理由とfallbackをtelemetryへ残す"). */
  readonly rationale: string;
  readonly fingerprint: TargetFingerprint;
  /** The exact text matched — what the existing apply machinery's `search` argument should be. */
  readonly anchorText: string;
  /** Char offsets (into `fileText`) of the matched span. */
  readonly spanStart: number;
  readonly spanEnd: number;
}

export type EditSelectionRefusalCode = "ambiguous" | "not-found" | "unsupported";

export interface EditSelectionRefusal {
  readonly ok: false;
  readonly code: EditSelectionRefusalCode;
  readonly reason: string;
}

export type EditSelectionResult = { readonly ok: true; readonly selection: EditSelection } | EditSelectionRefusal;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function locateOnce(text: string, needle: string): { start: number; end: number } | undefined {
  const index = text.indexOf(needle);
  if (index === -1) return undefined;
  return { start: index, end: index + needle.length };
}

/** A safe (not byte-exact-boundary) substring covering 1-based inclusive lines [startLine, endLine], plus its char offset into `text` — enough to SCOPE a search, which is all the "bounded range" strategy needs. */
function sliceLines(text: string, startLine: number, endLine: number): { text: string; offset: number } | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return undefined;
  }
  const lines = text.split("\n");
  if (startLine > lines.length) return undefined;
  const clampedEnd = Math.min(endLine, lines.length);

  let offset = 0;
  for (let i = 0; i < startLine - 1; i++) offset += (lines[i]?.length ?? 0) + 1;

  let end = offset;
  for (let i = startLine - 1; i < clampedEnd; i++) {
    end += (lines[i]?.length ?? 0);
    if (i < lines.length - 1) end += 1; // account for the "\n" split ate, except past EOF
  }
  return { text: text.slice(offset, end), offset };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ScalarCandidate {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Cheap, bounded "config key: value" line scan — not a real JSON/YAML parse.
 * Matches `key: value` / `"key": value` (optionally quoted key, optional
 * trailing comma), one line at a time, and reports the VALUE token's char
 * span. A wrong-nesting false match is safe by construction: the caller still
 * requires `search` to occur in exactly one candidate's value, so a
 * same-named key at the wrong nesting level simply fails to match and
 * contributes nothing, rather than selecting a wrong target.
 */
function structuredScalarCandidates(text: string, keyName: string): readonly ScalarCandidate[] {
  const pattern = new RegExp(`^([ \\t]*"?${escapeRegExp(keyName)}"?[ \\t]*:[ \\t]*)(.*?)[ \\t]*,?[ \\t]*$`);
  const out: ScalarCandidate[] = [];
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = pattern.exec(line);
    if (match) {
      const prefix = match[1] ?? "";
      const value = match[2] ?? "";
      if (value !== "") {
        // `prefix` is the regex's own leading capture, so its length IS the
        // value's char offset within the line — no re-scan needed.
        const valueStart = offset + prefix.length;
        out.push({ value, start: valueStart, end: valueStart + value.length });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

function buildSelection(
  representation: EditRepresentationKind,
  rationale: string,
  input: SelectEditRepresentationInput,
  spanStart: number,
  spanEnd: number,
  extra: { symbolKind?: string; normalizedSignature?: string } = {},
): EditSelectionResult {
  const fingerprint = computeTargetFingerprint({
    path: input.path,
    fileText: input.fileText,
    spanStart,
    spanEnd,
    expectedCount: 1,
    symbolKind: extra.symbolKind,
    normalizedSignature: extra.normalizedSignature,
  });
  return {
    ok: true,
    selection: { representation, rationale, fingerprint, anchorText: input.search, spanStart, spanEnd },
  };
}

// ---------------------------------------------------------------------------
// The selector
// ---------------------------------------------------------------------------

export function selectEditRepresentation(input: SelectEditRepresentationInput): EditSelectionResult {
  if (input.search === "") {
    return { ok: false, code: "unsupported", reason: "empty search string carries no anchor for representation selection" };
  }

  // 1. unique literal — unscoped, whole-file.
  const wholeCount = countAnchorOccurrences(input.fileText, input.search);
  if (wholeCount === 1) {
    const span = locateOnce(input.fileText, input.search)!;
    return buildSelection("unique-literal", "search string is unique across the whole file", input, span.start, span.end);
  }

  // 2. bounded range.
  if (input.hints?.range) {
    const scoped = sliceLines(input.fileText, input.hints.range.startLine, input.hints.range.endLine);
    if (scoped && countAnchorOccurrences(scoped.text, input.search) === 1) {
      const local = locateOnce(scoped.text, input.search)!;
      return buildSelection(
        "bounded-range",
        `search string is unique within the bounded range ${input.hints.range.startLine}-${input.hints.range.endLine}`,
        input,
        scoped.offset + local.start,
        scoped.offset + local.end,
      );
    }
  }

  // 3. symbol body.
  if (input.hints?.symbol) {
    const hint = input.hints.symbol;
    const start = Math.max(0, Math.min(hint.bodyStart, input.fileText.length));
    const end = Math.max(start, Math.min(hint.bodyEnd, input.fileText.length));
    const body = input.fileText.slice(start, end);
    if (countAnchorOccurrences(body, input.search) === 1) {
      const local = locateOnce(body, input.search)!;
      return buildSelection(
        "symbol-body",
        `search string is unique within symbol "${hint.name}"'s body`,
        input,
        start + local.start,
        start + local.end,
        { symbolKind: hint.kind, normalizedSignature: hint.normalizedSignature },
      );
    }
  }

  // 4. structured scalar (config keys).
  if (input.hints?.structuredScalar) {
    const keyPath = input.hints.structuredScalar.keyPath;
    const segments = keyPath.split(".").filter((s) => s !== "");
    const keyName = segments[segments.length - 1];
    if (keyName !== undefined) {
      const candidates = structuredScalarCandidates(input.fileText, keyName);
      const matches = candidates.filter((c) => countAnchorOccurrences(c.value, input.search) === 1);
      if (matches.length === 1) {
        const only = matches[0]!;
        const local = locateOnce(only.value, input.search)!;
        return buildSelection(
          "structured-scalar",
          `search string uniquely matches the structured value at key "${keyPath}"`,
          input,
          only.start + local.start,
          only.start + local.end,
        );
      }
    }
  }

  // 5. orchestrated fallback — every strategy above failed to reach a unique
  // match. Refuse; never auto-pick (受入基準).
  if (wholeCount === 0) {
    return {
      ok: false,
      code: "not-found",
      reason: "search string does not occur in the file, and no scoping hint (range/symbol/structured key) locates it either — orchestrated fallback required",
    };
  }
  return {
    ok: false,
    code: "ambiguous",
    reason: `search string occurs ${wholeCount} times across the whole file, and no scoping hint (range/symbol/structured key) narrows it to exactly one — never auto-picked, orchestrated fallback required`,
  };
}
