// ---------------------------------------------------------------------------
// sfContinuationBundle.ts — W-CONT-BUNDLE: the structural continuation
// bundle (Semantic Frontier v0.15, Workstream 2/8).
//
// NORMATIVE SOURCE:
//   DESIGN-v0.15-sf-continuation-and-metrics.md §2.3 (2026-09-02 negative
//   result: a LEARNED pack-shape prior — even the exact `evidenceCount`
//   feature vector §2.1 specifies — is statistically indistinguishable from
//   a marginal-only baseline under taskId/fixtureId holdout, because 32 of
//   33 distinct feature keys occur under exactly one taskId: the feature
//   representation is a per-task fingerprint, not a generalizable signal.
//   This module therefore predicts from STRUCTURE ONLY (grounded concerns
//   `sfConcerns.ts` already extracted this task), never from any learned
//   frequency table.
//   §3.1 (serve the prediction as bodyless `evidence[]` rows, inside a
//   byte budget, with zero new wire fields — the existing `remaining`
//   field, populated in full, IS the mechanism).
//   Ratified DC2: `decision.next`'s arbitration authority stays with
//   `selectCanonicalNext` (DESIGN-v0.15-semantic-frontier-plan.md §10.0).
//   This module's output may ONLY fill `evidence[]`/`remaining` slack under
//   budget; it must never construct, rank, or override `next`.
//   DESIGN-v0.15-semantic-frontier-plan.md §3.5.1 (the "supporting" row
//   shape this module's fills mirror: `{handle, path, role, remaining}` —
//   no `body`, no `prior`, ~70-110 B measured) and §3.6 (structural concern
//   extraction — `sfConcerns.ts`'s grounded, non-advisory
//   definition/declaration/relation concerns are the only input this module
//   trusts; an advisory (heuristic-origin) concern is never grounds for a
//   fill, matching I-3).
//
// WHAT THIS MODULE IS: a pure, deterministic, total function from
// (concerns, already-served paths, an injected workspace capability) to a
// bounded list of STRUCTURAL continuation candidates:
//   - the declaration<->implementation counterpart of a grounded
//     declaration/relation concern (header/impl, `.d.ts`/`.ts`),
//   - the definition site when only its declaration was served, and the
//     symmetric case (declaration when only the definition was served),
//   - a verification-manifest-named referencing test, ONLY when the caller
//     already knows one (this module never derives one itself).
// Relation-concern callers/callees are deliberately OUT OF SCOPE — those
// belong to a relation packet (`features/graph-evidence/relationPacket.ts`,
// W-RELATION-PACKET/W-RELATION-WIRE), not this module; this module only
// reads the definition/declaration half of a relation concern's bindings.
//
// PURITY. Exactly like `sfConcerns.ts`'s own `SfWorkspaceIndex`/
// `SfAnchorResolver` injection (see that module's header comment, which
// applies here verbatim): the only capability this module reaches into the
// workspace through is `SfContinuationWorkspaceIndex`, an all-optional,
// injected, total set of accessors. Nothing here touches the filesystem,
// the clock, or module state. A candidate this index cannot resolve a real
// handle + line count for is skipped, never guessed — matching the wire
// budget shedder's own rule (`protocol/budget/shedders/readTaskPack.ts`'s
// `shedEvidenceBody`: "no addressing, no executable continuation, no shed").
// This module also never runs a search sweep: `candidatePathsNear` is
// documented as a small, bounded, same-stem probe, never a directory walk
// or a content search.
//
// FLAG FENCE: `TL_SF_CONTINUATION_BUNDLE` (`sfContinuationBundleEnabled()`,
// `util/flags.ts`, frozen — requires `sfStatefulEnabled()`, a composite this
// module does not check itself) gates the WIRING seam in
// `readCodeTaskPack.ts`, not this module: `buildStructuralContinuation` has
// no flag check of its own because it is pure and has nothing to gate — an
// empty `concerns` array (exactly what `sfConcerns.ts` returns when ITS own
// flag is off, or what a caller passes when `TL_SF_CONTINUATION_BUNDLE` is
// off) already yields `[]` by construction (see the first statement below).
// ---------------------------------------------------------------------------

import type { SfConcernAnchor, SfStructuralConcern } from "./sfConcerns.js";

// ---------------------------------------------------------------------------
// Wire shape — matches DESIGN-v0.15-semantic-frontier-plan.md §3.5.1's
// bodyless "supporting" row and §4.2's field mapping exactly: `path`,
// `handle`, `role`, `remaining`. No `body`, no `prior`. No new field.
// ---------------------------------------------------------------------------

/**
 * `"definition"` — the concrete definition site of an anchor.
 * `"declaration"` — a header/`.d.ts` declaration site.
 * `"counterpart"` — the implementation side of a declaration/header pair.
 * `"test"` — a verification-manifest-named referencing test.
 */
export type SfContinuationFillRole = "definition" | "declaration" | "counterpart" | "test";

export interface SfContinuationFill {
  readonly path: string;
  readonly handle: string;
  readonly role: SfContinuationFillRole;
  /** Always the FULL range, e.g. `["1-120"]` — a continuation fill is never partial (§3.5.1). */
  readonly remaining: readonly string[];
}

/** A real, already-resolved address for a workspace-relative path. */
export interface SfContinuationAddress {
  readonly handle: string;
  /** 1-based total line count, used to spell the full-range `remaining` window. */
  readonly totalLines: number;
}

/** A verification-manifest-named referencing test, already resolved to a real address. */
export interface SfContinuationNamedTest extends SfContinuationAddress {
  readonly path: string;
}

/**
 * The only capability this module reaches into the workspace through. Every
 * member is OPTIONAL and INJECTED; a caller under test supplies a synthetic
 * stub, and the real wiring seam (`readCodeTaskPack.ts`) binds these to the
 * session's real handle table, a bounded same-stem file probe, and the
 * pack's own verify-obligation manifest, respectively.
 */
export interface SfContinuationWorkspaceIndex {
  /** Real handle + total line count for a workspace-relative path, when it exists and is readable. Never derived here. */
  readonly resolveAddress?: (relPath: string) => SfContinuationAddress | undefined;
  /**
   * A SMALL, bounded set of same-stem candidate paths near a declaration
   * file (e.g. the same basename under a fixed list of implementation
   * extensions) — never a directory walk or a content search. The real
   * wiring seam builds this from a handful of `fs.existsSync`-style
   * probes, mirroring `readCodeTaskPack.ts`'s own
   * `singleSiteShortCircuitSeed` safe-path pattern.
   */
  readonly candidatePathsNear?: (declarationPath: string) => readonly string[];
  /** A verification-manifest-named referencing test for this path, when one is already known. Never derived here. */
  readonly namedTestFor?: (relPath: string) => SfContinuationNamedTest | undefined;
  /** True when `relPath` is already resident by a route this module does not itself track (the servedRangeLedger). */
  readonly isServed?: (relPath: string) => boolean;
}

export interface SfContinuationInput {
  readonly concerns: readonly SfStructuralConcern[];
  /** Paths already on THIS pack's wire — evidence + inventory + ledger. Never re-offered. */
  readonly servedPaths: ReadonlySet<string> | readonly string[];
  readonly workspaceIndex?: SfContinuationWorkspaceIndex;
  /** Measured-bytes ceiling for the WHOLE returned array (§3.1's conservative default). */
  readonly budgetBytes?: number;
  /** Row-count ceiling, independent of the byte budget. */
  readonly maxFills?: number;
}

/** §3.1: "prefetch upper bound ≤8KiB" was the measured, conservative starting default. */
export const SF_CONTINUATION_DEFAULT_BUDGET_BYTES = 8192;
export const SF_CONTINUATION_DEFAULT_MAX_FILLS = 6;

// ---------------------------------------------------------------------------
// The copied tiny rule. Task brief: "copy the tiny rule rather than
// importing across the fence." Functionally identical to
// `readCodeTaskPack.ts`'s private `isImplementationCounterpartOf` (14341)
// and `isImplementationPath` (16610) — copied, not imported, because both
// are private to that module (the D5 resolver this module may not reach
// into beyond its two exported functions) and because
// `features/graph-evidence/**` is a separate fence this wave does not cross
// either. Any future divergence between the two copies is a documentation
// smell, not a correctness bug: both encode the same header/impl-pair rule.
// ---------------------------------------------------------------------------

const SF_CONTINUATION_IMPLEMENTATION_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".go", ".java", ".js", ".jsx", ".kt", ".kts",
  ".m", ".mm", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);

function sfContinuationExtname(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return filePath.slice(dot).toLowerCase();
}

/** A header/`.d.ts` declaration-shaped path — the "declares" side of a pair. */
function sfContinuationIsDeclarationPath(filePath: string): boolean {
  return /\.d\.(?:[cm]?ts|tsx)$/i.test(filePath)
    || [".h", ".hh", ".hpp", ".hxx"].includes(sfContinuationExtname(filePath));
}

/** Copied from `readCodeTaskPack.ts`'s private `isImplementationPath` (16610). */
function sfContinuationIsImplementationPath(filePath: string): boolean {
  return SF_CONTINUATION_IMPLEMENTATION_EXTS.has(sfContinuationExtname(filePath))
    && !/\.d\.(?:[cm]?ts|tsx)$/i.test(filePath)
    && !/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)/i.test(filePath)
    && !/(?:^|\/)__tests?__(?:\/|$)/i.test(filePath)
    && !/\.(?:spec|test)\.[^./]+$/i.test(filePath);
}

function sfContinuationStem(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  return base.replace(/\.d\.(?:[cm]?ts|tsx)$/i, "").replace(/\.[^.]+$/, "").toLowerCase();
}

/** Copied from `readCodeTaskPack.ts`'s private `isImplementationCounterpartOf` (14341). */
function sfContinuationIsCounterpartOf(candidatePath: string, declarationPath: string): boolean {
  if (candidatePath === declarationPath) return false;
  if (sfContinuationStem(candidatePath) !== sfContinuationStem(declarationPath)) return false;
  return sfContinuationIsDeclarationPath(declarationPath) && sfContinuationIsImplementationPath(candidatePath);
}

// ---------------------------------------------------------------------------
// Anchor grouping — concerns that share an anchor describe the same
// structural site from different angles (definition / declaration /
// relation). §3.6.1's D5 extraction always mints these together for a
// qualified anchor, so grouping by anchor is how this module recovers "the
// pair" without re-deriving it.
// ---------------------------------------------------------------------------

function sfContinuationAnchorKey(anchor: SfConcernAnchor): string {
  switch (anchor.kind) {
    case "symbol":
      return `symbol:${anchor.symbol}`;
    case "qualified":
      return `qualified:${anchor.qualified}`;
    case "path":
      return `path:${anchor.path}`;
    case "literal":
      return `literal:${anchor.literal}`;
    case "verb":
      return `verb:${anchor.verb}`;
    default:
      return "unknown";
  }
}

function sfContinuationUniq(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The predictor
// ---------------------------------------------------------------------------

export function buildStructuralContinuation(input: SfContinuationInput): SfContinuationFill[] {
  const {
    concerns,
    servedPaths,
    workspaceIndex,
    budgetBytes = SF_CONTINUATION_DEFAULT_BUDGET_BYTES,
    maxFills = SF_CONTINUATION_DEFAULT_MAX_FILLS,
  } = input;
  if (concerns.length === 0) return [];
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return [];
  if (!Number.isFinite(maxFills) || maxFills <= 0) return [];

  const served = servedPaths instanceof Set ? servedPaths : new Set(servedPaths);
  const isServed = (path: string): boolean => served.has(path) || workspaceIndex?.isServed?.(path) === true;

  const emitted = new Set<string>();
  const fills: SfContinuationFill[] = [];
  let bytes = 0;
  let stopped = false;

  const tryAdd = (
    path: string,
    role: SfContinuationFillRole,
    preResolved?: SfContinuationAddress,
  ): void => {
    if (stopped || path === "") return;
    if (emitted.has(path) || isServed(path)) return;
    if (fills.length >= maxFills) {
      stopped = true;
      return;
    }
    // A caller-supplied address (e.g. a manifest-named test's own already-
    // minted handle) wins over a fresh `resolveAddress` lookup — re-deriving
    // it would discard the more authoritative address another wave already
    // proved.
    const address = preResolved ?? workspaceIndex?.resolveAddress?.(path);
    if (address === undefined) return; // E5: no addressing, no executable continuation, no shed.
    const totalLines = Math.trunc(address.totalLines);
    if (address.handle === "" || !Number.isFinite(totalLines) || totalLines < 1) return;
    const row: SfContinuationFill = {
      path,
      handle: address.handle,
      role,
      remaining: [`1-${totalLines}`],
    };
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes + rowBytes > budgetBytes) {
      stopped = true;
      return;
    }
    bytes += rowBytes;
    emitted.add(path);
    fills.push(row);
  };

  // Group concerns by anchor, preserving the concerns array's own order —
  // determinism follows directly from the caller's (also deterministic)
  // concern order.
  const groupOrder: string[] = [];
  const groups = new Map<string, SfStructuralConcern[]>();
  for (const concern of concerns) {
    const key = sfContinuationAnchorKey(concern.anchor);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.push(concern);
  }

  for (const key of groupOrder) {
    if (stopped) break;
    const group = groups.get(key)!;
    const grounded = (kind: SfStructuralConcern["kind"]): SfStructuralConcern | undefined =>
      group.find((c) => c.kind === kind && !c.advisory);

    const definitionConcern = grounded("definition");
    const declarationConcern = grounded("declaration");
    const relationConcern = grounded("relation");
    if (definitionConcern === undefined && declarationConcern === undefined && relationConcern === undefined) {
      continue;
    }

    const defSites = sfContinuationUniq(definitionConcern?.bindings ?? []);
    const declSites = sfContinuationUniq(declarationConcern?.bindings ?? []);
    // A relation concern's bindings mix usages (callers/callees — out of
    // scope, they belong to a relation packet) with definitions. Only the
    // header/declaration-SHAPED entries are eligible here: those are the
    // "declaration" half of a relation-concern-only pair (the explicit-
    // target case, where a bare header path becomes a `relation` concern
    // with no sibling definition/declaration concern at all).
    const relationSites = sfContinuationUniq(relationConcern?.bindings ?? []).filter(sfContinuationIsDeclarationPath);

    const roleFor = (path: string): SfContinuationFillRole => {
      if (defSites.includes(path)) return "definition";
      return sfContinuationIsDeclarationPath(path) ? "declaration" : "counterpart";
    };

    // (a) + (b): every structural site this task already grounded, in
    // (definition, declaration/counterpart) order — fills whichever half of
    // the pair was NOT served, in both directions at once (only-declaration-
    // served fills the definition; only-definition-served fills whatever
    // the declaration concern still names, counterpart included).
    for (const path of [...defSites, ...declSites]) tryAdd(path, roleFor(path));

    // (c) discover a MISSING counterpart when nothing already grounded one
    // (either D5 never resolved a counterpart, or this is a plain
    // explicit-target/relation concern with only a header binding).
    const structuralSites = sfContinuationUniq([...defSites, ...declSites, ...relationSites]);
    const counterpartAlreadyKnown = structuralSites.some(sfContinuationIsImplementationPath);
    if (!counterpartAlreadyKnown) {
      for (const declPath of structuralSites.filter(sfContinuationIsDeclarationPath)) {
        const candidates = workspaceIndex?.candidatePathsNear?.(declPath) ?? [];
        for (const candidate of candidates) {
          if (!sfContinuationIsCounterpartOf(candidate, declPath)) continue;
          tryAdd(candidate, "counterpart");
        }
      }
    }

    // (d) a manifest-named referencing test, ONLY when the caller already
    // knows one for one of this anchor's structural sites. One fill per
    // anchor group keeps this bounded and deterministic; the first
    // structural site (in the same definition-then-declaration order) that
    // resolves one wins.
    if (!stopped) {
      for (const path of structuralSites) {
        const named = workspaceIndex?.namedTestFor?.(path);
        if (named === undefined) continue;
        tryAdd(named.path, "test", { handle: named.handle, totalLines: named.totalLines });
        break;
      }
    }
  }

  return fills;
}

// ---------------------------------------------------------------------------
// Side-table publication — the "pack context for continuation" W-DEMOTE
// reads. Mirrors `sfSatisfaction.ts`'s own `attachSfPackContext`/
// `sfPackContextFor` WeakMap pattern (NO WIRE BYTES, BY CONSTRUCTION) rather
// than extending that module's `SfPackContext`, since this module's file
// allowlist does not include `sfSatisfaction.ts`.
// ---------------------------------------------------------------------------

const continuationFillsByResult = new WeakMap<object, readonly SfContinuationFill[]>();

/** Publish the fills this pack offered. Overwrites any earlier publication for the same object. */
export function attachSfContinuationFills(result: object, fills: readonly SfContinuationFill[]): void {
  if (result === null || typeof result !== "object") return;
  continuationFillsByResult.set(result, fills);
}

/**
 * The fills this pack offered, or `undefined` when this module never ran for
 * it (flag off, no SF context, or observation-only). W-DEMOTE reads this as
 * `selectCanonicalNext`'s `continuation` input
 * (DESIGN-v0.15-semantic-frontier-plan.md §10.0's priority (3)).
 */
export function sfContinuationFillsFor(result: object): readonly SfContinuationFill[] | undefined {
  if (result === null || typeof result !== "object") return undefined;
  return continuationFillsByResult.get(result);
}

// ---------------------------------------------------------------------------
// Metrics gate helper (§4/DC4: `next_hit_rate`'s continuation-bundle sibling)
// ---------------------------------------------------------------------------

/** One subsequent call, as far as this metric needs to know it. */
export interface SfContinuationSubsequentCall {
  readonly handle?: string;
  readonly path?: string;
}

/**
 * The fraction of offered `fills` that a subsequent call actually referenced
 * (by handle or by path). Returns `undefined` — never `0` — when no fills
 * were offered, so an aggregate gate never conflates "nothing predicted"
 * with "predicted and missed every time".
 */
export function continuationHitRate(
  fills: readonly SfContinuationFill[],
  subsequentCalls: readonly SfContinuationSubsequentCall[],
): number | undefined {
  if (fills.length === 0) return undefined;
  const requestedHandles = new Set<string>();
  const requestedPaths = new Set<string>();
  for (const call of subsequentCalls) {
    if (typeof call.handle === "string" && call.handle !== "") requestedHandles.add(call.handle);
    if (typeof call.path === "string" && call.path !== "") requestedPaths.add(call.path);
  }
  let hits = 0;
  for (const fill of fills) {
    if (requestedHandles.has(fill.handle) || requestedPaths.has(fill.path)) hits += 1;
  }
  return hits / fills.length;
}
