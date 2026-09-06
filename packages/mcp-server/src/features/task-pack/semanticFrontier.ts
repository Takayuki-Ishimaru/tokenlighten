// Trace-only Semantic Frontier attestation. It never changes protocol output.
import { createHash } from "node:crypto";
import type { TaskPackResult, TaskPackSurface } from "./model.js";
import { sfDemoteEnabled, sfStatefulEnabled } from "../../util/flags.js";

const CANDIDATE_CAP = 24;
const RELATION_CAP = 24;
// Leave room for util/trace.ts's common envelope.  The cap applies to the
// attestation payload; the JSONL record (event, ts, and envelope included)
// must still fit in 12 KiB.
const SERIALIZED_BYTE_CAP = 10 * 1024;
type ConcernKind = "flag" | "template" | "generated" | "measurement" | "relation";
type AnchorKind = "sigil" | "path" | "literal" | "kind";
type Proof = "path-exact" | "identifier-literal" | "path-semantic" | "provider-semantic" | "graph-edge" | "structural-role" | "lexical-only";
type OpaqueAnchor = { id: string; kind: AnchorKind; basename_class?: string };
type InternalAnchor = OpaqueAnchor & { raw: string };
type InternalConcern = { id: string; kind: ConcernKind; anchors: InternalAnchor[] };
type Binding = { concern_id: string; anchor_id: string; anchor_kind: AnchorKind; proof: Proof };
type Candidate = { surface: TaskPackSurface; path: string; role: string; required: boolean; proof: Proof; disposition: "required" | "supporting"; bytes: number; bindings: Binding[] };
export interface SemanticFrontierAttestationInput { result: TaskPackResult; query: string; guardEnabled: boolean; finalDecision?: string; finalEvidenceCount?: number; finalEvidenceBytes?: number; }
export interface SemanticFrontierTraceSeed {
  /** Already privacy-filtered, bounded fields only. Never put TaskPackResult here. */
  readonly attestation: Readonly<Record<string, unknown>>;
  readonly guard_enabled: boolean;
  /** Count of internal continuation markers, not a claim that wire suppression occurred. */
  readonly marker_count: number;
}
export interface SemanticFrontierWireObservation {
  readonly wire_observed: boolean;
  /** Null is an honest codec/JSON observation failure, never a guess. */
  readonly wire_kind?: string | null;
  readonly decision_kind?: string | null;
  readonly evidence_count?: number;
  readonly evidence_body_bytes?: number;
  readonly evidence_prior_bytes?: number;
  readonly evidence_path_ids?: readonly string[];
  /** Opaque final evidence addressing identities, including multiplicity. */
  readonly evidence_witness_ids?: readonly string[];
  /** Opaque final decision.next identity after funnel attribution is ignored. */
  readonly decision_next_witness_id?: string;
  /**
   * W-DEMOTE follow-up (§6 P-2), TL_SF_DEMOTE only. Absent (not 0) when the
   * flag is off, so the legacy/off trace shape stays byte-identical to
   * before this wave. protocol/envelope.ts populates all three together, from
   * decisionWire.ts's `semanticFrontierDemotionCounters` over this same
   * observed wire evidence array.
   *
   * FX-R3d (D10, 2026-09-04): rows `applySemanticFrontierDemotion` ITSELF
   * withheld a body from and the final wire still ships bodyless — not the
   * count of bodyless-shaped rows. Any bodyless row used to count, so a
   * caller-named file that joined the frontier past the cap (D8/FX-R3c) was
   * scored as engagement the demotion pass never produced.
   */
  readonly demoted_count?: number;
  /** Must be 0 (I-2/D4); present alongside `demoted_count` only. */
  readonly re_suppression_count?: number;
  /**
   * FX-R3d (D10): caller-named D8 rows shipped bodyless that W-DEMOTE did NOT
   * demote — the residual `demoted_count` used to absorb. Diagnostic only: it
   * never feeds `committed`, and it is disjoint from `demoted_count`.
   */
  readonly withheld_named_count?: number;
}
const continuationOptional = new WeakSet<TaskPackSurface>();
/** Internal semantic state only: never projected on a task-pack surface. */
export function isSemanticFrontierContinuationOptional(surface: TaskPackSurface): boolean { return continuationOptional.has(surface); }

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
export const semanticFrontierPathId = (path: string): string => sha(`path\0${path}`);
const pathIdentity = (path: string): { path_id: string; path_class?: string } => {
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(path.split("/").at(-1) ?? "")?.[0]?.toLowerCase();
  return { path_id: semanticFrontierPathId(path), ...(extension === undefined ? {} : { path_class: `*${extension}` }) };
};
const stable = <T>(values: readonly T[], key: (value: T) => string): T[] => [...values].sort((a, b) => key(a).localeCompare(key(b)));
function opaque(kind: AnchorKind, raw: string): InternalAnchor {
  const base = raw.split("/").at(-1) ?? "";
  const extension = kind === "path" ? /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0]?.toLowerCase() : undefined;
  return { id: sha(`${kind}\0${raw}`), kind, raw, ...(extension === undefined ? {} : { basename_class: `*${extension}` }) };
}
function anchorsForQuery(query: string): InternalAnchor[] {
  const found: InternalAnchor[] = [];
  const add = (kind: AnchorKind, raw: string): void => { if (raw !== "" && !found.some((item) => item.kind === kind && item.raw === raw)) found.push(opaque(kind, raw)); };
  for (const match of query.matchAll(/--[A-Za-z][A-Za-z0-9_-]*|\b[A-Z][A-Z0-9_]{2,}\b/g)) add("sigil", match[0]!);
  for (const match of query.matchAll(/(?:^|[\s"'`「『（(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)(?=$|[\s"'`」』）),，。:：;；!?！？]|について|を|に|の|で|へ|から|まで)/gu)) add("path", match[1]!);
  for (const match of query.matchAll(/(?:"([^"\n]{1,160})"|'([^'\n]{1,160})'|`([^`\n]{1,160})`)/g)) add("literal", match[1] ?? match[2] ?? match[3] ?? "");
  return stable(found, (anchor) => `${anchor.kind}:${anchor.id}`).slice(0, 12);
}
function compileConcerns(query: string): InternalConcern[] {
  const anchors = anchorsForQuery(query);
  const specs: Array<[ConcernKind, RegExp, AnchorKind[]]> = [
    ["flag", /(?:--[A-Za-z]|\b(?:flag|env|toggle)\b|フラグ|環境変数)/iu, ["sigil"]],
    ["template", /(?:\b(?:template|contract|guide|spec)\b|テンプレート|契約|ガイド|仕様|設計)/iu, ["path", "literal"]],
    ["generated", /(?:\b(?:generated|generate|generator|output)\b|生成|出力)/iu, ["path", "literal"]],
    ["measurement", /(?:\b(?:benchmark|bench|measure(?:ment)?|metric)\b|ベンチ|計測|測定)/iu, ["literal"]],
    ["relation", /(?:\b(?:relations?|graphs?|edges?|wiring|imports?|references?|continuations?)\b|関係|接続|参照|継続)/iu, ["path", "literal"]],
  ];
  return specs.flatMap(([kind, pattern, kinds]) => {
    if (!pattern.test(query)) return [];
    const matched = anchors.filter((anchor) => kinds.includes(anchor.kind));
    return [{ id: `semantic-frontier:${kind}`, kind, anchors: matched.length > 0 ? matched : [opaque("kind", kind)] }];
  });
}
/**
 * ADVISORY TIER (decision D3, plan §3.6.1 rule 6).
 *
 * `anchorsForQuery` and `compileConcerns` above are the ORIGINAL,
 * vocabulary-driven concern source: five regexes decide whether a concern
 * exists at all, which is exactly why engagement tracked the caller's phrasing
 * instead of the workspace (DESIGN-v0.14-plan.md:120). v0.15 retires them as a
 * SOURCE of authority and keeps them as a hint. The two readers below are the
 * whole of that hint's public surface; `sfConcerns.ts` consumes them, stamps
 * everything they produce `origin:"heuristic"`, and by invariant I-3 such a
 * concern can neither close a task nor block a peer.
 *
 * Additive readers over the same pure functions: the trace-only attestation
 * path is unchanged, and so is every byte it emits.
 */
export interface AdvisoryAnchorSpec { readonly kind: AnchorKind; readonly raw: string }
export interface AdvisoryConcernSpec { readonly id: string; readonly kind: ConcernKind; readonly anchors: readonly AdvisoryAnchorSpec[] }

/** Sigil / path / quoted-literal anchors of `query`, bounded and stably ordered. */
export function advisoryQueryAnchors(query: string): AdvisoryAnchorSpec[] {
  return anchorsForQuery(query).map((anchor) => ({ kind: anchor.kind, raw: anchor.raw }));
}

/** The legacy five-vocabulary matches for `query`, as ADVISORY hints only. */
export function advisoryRegexConcerns(query: string): AdvisoryConcernSpec[] {
  return compileConcerns(query).map((concern) => ({
    id: concern.id,
    kind: concern.kind,
    anchors: concern.anchors.map((anchor) => ({ kind: anchor.kind, raw: anchor.raw })),
  }));
}

type Relation = { id: string; proof: "graph-edge"; relation_kind: string; from_path: string; to_path: string };
function graphRelations(result: TaskPackResult): Relation[] {
  const graph = result.wiring?.evidence_graph;
  if (graph === undefined) return [];
  const paths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  return stable(graph.relations.flatMap((edge) => {
    const from = paths.get(edge.from); const to = paths.get(edge.to);
    const relationKind = typeof edge.kind === "string" ? edge.kind : "related";
    return typeof from !== "string" || typeof to !== "string" ? [] : [{ id: sha(`edge\0${edge.from}\0${edge.to}\0${relationKind}`), proof: "graph-edge" as const, relation_kind: relationKind, from_path: from, to_path: to }];
  }), (edge) => `${edge.from_path}\0${edge.to_path}\0${edge.id}`);
}
function bindingFor(concern: InternalConcern, surface: TaskPackSurface, code: string, graphPaths: Set<string>): Binding | undefined {
  for (const anchor of concern.anchors) {
    if (concern.kind === "relation") {
      if (graphPaths.has(surface.path)) return { concern_id: concern.id, anchor_id: anchor.id, anchor_kind: anchor.kind, proof: "graph-edge" };
      continue;
    }
    if (anchor.kind === "path" && (anchor.raw === surface.path || surface.path.endsWith(`/${anchor.raw}`))) return { concern_id: concern.id, anchor_id: anchor.id, anchor_kind: anchor.kind, proof: "path-exact" };
    if (anchor.kind !== "kind" && anchor.raw.length >= 3 && code.includes(anchor.raw)) return { concern_id: concern.id, anchor_id: anchor.id, anchor_kind: anchor.kind, proof: "identifier-literal" };
    const lower = surface.path.toLowerCase();
    const template = concern.kind === "template" && (["doc", "contract"].includes(surface.role) || /(?:template|render)/u.test(lower));
    const generated = concern.kind === "generated" && (/(?:\.gen\.|generated|generator|derived)/u.test(lower) || surface.role === "generated");
    const flag = concern.kind === "flag" && (surface.role === "config" || /(?:flag|config|env)/u.test(lower));
    const measurement = concern.kind === "measurement" && (surface.role === "test" || /(?:bench|metric|measure)/u.test(lower));
    if (template || generated || flag || measurement) return { concern_id: concern.id, anchor_id: anchor.id, anchor_kind: anchor.kind, proof: "provider-semantic" };
  }
  return undefined;
}
function contractEvidenceAddresses(result: TaskPackResult): Set<string> {
  const addresses = new Set<string>();
  const contract = result.execution_contract as unknown as Record<string, unknown> | undefined;
  const certificate = contract?.["readiness_certificate"];
  if (certificate === null || typeof certificate !== "object" || Array.isArray(certificate)) return addresses;
  for (const key of ["action_frontier", "evidence_handles"]) {
    const values = (certificate as Record<string, unknown>)[key];
    if (Array.isArray(values)) for (const value of values) if (typeof value === "string") addresses.add(value);
  }
  return addresses;
}

function hasExplicitSurfaceAnchor(surface: TaskPackSurface, query: string): boolean {
  const why = surface.why ?? "";
  if (/(?:caller-supplied|explicit|literal-first|filename-match|query-identifier)/u.test(why)) return true;
  if (surface.path !== "" && query.includes(surface.path)) return true;
  return surface.symbol !== undefined && new RegExp(`(?:^|[^A-Za-z0-9_$])${surface.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_$])`, "u").test(query);
}

/**
 * A legacy producer can mechanically stamp every located surface `required`.
 * That is not enough to make each one a semantic primary: only an explicit
 * anchor, the ranked primary, a certified action/evidence handle, a typed
 * provider/literal binding, or a real graph edge may keep a continuation
 * carrier. The source flag remains untouched for legacy compatibility; this
 * classifier is trace/continuation-only.
 */
function semanticPrimary(
  surface: TaskPackSurface,
  index: number,
  query: string,
  bindings: readonly Binding[],
  graphPaths: ReadonlySet<string>,
  contractAddresses: ReadonlySet<string>,
  producerUsesSupporting: boolean,
): boolean {
  // An explicit producer-side `required:false` remains supporting unless it
  // independently proves a typed/graph/explicit obligation. In particular it
  // must not become primary merely by being first in a compact test packet.
  const hardBinding = bindings.some((binding) => binding.proof === "path-exact"
    || binding.proof === "identifier-literal"
    || binding.proof === "provider-semantic"
    || binding.proof === "graph-edge");
  if (surface.required === false && !hardBinding && !graphPaths.has(surface.path)
    && !contractAddresses.has(surface.handle) && !hasExplicitSurfaceAnchor(surface, query)) return false;
  // A producer that has already emitted an explicit supporting sibling is
  // expressing requiredness deliberately. Respect its explicit `true` rather
  // than reclassifying a same-path, differently-addressed primary by rank.
  // The mechanical-all-true producer shape has no such counterexample and is
  // handled by the semantic evidence rules below.
  if (surface.required === true && producerUsesSupporting) return true;
  if (index === 0 || hasExplicitSurfaceAnchor(surface, query)) return true;
  if (contractAddresses.has(surface.handle)) return true;
  if (graphPaths.has(surface.path)) return true;
  return hardBinding;
}

function candidatesFor(result: TaskPackResult, concerns: readonly InternalConcern[], relations: readonly Relation[], query: string): Candidate[] {
  const graphPaths = new Set(relations.flatMap((edge) => [edge.from_path, edge.to_path]));
  const contractAddresses = contractEvidenceAddresses(result);
  const producerUsesSupporting = result.surfaces.some((surface) => surface.required === false);
  return stable(result.surfaces.map((surface, index) => {
    const code = surface.code ?? surface.code_unchanged ?? "";
    const bindings = concerns.map((concern) => bindingFor(concern, surface, code, graphPaths)).filter((value): value is Binding => value !== undefined);
    const proof: Proof = bindings[0]?.proof ?? (surface.role !== "unknown" ? "structural-role" : "lexical-only");
    const primary = semanticPrimary(surface, index, query, bindings, graphPaths, contractAddresses, producerUsesSupporting);
    return { surface, path: surface.path, role: surface.role, required: primary, proof, disposition: primary ? "required" : "supporting", bytes: Buffer.byteLength(code, "utf8"), bindings: stable(bindings, (binding) => `${binding.concern_id}:${binding.anchor_id}`) };
  }), (candidate) => `${candidate.path}\0${candidate.role}`);
}
function unresolvedFor(concerns: readonly InternalConcern[], candidates: readonly Candidate[], contract: TaskPackResult["execution_contract"]): Array<{ id: string; kind: ConcernKind; reason: string }> {
  const closureOpen = Array.isArray(contract?.semantic_closure?.unresolved) && contract.semantic_closure.unresolved.length > 0;
  const gapsOpen = Array.isArray(contract?.capability_gaps) && contract.capability_gaps.length > 0;
  return concerns.flatMap((concern) => {
    const resolved = candidates.some((candidate) => candidate.bindings.some((binding) => binding.concern_id === concern.id && (concern.kind === "relation" ? binding.proof === "graph-edge" : binding.proof === "path-exact" || binding.proof === "identifier-literal" || binding.proof === "path-semantic" || binding.proof === "provider-semantic")));
    return !closureOpen && !gapsOpen && resolved ? [] : [{ id: concern.id, kind: concern.kind, reason: closureOpen ? "semantic-closure-open" : gapsOpen ? "capability-gap-open" : "no-concern-hard-proof" }];
  });
}
// ---------------------------------------------------------------------------
// D4 (FX-R3, 2026-09-04) — THE MARKING SOURCE UNDER TL_SF_DEMOTE.
//
// Ruling (i) fixed the FLAG gate of `annotateSemanticFrontierContinuation`
// (classification now runs under either lever) but left its SOURCE untouched:
// `compileConcerns(query).length === 0 => return` meant that under the ten v2
// flags NOTHING was ever demotable unless the caller's phrasing happened to
// match one of the five retired legacy regexes (template/relation/flag/
// generated/measurement vocabulary). That is the exact query-phrasing
// dependence D3/G3 retired the vocabulary FOR. Live proof, same fixture and
// the same two files: "Trace ENGAGEMENT_WITNESS continuation relation while
// retaining the supporting context." marked `src/supporting_notes.ts`
// optional; "Trace ENGAGEMENT_WITNESS and explain renderEngagement while
// retaining the supporting notes." marked nothing at all.
//
// THE IMPLEMENTED CONTRACT (this wave's ruling):
//   * `guardEnabled` (the legacy TL_SEMANTIC_FRONTIER_GUARD arm) keeps the
//     legacy `compileConcerns` source and nothing else — byte-identical.
//     The two levers are mutually exclusive in production
//     (`assertSemanticFrontierV2FlagConsistency` refuses to boot otherwise),
//     so an explicit `guardEnabled` argument wins here by construction; it is
//     only ever both in a spec that passes the flag by hand.
//   * Under `sfDemoteEnabled()` the source is the pack's GROUNDED
//     (non-advisory, bound) v2 structural concern state, supplied by the
//     caller (`structuralConcerns`) from the SF pack context — never
//     re-extracted here, so the two can never disagree about their input.
//     A candidate is marked continuation-optional when it is not the ranked
//     primary, carries NO legacy binding, is not an explicit producer
//     `required:true` row (D3(a)), and has no binding to any grounded
//     structural concern.
//   * ZERO grounded structural concerns => mark nothing (conservative). This
//     is also what the pre-seam call site gets, since the concerns do not
//     exist yet at that point in the build.
//
// ATTESTATION. `eligible`/`attempted` keep their meaning ("a concern source
// produced something to work with"); under DEMOTE they now reflect the UNION
// source — the legacy regex concerns the attestation has always reported,
// plus the structural concerns this marking pass actually used, which the
// privacy-safe attestation payload does not enumerate.
// ---------------------------------------------------------------------------

/**
 * The structural-concern fields this module reads. Structurally satisfied by
 * `sfConcerns.ts`'s `SfStructuralConcern`; declared locally so this module
 * (which `sfConcerns.ts` itself imports for the advisory tier) needs no import
 * back the other way.
 */
export interface SemanticFrontierStructuralConcernView {
  readonly advisory?: boolean;
  readonly bindings?: readonly string[];
  readonly anchor?: {
    readonly kind?: string;
    readonly path?: string;
    readonly symbol?: string;
    readonly qualified?: string;
    readonly qualifier?: string;
    readonly member?: string;
  };
}

/** `a` and `b` name the same workspace-relative file. */
function samePathAddress(a: string, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");
  const left = norm(a);
  const right = norm(b);
  if (left === "" || right === "") return false;
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** A whole-word occurrence of `identifier` in `text`. */
function mentionsIdentifier(text: string, identifier: string): boolean {
  if (identifier.length < 3 || text === "") return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_$])`, "u").test(text);
}

/** Only a non-advisory concern with at least one binding can ground anything. */
function groundedStructuralConcerns(
  concerns: readonly SemanticFrontierStructuralConcernView[] | undefined,
): SemanticFrontierStructuralConcernView[] {
  return (concerns ?? []).filter((concern) =>
    concern !== null && typeof concern === "object"
    && concern.advisory !== true
    && Array.isArray(concern.bindings) && concern.bindings.length > 0);
}

/**
 * Is `surface` bound to any grounded structural concern — by ADDRESS (one of
 * the concern's bindings, or a path anchor) or by the concern's own
 * symbol/qualified anchor appearing as this surface's symbol or in its served
 * body? Anything that answers true keeps its body.
 */
function boundToStructuralConcern(
  surface: TaskPackSurface,
  grounded: readonly SemanticFrontierStructuralConcernView[],
): boolean {
  const code = surface.code ?? surface.code_unchanged ?? "";
  for (const concern of grounded) {
    for (const binding of concern.bindings ?? []) {
      if (typeof binding === "string" && surface.path !== "" && samePathAddress(binding, surface.path)) return true;
    }
    const anchor = concern.anchor;
    if (anchor === undefined || anchor === null) continue;
    if (typeof anchor.path === "string" && surface.path !== "" && samePathAddress(anchor.path, surface.path)) return true;
    for (const identifier of [anchor.symbol, anchor.member, anchor.qualified]) {
      if (typeof identifier !== "string" || identifier === "") continue;
      if (surface.symbol !== undefined && surface.symbol === identifier) return true;
      if (mentionsIdentifier(code, identifier)) return true;
    }
  }
  return false;
}

/**
 * What the last marking pass over a pack actually had to work with, so the
 * attestation can report `eligible`/`attempted` against the UNION source under
 * `TL_SF_DEMOTE` instead of the legacy vocabulary alone (FX-R3 D4). Keyed on
 * the pack object, exactly like `continuationOptional` above; nothing here is
 * serializable and nothing reaches the wire.
 */
interface SemanticFrontierMarkingSource {
  /** Legacy `compileConcerns` vocabulary hits for this query. */
  readonly legacy: number;
  /** Non-advisory, bound v2 structural concerns this pass actually used. */
  readonly grounded: number;
  /** Advisory v2 structural concerns present but unusable as a source (I-3). */
  readonly advisory: number;
  /** Which source the pass RAN on. `none` = it ran and had nothing to use. */
  readonly source: "legacy" | "structural" | "none";
}

const markingSourceOfPack = new WeakMap<object, SemanticFrontierMarkingSource>();

/**
 * Record what this marking pass had to work with, never DOWNGRADING an
 * earlier one. The classifier runs more than once over the same pack object
 * (readCodeTaskPack.ts: the pre-booking seam re-runs it with the concerns,
 * and the answer-only final projection runs it again without them), so a
 * later concern-less pass must not erase the source the pass that actually
 * marked rows used.
 */
function noteMarkingSource(result: object, next: SemanticFrontierMarkingSource): void {
  const prior = markingSourceOfPack.get(result);
  if (prior !== undefined && prior.grounded > next.grounded) return;
  markingSourceOfPack.set(result, next);
}

/** Mark every eligible concern's unbound context; required remains edit/primary. */
export function annotateSemanticFrontierContinuation(
  result: TaskPackResult,
  query: string,
  guardEnabled: boolean,
  structuralConcerns?: readonly SemanticFrontierStructuralConcernView[],
): void {
  // Third inertness layer (ratified): classification must run under EITHER
  // lever. TL_SF_DEMOTE and the legacy TL_SEMANTIC_FRONTIER_GUARD are
  // mutually exclusive (assertSemanticFrontierV2FlagConsistency), but both
  // depend on candidates having been marked continuation-optional HERE —
  // gating solely on the caller-supplied `guardEnabled` left demotion inert
  // whenever only TL_SF_DEMOTE was on, since nothing was ever marked for it
  // to demote. The legacy guard-only path stays byte-identical: this only
  // ADDS a second, independent way to pass the gate.
  if (!guardEnabled && !sfDemoteEnabled()) return;
  const concerns = compileConcerns(query);
  if (guardEnabled) {
    // LEGACY ARM — unchanged, vocabulary-sourced, byte-identical. The D7 note
    // below is a WeakMap side table only; the attestation reads it solely
    // under `sfDemoteEnabled()`, which is mutually exclusive with this arm.
    noteMarkingSource(result, {
      legacy: concerns.length,
      grounded: 0,
      advisory: 0,
      source: concerns.length > 0 ? "legacy" : "none",
    });
    if (concerns.length === 0) return;
    for (const candidate of candidatesFor(result, concerns, graphRelations(result), query)) {
      // Preserve every hard/typed binding. Unbound lexical context remains
      // useful to show in the producer result, but it must not amplify a qref
      // continuation merely because a legacy producer stamped it required.
      if (!candidate.required && candidate.bindings.length === 0) {
        continuationOptional.add(candidate.surface);
      }
    }
    return;
  }
  // v2 ARM (TL_SF_DEMOTE) — structural source, D4.
  const grounded = groundedStructuralConcerns(structuralConcerns);
  // D7 (FX-R3b, 2026-09-04) — DIAGNOSABILITY. "Nothing was demoted" had three
  // indistinguishable causes on the wire: no concern was extracted at all, one
  // was extracted but stayed advisory (nothing grounded it), or grounding
  // happened and residency/eligibility refused. The first two are separated
  // here, as COUNTS and an ENUM only — no identifiers, no paths, no query text
  // — and the attestation emits them solely under the v2 flags, so the
  // legacy-guard wire stays byte-identical.
  const advisoryCount = (structuralConcerns ?? []).length - grounded.length;
  noteMarkingSource(result, {
    legacy: concerns.length,
    grounded: grounded.length,
    advisory: Math.max(0, advisoryCount),
    source: grounded.length > 0 ? "structural" : "none",
  });
  if (grounded.length === 0) return;
  for (const candidate of candidatesFor(result, concerns, graphRelations(result), query)) {
    if (candidate.required || candidate.bindings.length > 0) continue;
    // D3(a) (FX-R3, 2026-09-04): an EXPLICIT producer `required:true` is never
    // continuation-optional. `semanticPrimary` only honors that flag when the
    // producer also used `required:false` somewhere in the same pack
    // (`producerUsesSupporting`), so on an all-true producer — which is what
    // the recursive read closure mints — a row the producer had explicitly
    // called required could be demoted out from under the very obligation it
    // was minted for.
    if (candidate.surface.required === true) continue;
    if (boundToStructuralConcern(candidate.surface, grounded)) continue;
    continuationOptional.add(candidate.surface);
  }
}
function publicConcern(concern: InternalConcern): { id: string; kind: ConcernKind; anchors: OpaqueAnchor[] } { return { id: concern.id, kind: concern.kind, anchors: concern.anchors.map(({ id, kind, basename_class }) => ({ id, kind, ...(basename_class === undefined ? {} : { basename_class }) })) }; }
/** Build the final bounded shadow record without serializing query text or bodies. */
export function buildSemanticFrontierAttestation(input: SemanticFrontierAttestationInput): Record<string, unknown> {
  let concerns = compileConcerns(input.query); let relations = graphRelations(input.result);
  const allCandidates = candidatesFor(input.result, concerns, relations, input.query); let candidates = allCandidates.slice(0, CANDIDATE_CAP);
  const counts = { concerns: 0, anchors: 0, relations: Math.max(0, relations.length - RELATION_CAP), candidates: Math.max(0, allCandidates.length - candidates.length), dropped: 0 };
  relations = relations.slice(0, RELATION_CAP);
  const make = (): Record<string, unknown> => {
    const dropped = allCandidates.slice(candidates.length).map((candidate) => pathIdentity(candidate.path).path_id).sort();
    const emitted = candidates.map(({ surface: _surface, path, ...candidate }) => ({ ...candidate, ...pathIdentity(path) }));
    // FX-N0 (2026-09-03): `TL_SEMANTIC_FRONTIER_GUARD` (`input.guardEnabled`)
    // and `TL_SF_DEMOTE` are mutually exclusive
    // (`assertSemanticFrontierV2FlagConsistency`), so gating solely on
    // `guardEnabled` made this provisional field structurally `false` for
    // the entire v0.15 (B) treatment arm — a marker set by
    // `annotateSemanticFrontierContinuation` under EITHER lever (that
    // function's own gate is `guardEnabled || sfDemoteEnabled()`) must be
    // able to commit under either lever too. `sfStatefulEnabled()` is
    // included defensively per that function's third-inertness-layer fix,
    // though `sfDemoteEnabled()` already implies it. This value is
    // provisional and discarded by `prepareSemanticFrontierTraceSeed`
    // below; the authoritative post-wire value is computed in
    // `finalizeSemanticFrontierAttestation`.
    const committed = (input.guardEnabled || sfDemoteEnabled() || sfStatefulEnabled())
      && input.result.surfaces.some((surface) => isSemanticFrontierContinuationOptional(surface));
    // FX-R3 D4 (2026-09-04): `eligible`/`attempted` keep their meaning — "a
    // concern source produced something this pass could work with" — but under
    // `TL_SF_DEMOTE` the source is the UNION: the legacy regex concerns this
    // payload has always enumerated, plus the pack's grounded structural
    // concerns, which the marking pass actually used and which this
    // privacy-safe payload deliberately does not enumerate. The legacy-guard
    // arm is byte-identical (`sfDemoteEnabled()` is false there).
    const markingSource = sfDemoteEnabled() ? markingSourceOfPack.get(input.result) : undefined;
    const groundedMarkingConcerns = markingSource?.grounded ?? 0;
    const sourceProducedConcerns = concerns.length > 0 || groundedMarkingConcerns > 0;
    // D7 (FX-R3b): privacy-safe marking diagnosability, v2 flags only. Counts
    // and one enum; absent (not zero) whenever TL_SF_DEMOTE is off, which is
    // what keeps the legacy/off attestation byte-identical.
    const markingDiagnostics: Record<string, unknown> = sfDemoteEnabled()
      ? {
        structural_concerns: {
          grounded: markingSource?.grounded ?? 0,
          advisory: markingSource?.advisory ?? 0,
        },
        marking_source: markingSource?.source ?? "none",
      }
      : {};
    return { schema_version: 1, ...markingDiagnostics, eligible: sourceProducedConcerns, attempted: sourceProducedConcerns, committed, guard_enabled: input.guardEnabled, decision: input.finalDecision ?? input.result.execution_contract?.typestate.phase ?? input.result.route?.action ?? "unknown", surface_count: input.finalEvidenceCount ?? allCandidates.length, surface_bytes: input.finalEvidenceBytes ?? allCandidates.reduce((sum, candidate) => sum + candidate.bytes, 0), concerns: concerns.map(publicConcern), relations: relations.map((edge) => ({ id: edge.id, proof: edge.proof, relation_kind: edge.relation_kind, from_path_id: pathIdentity(edge.from_path).path_id, to_path_id: pathIdentity(edge.to_path).path_id })), candidates: emitted, required_path_ids: [...new Set(emitted.filter((candidate) => candidate.required).map((candidate) => candidate.path_id))].sort(), supporting_path_ids: [...new Set(emitted.filter((candidate) => !candidate.required).map((candidate) => candidate.path_id))].sort(), dropped_path_ids: dropped.slice(0, CANDIDATE_CAP), unresolved: unresolvedFor(concerns, candidates, input.result.execution_contract), truncated_count: { ...counts, dropped: counts.dropped + dropped.length } };
  };
  let payload = make();
  while (Buffer.byteLength(JSON.stringify(payload), "utf8") > SERIALIZED_BYTE_CAP) {
    if (candidates.length > 0) { candidates = candidates.slice(0, -1); counts.candidates += 1; }
    else if (relations.length > 0) { relations = relations.slice(0, -1); counts.relations += 1; }
    else if (concerns.some((concern) => concern.anchors.length > 0)) { const removed = concerns.reduce((total, concern) => total + (concern.anchors.length > 0 ? 1 : 0), 0); concerns = concerns.map((concern) => concern.anchors.length === 0 ? concern : { ...concern, anchors: concern.anchors.slice(0, -1) }); counts.anchors += removed; }
    else if (concerns.length > 0) { concerns = concerns.slice(0, -1); counts.concerns += 1; }
    else break;
    payload = make();
  }
  return payload;
}

/**
 * Capture the shadow's input while the task-pack result is still available.
 * The returned value is deliberately safe to retain in the call-local trace
 * context:
 * no query text, paths, bodies, handles, or result/surface objects escape.
 */
export function prepareSemanticFrontierTraceSeed(
  result: TaskPackResult,
  query: string,
  guardEnabled: boolean,
): SemanticFrontierTraceSeed {
  const markerCount = result.surfaces.filter((surface) => isSemanticFrontierContinuationOptional(surface)).length;
  const attestation = buildSemanticFrontierAttestation({ result, query, guardEnabled });
  // These are observed only after the codec, shedding and fail-closed paths.
  // Deleting them prevents a provisional producer fact from masquerading as a
  // final wire fact if finalization later fails or changes the response kind.
  delete attestation["decision"];
  delete attestation["surface_count"];
  delete attestation["surface_bytes"];
  delete attestation["committed"];
  return { attestation, guard_enabled: guardEnabled, marker_count: markerCount };
}

/** Combine the opaque seed with facts parsed from the actual final JSON wire. */
export function finalizeSemanticFrontierAttestation(
  seed: SemanticFrontierTraceSeed,
  observation: SemanticFrontierWireObservation,
  witnesses: readonly {
    reason: string;
    kind: "evidence" | "decision";
    id: string;
    outcome?: "next" | "await-input";
  }[],
): Record<string, unknown> {
  const finalEvidenceIds = new Set(observation.evidence_witness_ids ?? []);
  const activeWitnesses = observation.wire_observed && observation.wire_kind === "read.task_pack"
    ? witnesses.filter((witness) => witness.kind === "evidence"
      ? finalEvidenceIds.has(witness.id)
      : witness.outcome === "await-input"
        ? observation.decision_kind === "await_input"
        : observation.decision_next_witness_id === witness.id)
    : [];
  // A marker or a pre-shed projection note cannot claim a commit.  Only a
  // witness that survives in the final task-pack wire establishes one.
  //
  // FX-N0 (2026-09-03): `seed.guard_enabled` reports only the LEGACY
  // `TL_SEMANTIC_FRONTIER_GUARD` lever, which is mutually exclusive with
  // `TL_SF_DEMOTE` (`assertSemanticFrontierV2FlagConsistency`) — so gating
  // the whole formula on it made `committed` a structural constant `false`
  // for the entire v0.15 (B) treatment arm, even when that arm's own
  // demotion mechanism visibly acted (`observation.demoted_count > 0`).
  // `activeWitnesses` is itself only ever populated by the legacy guard's
  // suppression/next-selection path (`protocol/decisionWire.ts`), so it
  // stays the correct signal for `seed.guard_enabled`; `demoted_count` is
  // the parallel decision/trace fact for the v2 demote path — present only
  // when `TL_SF_DEMOTE` observed a real final-wire demotion
  // (`protocol/envelope.ts`'s `observeSemanticFrontierWire`, itself gated on
  // `sfDemoteEnabled()`) — so no additional flag re-check is needed here:
  // either disjunct is already self-gated by the lever that produced it,
  // and OR-ing them keeps the legacy-only arm's value byte-identical
  // (`demoted_count` is `undefined` whenever `TL_SF_DEMOTE` is off).
  //
  // FX-R3d (D10, 2026-09-04) — WHAT `committed` NOW MEANS ON THE V2 ARM.
  // "the demotion mechanism visibly acted" is only true of `demoted_count` now
  // that the count is MARK-based: `applySemanticFrontierDemotion` marked the
  // surface it took a body from, and the final wire still ships that row
  // bodyless. Before D10 the count was read off wire SHAPE, so a caller-named
  // row that joined the frontier bodyless past the byte cap (D8/FX-R3c) set
  // `committed:true` on a call where ZERO bodies were withheld — measured live
  // on the sealed SF05 replay. `committed` is the engagement signal for the
  // deterministic v2 gate, the smoke floor and the paid A/B, so that was an
  // inflation of the treatment arm's own headline claim. `withheld_named_count`
  // now carries those rows and deliberately does NOT enter this formula.
  const demotionCommitted = typeof observation.demoted_count === "number" && observation.demoted_count > 0;
  const committed = observation.wire_observed
    && observation.wire_kind === "read.task_pack"
    && ((seed.guard_enabled && activeWitnesses.length > 0) || demotionCommitted);
  const totalEvidenceBytes = (observation.evidence_body_bytes ?? 0) + (observation.evidence_prior_bytes ?? 0);
  // These are privacy-safe, opaque hashes of final wire addresses/next.  They
  // are emitted so the paid verifier can detect trace-field tampering against
  // the captured wire; raw path, handle, range and request material remain
  // absent from the trace.
  const publicObservation = observation;
  return {
    ...seed.attestation,
    attempted: seed.attestation["attempted"] === true,
    committed,
    guard_enabled: seed.guard_enabled,
    marker_count: seed.marker_count,
    suppression_reasons: [...new Set(activeWitnesses.map((witness) => witness.reason))].sort(),
    ...publicObservation,
    // Kept as compact aliases for the existing trace reader; the typed fields
    // above are the authoritative final-wire observation.
    ...(observation.wire_observed ? {
      decision: observation.decision_kind ?? "unknown",
      surface_count: observation.evidence_count ?? 0,
      surface_bytes: totalEvidenceBytes,
    } : {}),
  };
}
