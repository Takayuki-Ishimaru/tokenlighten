/**
 * impactGuard.ts — V11-06 Known-Local Fast Path v2: Cheap Impact Guard.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-06 実装内容: "Cheap Impact Guardで
 * export/public、declaration/signature変更、reference count、schema/API
 * surface、shared constant、generated sourceを検査する。Guardはfast pathへ入れる
 * 証明ではなく、危険兆候を除外するために使う。" — every signal in this module is
 * an EXCLUSION signal, never an admission proof: a "local" verdict means no
 * danger sign fired, not "this is provably safe". `evaluateImpactGuard`'s
 * result is one of three verdicts, and "unknown" and "not-local" are treated
 * IDENTICALLY by every caller — both mean orchestrated (受入基準: "guard不明時
 * はorchestratedへfallback").
 *
 * TWO TIERS OF SIGNAL
 * --------------------
 *  (a) The graph-evidence probe (`features/graph-evidence/`, V11-01), run
 *      ONLY when `TL_GRAPH_EVIDENCE` is also on. `evaluateGraphImpactSignal`
 *      is pure — it interprets an already-computed `GraphProbeAttempt` — and
 *      `attemptGraphImpactProbe` is the (I/O-performing) wiring that actually
 *      builds one against a real tl-graph index, kept separate so the
 *      decision logic stays unit-testable without a filesystem.
 *
 *      DESIGN-v0.11-expansion-plan-reconciliation.md's wave-A intent for this
 *      guard: ONE `analyzeImpact` call with tight bounds (`maxDepth:1`), then
 *      `result.coverage !== "complete"` ⇒ NOT known-local (an overlay that
 *      could not prove anything must never be read as "no impact found"),
 *      and `nodesInTier(result, "required").length > 1` ⇒ NOT known-local.
 *
 *      ONE DELIBERATE REFINEMENT of that shorthand: `impact.ts`'s own
 *      `resolveSeed` seeds a SYMBOL target with its containing FILE too (a
 *      "companion seed, not a hop" — impact.ts's words), and `tierFor`
 *      assigns depth-0 nodes `required` UNCONDITIONALLY. That means a bare
 *      `nodesInTier(result, "required").length` starts at 2 for every
 *      symbol-seeded probe (the symbol node plus its file companion) before a
 *      single edge is even followed — so ">1" over the RAW count would flag
 *      every graph-backed symbol edit as not-local, seed or no seed,
 *      defeating the check. This module counts only nodes with `depth > 0` —
 *      i.e. `analyzeImpact` had to actually WALK an edge to reach them — which
 *      is also the literal reading of this guard's own acceptance fixture:
 *      "edit an exported symbol with >1 required-tier CONSUMERS" (plural,
 *      consumers — not "required-tier nodes including the thing being
 *      edited").
 *
 *      A SECOND refinement, mechanical rather than semantic: the bounds
 *      passed to analyzeImpact use maxDepth:2, not the literally-quoted 1 —
 *      bounds.ts's tracker records a truncation the instant a discovered
 *      node's OWN next hop would exceed maxDepth, UNCONDITIONALLY (before
 *      checking whether that hop would have found anything), so with
 *      maxDepth:1 every depth-1 consumer this guard exists to COUNT also
 *      immediately truncates the walk and degrades result.coverage below
 *      complete — making the fanout check above unreachable for any
 *      workspace with a real consumer. requiredMaxDepth is pinned to 1
 *      independently (DEFAULT_GRAPH_PROBE_BOUNDS's doc comment below has the
 *      full mechanical explanation), so the ACTUAL required-tier semantics —
 *      "one hop from the seed" — are unchanged; only the walk's truncation-
 *      accounting budget grew by one dead-end hop.
 *
 *  (b) Cheap local checks needing no graph at all (`evaluateCheapImpactSignals`)
 *      — lexical/path signals computable from the call's OWN args, no file
 *      read required: exported/public surface, a declaration/signature line
 *      in the edited text, a generated-source path (reuses
 *      `features/graph-evidence/adapters.ts`'s `classifyPathRole` — the
 *      wave-A module's own path-role classifier), and a shared-constant/
 *      enum/schema surface path. Because these need no I/O, they are safe to
 *      run from `routing/classifier.ts`'s `classifyRoute` — a pure function
 *      of (tool, args) that must stay synchronous and I/O-free — so the
 *      classifier's ADDITIVE `guard` field (routing/classifier.ts) is wired
 *      from THIS half only; the graph probe is wired exclusively from the
 *      dispatch integration (tools/searchReplaceEdit.ts), which already does
 *      real I/O.
 *
 * `combineImpactGuardSignals` ORs signals together: `not-local` beats
 * `unknown` beats `local`, and reasons accumulate from every non-`local`
 * contributor. A signal that was never run (e.g. the graph probe when
 * TL_GRAPH_EVIDENCE is off) contributes nothing — neither an exclusion nor an
 * admission — which is why it reports `local`/`[]` rather than `unknown`:
 * "this signal has no opinion" must not itself become a reason to distrust
 * the fast path when every signal that DID run found nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadGraphIndex, type GraphIndex } from "../graph/index.js";
import { graphEvidenceEnabled } from "../util/flags.js";
import {
  classifyPathRole,
  contentSha,
  createTlGraphProviders,
} from "../features/graph-evidence/adapters.js";
import { analyzeImpact, nodesInTier, type ImpactResult } from "../features/graph-evidence/impact.js";
import type { ExpansionBounds } from "../features/graph-evidence/bounds.js";
import { makeGenerationView } from "../features/graph-evidence/stale.js";

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type ImpactGuardVerdict = "local" | "not-local" | "unknown";

export interface ImpactGuardResult {
  readonly verdict: ImpactGuardVerdict;
  readonly reasons: readonly string[];
}

const VERDICT_RANK: Readonly<Record<ImpactGuardVerdict, number>> = { local: 0, unknown: 1, "not-local": 2 };

/** ORs signals together: the strongest (most exclusionary) verdict wins, and reasons accumulate from every non-`local` contributor. */
export function combineImpactGuardSignals(...signals: readonly ImpactGuardResult[]): ImpactGuardResult {
  let verdict: ImpactGuardVerdict = "local";
  const reasons: string[] = [];
  for (const signal of signals) {
    if (VERDICT_RANK[signal.verdict] > VERDICT_RANK[verdict]) verdict = signal.verdict;
    if (signal.verdict !== "local") reasons.push(...signal.reasons);
  }
  return { verdict, reasons };
}

// ---------------------------------------------------------------------------
// (b) Cheap local checks — no I/O, safe to call from routing/classifier.ts.
// ---------------------------------------------------------------------------

export interface CheapGuardInput {
  readonly path: string;
  /** The edit's "before" text, when known (e.g. `args["search"]`). */
  readonly searchText?: string;
  /** The edit's "after" text, when known (e.g. `args["replace"]`). */
  readonly replaceText?: string;
  /** Full current file text, when available — sharpens the declaration-line check to the matched span's own containing line. */
  readonly fileText?: string;
}

const EXPORTED_PUBLIC_RE = /\b(export|module\.exports|exports\.\w|public|__all__)\b/;

const DECLARATION_LINE_RE =
  /^[ \t]*(export\s+)?(default\s+)?(abstract\s+)?(public\s+|private\s+|protected\s+|static\s+)*(class|interface|enum|struct|trait|type|function|def)\s+[A-Za-z_$][\w$]*/m;

const SCHEMA_EXTENSIONS = new Set(["proto", "graphql", "gql", "thrift", "avsc", "idl"]);
const SHARED_SURFACE_DIR_SEGMENTS = new Set(["shared", "common", "constants", "contracts", "schema", "schemas"]);
const SHARED_SURFACE_BASENAME_RE = /(^|\/)(constants|enums|schema|types|contracts)\.[a-z0-9]+$/i;

function extensionOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isSharedSurfacePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const segments = normalized.toLowerCase().split("/").slice(0, -1);
  if (segments.some((segment) => SHARED_SURFACE_DIR_SEGMENTS.has(segment))) return true;
  if (SHARED_SURFACE_BASENAME_RE.test(normalized.toLowerCase())) return true;
  return SCHEMA_EXTENSIONS.has(extensionOf(normalized));
}

/** The line of `fileText` containing the FIRST occurrence of `needle`, or undefined. */
function containingLine(fileText: string, needle: string): string | undefined {
  if (needle === "") return undefined;
  const index = fileText.indexOf(needle);
  if (index === -1) return undefined;
  const lineStart = fileText.lastIndexOf("\n", index) + 1;
  const nextNewline = fileText.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? fileText.length : nextNewline;
  return fileText.slice(lineStart, lineEnd);
}

/** No I/O — every input is text the caller already has in hand (call args, optionally a file read it already performed for another reason). */
export function evaluateCheapImpactSignals(input: CheapGuardInput): ImpactGuardResult {
  const reasons: string[] = [];
  const editedText = [input.searchText, input.replaceText]
    .filter((text): text is string => text !== undefined)
    .join("\n");

  if (editedText !== "" && EXPORTED_PUBLIC_RE.test(editedText)) {
    reasons.push("exported-or-public-surface");
  }

  const declarationHit =
    (editedText !== "" && DECLARATION_LINE_RE.test(editedText)) ||
    (input.fileText !== undefined &&
      input.searchText !== undefined &&
      (() => {
        const line = containingLine(input.fileText!, input.searchText!);
        return line !== undefined && DECLARATION_LINE_RE.test(line);
      })());
  if (declarationHit) {
    reasons.push("declaration-or-signature-edit");
  }

  if (classifyPathRole(input.path) === "generated") {
    reasons.push("generated-source-path");
  }

  if (isSharedSurfacePath(input.path)) {
    reasons.push("shared-constant-schema-surface");
  }

  return reasons.length === 0 ? { verdict: "local", reasons: [] } : { verdict: "not-local", reasons };
}

// ---------------------------------------------------------------------------
// (a) Graph-evidence probe — pure interpretation half.
// ---------------------------------------------------------------------------

export type GraphProbeAttempt =
  | { readonly attempted: false }
  | { readonly attempted: true; readonly available: false }
  | { readonly attempted: true; readonly available: true; readonly result: ImpactResult };

/**
 * Pure: interprets an already-computed probe attempt. `attempted:false`
 * (TL_GRAPH_EVIDENCE off, or the caller chose not to run the probe at all —
 * e.g. routing/classifier.ts's args-only call site) contributes NOTHING: not
 * an exclusion, not an admission. `attempted:true, available:false` (the
 * graph could not be loaded, or its coverage never reached `complete`) is the
 * "an overlay that couldn't prove anything is never read as no impact found"
 * rule, made a hard `unknown`.
 */
export function evaluateGraphImpactSignal(probe: GraphProbeAttempt | undefined): ImpactGuardResult {
  if (probe === undefined || !probe.attempted) {
    return { verdict: "local", reasons: [] };
  }
  if (!probe.available) {
    return { verdict: "unknown", reasons: ["graph-unavailable"] };
  }
  if (probe.result.coverage !== "complete") {
    return { verdict: "unknown", reasons: [`graph-coverage-incomplete:${probe.result.coverage}`] };
  }
  // See this file's header for why `depth > 0` — the seed's own companion
  // nodes must not count as "consumers".
  const consumers = nodesInTier(probe.result, "required").filter((node) => node.depth > 0);
  if (consumers.length > 1) {
    return { verdict: "not-local", reasons: [`graph-required-consumers:${consumers.length}`] };
  }
  return { verdict: "local", reasons: [] };
}

// ---------------------------------------------------------------------------
// (a) Graph-evidence probe — I/O-performing wiring half.
// ---------------------------------------------------------------------------

/**
 * Tight bounds per the wave-A intent quoted in this file's header — everything
 * small, this probe must stay CHEAP. `maxDepth` is 2, not the literally-quoted
 * 1, for a mechanical reason: `bounds.ts`'s `BoundTracker.admitDepth` records
 * a truncation the instant a discovered node's OWN next hop would exceed
 * `maxDepth` — UNCONDITIONALLY, before even checking whether that hop would
 * have found anything. With `maxDepth:1`, EVERY depth-1 consumer discovered
 * (the exact signal this guard exists to count) triggers that one-hop-further
 * probe and is immediately truncated, which `coverageUnderTruncation`
 * (bounds.ts) then degrades below `complete` — so the `nodesInTier(...,
 * "required").length > 1` check the wave-A intent describes would never be
 * REACHED once a real consumer exists; `evaluateGraphImpactSignal` would
 * report `unknown` for every non-trivial workspace, not `not-local`. One
 * extra hop of walk BUDGET avoids that false truncation (a REFERENCES-only
 * provider set's file-level nodes derive zero further edges regardless — see
 * `fileDrafts` in edges.ts — so nothing is ever actually discovered at depth
 * 2); `requiredMaxDepth:1` below keeps the ACTUAL required-tier semantics at
 * "one hop from the seed", independent of this walk-budget adjustment.
 */
export const DEFAULT_GRAPH_PROBE_BOUNDS: ExpansionBounds = {
  maxNodes: 32,
  maxDepth: 2,
  maxFanout: 16,
  maxBytes: 131072,
  maxDurationMs: 200,
};

/** See `DEFAULT_GRAPH_PROBE_BOUNDS`'s doc comment for why this is pinned independently of `bounds.maxDepth`. */
const REQUIRED_MAX_DEPTH = 1;

export interface GraphImpactProbeOptions {
  readonly workspace: string;
  readonly path: string;
  readonly symbol: string;
  readonly symbolKind?: string;
  readonly language?: string;
  /** The seed file's CURRENT text — sha-stamped without a second read. */
  readonly fileText: string;
  readonly bounds?: ExpansionBounds;
  readonly now?: () => number;
  /** Injected for tests; defaults to a real `loadGraphIndex(workspace)`. */
  readonly index?: GraphIndex;
  /** Injected for tests; defaults to `tl-graph:${index.rootHash()}` (V11-05's accessor). */
  readonly generation?: string;
  /**
   * Reads one referencing file's text for sha-stamping (undefined ⇒ unreadable,
   * so that edge fails staleness fail-closed — see stale.ts). Defaults to a
   * real, bounded fs read under `workspace`. Called at most `bounds.maxFanout`
   * times — this is what keeps the probe's I/O CHEAP: only the files tl-graph
   * itself names as referencing this exact symbol are ever read, never a
   * workspace-wide sweep.
   */
  readonly readReferencingFile?: (relPath: string) => string | undefined;
}

function defaultFileReader(workspace: string): (relPath: string) => string | undefined {
  return (relPath: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(workspace, relPath), "utf8");
    } catch {
      return undefined;
    }
  };
}

/**
 * The I/O-performing half. `evaluateGraphImpactSignal` above never calls
 * this — it only interprets whatever `GraphProbeAttempt` its caller already
 * produced — so the DECISION stays unit-testable with zero filesystem
 * fixtures, while this function is what a real dispatch seam
 * (tools/searchReplaceEdit.ts, behind TL_FAST_PATH_V2) calls to get one.
 */
export function attemptGraphImpactProbe(opts: GraphImpactProbeOptions): GraphProbeAttempt {
  if (!graphEvidenceEnabled()) return { attempted: false };

  const index = opts.index ?? loadGraphIndex(opts.workspace);
  if (index === undefined) return { attempted: true, available: false };

  const rootHash = index.rootHash();
  const generation = opts.generation ?? (rootHash !== undefined ? `tl-graph:${rootHash}` : undefined);
  if (generation === undefined) return { attempted: true, available: false };

  const bounds = opts.bounds ?? DEFAULT_GRAPH_PROBE_BOUNDS;
  const readReferencing = opts.readReferencingFile ?? defaultFileReader(opts.workspace);

  const shas = new Map<string, string>([[opts.path, contentSha(opts.fileText)]]);
  const referencingPaths = [...new Set(index.references(opts.symbol).map((location) => location.path))]
    .filter((candidate) => candidate !== opts.path)
    .slice(0, bounds.maxFanout);
  for (const relPath of referencingPaths) {
    const text = readReferencing(relPath);
    if (text !== undefined) shas.set(relPath, contentSha(text));
  }

  const languages = opts.language !== undefined ? [opts.language] : [];
  const providers = createTlGraphProviders({
    workspace: opts.workspace,
    files: [opts.path, ...referencingPaths],
    sourceShas: shas,
    languages,
    index,
    generation,
    // adapters.ts defaults to `unknown` ("not cross-checked against the live
    // source index") — a caller must supply "a real proof" to override it
    // (adapters.spec.ts's own "accepts a proven coverage claim" test is the
    // precedent). This probe HAS one: tl-graph's reference index is built by
    // a full-repository walk (skeleton-engine graphBuilder.ts), the read
    // generation is freshly re-derived from the loaded index's own
    // rootHash() (V11-05's accessor) rather than cached, and every edge
    // this probe admits is independently re-verified
    // per-edge by stale.ts before it can affect the verdict — a file this
    // probe could not read (or whose content moved) fails that check and
    // downgrades `result.coverage` to `partial` regardless of this claim.
    // "Complete" here means "this provider is not ITSELF a reason to
    // distrust the result", not "no possible drift exists anywhere" — the
    // latter is what the per-edge staleness re-check is for.
    coverage: {
      status: "complete",
      languages,
      reason: "tl-graph full-repo reference index; generation + every admitted edge re-verified fresh per-call",
    },
  });
  if (providers.references === undefined) return { attempted: true, available: false };

  const generations = makeGenerationView(
    [[providers.references.identity.id, providers.references.identity.indexGeneration]],
    shas,
  );

  const result = analyzeImpact({
    seeds: [{ kind: "symbol", path: opts.path, symbol: opts.symbol, symbolKind: opts.symbolKind }],
    providers: { references: providers.references },
    bounds,
    generations,
    edgeTypes: ["REFERENCES"],
    requiredMaxDepth: REQUIRED_MAX_DEPTH,
    now: opts.now,
  });

  return { attempted: true, available: true, result };
}

// ---------------------------------------------------------------------------
// Composed guard
// ---------------------------------------------------------------------------

export function evaluateImpactGuard(input: CheapGuardInput & { readonly graph?: GraphProbeAttempt }): ImpactGuardResult {
  return combineImpactGuardSignals(evaluateCheapImpactSignals(input), evaluateGraphImpactSignal(input.graph));
}

/**
 * The composing decision "0 false fast path" is tested against: a selection
 * that failed (ambiguous/not-found/unsupported) is never fast-path-eligible
 * regardless of the guard, and a guard verdict other than `local` (i.e.
 * `not-local` OR `unknown` — 受入基準 treats them identically) is never
 * fast-path-eligible regardless of how clean the selection was.
 */
export function isFastPathEligible(guard: ImpactGuardResult, selection: { readonly ok: boolean }): boolean {
  return selection.ok && guard.verdict === "local";
}
