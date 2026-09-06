// ---------------------------------------------------------------------------
// sfSatisfaction.ts — the Semantic Frontier (v0.15) SATISFACTION UPDATER.
//
// DESIGN-v0.15-semantic-frontier-plan.md §3.3 (the kind -> concern table),
// §3.4 (what a closed set means for the decision), §6.1 U-4 (the test table),
// §9 row W4, §11 Wave 3 row W-SATISFACTION.
//
// THE ONE QUESTION THIS MODULE ANSWERS: given the concerns a task opened and
// ONE response that is about to go on the wire, WHICH concerns did that
// response actually discharge? Nothing else. It does not open concerns
// (`sfConcerns.ts`), it does not write state (`task-state/sfState.ts`), it
// does not rank, demote, or arbitrate `next` (W-DEMOTE / W-NEXT-ARBITER), and
// it never touches a response.
//
// PURITY. `applyResponseToConcerns` is total and deterministic over its
// arguments: no filesystem, no clock, no module state, no I/O, no throw on any
// input shape. That is what lets the whole §3.3 table be one test row per rule
// with no workspace at all, and it is why the fail-open guarantee at the wiring
// seam (`readCodeTaskPack.ts`) only has to wrap state access, never this.
//
// THE RULE THAT MAKES THE TABLE HONEST: a concern closes only against evidence
// that was ACTUALLY SERVED. Three consequences the plan calls out by name:
//
//   * `read.receipt` closes NOTHING. A receipt says "you already hold this";
//     counting it as satisfaction would claim a delivery that did not happen
//     on this turn. Its `decision-unchanged` tag restates a certificate — the
//     certificate is the DECISION's, not this updater's.
//   * `edit.rolled_back` and `edit.state_unknown` close NOTHING. One says
//     nothing landed; the other says the disk is unproven. Neither is a
//     discharge, and `edit.state_unknown` in particular must never look like
//     progress, because its recovery step is the caller's next obligation.
//   * `read.map` / `search.matches` / `search.tree` close nothing in the
//     current concern vocabulary: a skeleton, a match line, and a tree are
//     STRUCTURAL evidence, and every concern kind `sfConcerns.ts` mints today
//     is a BODY or a RELATION claim. §3.3 reserves a `definition-location`
//     concern for skeletons; the moment W-CONCERNS mints one, `structuralRule`
//     below is the single place that changes.
//
// I-3 IS INHERITED, NOT RE-IMPLEMENTED. An advisory (heuristic-origin) concern
// is never reported satisfied here, matching `obligationDag.canClose`. This
// module never *forces* a closure either: it NOMINATES concern ids, and the
// caller hands each one to `markConcernSatisfied`, which routes through that
// same single gate. A nomination this module gets wrong is refused there, not
// silently applied — the gate stays the one authority (§3.4 I-4).
//
// MONOTONICITY (§6.1 P-1) IS STRUCTURAL. A concern already `satisfied` in the
// snapshot is reported in `alreadySatisfied` and never re-nominated, and no
// code path here ever moves a concern back to open. Only `edit.applied`'s
// evidence invalidation can re-open one, and that is the state adapter's job
// (`deriveEditClosureOps`), not this module's.
//
// NO RELATION-PACKET IMPORT, ON PURPOSE. W-RELATION-PACKET fences
// `features/graph-evidence/relationPacket.ts` to tests this wave. This module
// therefore declares the STRUCTURAL VIEW it needs (`SfRelationPacketView`),
// which the real `RelationPacket` satisfies without either file knowing about
// the other. What this wave decides is only WHEN a packet counts as a relation
// concern's proof; wiring a packet into a response is W-DEMOTE/W-RELATION.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import type { SfSatisfactionProof, SfServedEvidence, SfSnapshot } from "../../task-state/sfState.js";
import type { SfConcernKind, SfStructuralConcern } from "./sfConcerns.js";

// ---------------------------------------------------------------------------
// Response description
// ---------------------------------------------------------------------------

/**
 * The 15 protocol reply kinds, spelled exactly as `kind` carries them. The
 * three edit kinds that are not `edit.applied`, plus `read.receipt` and
 * `refusal`, are the no-op rows of §3.3.
 */
export type SfResponseKind =
  | "read.task_pack"
  | "read.text"
  | "read.map"
  | "read.batch"
  | "read.artifact"
  | "read.receipt"
  | "read.closure"
  | "search.matches"
  | "search.references"
  | "search.tree"
  | "edit.applied"
  | "edit.reclassified"
  | "edit.rolled_back"
  | "edit.state_unknown"
  | "refusal";

/**
 * One surface this response carries, in the same shape the state adapter
 * catalogs (`SfServedEvidence`) plus the two facts satisfaction needs and
 * cataloging does not.
 */
export interface SfResponseEvidence extends SfServedEvidence {
  /**
   * True iff BYTES went on the wire for this surface. A bodyless supporting
   * line — an address the caller could fetch — is reachability, not delivery,
   * and §3.3 forbids it from adding evidence at all.
   *
   * Omitted means "infer from the catalog class": `direct` (or a `sha` with no
   * explicit class) is a body, `structural` is not.
   */
  readonly body?: boolean;
  /**
   * The surface was capped mid-serve. A truncated entry cannot satisfy
   * `min-grounded-evidence` (§3.3, `read.batch` row), so it closes nothing —
   * the caller holds a prefix, not the claim.
   */
  readonly truncated?: boolean;
}

/** One `read.batch` entry. Entries are evaluated INDEPENDENTLY (§3.3). */
export interface SfResponseEntry {
  readonly evidence?: readonly SfResponseEvidence[];
  /** Entry-level truncation, as `read.batch` reports it per entry. */
  readonly truncated?: boolean;
}

/** The anchor a `search.references` page was taken around. */
export interface SfResponseAnchor {
  readonly symbol?: string;
  readonly path?: string;
}

/**
 * The structural view of a relation packet this module needs. The real
 * `RelationPacket` (`features/graph-evidence/relationPacket.ts`) satisfies it
 * structurally; see the header for why it is not imported.
 */
export interface SfRelationPacketView {
  // F10 (round 11), additive only: without `qualified`, a D5 qualified-anchor
  // relation concern (`{kind:"qualified", qualifier, member}`) could never be
  // matched by `packetCovers` below — a qualified `RelationPacket.anchor`
  // carries `.qualified`, never `.symbol`, so the pre-existing symbol-only
  // comparison silently missed it. Coordinated with FX-B (sfSatisfaction.ts's
  // owner): purely additive, nothing existing removed or renamed.
  readonly anchor: {
    readonly symbol?: string;
    readonly path?: string;
    readonly qualified?: { readonly class: string; readonly member: string };
  };
  readonly definition?: { readonly path: string };
  /**
   * Optional (FX-R2, 2026-09-03, mirrors the `callees` note below): the real
   * `RelationPacket.callers` is absent — never an empty array — when its
   * port cannot compute callers at all (no real `GraphIndex` on disk; see
   * `relationGraphPort.ts`'s `callersOf` gating / `relationPacket.ts`'s
   * `unavailableRelations`). `relationPacketSatisfies` below already treated
   * this defensively (`Array.isArray(packet.callers) ? ... : 0`) before this
   * field was ever optional, so no logic here changes — only the type now
   * says what was already true.
   */
  readonly callers?: readonly unknown[];
  /**
   * Optional (FX-G-B, 2026-09-03): the real `RelationPacket.callees` is
   * absent — never an empty array — when its port cannot compute callees at
   * all (see `relationGraphPort.ts`'s `calleesOf` removal / `relationPacket.
   * ts`'s `unavailableRelations`). `relationPacketSatisfies` below already
   * treated this defensively (`Array.isArray(packet.callees) ? ... : 0`)
   * before this field was ever optional, so no logic here changes — only
   * the type now says what was already true.
   */
  readonly callees?: readonly unknown[];
  /**
   * FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z), additive): a
   * file+line MENTION of the anchor, never a proven call — a real
   * `RelationPacket.referencedBy` is present iff its port implemented
   * `referencedBy` and reported at least one (see `relationGraphPort.ts`'s
   * `referencedBy`/`graph/index.ts`'s `GraphIndex.hasReferenceOccurrences`
   * doc). DELIBERATELY NOT consulted by `relationPacketSatisfies` below —
   * only `callers`/`callees` (proven call edges) count toward satisfying a
   * relation concern; `referenced_by` is grounded evidence for the wire
   * (`plan.wiring.evidence_graph`) but never closes the concern on its own.
   * A concern anchored on nothing BUT a non-empty `referencedBy` (no
   * `callers`/`callees`) therefore stays open under `relationPacketSatisfies`
   * — DESIGN-v0.15 §3.7/(z) treats a mention as weaker proof than a call, and
   * this module's job is satisfaction, not evidence disclosure (that is
   * `sfRelationSeam.ts`'s). UPDATE (ruling (cc), FX-Y1, round-23B finding 1,
   * 2026-09-04): that concern is NOT therefore stuck open forever — see
   * `relationDisclosureSatisfies` below, a SEPARATE rule that closes it via
   * the `unavailable` disclosure once the anchor's own definition/declaration
   * has been served. `referencedBy` still never counts toward that rule
   * either (it is not required, and its presence never substitutes for the
   * `unavailable` disclosure) — when a reference source exists, its evidence
   * rides the wire via `plan.wiring.evidence_graph` regardless of which rule
   * (if either) closed the concern, so the caller gets it either way.
   */
  readonly referencedBy?: readonly unknown[];
  /**
   * FX-Y1 (round-23B finding 1, HIGH, ruling (cc), 2026-09-04): the relation
   * classes a REAL port structurally cannot compute for this workspace at
   * all — mirrors `RelationPacket.unavailable` (`relationPacket.ts`, itself
   * `RelationGraphPort.unavailableRelations`/`unavailableRelationsForAnchor`'s
   * union). Consulted by `relationDisclosureSatisfies` below: a capability
   * the workspace cannot provide is a disclosed GAP, not silence, and ruling
   * (cc) makes disclosure — never fabrication, never a silent close — the
   * discharge path for a concern no provider in this codebase can otherwise
   * ground. Literal-typed rather than `readonly unknown[]` (unlike the
   * sibling fields above) because this one IS branched on here, not merely
   * carried structurally.
   */
  readonly unavailable?: readonly ("callers" | "callees")[];
  readonly truncated?: {
    readonly definition: number;
    readonly declaration: number;
    /** Absent (never `0`) exactly when `callers` above is absent (FX-R2). */
    readonly callers?: number;
    /** Absent (never `0`) exactly when `callees` above is absent. */
    readonly callees?: number;
    readonly implementations: number;
  };
  readonly resolved?: boolean;
}

/** The decision this response carries, when it carries one. */
export interface SfResponseDecision {
  readonly kind?: string;
  readonly state?: string;
}

export interface SfResponse {
  readonly kind: SfResponseKind;
  /** Surfaces served by this response (every read kind, `search.*`, `read.closure`). */
  readonly evidence?: readonly SfResponseEvidence[];
  /** `read.batch` entries; each is applied on its own. */
  readonly entries?: readonly SfResponseEntry[];
  /** `edit.applied`: the paths that actually landed. A PARTIAL set is normal. */
  readonly applied?: readonly string[];
  readonly decision?: SfResponseDecision;
  /**
   * `search.references` / `search.matches` / `search.tree`: whether the sweep is
   * EXHAUSTIVE. A `next` cursor, an incomplete `scope_report`, or a cap means
   * `false`, and an incomplete sweep closes nothing (§3.3).
   */
  readonly complete?: boolean;
  /** `search.references`: what the page was anchored on. */
  readonly anchor?: SfResponseAnchor;
  /**
   * `read.closure`: `"not-applicable"` means NO test or mock references the
   * edit. §3.3 makes that an INVALIDATION of the verify concern, never a
   * satisfaction, so it closes nothing here.
   */
  readonly closureStatus?: "ok" | "not-applicable" | string;
  /** A compiled relation packet riding this response, when one was built. */
  readonly relationPacket?: SfRelationPacketView;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Which §3.3 row discharged a concern. Recorded in the proof, never branched on. */
export type SfSatisfactionRule =
  | "body-covers-binding"
  | "batch-entry-body-covers-binding"
  | "artifact-section-covers-binding"
  | "references-complete-for-anchor"
  | "relation-packet-two-sided"
  | "relation-disclosed-unavailable"
  | "closure-kit-covers-verify"
  | "edit-applied-covers-every-binding";

/**
 * `SfSatisfactionProof` plus the rule that produced it, so it can be handed
 * straight to `markConcernSatisfied` while staying auditable.
 */
export interface SfConcernProof extends SfSatisfactionProof {
  readonly rule: SfSatisfactionRule;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export interface SfSatisfactionResult {
  /**
   * Concerns this response NEWLY discharges, in the order the concerns were
   * extracted. Hand each to `markConcernSatisfied` — the closure gate has the
   * last word.
   */
  readonly satisfied: readonly string[];
  /** `concernId -> proof`, covering exactly the ids in `satisfied`. */
  readonly proofs: Readonly<Record<string, SfConcernProof>>;
  /** Concerns still not discharged after this response (advisory ones included). */
  readonly untouched: readonly string[];
  /** Concerns the snapshot already held satisfied. Never re-nominated (P-1). */
  readonly alreadySatisfied: readonly string[];
  /**
   * Wave-4 hook (§11 W-SATISFACTION: "keep the verify-concern hook point
   * open"). Ids of `verify` concerns this response makes DUE — an
   * `edit.applied` on their bindings. They are NOT satisfied by that edit;
   * they are the work the edit created. W-VERIFY-CLOSURE consumes this.
   */
  readonly openVerify: readonly string[];
}

export interface SfApplyInput {
  readonly snapshot: SfSnapshot;
  readonly concerns: readonly SfStructuralConcern[];
  readonly response: SfResponse;
  /**
   * R27b-FIX (2026-09-05, review R27b F9 finding, HIGH): the F9 direct-read
   * window map for this pack (`SfPackContext.namedFrontierDirectWindows` /
   * `readCodeTaskPack.sfNamedFrontierDirectWindowsFor`), keyed by
   * workspace-relative path. A `"<start>-<end>"` value is the BOUNDED WINDOW
   * F9's own `next` asks the caller to read for that path; `undefined` (key
   * present) means the file is within bound and the whole file is the answer.
   *
   * WHY SATISFACTION NEEDS IT. `bodyCanSatisfy` closes a path-anchored concern
   * on ANY served body of that path, and `evidenceCovers` matches on `path`
   * alone — it never consults `lineRange`. A window that MISSES the answer
   * (F9's token-overlap anchor guessed wrong, or no token matched and it
   * defaulted to line 1) is not `truncated` — the server answered the explicit
   * range in full — so a 150-of-2000-line body closed the whole concern
   * exactly as a whole-file serve would. `bodyRangeCoversConcernWindow` below
   * is the fix: the served body must COVER the concern's own resolved window.
   *
   * Absent (or a path absent from it) leaves the pre-F9 rule untouched, which
   * is what keeps a task with no named-frontier join byte-identical.
   */
  readonly directReadWindows?: ReadonlyMap<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// The kind table
// ---------------------------------------------------------------------------

/**
 * Concern kinds a served BODY can discharge. `usage` and `relation` are absent
 * deliberately: reading a definition proves what a symbol IS, never who calls
 * it, and pretending otherwise is exactly the false-closure the v0.14 paid run
 * charged for. Those two close via `search.references` or a relation packet.
 * `verify` is absent for the same reason: only a closure kit discharges it.
 */
const BODY_SATISFIABLE: ReadonlySet<SfConcernKind> = new Set<SfConcernKind>([
  "definition",
  "declaration",
  "template",
  "generated",
  "answer",
]);

/**
 * F9 (2026-09-04, ruling (b)): a PATH-anchored concern names a FILE, not a
 * symbol — "who calls this symbol" has no meaning for it, so the `usage`/
 * `relation` body exclusion above (which exists specifically to stop a
 * definition read from masquerading as caller-EDGE proof) does not apply.
 * `sfConcerns.ts` rule (4)/(4b) mints exactly this shape — a role-less
 * caller-named path becomes a `relation`-kind, path-anchored concern — and on
 * the sealed SF05 replay that concern had no rule that could ever close it:
 * `BODY_SATISFIABLE` excludes `relation`, and D8's own header comment
 * documents why `search.references` over a path is meaningless too ("asks for
 * call sites of a filename"). Left unclosed, the arbiter re-selects it and
 * re-arms the SAME `next` forever (F9 ruling (c)'s failure mode). A served
 * body of the exact named file IS the proof the caller's own request asked
 * for, whatever kind label the extractor gave the concern.
 */
function bodyCanSatisfy(concern: SfStructuralConcern): boolean {
  if (BODY_SATISFIABLE.has(concern.kind)) return true;
  return concern.anchor.kind === "path";
}

/**
 * R27b-FIX (2026-09-05, review R27b F9 finding, HIGH). Does this served body
 * actually cover the WINDOW the concern is about?
 *
 * F9's own `next` for a path-anchored concern is an EXPLICIT bounded read
 * (`content:"full", range:"<start>-<end>"`), chosen by a token-overlap anchor
 * heuristic. The server answers that range in full, so the body is never
 * `truncated` — and before this rule, a body that served lines 1-150 of a
 * 2000-line file whose answer lives at line 1800 discharged the concern
 * exactly as a whole-file serve would, purely because the PATHS matched.
 *
 * The rule: a path-anchored concern closes on a body only when that body's
 * line range covers the concern's RESOLVED WINDOW — the F9
 * `namedFrontierDirectWindows` range for that path, or the whole file when the
 * map says the file is within bound (key present with `undefined`). A body
 * that misses the window leaves the concern OPEN, and the arbiter's `next`
 * stays the bounded window read.
 *
 * Deliberately narrow in three ways, so nothing outside the finding moves:
 *   * no window map, or the path absent from it => unchanged (pre-F9 shape);
 *   * a non-path anchor => unchanged (the map is path-keyed);
 *   * a body with NO `lineRange` => unchanged. That is an unbounded/whole-file
 *     serve, which covers every window by construction.
 */
function bodyRangeCoversConcernWindow(
  concern: SfStructuralConcern,
  ev: SfResponseEvidence,
  windows: ReadonlyMap<string, string | undefined> | undefined,
): boolean {
  if (windows === undefined || windows.size === 0) return true;
  if (concern.anchor.kind !== "path") return true;
  const window = resolvedConcernWindow(concern, windows);
  if (window === undefined) return true;
  const range = ev.lineRange;
  if (range === undefined) return true;
  const startLine = Number(range.startLine);
  const endLine = Number(range.endLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return true;
  return startLine <= window[0] && endLine >= window[1];
}

/**
 * The bounded window recorded for this concern's own address, or `undefined`
 * when none is (the path is absent from the map, or present with `undefined`,
 * which means "no bound needed — read the whole file").
 */
function resolvedConcernWindow(
  concern: SfStructuralConcern,
  windows: ReadonlyMap<string, string | undefined>,
): [number, number] | undefined {
  const addresses: string[] = [];
  const direct = anchorPath(concern);
  if (direct !== undefined && direct !== "") addresses.push(direct);
  for (const binding of concern.bindings) if (binding !== "") addresses.push(binding);
  if (addresses.length === 0) return undefined;
  for (const [key, value] of windows) {
    if (typeof value !== "string") continue;
    if (!addresses.some((address) => samePath(address, key))) continue;
    const bounds = /^(\d+)-(\d+)$/.exec(value.trim());
    if (bounds === null) continue;
    const start = Number(bounds[1]);
    const end = Number(bounds[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    return [start, end];
  }
  return undefined;
}

/** Concern kinds `search.references` can discharge for its anchor. */
const REFERENCE_SATISFIABLE: ReadonlySet<SfConcernKind> = new Set<SfConcernKind>([
  "usage",
  "relation",
]);

/**
 * Kinds that close nothing, ever. `read.map`, `search.matches` and
 * `search.tree` are here because their evidence is STRUCTURAL and no concern
 * kind exists today that structural evidence discharges (see the header);
 * the rest are the plan's explicit no-op rows.
 */
const NO_OP_KINDS: ReadonlySet<SfResponseKind> = new Set<SfResponseKind>([
  "read.map",
  "read.receipt",
  "search.matches",
  "search.tree",
  "edit.reclassified",
  "edit.rolled_back",
  "edit.state_unknown",
  "refusal",
]);

/**
 * §3.3's `read.map` / `search.matches` / `search.tree` rows, named so the ONE
 * place that changes when a `definition-location` (or `inventory`, or
 * `existence`) concern kind is minted is visible to a reader and to grep.
 */
export function structuralRule(): { closes: readonly SfConcernKind[] } {
  return { closes: [] };
}

// ---------------------------------------------------------------------------
// Path and anchor matching
// ---------------------------------------------------------------------------

function normPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Two spellings of one address. Exact after normalization, or one a path
 * SUFFIX of the other on a segment boundary — a concern bound by the workspace
 * index and a surface emitted by the pack can legitimately differ by a root
 * prefix, and treating those as different addresses would silently refuse
 * every closure.
 */
function samePath(a: string, b: string): boolean {
  const left = normPath(a);
  const right = normPath(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function sameSymbol(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === "" || b === "") return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** The symbol names a concern's anchor answers to. Empty for path/verb anchors. */
function anchorSymbols(concern: SfStructuralConcern): string[] {
  const anchor = concern.anchor;
  if (anchor.kind === "symbol") return [anchor.symbol];
  if (anchor.kind === "qualified") return [anchor.member, anchor.qualified];
  return [];
}

/** The path an anchor names directly, when it names one. */
function anchorPath(concern: SfStructuralConcern): string | undefined {
  return concern.anchor.kind === "path" ? concern.anchor.path : undefined;
}

/**
 * Does this one served surface cover this concern?
 *
 * ANY binding is enough for a READ. A concern bound to several candidate
 * paths asks "where is this defined" — serving the one that holds it answers
 * the whole concern, and demanding all of them would keep a discharged concern
 * open forever. (`edit.applied` takes the opposite, stricter rule; see
 * `editCovers`.)
 */
function evidenceCovers(concern: SfStructuralConcern, ev: SfResponseEvidence): boolean {
  const path = typeof ev.path === "string" ? ev.path : "";
  if (path !== "") {
    for (const binding of concern.bindings) if (samePath(binding, path)) return true;
    const direct = anchorPath(concern);
    if (direct !== undefined && samePath(direct, path)) return true;
  }
  for (const symbol of anchorSymbols(concern)) if (sameSymbol(symbol, ev.symbol)) return true;
  return false;
}

/**
 * The concerns one served surface contributes to, ignoring current state.
 *
 * This is the CATALOG-side view of the same coverage rule `applyResponseToConcerns`
 * closes on, exported so the task_pack seam can fill `SfServedEvidence.concernIds`
 * from one rule instead of a second, drifting one. It answers "which concerns is
 * this address about", not "which concerns does it discharge" — advisory concerns
 * are included here (they legitimately point at evidence; they just never close),
 * and a bodyless surface still contributes a reference.
 */
export function concernsAddressedByEvidence(
  concerns: readonly SfStructuralConcern[],
  ev: SfResponseEvidence,
): string[] {
  const out: string[] = [];
  for (const concern of concerns) {
    if (concern === undefined || concern === null || concern.id === "") continue;
    if (!evidenceCovers(concern, ev)) continue;
    if (!out.includes(concern.id)) out.push(concern.id);
  }
  return out;
}

/**
 * Did the edit discharge this concern? EVERY binding must have been written.
 *
 * The asymmetry with `evidenceCovers` is the point. A template/generated pair,
 * a header/impl pair, a call site and its declaration — an edit that touched
 * one half left the other half's obligation exactly where it was. A partial
 * applied path set therefore satisfies only the concerns entirely inside it.
 */
function editCovers(concern: SfStructuralConcern, appliedPaths: readonly string[]): boolean {
  if (appliedPaths.length === 0) return false;
  const hits = (candidate: string): boolean => appliedPaths.some((p) => samePath(p, candidate));
  if (concern.bindings.length > 0) return concern.bindings.every(hits);
  const direct = anchorPath(concern);
  return direct !== undefined && hits(direct);
}

/**
 * A body is on the wire for this surface. Explicit `body` wins; otherwise the
 * catalog class decides, and a `sha` with no explicit class means direct bytes
 * (that is exactly how `sfState.identityFrom` classifies the same record).
 */
function hasBody(ev: SfResponseEvidence): boolean {
  if (ev.truncated === true) return false;
  if (typeof ev.body === "boolean") return ev.body;
  const cls = ev.evidenceClass ?? (typeof ev.sha === "string" && ev.sha !== "" ? "direct" : "structural");
  return cls === "direct";
}

function evidenceIdOf(ev: SfResponseEvidence, index: number): string {
  if (typeof ev.evidenceId === "string" && ev.evidenceId !== "") return ev.evidenceId;
  const range = ev.lineRange === undefined ? "" : `:${ev.lineRange.startLine}-${ev.lineRange.endLine}`;
  const path = typeof ev.path === "string" ? normPath(ev.path) : `#${index}`;
  return `${path}${range}`;
}

// ---------------------------------------------------------------------------
// The relation-packet rule (§3.7, decided here, wired later)
// ---------------------------------------------------------------------------

/**
 * WHEN a relation packet discharges a relation concern.
 *
 * All three must hold:
 *   1. the anchor RESOLVED and the packet carries a `definition` — without a
 *      definition site the packet describes edges around a symbol nobody has
 *      located, which answers nothing;
 *   2. at least one of `callers` / `callees` is non-empty — a relation concern
 *      is about the OTHER END. A definition with no edge either way is a
 *      definition concern's proof, not a relation concern's;
 *   3. the truncation counts are DISCLOSED. A packet that dropped candidates
 *      without saying how many is an unbounded claim, and an unbounded claim
 *      cannot close a bounded obligation. Disclosure is the bar, not zero
 *      truncation: a packet that says "40 callers did not fit" has told the
 *      caller the truth and may close the concern the caller opened.
 *
 * `implementations` deliberately does NOT count on its own: an implements edge
 * with no call edge leaves the usage question open.
 *
 * `referencedBy` (FX-W1, round 21B finding 1, HIGH, 2026-09-04, ruling (z))
 * deliberately does NOT count either: it is a file+line MENTION of the
 * anchor — a real occurrence-based index's non-definition, non-import
 * occurrence — never a proven call. Rule 2 above stays "`callers`/`callees`
 * non-empty" exactly as written; a packet whose ONLY edge evidence is a
 * non-empty `referencedBy` is grounded-but-not-satisfied BY THIS RULE — real
 * evidence reaches the wire via `sfRelationSeam.ts`'s projection
 * (`plan.wiring.evidence_graph`, `"referenced_by"` relations) either way.
 *
 * THIS IS NOT THE ONLY RULE ANY MORE (ruling (cc), FX-Y1, round-23B finding 1,
 * HIGH, 2026-09-04): a packet that fails this two-sided test may still close
 * the concern via `relationDisclosureSatisfies` below, when the gap is
 * DISCLOSED rather than merely absent. The two rules are deliberately
 * distinct functions, never merged into this one's own return value, so a
 * caller who wants to know specifically "did this packet PROVE an edge" (this
 * function) keeps that exact, narrower answer.
 */
export function relationPacketSatisfies(packet: SfRelationPacketView | undefined): boolean {
  if (packet === undefined) return false;
  if (packet.resolved === false) return false;
  if (packet.definition === undefined) return false;
  if (packet.truncated === undefined) return false;
  const callers = Array.isArray(packet.callers) ? packet.callers.length : 0;
  const callees = Array.isArray(packet.callees) ? packet.callees.length : 0;
  return callers > 0 || callees > 0;
}

function packetCovers(concern: SfStructuralConcern, packet: SfRelationPacketView): boolean {
  // F10 (round 11): match the D5 qualified shape FIRST — a qualified packet
  // anchor never sets `.symbol`, so without this branch a qualified relation
  // concern could never be satisfied by its own packet.
  const qualified = packet.anchor?.qualified;
  if (
    qualified !== undefined &&
    concern.anchor.kind === "qualified" &&
    sameSymbol(qualified.class, concern.anchor.qualifier) &&
    sameSymbol(qualified.member, concern.anchor.member)
  ) {
    return true;
  }
  const symbol = packet.anchor?.symbol;
  for (const candidate of anchorSymbols(concern)) if (sameSymbol(candidate, symbol)) return true;
  const path = packet.anchor?.path ?? packet.definition?.path;
  if (typeof path !== "string" || path === "") return false;
  for (const binding of concern.bindings) if (samePath(binding, path)) return true;
  const direct = anchorPath(concern);
  return direct !== undefined && samePath(direct, path);
}

/**
 * RULING (cc), 2026-09-04 — FX-Y1 (round-23B review finding 1, HIGH).
 *
 * The review found that `relationPacketSatisfies` above is a SOUND rule for
 * what it claims (a proven edge closes the concern), but it is the ONLY rule,
 * and no provider in this codebase today ever returns a proven `callers`
 * edge (`relationGraphPort.ts`'s `callersOf` gates on `hasCallEdges()`,
 * which every reader — SCIP, the token graph — hardcodes to `false`;
 * `graph/index.ts`'s own comment: "No provider in this codebase proves a
 * call today"). `callees` has NO real source at all, ever (same file). A
 * relation concern therefore gated, unconditionally, on a capability the
 * workspace can never supply — not a rare edge case, but every ordinary
 * "fix/explain/why is X called" query, in every workspace, forever.
 *
 * The ruling: a concern whose satisfaction requires a capability the
 * workspace cannot provide is satisfied by DISCLOSURE, not left blocking and
 * not silently dropped. This function is the "workspace cannot provide it"
 * half of that test: the packet's anchor resolved to a real `definition`
 * (same floor as the two-sided rule — an unresolved anchor proves nothing
 * either way) AND `unavailable` actually NAMES the gap. A packet that simply
 * found zero callers/callees on a REAL call-edge source (no `unavailable`
 * entry at all) is the opposite case — "computed, found none" — and this
 * function correctly returns `false` for it: only a DISCLOSED absence
 * discharges by disclosure; a silent one still blocks, exactly like an
 * undisclosed truncation still blocks the two-sided rule above.
 *
 * `referencedBy` is deliberately NOT a precondition here either way (see the
 * field's own doc comment): a reference source's presence rides the wire as
 * evidence regardless of which rule closes the concern, but its ABSENCE must
 * never prevent disclosure from doing its job — that would re-introduce the
 * exact "unconditionally unsatisfiable in the overwhelming majority of real
 * workspaces, which have no SCIP index at all" defect the review reported.
 */
export function relationDisclosureSatisfies(packet: SfRelationPacketView | undefined): boolean {
  if (packet === undefined) return false;
  if (packet.resolved === false) return false;
  if (packet.definition === undefined) return false;
  return Array.isArray(packet.unavailable) && packet.unavailable.length > 0;
}

/**
 * The OTHER half of ruling (cc): disclosure alone is not enough. §3.4's own
 * framing survives — "X's definition (and declaration where one exists) has
 * been served" — because a relation concern that closes on disclosure alone,
 * with nothing else ever served, would let a query about a symbol nobody
 * looked at "succeed" purely because callers are structurally uncomputable.
 * The definition/declaration siblings are the SAME anchor rule 5
 * (`sfConcerns.ts`) inherited the relation concern's own anchor from, so
 * "the sibling concerns for this exact anchor" is the precise, mechanical
 * reading of "X's definition/declaration".
 *
 * `isDischarged` reads the caller's live nomination state (§6.1 P-1: a
 * concern satisfied EARLIER in this same response, or already satisfied by
 * the snapshot this call started from, both count — `openSemanticFrontierPackState`'s
 * two-pass lifecycle, sync body pass then async relation-packet pass over the
 * SAME updated snapshot, means the sibling is always resolved by the time
 * this runs for a real pack).
 *
 * ROUND-24 FINDING 1 / RULING (dd), 2026-09-04 (FX-Y2): `isDischarged` alone
 * is NOT enough any more. It reads the PERSISTED concern snapshot, and that
 * mark can predate a same-pack `TL_SF_DEMOTE` pass that withheld the
 * sibling's own body AFTER the sync satisfaction pass already recorded it
 * satisfied but BEFORE this (async) relation pass runs — a `declaration`
 * concern (`sfConcerns.ts` rule 2) is non-advisory but never caller-named, so
 * nothing stopped it being reordered into the demoted tail on the strength of
 * a mark that was true when it was made and false by the time the response
 * actually ships. `bodies` here is REQUIRED to be the caller's post-seam,
 * post-demotion evidence (see `applySemanticFrontierRelationPackets`'s own
 * call site) — this function does not know or care where it came from, but
 * that is what makes the check below honest: whenever THIS response speaks
 * to a sibling's address AT ALL (an evidence entry that covers it, however it
 * got there), that entry's OWN body flag settles the question, full stop —
 * body present closes it, body withheld does not, no matter what the
 * persisted mark says. `isDischarged` is consulted only when this response
 * says NOTHING about the address at all, which is exactly the
 * genuinely-earlier-response lifecycle this function's own tests (and P-1)
 * already cover: a real prior call served the body, THIS call never
 * re-touches that address, and the persisted mark is the only honest source
 * left for it.
 *
 * No sibling `definition`/`declaration` concern exists at all (e.g. rule 5's
 * anchor came from something other than a definition-shaped primary) falls
 * back to asking whether THIS response served a body at the relation
 * concern's own address directly — the one other honest reading of "X's
 * definition has been served" when there is no separate concern object to
 * check against.
 */
function relationGroundingSiblings(
  concern: SfStructuralConcern,
  concerns: readonly SfStructuralConcern[],
): SfStructuralConcern[] {
  return concerns.filter((candidate) => {
    if (candidate === undefined || candidate === null) return false;
    if (candidate.id === concern.id) return false;
    if (candidate.kind !== "definition" && candidate.kind !== "declaration") return false;
    const candidatePath = anchorPath(candidate);
    const directPath = anchorPath(concern);
    if (candidatePath !== undefined && directPath !== undefined && samePath(candidatePath, directPath)) return true;
    for (const own of anchorSymbols(concern)) {
      for (const other of anchorSymbols(candidate)) if (sameSymbol(own, other)) return true;
    }
    return false;
  });
}

/**
 * Is `sibling` grounded for THIS response, per the round-24/(dd) rule above?
 * An evidence entry covering the sibling's own address (whatever rule put it
 * there) settles it on THAT entry's body flag; only when this response is
 * silent about the address does the persisted `isDischarged` mark decide.
 */
function siblingGroundingHolds(
  sibling: SfStructuralConcern,
  bodies: readonly SfResponseEvidence[],
  isDischarged: (concernId: string) => boolean,
): boolean {
  const addressed = bodies.filter((ev) => evidenceCovers(sibling, ev));
  if (addressed.length > 0) return addressed.some((ev) => hasBody(ev));
  return isDischarged(sibling.id);
}

function relationAnchorGroundingServed(
  concern: SfStructuralConcern,
  concerns: readonly SfStructuralConcern[],
  isDischarged: (concernId: string) => boolean,
  bodies: readonly SfResponseEvidence[],
): boolean {
  const siblings = relationGroundingSiblings(concern, concerns);
  if (siblings.length > 0) {
    return siblings.every((sibling) => siblingGroundingHolds(sibling, bodies, isDischarged));
  }
  return bodies.some((ev) => hasBody(ev) && evidenceCovers(concern, ev));
}

/**
 * RULING (dd), round-24 finding 1, 2026-09-04 (FX-Y2), eligibility half.
 *
 * `demotionEligibleNow` (`canonicalDecision.ts`) used to treat only
 * caller-named addresses (`snapshot.requiredAddresses`, I-2) as permanently
 * un-demotable. A `declaration` concern is non-advisory but never
 * caller-named (`sfConcerns.ts` rule 2 never sets `required`), so its address
 * was demotion-eligible the instant the sync satisfaction pass closed it —
 * even while a SIBLING `relation` concern sharing its anchor was (and, absent
 * this fix, could remain) still open, waiting on that exact body to ground
 * its own eventual disclosure-based closure (`relationAnchorGroundingServed`
 * above). Demoting the sibling there stripped the grounding the later
 * disclosure check went on to trust from a stale mark alone — the defect this
 * whole file's fixes close from two directions.
 *
 * This is the OTHER direction: refuse to demote in the first place. `path`
 * is ineligible for demotion in this pack (treated as required-for-demotion
 * purposes, exactly like I-2, without being added to `requiredAddresses`
 * itself — I-2's own caller-named meaning stays exactly as documented at its
 * call site) whenever it is the address of ANY open (not yet `"satisfied"`),
 * non-advisory concern's own binding/anchor, OR — for an OPEN `relation`
 * concern specifically — the address of one of that relation concern's
 * grounding definition/declaration siblings (`relationGroundingSiblings`),
 * REGARDLESS of whether that sibling itself already reads `"satisfied"` in
 * the snapshot (that is precisely the case this rule exists to protect: the
 * sibling closed early, off a body demotion would otherwise remove).
 *
 * Called once, before a demotion decision is made, never after: a surface
 * already demoted by an earlier pass is never reconsidered here, so this can
 * only ever keep a body — it never un-suppresses one (`re_suppression_count`
 * stays 0, decisionWire.ts's own separate invariant).
 */
export function isAddressGroundingOpenConcern(
  path: string,
  concerns: readonly SfStructuralConcern[],
  openNonAdvisoryIds: readonly string[],
): boolean {
  if (typeof path !== "string" || path === "") return false;
  const open = new Set(openNonAdvisoryIds);
  const addressMatches = (candidate: SfStructuralConcern): boolean => {
    for (const binding of candidate.bindings) if (samePath(binding, path)) return true;
    const direct = anchorPath(candidate);
    return direct !== undefined && samePath(direct, path);
  };
  for (const concern of concerns) {
    if (concern === undefined || concern === null || concern.advisory) continue;
    if (!open.has(concern.id)) continue;
    if (addressMatches(concern)) return true;
    if (concern.kind !== "relation") continue;
    for (const sibling of relationGroundingSiblings(concern, concerns)) {
      if (addressMatches(sibling)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------

interface Nomination {
  readonly rule: SfSatisfactionRule;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

/**
 * Which concerns did `response` discharge?
 *
 * Total: every unexpected input shape (an inert snapshot, an unknown kind, a
 * missing array, a null entry) yields "nothing was satisfied", which is the
 * fail-open answer — SF never claims a delivery it cannot prove, and never
 * throws into a read path.
 *
 * An INERT snapshot (`active:false`) means SF is observation-only for this
 * call (I-1): every concern is reported untouched and nothing is nominated.
 */
export function applyResponseToConcerns(input: SfApplyInput): SfSatisfactionResult {
  const concerns = Array.isArray(input?.concerns) ? input.concerns : [];
  const empty = (): SfSatisfactionResult => ({
    satisfied: [],
    proofs: {},
    untouched: concerns.map((c) => c?.id ?? "").filter((id) => id !== ""),
    alreadySatisfied: [],
    openVerify: [],
  });
  if (input?.snapshot?.active !== true) return empty();
  const response = input.response;
  if (response === undefined || response === null || typeof response.kind !== "string") return empty();

  const satisfiedAlready = new Set(
    (input.snapshot.concerns ?? [])
      .filter((c) => c.state === "satisfied")
      .map((c) => c.id),
  );

  const nominations = new Map<string, Nomination>();
  const openVerify: string[] = [];

  const nominate = (concern: SfStructuralConcern, nomination: Nomination): void => {
    // I-3: an advisory concern closes nothing. Enforced here as well as at the
    // gate, so a caller reading `satisfied` alone can never see one.
    if (concern.advisory) return;
    if (satisfiedAlready.has(concern.id)) return;
    if (nominations.has(concern.id)) return;
    nominations.set(concern.id, nomination);
  };

  const kind = response.kind as SfResponseKind;
  const bodies = Array.isArray(response.evidence) ? response.evidence.filter((e) => e != null) : [];
  // R27b-FIX F9: the pack's own bounded-window map, when the seam supplied one.
  const directReadWindows = input.directReadWindows instanceof Map
    || (input.directReadWindows !== undefined && typeof (input.directReadWindows as { get?: unknown }).get === "function")
    ? input.directReadWindows
    : undefined;

  if (!NO_OP_KINDS.has(kind)) {
    switch (kind) {
      case "read.task_pack":
      case "read.text":
      case "read.artifact": {
        const rule: SfSatisfactionRule =
          kind === "read.artifact" ? "artifact-section-covers-binding" : "body-covers-binding";
        applyBodies(concerns, bodies, rule, kind, nominate, directReadWindows);
        break;
      }
      case "read.batch": {
        const entries = Array.isArray(response.entries) ? response.entries : [];
        for (const entry of entries) {
          if (entry === undefined || entry === null) continue;
          // An entry that was truncated closes nothing, whatever its surfaces
          // claim: the caller holds a prefix (§3.3, `read.batch`).
          if (entry.truncated === true) continue;
          const entryBodies: SfResponseEvidence[] = Array.isArray(entry.evidence)
            ? entry.evidence.filter((e: SfResponseEvidence) => e != null)
            : [];
          applyBodies(concerns, entryBodies, "batch-entry-body-covers-binding", kind, nominate, directReadWindows);
        }
        // A batch may also carry top-level evidence (a synthesized whole-file
        // handle registered outside any entry); it is applied on the same rule.
        applyBodies(concerns, bodies, "batch-entry-body-covers-binding", kind, nominate, directReadWindows);
        break;
      }
      case "search.references": {
        // Paging is not done => `min-grounded-evidence` is not met (§3.3).
        if (response.complete === true) {
          for (const concern of concerns) {
            if (!REFERENCE_SATISFIABLE.has(concern.kind)) continue;
            if (!referencesCover(concern, response, bodies)) continue;
            nominate(concern, {
              rule: "references-complete-for-anchor",
              evidenceIds: bodies.map(evidenceIdOf),
              note: "search.references/references-complete-for-anchor",
            });
          }
        }
        break;
      }
      case "read.closure": {
        // `status:"not-applicable"` INVALIDATES a verify concern; it does not
        // satisfy one. Nothing is nominated on that branch.
        if (response.closureStatus !== "not-applicable") {
          for (const concern of concerns) {
            if (concern.kind !== "verify") continue;
            // S-F1 (round-11, 2026-09-03): a kit row that names a target but
            // never actually carried a body (truncated, or a structural-only
            // reference) discharges NOTHING — matching every other rule in
            // this file (`applyBodies` already filters on `hasBody`). Without
            // this filter, a bodyless `read.closure` kit row could nominate a
            // verify concern satisfied purely by NAMING the target.
            const withBody = bodies.filter(hasBody);
            const covering = withBody.filter((ev) => evidenceCovers(concern, ev));
            const proofBodies = concern.bindings.length === 0 && anchorPath(concern) === undefined
              ? withBody
              : covering;
            if (proofBodies.length === 0) continue;
            nominate(concern, {
              rule: "closure-kit-covers-verify",
              evidenceIds: proofBodies.map(evidenceIdOf),
              note: "read.closure/closure-kit-covers-verify",
            });
          }
        }
        break;
      }
      case "edit.applied": {
        const applied = (Array.isArray(response.applied) ? response.applied : [])
          .filter((p): p is string => typeof p === "string" && p !== "");
        for (const concern of concerns) {
          if (!editCovers(concern, applied)) continue;
          if (concern.kind === "verify") {
            // The edit CREATED this obligation; it did not discharge it.
            if (!concern.advisory && !satisfiedAlready.has(concern.id)) openVerify.push(concern.id);
            continue;
          }
          if (concern.disposition !== "edit") continue;
          nominate(concern, {
            rule: "edit-applied-covers-every-binding",
            evidenceIds: applied.map(normPath),
            note: "edit.applied/edit-applied-covers-every-binding",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // A relation packet rides whatever response carried it, so its rule runs
  // outside the kind switch — including on a kind that closes nothing itself.
  const packet = response.relationPacket;
  if (packet !== undefined) {
    // §6.1 P-1: a sibling this SAME response already discharged (nominated
    // above, e.g. the body pass) or that an earlier response already closed
    // (the snapshot this call started from) both count as "served" for
    // `relationAnchorGroundingServed` — see that function's own doc comment.
    const isDischarged = (concernId: string): boolean =>
      satisfiedAlready.has(concernId) || nominations.has(concernId);
    const twoSided = relationPacketSatisfies(packet);
    for (const concern of concerns) {
      if (concern.kind !== "relation") continue;
      if (!packetCovers(concern, packet)) continue;
      if (twoSided) {
        nominate(concern, {
          rule: "relation-packet-two-sided",
          evidenceIds: packet.definition === undefined ? [] : [normPath(packet.definition.path)],
          note: "relation-packet/relation-packet-two-sided",
        });
        continue;
      }
      // Ruling (cc), FX-Y1 (round-23B finding 1): the packet did not PROVE an
      // edge, but it may still discharge the concern by DISCLOSING that the
      // workspace cannot compute one — never a silent close, never a
      // fabricated edge — provided the anchor's own definition/declaration
      // has actually been served.
      if (
        relationDisclosureSatisfies(packet) &&
        relationAnchorGroundingServed(concern, concerns, isDischarged, bodies)
      ) {
        nominate(concern, {
          rule: "relation-disclosed-unavailable",
          evidenceIds: packet.definition === undefined ? [] : [normPath(packet.definition.path)],
          note: "relation-packet/relation-disclosed-unavailable",
        });
      }
    }
  }

  const satisfied: string[] = [];
  const untouched: string[] = [];
  const alreadySatisfied: string[] = [];
  const proofs: Record<string, SfConcernProof> = {};
  for (const concern of concerns) {
    if (concern === undefined || concern === null || concern.id === "") continue;
    if (satisfiedAlready.has(concern.id)) {
      if (!alreadySatisfied.includes(concern.id)) alreadySatisfied.push(concern.id);
      continue;
    }
    const nomination = nominations.get(concern.id);
    if (nomination === undefined) {
      if (!untouched.includes(concern.id)) untouched.push(concern.id);
      continue;
    }
    if (satisfied.includes(concern.id)) continue;
    satisfied.push(concern.id);
    proofs[concern.id] = {
      rule: nomination.rule,
      evidenceIds: [...nomination.evidenceIds],
      note: nomination.note,
    };
  }

  return { satisfied, proofs, untouched, alreadySatisfied, openVerify };
}

function applyBodies(
  concerns: readonly SfStructuralConcern[],
  bodies: readonly SfResponseEvidence[],
  rule: SfSatisfactionRule,
  kind: SfResponseKind,
  nominate: (concern: SfStructuralConcern, nomination: Nomination) => void,
  windows: ReadonlyMap<string, string | undefined> | undefined,
): void {
  if (bodies.length === 0) return;
  for (const concern of concerns) {
    if (concern === undefined || concern === null) continue;
    if (!bodyCanSatisfy(concern)) continue;
    // R27b-FIX F9: a body that misses the concern's resolved window proves
    // nothing about it — see `bodyRangeCoversConcernWindow`.
    const covering = bodies.filter(
      (ev) => hasBody(ev)
        && evidenceCovers(concern, ev)
        && bodyRangeCoversConcernWindow(concern, ev, windows),
    );
    if (covering.length === 0) continue;
    nominate(concern, {
      rule,
      evidenceIds: covering.map(evidenceIdOf),
      note: `${kind}/${rule}`,
    });
  }
}

/**
 * A references page covers a concern when it was anchored on that concern's
 * symbol, or — when the page names no anchor — when one of the referencing
 * files it served is a binding of the concern.
 */
function referencesCover(
  concern: SfStructuralConcern,
  response: SfResponse,
  bodies: readonly SfResponseEvidence[],
): boolean {
  const anchor = response.anchor;
  if (anchor !== undefined) {
    for (const symbol of anchorSymbols(concern)) if (sameSymbol(symbol, anchor.symbol)) return true;
    if (typeof anchor.path === "string" && anchor.path !== "") {
      for (const binding of concern.bindings) if (samePath(binding, anchor.path)) return true;
      const direct = anchorPath(concern);
      if (direct !== undefined && samePath(direct, anchor.path)) return true;
    }
    return false;
  }
  return bodies.some((ev) => evidenceCovers(concern, ev));
}

// ---------------------------------------------------------------------------
// The internal pack context (NO WIRE BYTES, BY CONSTRUCTION)
// ---------------------------------------------------------------------------

/**
 * What W-DEMOTE and W-NEXT-ARBITER need from a task_pack, and what this wave
 * puts within their reach WITHOUT changing a single emitted byte.
 *
 * A `WeakMap` keyed by the result object was the ORIGINAL design here, on the
 * theory that "every serializer, cloner, fingerprinter, and byte-baseline in
 * this server takes the result object as its input, so a side table cannot be
 * reached by any of them." That theory was false: `util/attachSupply.ts`
 * shallow-copies the pack (`{...result}`) before `server.ts` ever derives the
 * canonical decision, so the WeakMap key the production dispatch path holds by
 * the time it asks is a DIFFERENT object than the one this module was told
 * about — round-22B finding 2 (fifth production-inertness layer, §0.3(j)):
 * the closure-gating arbiter silently no-ops on every real call, regardless of
 * query or concern kind, because `sfPackContextFor` always misses.
 *
 * The fix carries a stable per-pack TOKEN on the result object itself, as an
 * own, ENUMERABLE, Symbol-keyed property (`SF_CONTEXT_TOKEN_KEY`). This
 * survives exactly the copies that matter and none that don't, by
 * construction rather than by audit:
 *   - `{...result}` / `Object.assign({}, result)` copy own enumerable
 *     properties for BOTH string and symbol keys (verified: ECMA-262
 *     CopyDataProperties iterates `[[OwnPropertyKeys]]`), so every shallow
 *     copy along attachSupply's/attachServerBuildOnce's/the receipt/shedder
 *     chain keeps the token riding on the copy.
 *   - `JSON.stringify` — the ONE thing that actually produces wire bytes
 *     (`protocol/result.ts`'s `toolOk`/`toolStructuredError`) — silently
 *     drops all symbol-keyed properties by spec. The token can never appear
 *     on the wire; no separate stripping step is needed, and none exists.
 *   - `structuredClone`/a `JSON.parse(JSON.stringify(x))` round-trip DOES
 *     drop a symbol-keyed property (verified). Neither occurs on a task_pack
 *     result anywhere between this seam and the wire (audited: `server.ts`'s
 *     only `structuredClone` calls are on tool *definitions*, not pack
 *     results; `readCodeTaskPack.ts`'s `structuredClone` calls clone
 *     SUB-fields — `contract`, `result.concerns` — assigned back onto the
 *     same result object, never the top-level object itself). Should a future
 *     copy site need one of those, it must re-attach via
 *     `attachSfPackContext` on its output, exactly like `attachSupply` no
 *     longer has to.
 *
 * `packContexts` (the original `WeakMap`) is kept as a same-object fallback
 * for callers that still hold the exact pre-copy pack (direct
 * `buildTaskPack` + `deriveCanonicalTaskDecision` callers, most existing
 * tests) — it is consulted only when the token lookup misses, never instead
 * of it, so a stale/foreign token can never resurrect a wrong context.
 *
 * `contextsByToken` is a plain `Map`, not a `WeakMap` (a string key cannot be
 * weakly held), so it is bounded (`SF_PACK_CONTEXT_TOKENS_MAX`) with
 * oldest-first eviction. A pack's token is only ever consulted within the
 * same synchronous dispatch that minted it, so eviction of an old entry can
 * only affect a caller holding a token from long before any live request.
 */
export interface SfPackContext {
  /** The state adapter's view after this pack was recorded. May be inert. */
  readonly snapshot: SfSnapshot;
  /** The concerns extracted for this task (`[]` when the extraction flag is off). */
  readonly concerns: readonly SfStructuralConcern[];
  /** What this pack discharged. */
  readonly satisfaction: SfSatisfactionResult;
  /**
   * §3.6.2: the profile was GUESSED with low confidence, so SF may not
   * suppress, demote, or close anything on this call. W-DEMOTE / W-NEXT must
   * check this before acting on anything else here.
   */
  readonly observationOnly: boolean;
  /**
   * F9 (2026-09-04, ruling (a)): every caller-named path this pack's
   * frontier join touched, keyed by workspace-relative path. A key present
   * with a `"<start>-<end>"` value names a pre-computed, query-anchored
   * bounded window (reusing the retired F1 anchor/window machinery —
   * `readCodeTaskPack.ts`'s `sfNamedFrontierWindowRange` — sized against a
   * FOLLOW-UP call's target rather than an inlined pack body); a key present
   * with `undefined` means "read the file directly, no bound needed" (the
   * join already inlined it, or no window could be computed). A path ABSENT
   * from this map falls back to the pre-F9 whole-file/`qref` `next` shape
   * unchanged — so a task with no named-frontier join (or the flag off) is
   * byte-identical by construction. W-NEXT-ARBITER (`selectCanonicalNext.ts`)
   * is the only reader.
   */
  readonly namedFrontierDirectWindows?: ReadonlyMap<string, string | undefined>;
}

const packContexts = new WeakMap<object, SfPackContext>();

/**
 * The property key carrying the per-pack context token. A `Symbol` (not a
 * string) so it is structurally invisible to `JSON.stringify` — see the
 * block comment above. Exported READ-ONLY for tests that need to assert the
 * wire never carries it; nothing outside this module may write through it.
 */
export const SF_CONTEXT_TOKEN_KEY: unique symbol = Symbol("tokenlighten.sfPackContextToken");

/** Upper bound on live tokens; see the block comment above. */
export const SF_PACK_CONTEXT_TOKENS_MAX = 256;

const contextsByToken = new Map<string, SfPackContext>();

function mintSfContextToken(): string {
  return randomBytes(12).toString("hex");
}

function registerToken(token: string, context: SfPackContext): void {
  contextsByToken.set(token, context);
  while (contextsByToken.size > SF_PACK_CONTEXT_TOKENS_MAX) {
    const oldest = contextsByToken.keys().next();
    if (oldest.done === true) break;
    contextsByToken.delete(oldest.value);
  }
}

/** Publish the SF view of one pack. Overwrites any earlier view of the same object. */
export function attachSfPackContext(result: object, context: SfPackContext): void {
  if (result === null || typeof result !== "object") return;
  packContexts.set(result, context);
  const token = mintSfContextToken();
  registerToken(token, context);
  try {
    Object.defineProperty(result, SF_CONTEXT_TOKEN_KEY, {
      value: token,
      enumerable: true, // MUST be enumerable — this is what survives {...result}.
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen/non-extensible result cannot carry the token forward through a
    // copy; the WeakMap fallback above still resolves for THIS exact object.
  }
}

/** The SF view of one pack, or `undefined` when SF did not run for it. */
export function sfPackContextFor(result: object): SfPackContext | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const token = (result as Record<symbol, unknown>)[SF_CONTEXT_TOKEN_KEY];
  if (typeof token === "string") {
    const viaToken = contextsByToken.get(token);
    if (viaToken !== undefined) return viaToken;
  }
  return packContexts.get(result);
}

/** Test-only: drop every live token/context, so specs start from a clean slate. */
export function resetSfPackContextTokensForTest(): void {
  contextsByToken.clear();
}
