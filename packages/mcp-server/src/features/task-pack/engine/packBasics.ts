// packBasics — extracted implementation; imports point to the owning modules.
import type { CompoundRequestPlan } from "../compoundRequests.js";
import type { ContinuationPlan } from "../../../util/continuation.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { RequestItem } from "../requestItems.js";
import type { TaskPackArgs } from "../model.js";
import type { ToolCall } from "@tokenlighten/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_RESPONSE_BYTE_FLOOR } from "../../../tools/readCodeModes.js";
import { activeEngineConfiguration } from "../../engines/config.js";
import { resolveCallerByteCeiling } from "../../../tools/readCodeModes.js";

export type ContinuationCall = ToolCall & { purpose?: string };

export type ContinuationLike = {
  readonly tool: string;
  readonly arguments: { readonly [key: string]: unknown };
  readonly purpose?: string;
};

export function canonicalContinuationCall(call: ContinuationLike | undefined): ContinuationCall | undefined {
  return call as ContinuationCall | undefined;
}

export function deriveNextFromPlan(plan: ContinuationPlan): ContinuationCall | undefined {
  return plan.stages[0]?.calls[0] as ContinuationCall | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Serialized JSON byte cap for a task_pack response, at the LOWEST
 * confidence tier (no code-bearing surfaces). Scales up via
 * capForResult() when high-confidence/required surfaces carry embedded
 * code, so the pack can close the task in one read instead of forcing
 * follow-up slice calls — while staying far short of a full-file dump.
 *
 * Host-safe serve budget (2026-08-17): 22 KiB leaves room for the protocol
 * envelope so desktop clients keep the pack inline instead of externalizing it
 * to content.json, while preserving the minimum multi-surface skeleton.
 * Code-bearing tiers remain independently bounded by capForResult().
 */
export const MAX_TASK_PACK_BYTES = 22 * 1024;

/** Minimum caller budget that can carry the smallest honest task-pack envelope. */
export const REQUIRED_MIN_TASK_PACK_BYTES = 6144;

export function admitTaskPackBudget(args: Pick<TaskPackArgs, "maxBytes" | "maxTokens">): Record<string, unknown> | undefined {
  const requested = resolveCallerByteCeiling(args.maxBytes, args.maxTokens, undefined);
  return requested !== undefined && requested < REQUIRED_MIN_TASK_PACK_BYTES
    ? taskPackBudgetRefusal(requested, REQUIRED_MIN_TASK_PACK_BYTES)
    : undefined;
}

/** Internal-only proof fence: caller budgets below the construction floor are
 * refused before this builder, so reaching a failed assertion is a programming
 * error rather than a wire-visible task-pack outcome. */
export function assertTaskPackConstructionInvariant(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`unreachable task-pack construction invariant: ${detail}`);
}

export function taskPackBudgetRefusal(requested: number, requiredMin: number): Record<string, unknown> {
  return {
    kind: "refusal",
    code: "budget-below-minimum",
    field: "budget.bytes",
    required_min_bytes: requiredMin,
    retry: "call",
    ...(requested < DEFAULT_RESPONSE_BYTE_FLOOR
      ? { budget_floor_applied: { requested, applied: DEFAULT_RESPONSE_BYTE_FLOOR } }
      : {}),
  };
}

/**
 * Upper bound of the confidence-scaled cap (see capForResult()). Kept at the
 * 32 KiB transport-safe ceiling so it stays >= the raised base floor
 * (MAX_TASK_PACK_BYTES): a code-bearing pack must never be trimmed HARDER than
 * a code-less discovery pack, which is exactly the inversion a base-only bump
 * would introduce (base 24576 > old high 16384). Raised 16384 -> 32768.
 */
export const MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE = 32768;

/** Three independent concerns need an additive but still bounded proof tier. */
export const MAX_TASK_PACK_BYTES_MULTI_CONCERN = 32768;

/**
 * Hard transport-safe ceiling for semantic wiring. Claude Code persists larger
 * MCP payloads out-of-band, which turns an otherwise valid pack into an
 * unparseable tool result for the solver.
 */
export const MAX_TASK_PACK_BYTES_SEMANTIC_WIRING = 32768;

/**
 * Constructed receivers carry post-edit structural and executable proof.
 *
 * B2a ceiling decision (2026-08-01, second pass): RAISED 32768 -> 49152 for
 * construct-receiver proof packs ONLY. Numbers, not vibes: the measured T13
 * alternative to one complete pack was a 10-call, 72-77KB full-read cascade
 * plus 6-8 api turns per rep — strictly costlier than +16KB of one-shot
 * transport. Clamp safety: the only observed client clamp is token-based
 * (~25k tokens; the 2026-07-31 T05c incident clamped a 52KB single-line
 * markdown blob at roughly 2.5 chars/token). A 47-49KB wiring pack is JSON +
 * C-family code at ~3 chars/token ≈ 16k tokens — comfortably inside — and
 * semanticSignalRegression.spec.ts still pins >= 1536B of headroom under the
 * NEW ceiling so envelope creep is caught before it re-saturates. Measured at
 * this ceiling: hub 4.7KB->16984B complete, produced-class header 122B->1631B
 * complete, pack 47178B, phase prepared. The wiring-envelope diet (evidence
 * graph + structural checks + certificate ≈ 15.7KB ≈32% of this budget) stays
 * a worthwhile follow-up but is no longer the blocker.
 */
export const MAX_TASK_PACK_BYTES_CONSTRUCT_PROOF = 49152;

/**
 * EFF (TL_EFF_HUB_WHOLE, default OFF): headroom added to the construct-proof
 * ceiling while the construction hub is served whole, so the hub's extra
 * bytes do not push the review declarations out (T13, 2026-10-02: a whole
 * 16.7 KB hub under the unchanged ceiling dropped mavlink_dialect.hpp and
 * position_estimator.hpp's body). ~57 KB of JSON + C is ~19k tokens, inside
 * the ~25k-token client clamp the ceiling's own doc block cites.
 */
export const HUB_WHOLE_EXTRA_CAP_BYTES = 8192;

/**
 * B2a: per-surface completeness bar for a construct-receiver wiring frontier —
 * a required surface at or under this size is served WHOLE (no teaser, no
 * remaining_ranges). Larger files keep the anchored window plus disclosed
 * remaining_ranges.
 */
export const WIRING_COMPLETE_SURFACE_BYTES = 24576;

/** Companion line bound for WIRING_COMPLETE_SURFACE_BYTES (bytes are the real gate). */
export const WIRING_COMPLETE_SURFACE_LINES = 4096;

/**
 * B2a: bytes of COMPLETE bodies a construct-receiver pack may spend on
 * NON-priority surfaces.
 *
 * The two priority surfaces — the construction hub and the produced class's
 * declaration — are never refused: they are the measured triggers (all three
 * T13 reps opened with `mode=full` of the hub, and the declaration arrived as a
 * 122-byte stub). Everything else draws from this budget, which is what keeps
 * the pack inside MAX_TASK_PACK_BYTES_CONSTRUCT_PROOF once the ~15KB semantic
 * envelope (evidence graph, structural checks, certificate) is accounted for.
 * A surface refused here is NOT dropped — it keeps the anchored window plus
 * disclosed remaining_ranges it has always had, which is strictly better than
 * having trimToCap strip its body to nothing.
 */
export const CONSTRUCT_COMPLETE_EXTRA_BUDGET = 10240;

/**
 * A2 (v0.12, DESIGN-v0.12-plan.md §2 柱A) — EDIT-HUNK FRONTIER.
 *
 * Anchored-window budget of a construction-hub excerpt. Extracted verbatim from
 * the literal `6 * 1024` the Wave-4 ladder used, so the radius the ladder picks
 * is bit-for-bit the one it picked before A2.
 */
export const HUB_EXCERPT_BUDGET_BYTES = 6 * 1024;

/**
 * A2: bytes the VERBATIM (comment-preserving) landing-region window may add on
 * top of HUB_EXCERPT_BUDGET_BYTES.
 *
 * WHY 4096: `buildSemanticTaskWiringProfile` already spends exactly 4096 bytes
 * per REVIEW surface on this same construct-receiver path (`reviewEvidenceBytes`).
 * The edit-hunk window is therefore capped at one review surface's worth of
 * bytes — an existing evidence cap on this exact code path, not a new budget
 * concept. It is enforced TWICE: on the DELTA over the plain excerpt (the hunk
 * can never cost more than one review surface) and on the absolute total, and
 * only ever at the radius whose plain build already fit — so A2 can never
 * displace or shrink other frontier evidence beyond what the pre-A2 cap logic
 * already did.
 */
export const HUB_EDIT_HUNK_MAX_BYTES = 4096;

/**
 * A2: landing-window radii tried widest-first until the window's VERBATIM text
 * fits HUB_EDIT_HUNK_MAX_BYTES. No radius fitting means no hunk, i.e. today's
 * behavior — the excerpt is never widened on a guess.
 */
export const HUB_EDIT_HUNK_RADII = [24, 16, 10, 6] as const;

/** Multiple independently required Office inputs may share one bounded pack. */
export const MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE = 32768;

// ---------------------------------------------------------------------------
// T1 (2026-08-27 field-eval): caller/env/client-profile byte governance.
//
// AsyncLocalStorage (not a bare module `let`): buildTaskPack is async and
// awaits real file I/O between minting this value and capForResult's read of
// it (the artifact prefetch phase runs before buildTaskPackCore even starts;
// trimToCap's own shedding loop runs deep inside buildTaskPackCore). A bare
// variable set at entry and cleared at exit would leak across two
// buildTaskPack calls for DIFFERENT workspaces/clients that happen to
// interleave on the event loop while each awaits its own I/O --
// mcp/transport/modernHttp.ts's HTTP leg can hold more than one call open at
// once. ALS gives every buildTaskPack invocation its own isolated view, with
// no ceiling parameter threaded through fitsInCap's internal call sites or
// capForResult's other callers (attachPrefetchedArtifactSections,
// applyDocSliverHonesty, the packCapBytes diagnostics in
// dedupeTrimAndPersist) -- every one of them keeps calling capForResult(x)
// exactly as before; only capForResult's OWN body changed (see
// rawCapForResult below).
// ---------------------------------------------------------------------------
export const packByteCeilingStorage = new AsyncLocalStorage<number | undefined>();

// One configuration and pure-parser cache per async pack build. Concurrent
// requests never inherit another client's flag or partially parsed query.
export const compoundParsingStorage = new AsyncLocalStorage<{
  enabled: boolean;
  facets: Map<string, FacetRequirement[]>;
  items: Map<string, RequestItem[]>;
  plans: Map<string, CompoundRequestPlan>;
}>();

export const COMPOUND_REQUEST_CLAUSE_CAP = 8;

export function compoundParserOptions(): { enabled: boolean; maxClauses: number } {
  return {
    enabled: compoundParsingStorage.getStore()?.enabled ?? activeEngineConfiguration().compoundRequests.enabled,
    maxClauses: COMPOUND_REQUEST_CLAUSE_CAP,
  };
}
