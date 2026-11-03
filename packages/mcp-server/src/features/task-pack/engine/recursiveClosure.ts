// recursiveClosure — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { isFacetCallSiteLine } from "./changeAndReadinessEvidence2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { probeFileText } from "./readinessFalsification.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { surfaceContainsFacet } from "./changeAndReadinessEvidence2.js";

export function canonicalClosureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalClosureValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalClosureValue(item)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// D1 (FX-R3, 2026-09-04) — A CALL THE SERVER ALREADY RAN IS NOT A `next`.
//
// The DEEP recursive read closure below (`runRecursiveReadOnlyClosure`)
// EXECUTES the provisional contract's `next_call` itself to harvest surfaces
// (`why:"recursive-read-closure"`). When the loop ends, that call is still
// sitting on `result.next`, so `buildTaskExecutionContract`'s candidate chain
// can hand it back to the caller as `decision.next` — an instruction to run
// the very search this build already ran. Observed live (run
// 2026-09-04-semantic-frontier-v2-paid-ab-smoke-r3, cell SF05 ... -r0, first
// call): `decision.kind:"discover"` + `gaps:[missing-evidence surface-content]`
// + `next: tl_search_files find ["contract"]`, while the obligation actually open
// was a codeless surface that `gapFallback` (a `tl_read_file` of that exact
// handle) would have closed.
//
// The fix is a per-build fingerprint set of the calls the loop ran, consulted
// once — `parsedNextAfterProof` is dropped when it names an executed call, so
// the chain falls through to the obligation-specific fallback. Deliberately
// NOT recorded from the lean single-handle path or the candidate inline pass:
// this closes the shape the forensics named (the deep loop's self-executed
// search) without moving the far more common lean-profile packs' bytes.
//
// CARRIED BY TOKEN, NOT BY REFERENCE (ruling (bb)). `trimToCap` mutates and
// returns the same object, but a receipt/copy path may not, so the set is
// published both on a `WeakMap` keyed by the pack object and under an
// ENUMERABLE symbol-keyed token that survives `{...result}` — the same
// mechanism `sfSatisfaction.ts`'s `attachSfPackContext` uses, for the same
// reason. A symbol key is structurally invisible to `JSON.stringify`, so
// nothing here can reach the wire.
// ---------------------------------------------------------------------------

export const closureExecutedCallsByPack = new WeakMap<object, Set<string>>();

export const CLOSURE_EXECUTED_TOKEN_KEY: unique symbol = Symbol("tokenlighten.closureExecutedCalls");

export const closureExecutedCallsByToken = new Map<string, Set<string>>();

/** Upper bound on live tokens; oldest-first eviction (see the block above). */
export const CLOSURE_EXECUTED_TOKENS_MAX = 256;

/**
 * B1d (2026-08-01 retrieval-scope): is a facet's evidence STILL unserved?
 *
 * True when the surface is disclosed-partial AND the file holds a collaborator
 * CALL SITE for `facet` that this surface's served text does not contain. Live
 * forensics (run 2026-07-31-semantic-signal5-2, T03): the "shipping" facet
 * matched a shipping-COST line inside the already-served head, so the pack
 * claimed the facets were bundled and dropped `next`/`continuation` — while the
 * `shippingService.*` calls the question was actually about sat entirely in
 * remaining_ranges. A lexical hit inside what is already served proves nothing
 * new when the behavior is provably elsewhere.
 *
 * Needs the workspace to read the file; without one the check is skipped
 * (pre-B1d behavior), so no caller is forced to thread it through.
 */
export function facetEvidenceStillUnserved(
  surface: TaskPackSurface,
  facet: string,
  workspace: string,
): boolean {
  const partial = surface.content_completeness === "partial"
    || (surface.remaining_ranges?.length ?? 0) > 0;
  if (!partial) return false;
  const isCallSite = (line: string): boolean =>
    !/^\s*(?:\/\/|\/\*|\*|#)/.test(line)
    && hasIdentifierSegment(line, facet)
    && isFacetCallSiteLine(line, facet);
  // The facet's behavior IS demonstrated when the SERVED text itself carries a
  // call site for it. Further call sites elsewhere in a large class are more of
  // the same evidence, not a gap — this is the line between "answer the
  // question" and "dump the class", and crossing it would reopen discovery on
  // every partially-served answer pack.
  const servedText = servedSurfaceText(surface);
  if (servedText.split("\n").some(isCallSite)) return false;
  // Served evidence is a bare lexical mention (T03: a shipping-COST field).
  // A call site the pack did NOT serve is then the actual evidence gap.
  const content = probeFileText(workspace, surface.path);
  if (content === undefined) return false;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (!isCallSite(line)) continue;
    if (!servedText.includes(line.trim())) return true;
  }
  return false;
}

export function hasExactNamedAnswerFacetEvidence(
  result: TaskPackResult,
  query: string,
  workspace?: string,
): boolean {
  const facets = requiredQueryFacets(query);
  if (facets.length === 0) return false;
  const targetNames = new Set(explicitCodeIdentifiers(query).map(normIdent));
  return codeTaskPackSurfaces(result.surfaces).some((surface) =>
    targetNames.has(normIdent(path.basename(surface.path, path.extname(surface.path))))
    && hasCallableBody(surface)
    && facets.every((facet) =>
      surfaceContainsFacet(surface, facet)
      // B1d: a facet whose call sites are still unserved is NOT bundled, no
      // matter how many times the word appears in what WAS served.
      && !(workspace !== undefined && facetEvidenceStillUnserved(surface, facet, workspace))
    )
  );
}

/**
 * Broad analysis/review wording is intentionally read-only, but it is also
 * easy to satisfy accidentally with a same-word source file or documentation
 * decoy.  Only caller-scoped evidence, an extracted artifact, or an explicit
 * code identifier can close analysis discovery.  Unknown-scope analysis stays
 * in discovery and receives one bounded locate call instead of a false ready
 * certificate over arbitrary token matches.
 */
export function surfaceWhyHasMarker(why: string | undefined, marker: string): boolean {
  return (why ?? "").split(";").some((segment) => segment.trim() === marker);
}
