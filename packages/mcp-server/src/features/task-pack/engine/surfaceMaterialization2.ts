// surfaceMaterialization — extracted implementation; imports point to the owning modules.
import type { LikelyEditHint } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { LISTED_ITEM_DERIVED_WHY } from "../listedScopeItems.js";
import { MAX_TASK_PACK_BYTES_MULTI_CONCERN } from "./packBasics.js";

// ---------------------------------------------------------------------------
// Handle-grounded likely_edits: steer callers to inspect and edit the returned
// handle instead of falling back to path reads/writes. More syntax-specific
// edit intents can be added once task_pack includes exact slice text.
// ---------------------------------------------------------------------------

/**
 * Item 3: `edit_intent`/`done_check` are already carried ONCE at the
 * surface level (TaskPackSurface.edit_intent / .done_check). Earlier
 * versions repeated the identical strings a second time inside
 * likely_edits[handle-scoped-edit].intent/.done_check — pure duplicated
 * boilerplate that ate into the byte budget without adding information.
 * likely_edits now carries only the action-routing fields (kind/handle/
 * target/confidence); callers read intent/done_check from the surface.
 */
// P1-3(e) (hands-on report, 2026-09): `target` (a hand-formatted
// "tl_read_file mode=slice handle=..." / "tl_edit_file handle=... allowPathFallback=
// false" string) is retired — it was the legacy pre-canonical-protocol
// dialect AGENTS.md says must never be emitted, and every field it named is
// already carried structurally by `kind`/`handle`/`confidence`. Dropping it
// shrinks every pack that carries likely_edits and removes the only
// call-site risk (a consumer treating it as an opaque, parseable string —
// see contentFollowupTarget below, updated to read `.handle` directly).
export function buildLikelyEdits(
  role: string,
  handle: string,
  confidence?: number,
): LikelyEditHint[] {
  const c = Math.max(0.1, Math.min(1, Math.round((confidence ?? 0.5) * 100) / 100));
  const hints: LikelyEditHint[] = [
    {
      kind: "inspect-slice",
      handle,
      confidence: c,
    },
  ];

  if (!["data", "doc", "test"].includes(role)) {
    hints.push({
      kind: "handle-scoped-edit",
      handle,
      confidence: Math.max(0.1, Math.round((c - 0.1) * 100) / 100),
    });
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Derive a short "why" string from the locate candidate's raw why.
// ---------------------------------------------------------------------------

export function whySummary(raw: string, symbol?: string, role?: string): string {
  if (raw === "exact-symbol" && symbol) return `defines ${symbol}`;
  if (raw === "exact-text:distinctive") return "matched distinctive identifier";
  if (raw === "query-symbol") return `symbol hit for ${role ?? "query"}`;
  if (raw === "reference") return "reference site";
  if (raw === "family-stem") return "style family member";
  if (raw === "variant-text") return "variant token match";
  if (raw === "path-token") return "path token match";
  if (raw === "enum-family") return "enumerated value family";
  if (raw === "presentation-family") return "presentation/style family";
  if (raw === "exhaustive-initializer") return "exhaustive initializer/aggregation map for this family";
  // F2: a below-coverage-bar partial member overlap. The summary deliberately
  // avoids isPerSiteCheckSurface's trigger substrings (sibling/initializer/
  // aggregation/enumerat/family) so this non-required surface spawns no per-site
  // closure obligation.
  if (raw === "related-member-hit") return "related member reference";
  if (raw === "doc-contract-match") return "matched section in a contract/spec doc";
  // A listed item's discharge row names the accessor that carries the new
  // value and the item it answers; the 60-character cut below drops the item.
  if (raw.startsWith(`${LISTED_ITEM_DERIVED_WHY}:`)) return raw;
  // Default: return the raw string truncated.
  return raw.length > 60 ? raw.slice(0, 60) : raw;
}

// ---------------------------------------------------------------------------
// Confidence-scaled byte cap (A2 item 2): a pack with no code-bearing
// surfaces stays at the base MAX_TASK_PACK_BYTES (compact, handle-first).
// A pack whose required/high-confidence surfaces carry embedded code is
// allowed to grow toward MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE — just enough
// to fit that code instead of immediately discarding it in trimToCap's
// Phase 5. This keeps the LOW-confidence / discovery-only case compact
// while letting a genuinely task-closing pack actually close the task.
// ---------------------------------------------------------------------------

/**
 * DESIGN-v0.8 coverage-honesty (Part 4): the exact `why` markers
 * expandCppModuleClosure / augmentNativeSurfaceClosure stamp on a C/C++
 * header↔impl companion surface. A surface carrying one of these markers is a
 * module-closure companion of an already-selected native surface — its
 * embedded code is as load-bearing as a required surface's (live C++ cases:
 * a bug's lookup table lives in the .hpp companion of the matched .cpp), so it
 * gets high-confidence-cap treatment even though it is not itself `required`.
 */
export const MODULE_CLOSURE_WHY_MARKERS: ReadonlySet<string> = new Set(["header-source-pair", "include-target"]);

/** True when a surface is a C/C++ module-closure companion (by its `why` marker). */
export function isModuleClosureSurface(s: TaskPackSurface): boolean {
  return s.why !== undefined && MODULE_CLOSURE_WHY_MARKERS.has(s.why);
}

/**
 * WP-S2 rule 2 (TL_SEEDED_GENEROUS): packs whose caller NAMED >= 2 files that
 * an answer-profile seeded build decided to serve whole. Carried as a
 * Symbol-keyed own property plus a WeakSet — the same carrier
 * sfWithholdingMarks.ts uses for exactly this class of problem — so it is
 * invisible on the wire (`JSON.stringify` never walks symbol keys) and cannot
 * become a protocol field. `trimToCap` mutates and returns the SAME object, so
 * its own `fitsInCap` -> `capForResult` chain reads the mark back.
 */
export const SEEDED_GENEROUS_PACK_KEY: unique symbol = Symbol("tokenlighten.seededGenerousPack");

export const seededGenerousPacks = new WeakSet<object>();

export const seededGenerousPackTiers = new WeakMap<object, number>();

export function markSeededGenerousPack(result: TaskPackResult, tierBytes: number): void {
  seededGenerousPacks.add(result);
  seededGenerousPackTiers.set(result, tierBytes);
  try {
    Object.defineProperty(result, SEEDED_GENEROUS_PACK_KEY, {
      value: tierBytes, enumerable: true, configurable: true, writable: true,
    });
  } catch {
    // Non-extensible result: the WeakSet/WeakMap above still answer for this object.
  }
}

export function isSeededGenerousPack(result: TaskPackResult): boolean {
  const marked = (result as unknown as Record<symbol, unknown>)[SEEDED_GENEROUS_PACK_KEY];
  return marked === true || typeof marked === "number" || seededGenerousPacks.has(result);
}

/** The pack-budget tier `buildSeededTaskPack` claimed for this result (0 = unmarked). */
export function seededGenerousPackTier(result: TaskPackResult): number {
  if (!isSeededGenerousPack(result)) return 0;
  const marked = (result as unknown as Record<symbol, unknown>)[SEEDED_GENEROUS_PACK_KEY];
  if (typeof marked === "number") return marked;
  return seededGenerousPackTiers.get(result) ?? MAX_TASK_PACK_BYTES_MULTI_CONCERN;
}
