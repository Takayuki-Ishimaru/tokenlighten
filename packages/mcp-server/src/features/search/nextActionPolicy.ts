// nextActionPolicy.ts — the search family's NextActionPolicy arbiter (PI-05
// generalization, v0.10 beta.1+).
//
// SOURCE: DESIGN-v0.10-expansion-plan-reconciliation.md §2 row PI-05 ("Absent
// as policy. Hints/next are generated per call site (searchFamily.ts
// findNext/symbolsNext, findText.ts composeHint/repeatedHitHint); precedence
// exists only as scattered comments... alpha.2 shipped the absence-first
// seed: absenceAwareHint + narrowed continuations, with the emitter and the
// rung-6 shedder sharing one builder (findScopedNext)") and
// DESIGN-v0.10-expansion-plan-v1.3.md:1386-1450 (PI-05 problem statement:
// "不在証明と『検索をまとめて』のhintが同時に出る" — an absence proof and the
// generic "batch your searches" efficiency hint competing for the same
// response, and the caller losing track of which term was absent once it
// follows the generic hint into a reshaped call).
//
// WHAT THIS MODULE IS. Before this module, `hint`/`next` shape was decided
// independently at each call site: findNext/symbolsNext/findScopedNext
// (protocol/searchFamily.ts), composeHint/absenceAwareHint/repeatedHitHint
// (features/search/find/findText.ts), and the tree family's rung-6
// continuation builder (protocol/budget/shedders/searchTree.ts). Every one
// of those is now a THIN ADAPTER over the pure functions below — the
// domain-specific TEXT (which English sentence a given scenario produces:
// "regex matched nothing...", the edit-grade vs read-grade repeated-hit
// phrasing, a `.tokenlightenignore` scope caveat, …) still lives at the call
// site, which is the only place that knows it; what moved here is the
// ARBITRATION — which fragment wins when two candidates compete for the same
// slot, and whether a candidate continuation is safe to emit at all.
//
// WHY IT IS PURE. No workspace/session/filesystem access, and no imports
// from anywhere else in this package — only plain data in (strings, arrays,
// records, booleans) and plain data out. That is what makes the precedence
// table below testable as a flat, table-driven unit-test matrix (see
// __tests__/pi/pi05HintPrecedence.spec.ts) independent of any particular
// call site, and what makes it safe for BOTH `protocol/` and `features/` to
// import without creating a cycle: this module depends on nothing of theirs.
//
// PRECEDENCE (NORMATIVE).
//
//   1. STRONG ABSENCE forbids the generic batching nudge, and forbids
//      echoing a term this SAME response already proved absent into any
//      sanctioned `next`. `decideHint` drops the `secondary` fragment
//      whenever `facts.strongAbsence` is true (never the `primary` one —
//      the absence-recovery message itself, an edit-grade candidate note, a
//      scope-exclusion caveat, etc. are never "the generic hint" and are
//      never suppressed by this rule). `absencePreservedQueries` /
//      `sanctionSearchContinuation` narrow a candidate's `queries[]` to the
//      terms NOT in `absentTerms`, and decline (return `undefined`) rather
//      than emit a continuation with nothing safe left to re-run.
//   2. A SCOPED/NARROWED continuation beats a generic one. Every candidate
//      this module's call sites build already names the narrowest
//      constructible scope (a specific file, a smaller `depth`, the exact
//      still-open `queries[]`) — there is no "blind repeat" alternative
//      anywhere in this codebase to prefer over it, so this rule is a
//      structural invariant of the candidate BUILDERS (findScopedNext,
//      symbolsNext, the tree shed's shallower-tree builder), not a
//      suppression this module performs at emit time. It therefore does not
//      compete with rule 4's hint text: a scoped `next` and the generic
//      batching hint answer different questions ("what does THIS call do
//      next" vs "should FUTURE calls be batched") and are allowed to
//      co-occur — rule 1 (strong absence) is the only thing that silences
//      the generic hint. (Pinned by findBatchingHint.spec.ts's "cap-bake"
//      case: a truncated HIT still carries both a scoped `next` and the
//      generic hint — there is no absence, so rule 1 never fires there.)
//   3. PAGING/CURSOR continuation rules are unchanged and out of this
//      module's scope. `search.references`' cursor-based continuation is
//      owned entirely by findReferences.ts's own `next_call` (F5: a cursor
//      lives only inside `next.arguments`, never at the top level) and is
//      not routed through this arbiter. If it ever is, a cursor must pass
//      through byte-identical: it is not a `queries[]` entry and must never
//      be classified as suppressible/filterable evidence by rule 1's gate.
//   4. The GENERIC batching hint applies only when nothing stronger (rule 1)
//      forbids it — it is always the lower-priority `secondary` slot in
//      `decideHint`'s two-slot composition, never the `primary` one.
//
// `decideHint` and `sanctionSearchContinuation`/`absencePreservedQueries`
// know NOTHING about which search form (find/symbols/tree) is calling them —
// that is what "extends to the tree family" means in practice: the
// suppression is enforced by having exactly ONE implementation, not by each
// family re-deriving it. Today only `find` ever supplies a `secondary` hint
// fragment or a `queries[]`-bearing candidate; symbols/tree route through
// the same gate and get an unconditional pass-through, which is what makes
// them "thin adapters" rather than a special case carved out for them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hint composition — rules 1 and 4.
// ---------------------------------------------------------------------------

/** Which slot(s) survived arbitration and ended up in the composed text. */
export type HintClass = "none" | "primary-only" | "secondary-only" | "primary-and-secondary";

export interface HintComposition {
  /**
   * Always-admissible fragment: an absence-recovery message, a repeated-hit
   * note, a scope-exclusion caveat, an empty-query notice, … Never
   * suppressed by rule 1.
   */
  readonly primary?: string;
  /**
   * The generic/efficiency-class fragment (e.g. the "batch related tokens
   * into ONE call" nudge). Dropped by rule 1 whenever `facts.strongAbsence`
   * is true.
   */
  readonly secondary?: string;
}

export interface HintDecision {
  readonly text: string | undefined;
  readonly class: HintClass;
  /** True iff a `secondary` fragment was supplied but withheld under rule 1. */
  readonly suppressedByAbsence: boolean;
}

/**
 * The one join point every search-family hint goes through. `primary` is
 * always kept; `secondary` is kept too UNLESS `facts.strongAbsence` is true,
 * in which case rule 1 drops it. When both survive they join with the
 * established " | " separator, primary first — the exact format
 * `composeHint`/`absenceAwareHint` used before this module existed.
 */
export function decideHint(
  input: HintComposition,
  facts: { readonly strongAbsence: boolean },
): HintDecision {
  const primary = input.primary;
  const secondaryOffered = input.secondary;
  const suppressedByAbsence = facts.strongAbsence && Boolean(secondaryOffered);
  const secondary = facts.strongAbsence ? undefined : secondaryOffered;

  if (primary && secondary) {
    return { text: `${primary} | ${secondary}`, class: "primary-and-secondary", suppressedByAbsence };
  }
  if (primary) {
    return { text: primary, class: "primary-only", suppressedByAbsence };
  }
  if (secondary) {
    return { text: secondary, class: "secondary-only", suppressedByAbsence };
  }
  return { text: undefined, class: "none", suppressedByAbsence };
}

// ---------------------------------------------------------------------------
// Repeated-hit hint class — the two templates `repeatedHitHint` chooses
// between. The workspace/session lookup that decides which class applies
// (`isPlausibleEditTarget`) stays at the call site, so this module stays
// free of filesystem/session access — the call site passes in the
// already-computed boolean.
// ---------------------------------------------------------------------------

export type RepeatedHitClass = "edit-grade" | "read-grade";

export function classifyRepeatedHit(editGrade: boolean): RepeatedHitClass {
  return editGrade ? "edit-grade" : "read-grade";
}

/** `where` is the caller's own `"${path} ${range} handle=${handle}"` locator string. */
export function repeatedHitHintText(where: string, hitClass: RepeatedHitClass): string {
  return hitClass === "edit-grade"
    ? `edit-grade repeated-hit candidate: ${where}; if the bundled context matches the symptom, edit this handle without another locate/read`
    : `repeated-hit cluster: ${where}; exact source bundled below — read it from here instead of another locate. Not in this session's admissible edit set, so it is context, not an established edit target`;
}

// ---------------------------------------------------------------------------
// Absence facts + absence-preserving continuation — rule 1's `next`-half.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads the PI-04 `term_results[]` shape (`{original, status, …}`) off a
 * wire-shaped body and returns the original-cased terms this exact response
 * certified `"absent"`.
 */
export function absentTermsOf(body: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const termResults = Array.isArray(body["term_results"]) ? body["term_results"] : [];
  const absent = new Set<string>();
  for (const entry of termResults) {
    if (!isRecord(entry) || entry["status"] !== "absent") continue;
    const original = entry["original"];
    if (typeof original === "string" && original !== "") absent.add(original);
  }
  return absent;
}

/** Shared empty-set singleton for call sites with no absence concept (symbols/tree). */
export const NO_ABSENT_TERMS: ReadonlySet<string> = new Set();

/**
 * Rule 1's `next`-half: never echo a term this response already proved
 * absent back into a continuation "as if unknown". `queries` passes through
 * unchanged (same reference) when nothing is absent; narrows to the
 * surviving entries when some are; declines (`undefined`) when narrowing
 * would leave nothing safe to re-run — a continuation is never emitted as a
 * no-op call. Non-string entries (should not occur on a validated
 * `queries[]`, but the input type is `unknown[]`-compatible) are never
 * treated as absent.
 */
export function absencePreservedQueries(
  queries: readonly unknown[],
  absentTerms: ReadonlySet<string>,
): readonly unknown[] | undefined {
  if (absentTerms.size === 0) return queries;
  const narrowed = queries.filter((q) => typeof q !== "string" || !absentTerms.has(q));
  return narrowed.length === 0 ? undefined : narrowed;
}

/**
 * The one gate every search-family continuation candidate passes through
 * before its call site wraps it with `emittableToolCall`. A candidate
 * without a `queries` array (every `symbols`/`tree` candidate, and a `find`
 * candidate built from a single `query` string) passes through unchanged —
 * this is what makes those call sites genuine "thin adapters" over the same
 * policy rather than a special case carved out for them. A `find` candidate
 * with a non-empty `queries` array is narrowed per `absencePreservedQueries`
 * above, and the whole candidate is withheld (`undefined`) when nothing
 * survives narrowing.
 */
export function sanctionSearchContinuation(
  candidate: Record<string, unknown> | undefined,
  facts: { readonly absentTerms: ReadonlySet<string> },
): Record<string, unknown> | undefined {
  if (candidate === undefined) return undefined;
  const queries = candidate["queries"];
  if (!Array.isArray(queries) || queries.length === 0) return candidate;
  const narrowed = absencePreservedQueries(queries, facts.absentTerms);
  if (narrowed === undefined) return undefined;
  if (narrowed === queries) return candidate;
  return { ...candidate, queries: narrowed };
}
