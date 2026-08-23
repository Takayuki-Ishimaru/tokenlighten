// ---------------------------------------------------------------------------
// tombstone.ts — Hypothesis Tombstones for Task Reasoning IR v2 (V11-04).
//
// DESIGN-v0.10-expansion-plan-v1.3.md §7 V11-04: "Hypothesis Tombstoneへclaim、
// scope、evidence、strength、revive condition、validityを持たせる" / "weak
// rejectionはdeprioritized、strong rejectionはcomplete scope＋direct absenceを
// 要求する" / "SHA、index generation、provider coverage、user changeでnode／
// tombstoneを細粒度invalidateする" / "challenge／reviveを常に許可する".
// Acceptance: strong tombstone false rejection 0; stale tombstone 0 after a
// SHA/generation change.
//
// PURE. No store, no clock, no filesystem; every function returns fresh values.
//
// TWO STRENGTHS, TWO CONTRACTS:
//   weak   — a DEPRIORITIZATION. It says "this looked unpromising"; it never
//            licenses a completeness or absence claim, and nothing downstream
//            may treat it as proof.
//   strong — a REJECTION. It may only be built from a scope-COMPLETE search
//            plus DIRECT absence evidence, in the exact shape this repository
//            already uses for `search_files` absence (0 matches over a scope
//            the provider itself reported as complete). A strong tombstone
//            without that pair is UNCONSTRUCTIBLE: `DirectAbsenceProof`'s
//            literal `true`/`0` refuse it at the type level, and
//            `createStrongTombstone` re-refuses it at runtime for untrusted
//            input.
//
// STALENESS IS FAIL-CLOSED. A validity key that cannot be PROVED still current
// — a mismatched value, or a key type the live key set does not carry at all —
// kills the tombstone. The cost of a wrongly-killed tombstone is one repeated
// search; the cost of a wrongly-kept one is a permanently suppressed correct
// hypothesis, so the asymmetry is resolved toward re-searching.
// ---------------------------------------------------------------------------

import type {
  DirectAbsenceProof,
  EvidenceId,
  EvidenceIdentity,
  HypothesisTombstone,
  TombstoneScope,
  ValidityKey,
} from "@tokenlighten/types";

/** Claims are bounded the same way IR v1 bounds obligation claims. */
export const TOMBSTONE_CLAIM_MAX_CHARS = 200;

/** Revive conditions are prose an agent reads; bound them too. */
export const TOMBSTONE_REVIVE_MAX_CHARS = 200;

export type TombstoneRefusalReason =
  | "empty-id"
  | "empty-claim"
  | "empty-revive-condition"
  | "missing-validity-keys"
  | "incomplete-scope"
  | "missing-direct-absence"
  | "absence-not-grounded"
  | "absence-evidence-not-direct"
  | "absence-observed-matches";

export type TombstoneResult =
  | { ok: true; tombstone: HypothesisTombstone }
  | { ok: false; reason: TombstoneRefusalReason; detail: string };

export interface TombstoneInputCommon {
  id: string;
  claim: string;
  scope: TombstoneScope;
  evidenceRefs?: readonly EvidenceId[];
  reviveCondition: string;
  validityKeys: readonly ValidityKey[];
  /** Obligation ids this rejection would contradict if they ever closed. */
  contradicts?: readonly string[];
}

export interface StrongTombstoneInput extends TombstoneInputCommon {
  absence: DirectAbsenceProof;
  /** The catalog the absence evidence must resolve in, with a non-heuristic class. */
  evidenceCatalog: readonly EvidenceIdentity[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function checkCommon(input: TombstoneInputCommon): { reason: TombstoneRefusalReason; detail: string } | undefined {
  if (input.id.trim() === "") return { reason: "empty-id", detail: "a tombstone needs a stable id" };
  if (input.claim.trim() === "") return { reason: "empty-claim", detail: "a tombstone needs the claim it rejects" };
  if (input.reviveCondition.trim() === "") {
    // Plan §7: "challenge／reviveを常に許可する". A tombstone with no stated
    // revive condition is an un-appealable rejection, which this model does
    // not admit at any strength.
    return { reason: "empty-revive-condition", detail: "revive must always be possible; state its condition" };
  }
  if (input.validityKeys.length === 0) {
    // A tombstone with no invalidation basis could never go stale, which would
    // make "stale tombstone 0" vacuous instead of proved.
    return { reason: "missing-validity-keys", detail: "at least one validity key is required" };
  }
  return undefined;
}

function assemble(input: TombstoneInputCommon, strength: "weak" | "strong", absence?: DirectAbsenceProof): HypothesisTombstone {
  return {
    id: input.id,
    claim: input.claim.slice(0, TOMBSTONE_CLAIM_MAX_CHARS),
    scope: {
      kind: input.scope.kind,
      description: input.scope.description,
      ...(input.scope.paths === undefined ? {} : { paths: [...input.scope.paths] }),
      complete: input.scope.complete,
    },
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    strength,
    reviveCondition: input.reviveCondition.slice(0, TOMBSTONE_REVIVE_MAX_CHARS),
    validityKeys: input.validityKeys.map((k) => ({ type: k.type, value: k.value })),
    ...(absence === undefined ? {} : { absence: { ...absence } }),
    ...(input.contradicts === undefined ? {} : { contradicts: [...input.contradicts] }),
  };
}

/**
 * A weak tombstone: DEPRIORITIZED ONLY. It carries no scope-completeness and
 * no absence requirement precisely because it licenses nothing.
 */
export function createWeakTombstone(input: TombstoneInputCommon): TombstoneResult {
  const bad = checkCommon(input);
  if (bad !== undefined) return { ok: false, ...bad };
  return { ok: true, tombstone: assemble(input, "weak") };
}

/**
 * A strong tombstone: complete scope + DIRECT absence, or nothing. Every
 * refusal below is a "strong tombstone false rejection" that never happened.
 */
export function createStrongTombstone(input: StrongTombstoneInput): TombstoneResult {
  const bad = checkCommon(input);
  if (bad !== undefined) return { ok: false, ...bad };

  if (input.scope.complete !== true) {
    return { ok: false, reason: "incomplete-scope", detail: "a strong rejection requires a scope-complete search" };
  }
  const absence = input.absence as DirectAbsenceProof | undefined;
  if (absence === undefined) {
    return { ok: false, reason: "missing-direct-absence", detail: "a strong rejection requires direct absence evidence" };
  }
  // Re-check the literals at runtime: the type refuses a partial observation at
  // compile time, but untrusted (parsed) input reaches here as `unknown`-shaped
  // data that only claims to be a proof.
  if (absence.scopeComplete !== true) {
    return { ok: false, reason: "incomplete-scope", detail: "absence proof does not claim a complete scope" };
  }
  if (absence.observedMatches !== 0) {
    return {
      ok: false,
      reason: "absence-observed-matches",
      detail: `absence proof observed ${String(absence.observedMatches)} matches`,
    };
  }
  const evidence = input.evidenceCatalog.find((e) => e.evidenceId === absence.evidenceId);
  if (evidence === undefined) {
    return { ok: false, reason: "absence-not-grounded", detail: `absence evidence ${absence.evidenceId} is not in the catalog` };
  }
  if (evidence.evidenceClass !== "direct") {
    // Repo-wide rule: heuristic (and merely structural) evidence never closes
    // an absence. A strong rejection is an absence claim.
    return {
      ok: false,
      reason: "absence-evidence-not-direct",
      detail: `absence evidence ${absence.evidenceId} is ${evidence.evidenceClass}, not direct`,
    };
  }

  const refs = input.evidenceRefs ?? [];
  const withAbsenceRef = refs.includes(absence.evidenceId) ? refs : [...refs, absence.evidenceId];
  const common: TombstoneInputCommon = {
    id: input.id,
    claim: input.claim,
    scope: input.scope,
    evidenceRefs: withAbsenceRef,
    reviveCondition: input.reviveCondition,
    validityKeys: input.validityKeys,
    ...(input.contradicts === undefined ? {} : { contradicts: input.contradicts }),
  };
  return { ok: true, tombstone: assemble(common, "strong", absence) };
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export type TombstoneValidity =
  | { valid: true }
  | { valid: false; key: ValidityKey; cause: "value-changed" | "key-unverifiable" };

/**
 * Fail-closed validity: EVERY validity key must be matched, by type AND value,
 * against the live key set. An unmatched key type is `key-unverifiable`, which
 * is fatal for the same reason a changed SHA is — nothing proves the rejection
 * still holds.
 */
export function tombstoneValidity(
  tombstone: HypothesisTombstone,
  liveKeys: readonly ValidityKey[],
): TombstoneValidity {
  const live = new Map<string, Set<string>>();
  for (const k of liveKeys) {
    const bucket = live.get(k.type);
    if (bucket === undefined) live.set(k.type, new Set([k.value]));
    else bucket.add(k.value);
  }
  for (const key of tombstone.validityKeys) {
    const bucket = live.get(key.type);
    if (bucket === undefined) return { valid: false, key, cause: "key-unverifiable" };
    if (!bucket.has(key.value)) return { valid: false, key, cause: "value-changed" };
  }
  return { valid: true };
}

export interface TombstoneSweep {
  live: HypothesisTombstone[];
  invalidated: Array<{ id: string; key: ValidityKey; cause: "value-changed" | "key-unverifiable" }>;
}

/**
 * Drop every tombstone whose validity can no longer be proved. A SHA change, an
 * index-generation bump, a provider-coverage change and a user edit are all the
 * same event here: one key stopped matching, so the tombstone dies.
 */
export function sweepStaleTombstones(
  tombstones: readonly HypothesisTombstone[],
  liveKeys: readonly ValidityKey[],
): TombstoneSweep {
  const live: HypothesisTombstone[] = [];
  const invalidated: TombstoneSweep["invalidated"] = [];
  for (const t of tombstones) {
    const verdict = tombstoneValidity(t, liveKeys);
    if (verdict.valid) live.push(t);
    else invalidated.push({ id: t.id, key: verdict.key, cause: verdict.cause });
  }
  return { live, invalidated };
}

export interface ReviveOutcome {
  tombstones: HypothesisTombstone[];
  revived: boolean;
  /** The revived tombstone's claim, so a caller can re-open the hypothesis by name. */
  claim?: string;
}

/**
 * Revive is ALWAYS permitted (plan §7). No strength, evidence, or validity
 * check gates it: a rejection this model cannot appeal is a rejection this
 * model does not make.
 */
export function reviveTombstone(
  tombstones: readonly HypothesisTombstone[],
  id: string,
): ReviveOutcome {
  const target = tombstones.find((t) => t.id === id);
  if (target === undefined) return { tombstones: [...tombstones], revived: false };
  return {
    tombstones: tombstones.filter((t) => t.id !== id),
    revived: true,
    claim: target.claim,
  };
}

/** The strong tombstones still valid against `liveKeys` — Shadow Stop's contradiction input. */
export function liveStrongTombstones(
  tombstones: readonly HypothesisTombstone[],
  liveKeys: readonly ValidityKey[],
): HypothesisTombstone[] {
  return sweepStaleTombstones(tombstones, liveKeys).live.filter((t) => t.strength === "strong");
}
