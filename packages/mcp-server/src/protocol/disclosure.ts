// ---------------------------------------------------------------------------
// protocol v1 — the ENVELOPE-LEVEL DISCLOSURE CLASS (P3a S1, ruling 4 / [R5-21]).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md A.8.3
// (Envelope-level disclosures), A.8.1 rule E-1; A.13 row [R5-21];
// TL-R5-ADJUDICATIONS-2026-08-14 ruling 4.
//
// WHAT THIS MODULE IS. Four server-authored fields answer "WHICH TREE
// ANSWERED?" rather than "what is this result?":
//
//   cwd_corrected       the `.claire` -> `.claude` adoption the caller did not
//                       ask for                                   SUCCESS-ONLY
//   root_note           Guard 1's cross-workspace-bleed disclosure
//   workspace           the ambiguous-root disclosure
//   workspace_crossing  the nested-workspace boundary
//
// They belong to NO A.5.x member — no per-family field list owns them — so
// every family projector drops them, and before this module they were kept
// alive by TWO DUPLICATED re-injection loops: one on the success path
// (`envelope.ts`, after the family projection) and one inside `buildRefusal`
// (`refusal.ts`). Both files' own comments already named the gap verbatim, and
// ruling 4 ratified the fix: A.8 gains a named, closed envelope-level
// disclosure class, and the implementation DELETES the duplication rather than
// documenting it.
//
// WHY THEY MUST SURVIVE PROJECTION. All four are the 2026-08-09 root-mismatch
// wave's output, and every one of them exists because a measured incident ended
// with an agent reading or WRITING the wrong tree and being told plainly that
// it worked. A protocol projection that deletes a guard's disclosure re-opens
// the incident that guard closed.
//
// ONE MECHANISM, TWO POLICIES — AND WHY THE POLICIES ARE NOT MERGED.
// `carryDisclosures` below is the single implementation. It is called twice,
// because the two paths differ in ways that are byte-visible and neither
// difference is incidental:
//
//   * `cwd_corrected` is SUCCESS-ONLY by its emitter's own contract
//     (`server.ts`: "an error response reports the failure it hit, not an
//     unrelated cwd fixup"), so the refusal path carries three keys and the
//     success path four.
//   * The refusal path lands these keys in the A.5.15 ADVISORY block, which is
//     governed by A.8.1 rule E-1 (never emit `[]`/`{}`/`""`/`null` in place of
//     absence). The success path re-injects onto an already-projected body
//     whose emitter may legitimately have authored an empty value, and
//     silently dropping it there would be a NEW deletion, not a dedup.
//   * The success path must not overwrite a value the family projector already
//     placed; the refusal path builds a fresh advisory object where nothing can
//     be overwritten.
//
// Collapsing those into one call would change bytes on at least one path. The
// ruling's target is the duplicated LOGIC, and that is what this module holds:
// two call sites of one function, not two copies of one loop.
// ---------------------------------------------------------------------------

/**
 * The three disclosures that ride BOTH successes and refusals.
 *
 * Declared here rather than in `refusal.ts` because they are not a refusal
 * concept — `refusal.ts` was merely the file that happened to need them first.
 */
export const WORKSPACE_DISCLOSURE_KEYS = [
  "root_note", "workspace", "workspace_crossing",
] as const;

/**
 * The success-path class: the three above plus `cwd_corrected`.
 *
 * ORDER IS LOAD-BEARING. These keys are appended to an already-projected body,
 * so their sequence is their JSON key order on the wire and any permutation is
 * a byte change against the §6.1(b) pins. `cwd_corrected` leads because that is
 * where the pre-[R5-21] loop put it.
 */
export const SUCCESS_DISCLOSURE_KEYS = [
  "cwd_corrected", ...WORKSPACE_DISCLOSURE_KEYS,
] as const;

/**
 * How a call site wants the class applied. Both flags exist because a path
 * needs them, not to be configurable: see the module header.
 */
export type DisclosurePolicy = {
  /**
   * A.8.1 rule E-1: skip `null`, `[]`, `{}` and `""` rather than emitting them
   * in place of absence. True on the refusal path, whose destination is the
   * A.5.15 advisory block that E-1 governs.
   */
  readonly omitEmpty: boolean;
  /**
   * Never overwrite a key the destination already carries. True on the success
   * path, where a family projector may have authored the field deliberately
   * and the disclosure is only a floor.
   */
  readonly keepExisting: boolean;
};

/** The success path: four keys, no E-1 filter, never overwrite. */
export const SUCCESS_DISCLOSURE_POLICY: DisclosurePolicy = {
  omitEmpty: false,
  keepExisting: true,
};

/** The refusal path: three keys, E-1 filtered, into a fresh advisory block. */
export const REFUSAL_DISCLOSURE_POLICY: DisclosurePolicy = {
  omitEmpty: true,
  keepExisting: false,
};

/**
 * Copy the envelope-level disclosure class from an emitter's body onto a
 * projected payload, in `keys` order.
 *
 * Mutates `target` in place and appends in iteration order — which is exactly
 * why `SUCCESS_DISCLOSURE_KEYS` documents its own order as load-bearing.
 */
export function carryDisclosures(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[],
  policy: DisclosurePolicy,
): void {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (policy.keepExisting && target[key] !== undefined) continue;
    if (policy.omitEmpty && isEmptyDisclosure(value)) continue;
    target[key] = value;
  }
}

/** A.8.1 rule E-1's "empty" — `null`, `""`, `[]`, `{}`. */
function isEmptyDisclosure(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
