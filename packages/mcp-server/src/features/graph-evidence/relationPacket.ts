// ---------------------------------------------------------------------------
// graph-evidence/relationPacket.ts — W-RELATION-PACKET: relation packet
// compiler (core compiler only, NO wiring this wave).
//
// NORMATIVE SOURCE: DESIGN-v0.15-semantic-frontier-plan.md §3.7 (relation
// packets), §4.2 (the projection target is the EXISTING
// `plan.wiring.evidence_graph` field — no new wire field), §7.1
// (`relation_packet_one_shot`), §9 W6 ("relation packet compiler
// (`graph-evidence` 上の bounded 導出、`plan.wiring.evidence_graph` への射影)",
// named risk: fan-out bounding).
//
// WHAT THIS MODULE IS
// --------------------
// A PURE compiler: `compileRelationPacket()` takes an anchor, a
// `RelationGraphPort` (the caller's injected view of apiGraph + references —
// real production code binds it to `EdgeDeriver`/providers; a spec binds it
// to a synthetic fixture), and a byte/node/edge budget, and returns a
// `RelationPacket` — definition + declaration + direct callers/callees
// (+ implementations, when the port reports any) as compact edge lines with
// zoom handles, never bodies. `projectRelationPacketToEvidenceGraph()` then
// reshapes that packet into the EXISTING `TaskEvidenceGraph` wire shape
// (`@tokenlighten/types`) — this module defines its own structurally
// identical `RelationEvidenceGraph`/`RelationEvidenceNode`/
// `RelationEvidenceRelation` types rather than importing the wire types
// directly, so the engine stays a zero-foreign-import pure module (matching
// this directory's `purity.spec.ts` posture) while still being provably
// shape-compatible (see `relationPacket.spec.ts`'s structural assertion).
//
// WHAT THIS MODULE IS NOT
// ------------------------
//  * NOT wired. Nothing in `features/task-pack/**`, `server.ts`,
//    `protocol/**`, or `task-state/**` imports this file this wave. Deciding
//    WHEN a relation concern is satisfied by a packet (vs. falling back to
//    `search_files {action:"references"}` on a big fan-out, per §3.7.2's
//    "packet は『1 応答で足りるとき』の最適化であって、上限の代替ではない") is
//    W-SATISFACTION's job, not this compiler's.
//  * NOT reading flags or the environment. `sfRelationPacketsEnabled()`
//    (`util/flags.ts`) gates the future WIRING, not this pure function.
//  * NOT deriving edges itself. Edge derivation belongs to `EdgeDeriver`
//    (`edges.ts`) and the provider set (`providers.ts`); `RelationGraphPort`
//    is the seam a real adapter binds those to. This module only bounds,
//    sorts, and serializes what the port hands back.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { edgeId, nodeId, type GraphEdge, type GraphNode } from "./model.js";
import { BoundTracker, type ExpansionBounds } from "./bounds.js";

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

/** Exactly one binding strategy per call: a bare symbol, a qualified member, or a path. */
export interface RelationAnchor {
  readonly symbol?: string;
  readonly qualified?: { readonly class: string; readonly member: string };
  readonly path?: string;
}

function validateAnchor(anchor: RelationAnchor): void {
  if (anchor.symbol === undefined && anchor.qualified === undefined && anchor.path === undefined) {
    throw new RangeError(
      "compileRelationPacket: anchor must specify one of symbol, qualified, or path",
    );
  }
}

function anchorSymbolName(anchor: RelationAnchor): string | undefined {
  if (anchor.qualified !== undefined) return anchor.qualified.member;
  return anchor.symbol;
}

// ---------------------------------------------------------------------------
// Anchor byte bounding (F1, round 11). Every other packet field is priority-
// shedable via `admittedFlat` below (see `compileRelationPacket`), but the
// anchor itself is embedded in EVERY returned packet — including the
// "unresolved" fallback — and was never bounded: a single pathologically
// long anchor string (an obfuscated/minified symbol name, an absurd path)
// could single-handedly exceed `budget.maxBytes` with nothing left to shed,
// silently breaking the documented `bytes <= budget.maxBytes` invariant.
// Bounding it here, ALWAYS, keeps the anchor's own contribution small and
// predictable while disclosing (never silently discarding) what was cut.
// This never touches the anchor passed to `graph.resolveDefinition` /
// `resolveDeclaration` — only the copy embedded in the packet the caller
// sees.
// ---------------------------------------------------------------------------

const ANCHOR_FIELD_MAX_CHARS = 200;

function anchorFieldHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function boundAnchorText(value: string): string {
  if (value.length <= ANCHOR_FIELD_MAX_CHARS) return value;
  const elided = value.length - ANCHOR_FIELD_MAX_CHARS;
  return `${value.slice(0, ANCHOR_FIELD_MAX_CHARS)}…[+${elided} chars elided, sha256:${anchorFieldHash(value)}]`;
}

/** Bounds every over-length string field of `anchor`, leaving a short, disclosed placeholder in its place — never a silent truncation. */
function boundAnchorForPacket(anchor: RelationAnchor): RelationAnchor {
  if (anchor.symbol !== undefined && anchor.symbol.length > ANCHOR_FIELD_MAX_CHARS) {
    return { ...anchor, symbol: boundAnchorText(anchor.symbol) };
  }
  if (anchor.qualified !== undefined) {
    const { class: className, member } = anchor.qualified;
    if (className.length > ANCHOR_FIELD_MAX_CHARS || member.length > ANCHOR_FIELD_MAX_CHARS) {
      return { ...anchor, qualified: { class: boundAnchorText(className), member: boundAnchorText(member) } };
    }
  }
  if (anchor.path !== undefined && anchor.path.length > ANCHOR_FIELD_MAX_CHARS) {
    return { ...anchor, path: boundAnchorText(anchor.path) };
  }
  return anchor;
}

// ---------------------------------------------------------------------------
// The port — apiGraph + references, injectable for tests
// ---------------------------------------------------------------------------

/** A resolved anchor or declaration site: a node plus what a caller needs to zoom in. */
export interface RelationResolvedSite {
  readonly node: GraphNode;
  /** 1-based inclusive line range, e.g. "10-24". Omitted when unknown — never guessed. */
  readonly range?: string;
  /** Reusable read handle, when the port has already cast one. */
  readonly handle?: string;
}

/**
 * A relation class `compileRelationPacket` knows how to emit but a given
 * port may be structurally unable to compute — never "computed and found
 * none for this anchor" (that case stays a genuine empty array), only
 * "no adapter capability exists to attempt it, for any anchor". Extend this
 * union the same commit a second class gains a real "no source" adapter.
 *
 * FX-R2 (round 18B finding 2, 2026-09-03): `"callers"` added — the real
 * production port (`relationGraphPort.ts`'s `createWorkspaceRelationGraphPort`)
 * has no call-edge source AT ALL for either direction until a real
 * `GraphIndex` is on disk (`.tokenlighten/index/tl-graph.json`/`scip.binpb`);
 * TL does not write that file itself, so a fresh workspace's `callersOf` was
 * silently always `[]` before this fix — the identical FX-G-B shape
 * `"callees"` already covers, now extended to the symmetric case.
 */
export type RelationUnavailableKind = "callees" | "callers";

export interface RelationGraphPort {
  /**
   * Resolve the anchor to its definition site. For a `qualified` anchor
   * ({class, member}) the port MUST apply class-scoped matching (mirrors
   * D5): a member declared on a DIFFERENT class with the same name must
   * never bind. This compiler forwards the anchor verbatim and never
   * second-guesses the port's resolution — the scoping guarantee lives
   * entirely in the port's implementation (real or fixture).
   * Returns `undefined` when the anchor does not resolve to anything.
   */
  readonly resolveDefinition: (anchor: RelationAnchor) => RelationResolvedSite | undefined;
  /**
   * The declaration site, when distinct from the definition (e.g. a C/C++
   * header vs. its .cpp definition). Omit the method, or return `undefined`,
   * when the language has no such distinction — the packet then carries no
   * `declaration` at all rather than a duplicate of `definition`.
   */
  readonly resolveDeclaration?: (
    anchor: RelationAnchor,
    definition: RelationResolvedSite,
  ) => RelationResolvedSite | undefined;
  /**
   * Every direct edge touching `node`, in either direction. No bounding is
   * expected here — `compileRelationPacket` does all fan-out bounding. A
   * real adapter binds this to `EdgeDeriver.edgesFor` plus its provider set;
   * a test fixture returns a plain array.
   */
  readonly edgesFor: (node: GraphNode) => readonly GraphEdge[];
  /** True when `path` is test-only and should be deprioritized absent `includeTests`. */
  readonly isTestPath?: (path: string) => boolean;
  /**
   * Relation classes this port structurally cannot compute for ANY anchor
   * (e.g. `["callees"]` when the adapter has no real call-edge source —
   * see `relationGraphPort.ts`'s `calleesOf` removal note). When set,
   * `compileRelationPacket` never attempts that class: the resulting packet
   * OMITS the corresponding field (and its `truncated` counterpart) rather
   * than reporting an empty array, and lists the class in `unavailable` —
   * an empty array would read as "computed, found nothing" under this
   * codebase's absence-is-meaning convention, which is false here. Omit
   * this property (or leave it empty) when every class this compiler emits
   * is at least attempted.
   */
  readonly unavailableRelations?: readonly RelationUnavailableKind[];
  /**
   * FX-U2 (round 19B finding 1, 2026-09-04): a per-ANCHOR refinement of
   * `unavailableRelations` above, for a relation class whose availability
   * depends on the SPECIFIC anchor being compiled, not merely on whether
   * this port has any source at all. The motivating case: the real
   * production port's `callersOf` can only attribute a `GraphIndex`'s
   * bare-name reference list to one qualified `Class::member` anchor's own
   * definition when no OTHER definition shares that bare member name (see
   * `relationGraphPort.ts`'s `resolveDefinition`/`callersOf` comments for
   * the full mechanism) — when two classes share a member name and the
   * index carries no per-reference class-scope to disambiguate, attributing
   * the merged list to either one would be a guess, so the port names
   * `"callers"` here for THAT anchor rather than for the port as a whole
   * (where it would incorrectly suppress every OTHER, unambiguous anchor's
   * callers too).
   *
   * `compileRelationPacket` computes the effective unavailable set as the
   * UNION of `unavailableRelations` (anchor-independent) and whatever this
   * function returns for the anchor actually being compiled — never a
   * replacement, so a port can keep disclosing its structural gaps
   * unconditionally while ALSO refining one anchor's disclosure through
   * this hook. Omit when every class this port can ever compute has one
   * availability answer independent of the anchor (the common case, and the
   * only shape this type had before FX-U2).
   */
  readonly unavailableRelationsForAnchor?: (anchor: RelationAnchor) => readonly RelationUnavailableKind[];
  /**
   * FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): file+line
   * sites that MENTION the anchor's bare member name without proving a
   * call — a real occurrence-based index's non-definition, non-import
   * occurrences. Distinct from `callersOf`/`references` (`ReferenceProvider`,
   * `providers.ts`, gated on a proven CALL-edge source and classified as
   * `"calls"`/`"called-by"`): this method is a SEPARATE, top-level port
   * capability so `compileRelationPacket` can never confuse the two —
   * a real production port (`relationGraphPort.ts`'s
   * `createWorkspaceRelationGraphPort`) implements this ONLY when the loaded
   * `GraphIndex.hasReferenceOccurrences() === true` (SCIP today), and MUST
   * apply the same anchor-ambiguity discipline `callersOf` does (never
   * attribute a bare-name-collision's merged list to one specific anchor).
   *
   * Optional: a port with no reference-occurrence source at all omits this
   * method entirely (never a permissive `[]`) — `compileRelationPacket` then
   * never attempts the `referencedBy` class, and the resulting packet OMITS
   * the `referencedBy` field the same way it omits `implementations` when
   * the port never reported one (§the `implementations` field's own doc:
   * "Present iff the port reported at least one..."). There is deliberately
   * NO `RelationUnavailableKind` entry for this class (unlike `callers`/
   * `callees`) — `referenced_by` is an ADDITIVE, evidence-only signal no
   * existing guide sentence promises, so its absence needs no disclosure
   * beyond the field simply not appearing.
   */
  readonly referencedBy?: (anchor: RelationAnchor) => readonly RelationReferenceLocation[];
  /**
   * Round-22B finding 3 (MEDIUM, 2026-09-04): how many RAW candidates a real
   * port's own pre-admission fan-out cap (`relationGraphPort.ts`'s
   * `rawFanoutCap`) discarded for this anchor BEFORE `referencedBy` above
   * ever returned them — i.e. candidates this compiler's own admission loop
   * never even saw, so it could never count them into `truncated
   * .referencedBy` on its own. Optional and additive: a port with no
   * pre-admission cap (or no `referencedBy` capability at all) omits this
   * method entirely, and `compileRelationPacket` then adds `0` — never a
   * fabricated count. When present, `compileRelationPacket` folds the
   * reported number directly into `truncated.referencedBy`, keeping that
   * field's own doc ("Never silently dropped — always counted") honest for
   * the pre-admission cut, not merely the byte/edge-count shed this compiler
   * already tracked.
   */
  readonly referencedByOverflowCount?: (anchor: RelationAnchor) => number;
}

/**
 * A raw file+line mention `RelationGraphPort.referencedBy` reports, before
 * budget admission or handle minting. Deliberately NOT a `GraphNode`/
 * `SymbolReference` (the `edgesFor`/`ReferenceProvider` machinery,
 * `providers.ts`/`edges.ts`) — this capability bypasses `EdgeDeriver`
 * entirely (FX-W1: those files are shared with the token-index path and
 * cannot be gated per-format from here), so it needs no node identity, only
 * enough to mint a handle and disclose a location honestly.
 */
export interface RelationReferenceLocation {
  readonly path: string;
  /** 1-based line, when the occurrence carries one. Omitted, never guessed. */
  readonly line?: number;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface RelationPacketBudget {
  /** Distinct admitted sites (definition + declaration + each edge line), fan-out's primary fence. */
  readonly maxNodes: number;
  /** Total admitted edge lines across callers + callees + implementations. */
  readonly maxEdges: number;
  /** Ceiling on the packet's own serialized byte size (measured, never estimated-only). */
  readonly maxBytes: number;
}

/**
 * DESIGN-v0.15-semantic-frontier-plan.md §3.7.2's SF_RELATION_NODES_MAX /
 * SF_RELATION_EDGES_MAX / SF_RELATION_PACKET_BYTES. `maxBytes` was 6144
 * before W-RELATION-WIRE reconciled it against the design's own
 * `SF_RELATION_PACKET_BYTES = 4096` constant.
 */
export const DEFAULT_RELATION_PACKET_BUDGET: RelationPacketBudget = {
  maxNodes: 24,
  maxEdges: 48,
  maxBytes: 4096,
};

function normalizeBudget(budget: Partial<RelationPacketBudget> | undefined): RelationPacketBudget {
  const merged: RelationPacketBudget = { ...DEFAULT_RELATION_PACKET_BUDGET, ...budget };
  for (const key of ["maxNodes", "maxEdges", "maxBytes"] as const) {
    const value = merged[key];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `compileRelationPacket: budget.${key} must be a positive integer (got ${String(value)})`,
      );
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Edge lines and the packet
// ---------------------------------------------------------------------------

/**
 * `"referenced-by"` added (FX-W1, round 21B finding 1, HIGH, 2026-09-04,
 * ruling (z)): a file+line site that merely MENTIONS the anchor — a real
 * occurrence-based index's non-definition, non-import occurrence (SCIP,
 * once `Definition`/`Import` roles are excluded) — never a proven call.
 * Distinct from `"calls"`/`"called-by"`, which require a proven call-edge
 * source (`GraphIndex.hasCallEdges()`, still none exist today); this kind is
 * gated on the weaker `GraphIndex.hasReferenceOccurrences()` instead (see
 * `relationGraphPort.ts`'s `referencedBy`). Maps to the wire's
 * `"referenced_by"` `RelationEvidenceRelationKind`/`TaskEvidenceRelationKind`
 * (additive) — never `"direct_calls"`.
 */
export type EdgeLineKind = "calls" | "called-by" | "implements" | "declares" | "defines" | "imports" | "referenced-by";

/** A compact, bodyless relation line: enough to identify and zoom, never to read from inline. */
export interface EdgeLine {
  readonly path: string;
  readonly range?: string;
  readonly symbol: string;
  readonly kind: EdgeLineKind;
  readonly handle?: string;
}

export interface RelationSite {
  readonly path: string;
  readonly range?: string;
  readonly handle?: string;
}

export interface RelationPacketTruncation {
  readonly definition: number;
  readonly declaration: number;
  /** Absent (never `0`) when `callers` itself is absent (FX-R2) — an unattempted class has no truncation count to report. */
  readonly callers?: number;
  /** Absent (never `0`) when `callees` itself is absent — an unattempted class has no truncation count to report. */
  readonly callees?: number;
  readonly implementations: number;
  /**
   * FX-W1 (round 21B finding 1, 2026-09-04, ruling (z)): mirrors
   * `implementations`, not `callers`/`callees` — always present (`0` when
   * the port never implements `referencedBy` at all, matching
   * `implementations`'s own "unattempted reads as zero, absence of the
   * FIELD is the real signal" posture, since this class has no dedicated
   * `RelationUnavailableKind` entry to disclose non-attempt separately).
   */
  readonly referencedBy: number;
}

export interface RelationPacket {
  /** Every string field is bounded to `ANCHOR_FIELD_MAX_CHARS`; an over-length value is replaced by a disclosed `<prefix>…[+N chars elided, sha256:<digest>]` placeholder rather than left unsheddable (F1, round 11). */
  readonly anchor: RelationAnchor;
  /** Absent when the anchor did not resolve, OR when it resolved but was shed under an extreme byte budget. */
  readonly definition?: RelationSite;
  readonly declaration?: RelationSite;
  /** Absent (never an empty array) when the port lists `"callers"` in `unavailableRelations` (FX-R2) — see `unavailable` below. Present (possibly `[]`) whenever the port at least attempted this class. */
  readonly callers?: readonly EdgeLine[];
  /** Absent (never an empty array) when the port lists `"callees"` in `unavailableRelations` — see `unavailable` below. Present (possibly `[]`) whenever the port at least attempted this class. */
  readonly callees?: readonly EdgeLine[];
  /** Present iff the port reported at least one IMPLEMENTS/EXTENDS edge for this anchor. */
  readonly implementations?: readonly EdgeLine[];
  /**
   * FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): present iff
   * `RelationGraphPort.referencedBy` was implemented AND reported at least
   * one mention (mirrors `implementations`'s presence rule, never
   * `callers`/`callees`'s "absent means unavailable" rule — see
   * `RelationGraphPort.referencedBy`'s doc for why this class has no
   * `RelationUnavailableKind` entry). Every line's `kind` is
   * `"referenced-by"`; never `"calls"`/`"called-by"` — a mention is not a
   * call, and `projectRelationPacketToEvidenceGraph` maps it to the
   * honest, lower-confidence `"referenced_by"` wire kind, never
   * `"direct_calls"`.
   */
  readonly referencedBy?: readonly EdgeLine[];
  /** How many candidates of each kind did NOT fit the budget. Never silently dropped — always counted. */
  readonly truncated: RelationPacketTruncation;
  /**
   * Relation classes this packet's port cannot compute at all, carried
   * straight from `RelationGraphPort.unavailableRelations` — e.g.
   * `["callees"]` when no real call-edge source exists. Absent (never `[]`)
   * when every class this compiler emits was at least attempted. A reader
   * MUST NOT read the corresponding field's absence (`callees` here) as "no
   * callees" unless this array also fails to name it.
   */
  readonly unavailable?: readonly RelationUnavailableKind[];
  /**
   * Actual measured UTF-8 byte length of the packet AT ADMISSION TIME (this
   * field excluded) — i.e. the packet `compileRelationPacket` produced,
   * before any handle minting. When `handles_minted` below is set,
   * `mintRelationHandles()` carried this admission-time measurement forward
   * UNCHANGED rather than re-measuring after adding `.handle` strings to
   * every site/edge-line, so `bytes` describes that earlier, unminted
   * packet, not the one actually being returned. The real invariant —
   * `bytes <= budget.maxBytes || over_budget === true` — held at admission
   * time and is not re-verified after minting (G8: no response-level
   * re-measurement at that seam). Shedding tries the bounded anchor, then
   * declaration/callers/callees/implementations/referencedBy (FX-W1:
   * `referencedBy` sheds FIRST — the least authoritative signal this packet
   * carries), then the definition last, to fit `maxBytes` — but when even
   * the bounded anchor by itself cannot fit, `over_budget` is set instead of
   * silently exceeding the cap.
   */
  readonly bytes: number;
  /** Whether `graph.resolveDefinition(anchor)` found anything at all. Forced to `false` when `over_budget` is `true` — the packet holds nothing usable regardless of what resolution actually found. */
  readonly resolved: boolean;
  /** `true` only when even the bounded anchor (with everything else shed) does not fit `budget.maxBytes` — the documented escape hatch from `bytes <= budget.maxBytes` (F1, round 11). Absent (never `false`) otherwise. */
  readonly over_budget?: boolean;
  /** Set by `relationGraphPort.ts`'s `mintRelationHandles()` (a POST-compile step, never set by this compiler) to record that `bytes` above is the admission-time measurement taken BEFORE handles were minted onto the packet's sites/edge-lines — carried forward unchanged rather than re-measured, since minting only adds already-admitted `.handle` strings and never re-opens the admission decision (G8: no response-level re-measurement at this seam). Absent (never `false`) when this packet was never handle-minted. */
  readonly handles_minted?: true;
}

// ---------------------------------------------------------------------------
// Test-path deprioritization
// ---------------------------------------------------------------------------

const DEFAULT_TEST_PATH_RE =
  /(^|\/)(__tests__|__mocks__|tests?|specs?)(\/|$)|[._-](test|spec)s?\.[^/.]+$/i;

function defaultIsTestPath(path: string): boolean {
  return DEFAULT_TEST_PATH_RE.test(path);
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

interface RawRelation {
  readonly other: GraphNode;
  readonly edge: GraphEdge;
}

function dedupeByEdgeId(raw: readonly RawRelation[]): RawRelation[] {
  const seen = new Set<string>();
  const out: RawRelation[] = [];
  for (const item of raw) {
    const id = edgeId(item.edge);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Definition first, then declaration, then callers sorted by path/line, then callees — §3.7. */
function compareRaw(a: RawRelation, b: RawRelation): number {
  if (a.other.path !== b.other.path) return a.other.path < b.other.path ? -1 : 1;
  const aLine = a.other.line ?? Number.MAX_SAFE_INTEGER;
  const bLine = b.other.line ?? Number.MAX_SAFE_INTEGER;
  if (aLine !== bLine) return aLine - bLine;
  const aSym = a.other.symbol ?? "";
  const bSym = b.other.symbol ?? "";
  if (aSym !== bSym) return aSym < bSym ? -1 : 1;
  return edgeId(a.edge).localeCompare(edgeId(b.edge));
}

function edgeLineOf(node: GraphNode, kind: EdgeLineKind): EdgeLine {
  return {
    path: node.path,
    ...(node.line !== undefined ? { range: `${node.line}-${node.line}` } : {}),
    symbol: node.symbol ?? node.section ?? node.path,
    kind,
  };
}

function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// ---------------------------------------------------------------------------
// Classifying edges around the resolved anchor
// ---------------------------------------------------------------------------

interface Buckets {
  readonly callers: RawRelation[];
  readonly callees: RawRelation[];
  readonly implementations: RawRelation[];
}

/**
 * Classify by nodeId equality, not by assuming a fixed from/to convention:
 * a real `EdgeDeriver`-backed port always emits `CALLED_BY`/`CALLS` with the
 * anchor on `from`, but a test fixture may hand back the symmetric edge from
 * the OTHER endpoint's perspective. Reading both sides keeps the compiler
 * correct against either convention without special-casing the production
 * adapter.
 */
function classify(anchorId: string, edges: readonly GraphEdge[]): Buckets {
  const callers: RawRelation[] = [];
  const callees: RawRelation[] = [];
  const implementations: RawRelation[] = [];
  for (const edge of edges) {
    const fromIsAnchor = nodeId(edge.from) === anchorId;
    const toIsAnchor = nodeId(edge.to) === anchorId;
    if (!fromIsAnchor && !toIsAnchor) continue;
    if (edge.type === "CALLS") {
      if (fromIsAnchor) callees.push({ other: edge.to, edge });
      else callers.push({ other: edge.from, edge });
    } else if (edge.type === "CALLED_BY") {
      if (fromIsAnchor) callers.push({ other: edge.to, edge });
      else callees.push({ other: edge.from, edge });
    } else if (edge.type === "IMPLEMENTS" || edge.type === "EXTENDS") {
      // Only "who implements/extends the anchor" counts — the anchor being
      // the implementer of something ELSE is a different relation, out of
      // this packet's declared scope (definition/declaration/direct
      // callers/callees + implementations OF the anchor).
      if (toIsAnchor) implementations.push({ other: edge.from, edge });
    }
  }
  return { callers, callees, implementations };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export interface CompileRelationPacketOptions {
  readonly anchor: RelationAnchor;
  readonly graph: RelationGraphPort;
  readonly budget?: Partial<RelationPacketBudget>;
  readonly includeTests?: boolean;
}

type Category = "callers" | "callees" | "implementations" | "referencedBy";

interface QueuedEdge {
  readonly category: Category;
  readonly line: EdgeLine;
}

function zeroTruncation(): {
  definition: number;
  declaration: number;
  callers: number;
  callees: number;
  implementations: number;
  referencedBy: number;
} {
  return { definition: 0, declaration: 0, callers: 0, callees: 0, implementations: 0, referencedBy: 0 };
}

/**
 * Strips `callers`/`callees` from a fully-populated internal truncation
 * tally when the port lists either in `unavailableRelations` — the internal
 * tally always keeps numeric `callers`/`callees` (they simply never
 * increment, since no item of an unavailable class is ever queued for
 * admission) so every OTHER counter's bookkeeping is untouched; only the
 * OUTPUT packet omits the key(s). Key order is preserved
 * (definition, declaration, callers?, callees?, implementations,
 * referencedBy) so a packet that never disables anything keeps the exact
 * pre-FX-R2/FX-G-B shape. `referencedBy` (FX-W1) is never masked this way —
 * like `implementations`, it always reports its count (see
 * `RelationPacketTruncation.referencedBy`'s doc for why this class has no
 * `unavailable`-style masking).
 */
function truncationForOutput(
  tally: {
    definition: number;
    declaration: number;
    callers: number;
    callees: number;
    implementations: number;
    referencedBy: number;
  },
  calleesUnavailable: boolean,
  callersUnavailable: boolean,
): RelationPacketTruncation {
  const { definition, declaration, callers, callees, implementations, referencedBy } = tally;
  return {
    definition,
    declaration,
    ...(callersUnavailable ? {} : { callers }),
    ...(calleesUnavailable ? {} : { callees }),
    implementations,
    referencedBy,
  };
}

/** Dedupes by exact (path, line) pair and sorts path-then-line, mirroring `compareRaw`'s determinism for the non-`GraphEdge`-backed `referencedBy` class (FX-W1). */
function dedupeAndSortReferenceLocations(
  raw: readonly RelationReferenceLocation[],
): RelationReferenceLocation[] {
  const seen = new Set<string>();
  const out: RelationReferenceLocation[] = [];
  for (const loc of raw) {
    const key = `${loc.path}\u0000${loc.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const aLine = a.line ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.line ?? Number.MAX_SAFE_INTEGER;
    return aLine - bLine;
  });
}

/** `EdgeLine.symbol` has no source here (no `GraphNode` — see `RelationReferenceLocation`'s doc) — falls back to `path`, the SAME convention `edgeLineOf` above uses when a node carries no symbol/section of its own. */
function referencedByEdgeLineOf(loc: RelationReferenceLocation): EdgeLine {
  return {
    path: loc.path,
    ...(loc.line !== undefined ? { range: `${loc.line}-${loc.line}` } : {}),
    symbol: loc.path,
    kind: "referenced-by",
  };
}

export function compileRelationPacket(options: CompileRelationPacketOptions): RelationPacket {
  const { anchor, graph, includeTests = false } = options;
  validateAnchor(anchor);
  const budget = normalizeBudget(options.budget);
  const truncated = zeroTruncation();
  const boundedAnchor = boundAnchorForPacket(anchor);
  // FX-U2: the anchor-specific refinement is UNIONED with the port-wide
  // list, never substituted for it — see `RelationGraphPort
  // .unavailableRelationsForAnchor`'s doc.
  const anchorUnavailable = graph.unavailableRelationsForAnchor?.(anchor) ?? [];
  const calleesUnavailable =
    (graph.unavailableRelations?.includes("callees") ?? false) || anchorUnavailable.includes("callees");
  const callersUnavailable =
    (graph.unavailableRelations?.includes("callers") ?? false) || anchorUnavailable.includes("callers");
  const unavailableList: RelationUnavailableKind[] = [];
  if (calleesUnavailable) unavailableList.push("callees");
  if (callersUnavailable) unavailableList.push("callers");
  const unavailable: readonly RelationUnavailableKind[] | undefined =
    unavailableList.length > 0 ? unavailableList : undefined;

  const resolvedDefinition = graph.resolveDefinition(anchor);
  const resolved = resolvedDefinition !== undefined;

  if (resolvedDefinition === undefined) {
    const empty: RelationPacket = {
      anchor: boundedAnchor,
      ...(callersUnavailable ? {} : { callers: [] }),
      ...(calleesUnavailable ? {} : { callees: [] }),
      ...(unavailable !== undefined ? { unavailable } : {}),
      truncated: truncationForOutput(truncated, calleesUnavailable, callersUnavailable),
      bytes: 0,
      resolved: false,
    };
    return { ...empty, bytes: byteLen({ ...empty }) };
  }

  const anchorId = nodeId(resolvedDefinition.node);
  const resolvedDeclaration = graph.resolveDeclaration?.(anchor, resolvedDefinition);
  const declarationDistinct =
    resolvedDeclaration !== undefined && nodeId(resolvedDeclaration.node) !== anchorId;

  const isTestPath = graph.isTestPath ?? defaultIsTestPath;
  const rawEdges = graph.edgesFor(resolvedDefinition.node);
  const buckets = classify(anchorId, rawEdges);

  // Never attempted when the port disclosed no caller/callee source —
  // regardless of what `edgesFor` happened to return, an unavailable class
  // is never admitted (see `RelationGraphPort.unavailableRelations`'s doc).
  const sortedCallers = callersUnavailable ? [] : dedupeByEdgeId(buckets.callers).sort(compareRaw);
  const sortedCallees = calleesUnavailable ? [] : dedupeByEdgeId(buckets.callees).sort(compareRaw);
  const sortedImplementations = dedupeByEdgeId(buckets.implementations).sort(compareRaw);
  const hasImplementations = sortedImplementations.length > 0;

  // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): a SEPARATE
  // capability from `edgesFor`/`classify` above — `referencedBy` bypasses
  // `GraphEdge`/`EdgeDeriver` entirely (see `RelationGraphPort.referencedBy`'s
  // doc). Omitted (never `[]`) when the port does not implement it at all —
  // `dedupeAndSortReferenceLocations([])` and "the method is absent" both
  // yield an empty array here, which is fine: neither case ever sets
  // `hasReferencedBy` below, so the packet OMITS the field either way,
  // matching `implementations`'s own presence rule.
  const sortedReferencedBy = dedupeAndSortReferenceLocations(graph.referencedBy?.(anchor) ?? []);
  // Round-22B finding 3: fold the port's own pre-admission fan-out cut (raw
  // candidates this admission loop below never even sees) into the tally
  // BEFORE any byte/edge-count shedding runs, so `truncated.referencedBy`
  // counts the FULL gap between what the port found and what the wire
  // admits — never just the smaller byte/edge-count-shed portion of it.
  truncated.referencedBy += graph.referencedByOverflowCount?.(anchor) ?? 0;

  function toQueue(category: Category, kind: EdgeLineKind, items: readonly RawRelation[]): QueuedEdge[] {
    return items.map((item) => ({ category, line: edgeLineOf(item.other, kind) }));
  }

  // Tests are deprioritized GLOBALLY (never simply reshuffled within their own
  // category): every non-test edge, across every category, outranks every
  // test edge, unless the caller explicitly asked for tests.
  function partition(queue: readonly QueuedEdge[]): { primary: QueuedEdge[]; deprioritized: QueuedEdge[] } {
    if (includeTests) return { primary: [...queue], deprioritized: [] };
    const primary: QueuedEdge[] = [];
    const deprioritized: QueuedEdge[] = [];
    for (const item of queue) (isTestPath(item.line.path) ? deprioritized : primary).push(item);
    return { primary, deprioritized };
  }

  const callerQueue = partition(toQueue("callers", "called-by", sortedCallers));
  const calleeQueue = partition(toQueue("callees", "calls", sortedCallees));
  const implQueue = partition(toQueue("implementations", "implements", sortedImplementations));
  // FX-W1: queued and partitioned identically to the other classes, but kept
  // as its OWN category (never merged into `callers`) and admitted LAST —
  // a mere mention is the least authoritative signal this packet carries,
  // so it is the first thing shed under an over-budget packet (see the
  // `admittedFlat` priority-stack comment below: definition/declaration are
  // pushed first and shed last; whatever is pushed last here is shed first).
  const referencedByQueue = partition(
    sortedReferencedBy.map((loc): QueuedEdge => ({ category: "referencedBy", line: referencedByEdgeLineOf(loc) })),
  );

  const edgeAdmissionOrder: QueuedEdge[] = [
    ...callerQueue.primary,
    ...calleeQueue.primary,
    ...implQueue.primary,
    ...callerQueue.deprioritized,
    ...calleeQueue.deprioritized,
    ...implQueue.deprioritized,
    ...referencedByQueue.primary,
    ...referencedByQueue.deprioritized,
  ];

  const bounds: ExpansionBounds = {
    maxNodes: budget.maxNodes,
    maxDepth: 1,
    maxFanout: budget.maxEdges,
    maxBytes: budget.maxBytes,
    maxDurationMs: 60_000,
  };
  const tracker = new BoundTracker({ bounds });

  let definitionSite: RelationSite | undefined;
  let declarationSite: RelationSite | undefined;
  // FX-R2: `callers` is queued into this array only when `!callersUnavailable`
  // (`sortedCallers` above is `[]` in the unavailable case, and the admission
  // queue below is built from it), so this array is simply never populated
  // when the class is unavailable — `serialize()` omits the key entirely
  // rather than emit a fabricated present-but-empty `callers`.
  const callers: EdgeLine[] = [];
  const callees: EdgeLine[] = [];
  const implementations: EdgeLine[] = [];
  // FX-W1: populated only from `referencedByQueue` above (never `callers`) —
  // `serialize()` omits the key entirely when it stays empty, matching
  // `implementations`'s own "present iff non-empty" rule.
  const referencedBy: EdgeLine[] = [];

  // Priority-ordered undo stack: popping the tail sheds the LOWEST-priority
  // admitted item first (definition/declaration are pushed before any edge,
  // so they are always the last thing this stack can shed).
  const admittedFlat: Array<() => void> = [];

  const rawDefinitionSite: RelationSite = {
    path: resolvedDefinition.node.path,
    ...(resolvedDefinition.range !== undefined ? { range: resolvedDefinition.range } : {}),
    ...(resolvedDefinition.handle !== undefined ? { handle: resolvedDefinition.handle } : {}),
  };
  if (tracker.admitNode(byteLen(rawDefinitionSite), "definition")) {
    definitionSite = rawDefinitionSite;
    admittedFlat.push(() => {
      definitionSite = undefined;
      truncated.definition += 1;
    });
  } else {
    truncated.definition += 1;
  }

  if (declarationDistinct && resolvedDeclaration !== undefined) {
    const rawDeclarationSite: RelationSite = {
      path: resolvedDeclaration.node.path,
      ...(resolvedDeclaration.range !== undefined ? { range: resolvedDeclaration.range } : {}),
      ...(resolvedDeclaration.handle !== undefined ? { handle: resolvedDeclaration.handle } : {}),
    };
    if (tracker.admitNode(byteLen(rawDeclarationSite), "declaration")) {
      declarationSite = rawDeclarationSite;
      admittedFlat.push(() => {
        declarationSite = undefined;
        truncated.declaration += 1;
      });
    } else {
      truncated.declaration += 1;
    }
  }

  let edgesAdmitted = 0;
  for (const item of edgeAdmissionOrder) {
    if (edgesAdmitted >= budget.maxEdges) {
      truncated[item.category] += 1;
      continue;
    }
    if (!tracker.admitNode(byteLen(item.line), item.category)) {
      truncated[item.category] += 1;
      continue;
    }
    edgesAdmitted += 1;
    const target =
      item.category === "callers"
        ? callers
        : item.category === "callees"
          ? callees
          : item.category === "implementations"
            ? implementations
            : referencedBy;
    target.push(item.line);
    admittedFlat.push(() => {
      const index = target.indexOf(item.line);
      if (index >= 0) target.splice(index, 1);
      truncated[item.category] += 1;
    });
  }

  function serialize(): { core: Omit<RelationPacket, "bytes">; bytes: number } {
    const core: Omit<RelationPacket, "bytes"> = {
      anchor: boundedAnchor,
      ...(definitionSite !== undefined ? { definition: definitionSite } : {}),
      ...(declarationSite !== undefined ? { declaration: declarationSite } : {}),
      ...(callersUnavailable ? {} : { callers }),
      ...(calleesUnavailable ? {} : { callees }),
      ...(hasImplementations ? { implementations } : {}),
      // FX-W1: same "present iff non-empty" rule as `implementations` —
      // never masked by `unavailable` (this class has no
      // `RelationUnavailableKind` entry; see `RelationGraphPort
      // .referencedBy`'s doc).
      ...(referencedBy.length > 0 ? { referencedBy } : {}),
      ...(unavailable !== undefined ? { unavailable } : {}),
      truncated: truncationForOutput(truncated, calleesUnavailable, callersUnavailable),
      resolved,
    };
    return { core, bytes: byteLen(core) };
  }

  let { core, bytes } = serialize();
  // Final honest measurement: incremental per-item cost estimates ignore
  // JSON structural overhead (commas, brackets, the wrapping object's other
  // keys). Shed from the tail of admission order — lowest priority first —
  // until the ACTUAL serialized size fits, or nothing sheddable remains.
  while (bytes > budget.maxBytes && admittedFlat.length > 0) {
    const undo = admittedFlat.pop();
    undo?.();
    ({ core, bytes } = serialize());
  }

  if (bytes > budget.maxBytes) {
    // Irreducible (F1, round 11): everything shedable — declaration, callers,
    // callees, implementations, then the definition itself — is already
    // gone, and even the BOUNDED anchor by itself still does not fit
    // `maxBytes`. This is the documented escape hatch from
    // `bytes <= budget.maxBytes`: never silently exceed the cap, say so
    // instead. `bytes` still reports the actual measured size, honestly.
    const overBudget: Omit<RelationPacket, "bytes"> = { ...core, resolved: false, over_budget: true };
    return { ...overBudget, bytes: byteLen(overBudget) };
  }

  return { ...core, bytes };
}

// ---------------------------------------------------------------------------
// Projection to the EXISTING `plan.wiring.evidence_graph` wire shape
// (`TaskEvidenceGraph` in `@tokenlighten/types`, `packages/types/src/mcp/
// task-pack.ts`). D2/§4.2: no new wire field. This module defines its own
// structurally-identical mirror types below so the pure engine stays free of
// any import outside this directory — `relationPacket.spec.ts` asserts the
// mirror is exactly the real type, both structurally (a `satisfies`-style
// assignment) and by literal key-set, so drift in either type fails loudly.
// ---------------------------------------------------------------------------

export type RelationEvidenceNodeKind = "file" | "symbol";
/**
 * Mirrors `TaskEvidenceRelationKind` — a CLOSED 5-value wire union (FX-W1,
 * round 21B finding 1, HIGH, 2026-09-04, ruling (z): `"referenced_by"` added
 * additively — a file+line MENTION, never a proven call; see
 * `RelationGraphPort.referencedBy`'s doc). No sixth value may be added here
 * without a matching, equally additive `@tokenlighten/types` change.
 */
export type RelationEvidenceRelationKind = "defines" | "references" | "imports" | "direct_calls" | "referenced_by";
/** Mirrors `TaskEvidenceRole` — a CLOSED 6-value wire union. */
export type RelationEvidenceRole = "producer" | "consumer" | "adapter" | "insertion" | "host" | "carrier";

export interface RelationEvidenceNode {
  readonly id: string;
  readonly kind: RelationEvidenceNodeKind;
  readonly path: string;
  readonly symbol?: string;
  readonly handle: string;
  readonly range: string;
  readonly roles: RelationEvidenceRole[];
}

export interface RelationEvidenceRelation {
  readonly id: string;
  readonly kind: RelationEvidenceRelationKind;
  readonly from: string;
  readonly to: string;
  readonly provenance: "lexical" | "index";
  readonly confidence: number;
}

export interface RelationEvidenceGraph {
  readonly version: 1;
  readonly nodes: RelationEvidenceNode[];
  readonly relations: RelationEvidenceRelation[];
  /** Forwarded verbatim from `RelationPacket.unavailable` — relation classes no source packet contributing to this graph could compute at all. Absent (never `[]`) when every class every contributing packet emits was at least attempted. Mirrors `TaskEvidenceGraph.unavailable` (`@tokenlighten/types`) — mutable array, matching `nodes`/`relations` above, so the structural-parity assignment (`relationPacket.spec.ts`) type-checks. */
  unavailable?: RelationUnavailableKind[];
  /**
   * FX-R2 (round 18B finding 4, 2026-09-03): forwarded from
   * `RelationPacket.over_budget` — `true` when the compiling packet could not
   * fit `budget.maxBytes` even with everything shedable removed, so this
   * graph (which may otherwise look identical to "resolved nothing") is
   * actually "too large to serve, re-ask narrower", not "nothing found".
   * Absent (never `false`) when no contributing packet was over budget.
   * Mirrors `TaskEvidenceGraph.over_budget` (`@tokenlighten/types`).
   */
  over_budget?: true;
}

function shaHex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function evidenceNodeId(kind: RelationEvidenceNodeKind, path: string, symbol: string): string {
  return `${kind}:${shaHex(`${path}\u0000${symbol}`).slice(0, 12)}`;
}

function evidenceRelationId(kind: RelationEvidenceRelationKind, from: string, to: string): string {
  return `relation:${kind}:${shaHex(`${from}\u0000${to}`).slice(0, 12)}`;
}

/**
 * `TaskEvidenceRelationKind` has exactly five values (FX-W1 added
 * `"referenced_by"` additively) and none of them is "implements"/"declares"
 * — the closed wire union predates this packet shape. `implements` collapses
 * onto the nearest existing bucket (`references`); `declares` collapses onto
 * `defines`. This is a documented, deliberate lossy mapping, not an
 * oversight — see the module doc above. `"referenced-by"` (FX-W1) is NOT a
 * lossy mapping — it maps 1:1 onto the new `"referenced_by"` wire kind,
 * precisely because collapsing it onto `"direct_calls"` (the historical
 * shortcut this fix removes) or `"references"` (already used for the
 * `implements` collapse above, which would conflate two unrelated
 * relations) would misrepresent it either way.
 */
function toRelationKind(kind: EdgeLineKind): RelationEvidenceRelationKind {
  switch (kind) {
    case "calls":
    case "called-by":
      return "direct_calls";
    case "imports":
      return "imports";
    case "defines":
    case "declares":
      return "defines";
    case "implements":
      return "references";
    case "referenced-by":
      return "referenced_by";
  }
}

/** `TaskEvidenceNode.handle`/`.range` are REQUIRED strings on the wire; a packet's edge lines may lack either (no real handle/range was ever cast for it). This is honest-but-unwired: a future W-SATISFACTION consumer must replace `unresolved:*` handles with a real cast handle before this ever reaches a response. */
function placeholderHandle(nodeIdValue: string): string {
  return `unresolved:${nodeIdValue}`;
}

export function projectRelationPacketToEvidenceGraph(packet: RelationPacket): RelationEvidenceGraph {
  const nodes: RelationEvidenceNode[] = [];
  const relations: RelationEvidenceRelation[] = [];
  const seen = new Set<string>();
  const anchorSymbol = anchorSymbolName(packet.anchor);

  function addNode(
    path: string,
    symbol: string | undefined,
    handle: string | undefined,
    range: string | undefined,
    roles: readonly RelationEvidenceRole[],
  ): string {
    const kind: RelationEvidenceNodeKind = symbol !== undefined ? "symbol" : "file";
    const id = evidenceNodeId(kind, path, symbol ?? "");
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        kind,
        path,
        ...(symbol !== undefined ? { symbol } : {}),
        handle: handle ?? placeholderHandle(id),
        range: range ?? "",
        roles: [...roles],
      });
    }
    return id;
  }

  function addRelation(kind: RelationEvidenceRelationKind, from: string, to: string, confidence: number): void {
    const id = evidenceRelationId(kind, from, to);
    if (relations.some((relation) => relation.id === id)) return;
    relations.push({ id, kind, from, to, provenance: "index", confidence });
  }

  let definitionId: string | undefined;
  if (packet.definition !== undefined) {
    definitionId = addNode(
      packet.definition.path,
      anchorSymbol,
      packet.definition.handle,
      packet.definition.range,
      ["host"],
    );
  }
  let declarationId: string | undefined;
  if (packet.declaration !== undefined) {
    declarationId = addNode(
      packet.declaration.path,
      anchorSymbol,
      packet.declaration.handle,
      packet.declaration.range,
      ["host"],
    );
    if (definitionId !== undefined) addRelation("defines", declarationId, definitionId, 0.95);
  }
  const anchorId = definitionId ?? declarationId;

  for (const line of packet.callers ?? []) {
    const otherId = addNode(line.path, line.symbol, line.handle, line.range, ["consumer"]);
    if (anchorId !== undefined) addRelation(toRelationKind(line.kind), otherId, anchorId, 0.9);
  }
  for (const line of packet.callees ?? []) {
    const otherId = addNode(line.path, line.symbol, line.handle, line.range, ["producer"]);
    if (anchorId !== undefined) addRelation(toRelationKind(line.kind), anchorId, otherId, 0.9);
  }
  for (const line of packet.implementations ?? []) {
    const otherId = addNode(line.path, line.symbol, line.handle, line.range, ["adapter"]);
    if (anchorId !== undefined) addRelation(toRelationKind(line.kind), otherId, anchorId, 0.8);
  }
  // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): confidence
  // 0.5 — deliberately lower than every other relation this projection
  // emits (0.95 defines, 0.9 direct_calls, 0.8 references/implements) and
  // NEVER 0.9. A `"referenced-by"` line is a proven OCCURRENCE (SCIP
  // attributed this exact file+line to the symbol) but never a proven
  // CALL — the two must never read as equally trustworthy on the wire.
  for (const line of packet.referencedBy ?? []) {
    const otherId = addNode(line.path, line.symbol, line.handle, line.range, ["consumer"]);
    if (anchorId !== undefined) addRelation(toRelationKind(line.kind), otherId, anchorId, 0.5);
  }

  return {
    version: 1,
    nodes,
    relations,
    ...(packet.unavailable !== undefined ? { unavailable: [...packet.unavailable] } : {}),
    ...(packet.over_budget === true ? { over_budget: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// `relation_packet_one_shot` metric primitive (§7.1). Aggregation across many
// packets (the ratio the gate actually reads) is offline bench work
// (`bench/workflows/lib/tokenlighten_bench/`, §7.2) — this is the per-packet
// predicate that aggregator calls once per fixture case.
// ---------------------------------------------------------------------------

export interface RelationPacketOneShotResult {
  /** False when anything was truncated — §7.1 scopes the gate to "fan-out <= 24" cases only. */
  readonly applicable: boolean;
  readonly oneShot: boolean;
  readonly missingPaths: readonly string[];
  readonly coveredPaths: readonly string[];
}

export function relationPacketOneShot(
  packet: RelationPacket,
  expectedPaths: readonly string[],
): RelationPacketOneShotResult {
  const totalTruncated = Object.values(packet.truncated).reduce((sum: number, n) => sum + (n ?? 0), 0);
  const covered = new Set<string>();
  if (packet.definition !== undefined) covered.add(packet.definition.path);
  if (packet.declaration !== undefined) covered.add(packet.declaration.path);
  for (const line of packet.callers ?? []) covered.add(line.path);
  for (const line of packet.callees ?? []) covered.add(line.path);
  for (const line of packet.implementations ?? []) covered.add(line.path);
  for (const line of packet.referencedBy ?? []) covered.add(line.path);
  const missing = expectedPaths.filter((path) => !covered.has(path));
  return {
    applicable: totalTruncated === 0,
    oneShot: packet.resolved && missing.length === 0,
    missingPaths: missing,
    coveredPaths: [...covered].sort(),
  };
}
