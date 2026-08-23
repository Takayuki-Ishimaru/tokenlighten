/**
 * targetFingerprint.ts — V11-06 Known-Local Fast Path v2: Target Fingerprint.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-06 実装内容: "Target Fingerprintを
 * `path + SHA + symbol kind + normalized signature + surrounding hash +
 * expected count`で構成する" — computed once at edit SELECTION time, then
 * RE-VERIFIED immediately before the write actually happens. Any drift
 * between those two moments refuses the edit outright: this module never
 * approximates and never retries with fuzz (受入基準: "target driftによる
 * wrong edit 0件").
 *
 * PURE. No filesystem access, no clock, no process.env — every input is a
 * string the caller already holds. `write/editSelector.ts` computes a
 * fingerprint from the file text it selected a representation against;
 * `tools/searchReplaceEdit.ts` (behind TL_FAST_PATH_V2) re-verifies it
 * against a fresh read immediately before the existing apply machinery runs,
 * and refuses through the SAME stale-handle/precondition-shaped refusal the
 * rest of the write path already uses (write/preconditions.ts's
 * `hash-mismatch` — see that module's `current_sha`/`next` convention, which
 * this module's callers mirror rather than invent a new refusal shape for).
 *
 * WHY BOTH `contentSha` AND `surroundingHash`. `contentSha` is the same
 * whole-file digest `util/handles.ts`'s `shaOfText` produces for every other
 * staleness check in this codebase (handles, `precondition:"expected-hash"`)
 * — the blunt, maximally strict signal: ANY byte anywhere in the file moved.
 * `surroundingHash` is narrower: a small window around the fingerprinted span,
 * re-locatable by re-finding `expectedCount` occurrences of the same anchor
 * text. `verifyTargetFingerprint` below treats a mismatch on EITHER as drift
 * (受入基準's "ANY drift ⇒ refuse", not "the loudest drift ⇒ refuse") — the
 * two are kept separate rather than folded into one boolean so a caller
 * building a refusal payload can name exactly what moved.
 */

import { shaOfText } from "../util/handles.js";

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/** Plan-named shape: path + SHA + symbol kind + normalized signature + surrounding hash + expected count. */
export interface TargetFingerprint {
  readonly path: string;
  /** Whole-file content digest at computation time (`util/handles.ts` shaOfText format). */
  readonly contentSha: string;
  /** Declaration kind, when the selection anchored on a parsed symbol. */
  readonly symbolKind?: string;
  /** Whitespace-normalized declaration/signature text, when applicable. */
  readonly normalizedSignature?: string;
  /** Digest of a small window around the selected span. */
  readonly surroundingHash: string;
  /** Occurrences of the anchor text this fingerprint expects — usually 1. */
  readonly expectedCount: number;
}

/** Characters of context captured on each side of the selected span for `surroundingHash`. */
export const FINGERPRINT_WINDOW_CHARS = 160;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function surroundingWindow(text: string, start: number, end: number): string {
  const from = clamp(start - FINGERPRINT_WINDOW_CHARS, 0, text.length);
  const to = clamp(end + FINGERPRINT_WINDOW_CHARS, 0, text.length);
  return text.slice(from, to);
}

/** Non-overlapping occurrence count — mirrors write/textEdit.ts's countOccurrences precisely (kept as a local copy so this module has zero imports from that battle-hardened file). */
export function countAnchorOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface ComputeFingerprintInput {
  readonly path: string;
  readonly fileText: string;
  /** Char offsets (into `fileText`) of the span the selector anchored on. */
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly expectedCount: number;
  readonly symbolKind?: string;
  readonly normalizedSignature?: string;
}

/** Computed at SELECTION time — see this file's header. */
export function computeTargetFingerprint(input: ComputeFingerprintInput): TargetFingerprint {
  const start = clamp(input.spanStart, 0, input.fileText.length);
  const end = clamp(Math.max(input.spanEnd, start), 0, input.fileText.length);
  return {
    path: input.path,
    contentSha: shaOfText(input.fileText),
    ...(input.symbolKind !== undefined ? { symbolKind: input.symbolKind } : {}),
    ...(input.normalizedSignature !== undefined ? { normalizedSignature: input.normalizedSignature } : {}),
    surroundingHash: shaOfText(surroundingWindow(input.fileText, start, end)),
    expectedCount: input.expectedCount,
  };
}

// ---------------------------------------------------------------------------
// Re-verification
// ---------------------------------------------------------------------------

export interface VerifyFingerprintInput {
  /** A FRESH read, taken as close to apply-time as the caller can manage. */
  readonly currentFileText: string;
  /** The same anchor text `computeTargetFingerprint`'s span was drawn from. */
  readonly anchorText: string;
}

export type FingerprintDriftReason =
  | "content-sha-mismatch"
  | "expected-count-mismatch"
  | "surrounding-hash-mismatch";

export interface FingerprintVerification {
  readonly ok: boolean;
  /** Every check that failed — empty when `ok`. Never approximated: any one entry refuses. */
  readonly reasons: readonly FingerprintDriftReason[];
  readonly currentContentSha: string;
  readonly currentCount: number;
}

/**
 * RE-VERIFIED immediately before apply. Returns `ok:false` the instant any of
 * the three signals disagrees with what was fingerprinted at selection time —
 * never a "close enough" partial pass. A byte-identical `currentFileText`
 * trivially passes all three (same whole-file sha ⇒ the anchor's occurrence
 * count and surrounding bytes cannot have moved either), so the common case
 * costs one sha256 over the current text and nothing else.
 */
export function verifyTargetFingerprint(
  fingerprint: TargetFingerprint,
  input: VerifyFingerprintInput,
): FingerprintVerification {
  const currentContentSha = shaOfText(input.currentFileText);
  const currentCount = countAnchorOccurrences(input.currentFileText, input.anchorText);
  const reasons: FingerprintDriftReason[] = [];

  if (currentContentSha !== fingerprint.contentSha) reasons.push("content-sha-mismatch");
  if (currentCount !== fingerprint.expectedCount) reasons.push("expected-count-mismatch");

  if (currentCount === 1 && fingerprint.expectedCount === 1) {
    const index = input.currentFileText.indexOf(input.anchorText);
    const window = surroundingWindow(input.currentFileText, index, index + input.anchorText.length);
    if (shaOfText(window) !== fingerprint.surroundingHash) reasons.push("surrounding-hash-mismatch");
  }

  return { ok: reasons.length === 0, reasons, currentContentSha, currentCount };
}
