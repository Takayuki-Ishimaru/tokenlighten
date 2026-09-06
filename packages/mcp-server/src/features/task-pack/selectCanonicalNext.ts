// W-NEXT-ARBITER — the single arbiter of `decision.next` (DC2).
//
// Design of record: DESIGN-v0.15-semantic-frontier-plan.md §10.0 (the
// ratified DC2 interface contract), §3.4 (concern kind -> call shape),
// §6 P-4 (closure soundness), §3.5.3 (the ~90 B supporting-row estimate this
// module reuses to size continuation fills).
//
// `decision.next` is representable exactly once (D-1,
// `packages/types/src/mcp/decision.ts:152-179`). Three sister designs each
// want a say in its contents — this book's own concern ranking, the
// continuation-and-metrics book's lookahead prediction, and the turn-economy
// book's batch folding — so §10.0 hands this ONE function the whole
// decision, as a FIXED four-stage priority pipeline:
//
//   1. caller-named explicit targets       — always win, never reordered.
//   2. the top unsatisfied non-advisory concern — names the call when (1) is
//      empty.
//   3. continuation prediction             — may only fill `fills` (destined
//      for `evidence[]`/`remaining` slack) under `budgetBytes`; it NEVER sets
//      or changes `next`.
//   4. turn-economy batch folding          — a presentation-layer transform
//      applied LAST, to the address set (1) or (2) already selected. It can
//      widen a single-concern call into a same-shape multi-concern one, or
//      cap an oversized one; it never introduces an address (1)/(2) did not
//      already select, and never touches `next` when (1) and (2) are both
//      empty (see the P3-over-P4 test in the spec: fold has nothing to do
//      when nothing was selected).
//
// PURE. No I/O, no clock, no RNG — every field the caller needs is an input.
//
// TYPE DUPLICATION IS DELIBERATE. `StructuralConcernView` and
// `CanonicalSnapshotView` below are structural mirrors of `SfStructuralConcern`
// (`sfConcerns.ts`) and `SfSnapshot` (`task-state/sfState.ts`), narrowed to the
// fields this module reads. Both real modules carry their own wave fences
// (`sfConcerns.spec.ts`'s import allowlist; `sfState.spec.ts`'s "task-state/
// only" grep) that do not yet name this file — importing either module here
// would trip a fence owned by a concurrent workstream one wave early. Any real
// `SfStructuralConcern`/`SfSnapshot` satisfies these shapes structurally, so
// W-SATISFACTION/W-DEMOTE can pass the genuine objects straight through
// without a translation layer once they widen the allowlists to include this
// file. `sfConcerns.ts` itself uses the identical duplication pattern for
// `SfConcernSeed` vs. the state adapter's `SfConcernInput` — same reasoning.

import type { ToolCall } from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Structural mirrors (see file banner)
// ---------------------------------------------------------------------------

/** Mirrors `SfConcernKind` (`sfConcerns.ts`). */
export type SfConcernKind =
  | "definition"
  | "declaration"
  | "usage"
  | "relation"
  | "template"
  | "generated"
  | "verify"
  | "answer";

/** Mirrors `SfConcernAnchor` (`sfConcerns.ts`). */
export type SfConcernAnchor =
  | { readonly kind: "symbol"; readonly symbol: string }
  | {
    readonly kind: "qualified";
    readonly qualified: string;
    readonly qualifier: string;
    readonly member: string;
  }
  | { readonly kind: "path"; readonly path: string }
  // D6 (FX-R3b): an addressable-LOOKING token that resolved to no workspace
  // address. Never selectable as a read target — `anchorTarget` below falls
  // through to `{ path }` only for anchors that already carry one.
  | { readonly kind: "literal"; readonly literal: string }
  | { readonly kind: "verb"; readonly verb: string };

/**
 * Mirrors `SfStructuralConcern` (`sfConcerns.ts`), narrowed to the fields
 * this arbiter reads. `bindings` order is load-bearing: it is the ranking
 * `extractStructuralConcerns` already produced (plan §3.6.1) — this module
 * never re-sorts concerns.
 */
export interface StructuralConcernView {
  readonly id: string;
  readonly kind: SfConcernKind;
  readonly anchor: SfConcernAnchor;
  /** True iff `origin === "heuristic"`. An advisory concern is never selected (I-3). */
  readonly advisory: boolean;
  /**
   * True iff the caller named this address, or a resolver grounded a
   * definition.
   *
   * A RANKING SIGNAL ONLY (P-4, SF-3). It used to gate selection, which
   * deadlocked the arbiter against its own closure rule: `allNonAdvisoryClosed`
   * counts EVERY non-advisory concern, and `sfConcerns.ts` mints non-advisory
   * `required:false` concerns (a qualified anchor's `declaration`, `usage` and
   * `relation` siblings), so a task holding only those could never close and
   * the arbiter could never name a call that would close one — `canAct:false`
   * with `next:null` forever. Required concerns still go FIRST; the rest
   * follow in their already-ranked order.
   */
  readonly required: boolean;
  /** Workspace-relative paths this concern is bound to, ranked-order. */
  readonly bindings: readonly string[];
  /**
   * D8 (FX-R3c): mirrors `SfStructuralConcern.fileAnchor`. `false` means the
   * extractor PROVED this path anchor is not a servable file — a directory
   * (the auto-narrowed `scope_inferred` subtree arrives as an
   * `explicit-target` path concern) or a path the index says is absent. Such
   * a concern is skipped for `next` selection: on the sealed SF05 replay it
   * was the top REQUIRED concern, and it minted
   * `search_files action:"references" queries:["<a directory>"]` — a call that
   * can never close it — while the caller-named `CONTRACT.md` concern ranked
   * second and was never reached. `undefined` keeps every pre-D8 behaviour.
   */
  readonly fileAnchor?: boolean;
  /**
   * D9 (FX-R3c): the same-basename workspace paths an AMBIGUOUS filename
   * token matched. Surfaced through `SelectCanonicalNextResult.candidates` so
   * an `await_input` decision can carry the choice (ruling (cc)) instead of
   * dead-ending on a basename this layer cannot bind.
   */
  readonly candidates?: readonly string[];
}

/**
 * Mirrors `SfSnapshot` (`task-state/sfState.ts`), narrowed to the fields this
 * arbiter reads.
 */
export interface CanonicalSnapshotView {
  readonly active: boolean;
  readonly allNonAdvisoryClosed: boolean;
  /** Concern ids still open (non-advisory). A concern id absent here is closed. */
  readonly openNonAdvisory: readonly string[];
  /** Source uris already served with `required:true` (I-2, permanently un-demotable). */
  readonly requiredAddresses: readonly string[];
}

/** Mirrors `sfObservationOnly`'s input shape (`sfConcerns.ts`). */
export interface ProfileBindingView {
  readonly source?: string;
  readonly confidence?: number;
}

/** One caller-addressable location, in the shapes `read_file`/`search_files` accept. */
export interface SfAddress {
  readonly path?: string;
  readonly symbol?: string;
  readonly handle?: string;
  readonly range?: string;
}

export interface ContinuationInput {
  /** Candidate addresses, already ranked; earlier candidates are preferred. */
  readonly candidates: readonly SfAddress[];
  readonly budgetBytes: number;
}

export interface BatchFoldInput {
  readonly enabled: boolean;
  readonly maxTargets: number;
}

export interface SelectCanonicalNextInput {
  /** Priority 1. Caller-named `targets`/`paths`/`handles`/`scope.path`/`scope.symbol`. */
  readonly explicitTargets: readonly SfAddress[];
  /** Priority 2 source. Ranked order; this module never re-sorts it. */
  readonly concerns: readonly StructuralConcernView[];
  /** Absent or `active:false` means "gated off" — see the pass-through rule below. */
  readonly snapshot?: CanonicalSnapshotView;
  /** Priority 3. May only produce `fills`, never `next`. */
  readonly continuation?: ContinuationInput;
  /** Priority 4. A presentation transform over the address set (1)/(2) selected. */
  readonly batchFold?: BatchFoldInput;
  /** What `next` was before this call; returned untouched on every gated path. */
  readonly currentNext?: ToolCall | null;
  readonly profileBinding?: ProfileBindingView;
  readonly cwd?: string;
  readonly taskHandle?: string;
  /**
   * The pack's replay ref. A `read_file` `next` this arbiter builds REPLACES a
   * legacy continuation that carried one, so dropping it would turn a bounded
   * re-pack into a fresh, unscoped one (SF-2). `search_files` has no `qref`
   * field, so it is emitted on `read_file` calls only.
   */
  readonly qref?: string;
  /**
   * F9 (2026-09-04, ruling (a)): path -> a pre-computed bounded window range,
   * for every caller-named path a concern-driven `next` might otherwise
   * request as a whole-file/`qref` re-pack (`readCodeTaskPack.ts`'s
   * `applySemanticFrontierNamedFrontier`, reusing the retired F1 anchor/
   * window machinery). A key present with a range STRING builds a direct,
   * bounded `content:"full"` read of that window; a key present with
   * `undefined` builds a direct, bounded-free `content:"full"` whole-file
   * read; a path ABSENT from this map (including an absent map itself) falls
   * back to the pre-F9 `content:"auto"`+`qref` shape unchanged — SF-2's own
   * re-pack reasoning stays exactly as written for every OTHER concern shape
   * this arbiter builds. Neither branch is a re-pack (no `mode:"task_pack"`
   * is ever implied), so `qref` is never carried on either one (ruling (r)).
   */
  readonly pathDirectReadWindows?: ReadonlyMap<string, string | undefined>;
}

export type SelectCanonicalNextPriority = 1 | 2 | 3 | 4 | "none";

export interface SelectCanonicalNextRationale {
  readonly priority: SelectCanonicalNextPriority;
  readonly concernId?: string;
}

export interface SelectCanonicalNextClosure {
  /** True only when nothing here would block `act.*` (P-4: never act over an unsatisfied required concern). */
  readonly canAct: boolean;
  readonly reason: string;
}

export interface SelectCanonicalNextResult {
  readonly next: ToolCall | null;
  readonly fills: readonly SfAddress[];
  /**
   * D9 (ruling (cc)): the addresses an ambiguous concern is asking the caller
   * to choose between. Always empty on a gated pass-through, and empty when
   * no concern carried a choice — so a consumer can treat "non-empty" as "an
   * `await_input` may honestly carry candidates".
   */
  readonly candidates: readonly SfAddress[];
  readonly rationale: SelectCanonicalNextRationale;
  readonly closure: SelectCanonicalNextClosure;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * §3.5.3's own estimate for one supporting-row `evidence[]` line (~70-110 B;
 * the design text quotes "約 90 B" as its working figure). Continuation fills
 * are sized against this per-candidate cost — the only budget-relevant fact
 * this pure module can know without reading the real wire encoder.
 */
export const SUPPORTING_ROW_BYTES = 90;

const READ_TARGET_KINDS: ReadonlySet<SfConcernKind> = new Set(["definition", "declaration", "template", "generated"]);

// ---------------------------------------------------------------------------
// Gate (§10.4 / plan §3.6.2): observation-only or inactive/flag-off snapshot
// ---------------------------------------------------------------------------

function sfObservationOnlyLocal(binding: ProfileBindingView | undefined): boolean {
  if (binding === undefined) return false;
  if (binding.source !== "inferred") return false;
  return (binding.confidence ?? 0) < 0.5;
}

function passThrough(currentNext: ToolCall | null | undefined, reason: string): SelectCanonicalNextResult {
  return {
    next: currentNext ?? null,
    fills: [],
    candidates: [],
    rationale: { priority: "none" },
    closure: { canAct: false, reason },
  };
}

// ---------------------------------------------------------------------------
// Priority 2: top unsatisfied non-advisory concern
// ---------------------------------------------------------------------------

/**
 * D8 (FX-R3c): can this arbiter name a call that would actually CLOSE the
 * concern?
 *
 * A `literal`/`verb` anchor spells no address by construction (D6), and a
 * `path` anchor the extractor PROVED is not a file (a directory, or an absent
 * path) is an address no `read_file` can serve and no `references` query term
 * can name. Selecting one produced the live SF05 dead end: the top required
 * concern minted a references search over a DIRECTORY while the caller-named
 * file behind it was never reached. `fileAnchor === undefined` (no index) is
 * NOT proof of anything, so it stays selectable exactly as before.
 *
 * Skipping only affects WHICH concern names `next`; a skipped concern still
 * counts in `snapshot.allNonAdvisoryClosed`, so closure is unchanged.
 */
function isAddressableConcern(concern: StructuralConcernView): boolean {
  if (concern.anchor.kind === "literal" || concern.anchor.kind === "verb") return false;
  if (concern.anchor.kind === "path" && concern.fileAnchor === false) return false;
  return true;
}

function isConcernOpen(concern: StructuralConcernView, snapshot: CanonicalSnapshotView): boolean {
  if (!snapshot.openNonAdvisory.includes(concern.id)) return false;
  // Defensive second proof (§10.0 phrasing: "requiredAddresses / closed
  // concerns"): an address the caller already served as `required:true`
  // needs no further request even if the IR has not yet marked this exact
  // concern id closed.
  if (concern.bindings.length > 0 && concern.bindings.every((binding) => snapshot.requiredAddresses.includes(binding))) {
    return false;
  }
  return true;
}

/**
 * The top OPEN non-advisory concern, required ones first (SF-3).
 *
 * Two passes over one already-ranked list, not a sort: within each tier the
 * extractor's order is preserved exactly (§3.6.1), and `required` only decides
 * WHICH tier. Selecting any open non-advisory concern is what makes the
 * arbiter's reachable set equal to the closure rule's blocking set — the P-4
 * deadlock counter-example in the spec is precisely a task whose only open
 * concern is non-advisory and `required:false`.
 */
function pickTopUnsatisfiedConcern(
  concerns: readonly StructuralConcernView[],
  snapshot: CanonicalSnapshotView,
): StructuralConcernView | undefined {
  let secondary: StructuralConcernView | undefined;
  for (const concern of concerns) {
    if (concern.advisory) continue; // I-3: advisory closes/blocks/selects nothing.
    if (!isAddressableConcern(concern)) continue; // D8.
    if (!isConcernOpen(concern, snapshot)) continue;
    if (concern.required) return concern; // ranked list; the first required match wins.
    if (secondary === undefined) secondary = concern;
  }
  return secondary;
}

/**
 * The addressable target for one binding.
 *
 * A QUALIFIED anchor keeps its qualifier (SF-4): `Class::member` is how this
 * codebase spells a qualified callable everywhere else (`unqualifiedCallable`
 * in readCodeTaskPack.ts strips it back off on the resolving side), and the
 * bare `member` this used to emit is exactly the D5 defect — three sibling
 * headers declaring an unrelated `isHealthy()` are indistinguishable from the
 * one that defines `EKF::isHealthy`, so the qualifier must ride the target.
 */
function anchorTarget(path: string, anchor: SfConcernAnchor): SfAddress {
  if (anchor.kind === "symbol") return { path, symbol: anchor.symbol };
  if (anchor.kind === "qualified") return { path, symbol: anchor.qualified };
  return { path };
}

function anchorQueryTerm(anchor: SfConcernAnchor): string {
  if (anchor.kind === "symbol") return anchor.symbol;
  if (anchor.kind === "qualified") return anchor.member;
  if (anchor.kind === "path") return anchor.path;
  if (anchor.kind === "literal") return anchor.literal;
  return anchor.verb;
}

/**
 * Priority 4 (§10.0 item 4 / §10.3): fold in bindings from OTHER ready,
 * read-target-shaped, non-advisory, still-open concerns — in their
 * already-ranked order — up to `maxTargets` total addresses. Never touches
 * `usage`/`relation`/`verify`/`answer` concerns (they are not read-target
 * shaped) and never adds an address the top concern did not already make
 * eligible by kind.
 *
 * `maxTargets` IS A CAP (SF-10). It bounds the WHOLE address set, the top
 * concern's own bindings included; the previous `Math.max(base.length,
 * maxTargets)` could only ever widen, so the "or cap an oversized one" half of
 * this stage's contract never executed. Order is still never changed: the
 * result is a prefix of the top concern's bindings, extended in ranked order.
 */
function foldReadAddresses(
  top: StructuralConcernView,
  concerns: readonly StructuralConcernView[],
  snapshot: CanonicalSnapshotView,
  fold: BatchFoldInput | undefined,
): { readonly paths: readonly string[]; readonly folded: boolean } {
  const base = [...top.bindings];
  if (fold?.enabled !== true || !READ_TARGET_KINDS.has(top.kind)) {
    return { paths: base, folded: false };
  }
  // At least one address always survives: a cap of 0 (or below) would turn the
  // presentation transform into a call with no target at all.
  const max = Math.max(1, fold.maxTargets);
  const merged = base.slice(0, max);
  for (const concern of concerns) {
    if (merged.length >= max) break;
    if (concern.id === top.id) continue;
    if (concern.advisory) continue;
    if (!READ_TARGET_KINDS.has(concern.kind)) continue;
    if (!isConcernOpen(concern, snapshot)) continue;
    for (const binding of concern.bindings) {
      if (merged.length >= max) break;
      if (!merged.includes(binding)) merged.push(binding);
    }
  }
  // Widened OR capped: either way the fold changed the address set, which is
  // what `rationale.priority === 4` reports.
  return { paths: merged, folded: merged.length !== base.length };
}

function buildTaskFields(cwd: string | undefined, taskHandle: string | undefined): Record<string, unknown> {
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(taskHandle !== undefined ? { task: { handle: taskHandle } } : {}),
  };
}

/**
 * Build an executable `ToolCall` from a plain arguments object. `ToolCall`'s
 * own `ToolArguments` type (`packages/types/src/mcp/protocol.ts`) is an index
 * signature over `JsonValue`, which a `Record<string, unknown>` built from
 * `SfAddress`/path arrays does not structurally satisfy at the type level even
 * though every value is plain JSON — the same cast every other canonical-call
 * builder in this codebase performs at its own construction site.
 */
function mkCall(tool: ToolCall["tool"], args: Record<string, unknown>): ToolCall {
  return { tool, arguments: args } as unknown as ToolCall;
}

/**
 * The identity fields every arbitrated call must carry (SF-2). `qref` is
 * `read_file`-only: `search_files` has no such argument, and inventing one
 * would produce a call the server refuses on its own schema.
 */
interface CallIdentity {
  readonly cwd?: string;
  readonly taskHandle?: string;
  readonly qref?: string;
}

function buildConcernNext(
  top: StructuralConcernView,
  concerns: readonly StructuralConcernView[],
  snapshot: CanonicalSnapshotView,
  fold: BatchFoldInput | undefined,
  identity: CallIdentity,
  directWindows: ReadonlyMap<string, string | undefined> | undefined,
): { readonly call: ToolCall; readonly usedAddresses: readonly string[]; readonly folded: boolean } {
  const task = buildTaskFields(identity.cwd, identity.taskHandle);
  // D8 (FX-R3c): §3.4's `usage`/`relation` -> `references` mapping presumes a
  // SYMBOL anchor — `anchorQueryTerm` feeds the anchor's own value in as the
  // search term. A PATH-anchored relation concern is what rule (4)/(4b) mints
  // for a file the caller named (a role-less path gets `kind:"relation"`), and
  // handing `queries:["<a path>"]` to `references` asks for call sites of a
  // filename. The address IS the file, so the call that closes it is a read of
  // that file — which is also what D8's frontier join already put a row for.
  const pathAnchored = top.anchor.kind === "path";
  if (!pathAnchored && (top.kind === "usage" || top.kind === "relation")) {
    // §3.4: usage/relation concern -> search_files references.
    const scopePath = top.bindings[0];
    const call = mkCall("search_files", {
      action: "references",
      queries: [anchorQueryTerm(top.anchor)],
      ...(scopePath !== undefined ? { scope: { path: scopePath } } : {}),
      ...task,
    });
    return { call, usedAddresses: scopePath !== undefined ? [scopePath] : [], folded: false };
  }
  // F9 (2026-09-04, ruling (a)): a PATH-anchored concern this pack's
  // named-frontier join already sized a direct-read window for gets a
  // DIRECT, bounded `content:"full"` read of exactly that window (or, when
  // no window was needed, the whole file directly) — never the whole-file
  // `content:"auto"`+`qref` shape below. `qref` present alongside `targets`
  // makes `server.ts`'s `normalizeCanonicalRequest` treat the call as a
  // TASK_PACK RE-PACK (`mode:"task_pack"`) regardless of the target's actual
  // size — the measured SF05 defect: an extra, empty re-pack hop, then a
  // SEPARATE windowed read, where one direct bounded read would do. Neither
  // branch here is a re-pack, so `qref` is never carried on it (ruling (r)).
  // No fold either: folding other concerns' bindings in would defeat the
  // whole point of a BOUNDED single-file window.
  if (pathAnchored) {
    const directPath = top.bindings[0]
      ?? (top.anchor.kind === "path" ? top.anchor.path : undefined);
    if (directPath !== undefined && directWindows?.has(directPath) === true) {
      const range = directWindows.get(directPath);
      const call = mkCall("read_file", {
        targets: [{ path: directPath, ...(range === undefined ? {} : { range }) }],
        content: "full",
        ...task,
      });
      return { call, usedAddresses: [directPath], folded: false };
    }
  }
  // definition / declaration / template / generated / verify / answer (and
  // any path-anchored concern this pack's named-frontier join never
  // touched): §3.4's read_file mapping (verify/answer fall back to the same
  // shape when no dedicated kit reference is available on this pure input).
  const { paths, folded } = foldReadAddresses(top, concerns, snapshot, fold);
  const targets = (paths.length > 0 ? paths : top.bindings).map((path) => anchorTarget(path, top.anchor));
  const call = mkCall("read_file", {
    ...(identity.qref === undefined ? {} : { qref: identity.qref }),
    targets,
    content: "auto",
    ...task,
  });
  return { call, usedAddresses: paths, folded };
}

function buildExplicitNext(
  targets: readonly SfAddress[],
  identity: CallIdentity,
): ToolCall {
  // Priority 1: the caller's own addresses ride through verbatim — same
  // order, none dropped, none added (§3.4 step 4 / §10.0 item 1).
  return mkCall("read_file", {
    ...(identity.qref === undefined ? {} : { qref: identity.qref }),
    targets: targets.map((target) => ({ ...target })),
    content: "auto",
    ...buildTaskFields(identity.cwd, identity.taskHandle),
  });
}

// ---------------------------------------------------------------------------
// Priority 3: continuation fills (never `next`)
// ---------------------------------------------------------------------------

function addressKey(address: SfAddress): string {
  if (address.path !== undefined) return `path:${address.path}`;
  if (address.handle !== undefined) return `handle:${address.handle}`;
  if (address.symbol !== undefined) return `symbol:${address.symbol}`;
  return "empty";
}

/**
 * The addresses an existing `next` already names (SF-11).
 *
 * On the priority-3 path `next` is NOT replaced — it stays whatever the legacy
 * derivation produced — so a fill for an address that call already requests is
 * a duplicated supporting row: bytes spent restating a target the very next
 * call will serve anyway. Priorities 1 and 2 dedupe against their own
 * selection instead, because they REPLACE `next`.
 */
function boundAddressesOfCall(call: ToolCall | null | undefined): ReadonlySet<string> {
  const bound = new Set<string>();
  if (call === null || call === undefined) return bound;
  const args = call.arguments as unknown as Record<string, unknown> | undefined;
  if (args === null || typeof args !== "object") return bound;
  const addString = (value: unknown, kind: "path" | "handle" | "symbol"): void => {
    if (typeof value === "string" && value !== "") bound.add(`${kind}:${value}`);
  };
  addString(args["path"], "path");
  addString(args["handle"], "handle");
  addString(args["symbol"], "symbol");
  for (const [field, kind] of [["paths", "path"], ["handles", "handle"]] as const) {
    const list = args[field];
    if (Array.isArray(list)) for (const value of list) addString(value, kind);
  }
  const targets = args["targets"];
  if (Array.isArray(targets)) {
    for (const target of targets) {
      if (target === null || typeof target !== "object") continue;
      const record = target as Record<string, unknown>;
      addString(record["path"], "path");
      addString(record["handle"], "handle");
      addString(record["symbol"], "symbol");
    }
  }
  const scope = args["scope"];
  if (scope !== null && typeof scope === "object") {
    const record = scope as Record<string, unknown>;
    addString(record["path"], "path");
    addString(record["symbol"], "symbol");
  }
  return bound;
}

function selectFills(
  continuation: ContinuationInput | undefined,
  bound: ReadonlySet<string>,
): readonly SfAddress[] {
  if (continuation === undefined) return [];
  const fills: SfAddress[] = [];
  let spent = 0;
  for (const candidate of continuation.candidates) {
    if (bound.has(addressKey(candidate))) continue;
    if (spent + SUPPORTING_ROW_BYTES > continuation.budgetBytes) break;
    fills.push(candidate);
    spent += SUPPORTING_ROW_BYTES;
  }
  return fills;
}

/** Mirrors `SF_BASENAME_CANDIDATES_MAX` (sfConcerns.ts) — the same choice, one bound. */
const SF_ARBITER_CANDIDATES_MAX = 8;

/**
 * D9 (FX-R3c, ruling (cc)): every same-basename choice this call's concerns
 * carry, in concern order, deduped and bounded.
 *
 * FX-R3b already put the choice ON the concern (`SfStructuralConcern.candidates`)
 * — this is the missing half: the arbiter surfacing it, so an `await_input`
 * carries `candidates` instead of nothing. The family-token disambiguation
 * still runs FIRST (`sfConcerns.ts`'s `resolveFileToken`): when it yields a
 * unique match the concern is grounded and carries no `candidates` at all, so
 * this list is empty and the pack reads that one file instead of asking.
 */
function collectCandidates(concerns: readonly StructuralConcernView[]): readonly SfAddress[] {
  const out: SfAddress[] = [];
  const seen = new Set<string>();
  for (const concern of concerns) {
    for (const candidate of concern.candidates ?? []) {
      if (typeof candidate !== "string" || candidate === "") continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push({ path: candidate });
      if (out.length >= SF_ARBITER_CANDIDATES_MAX) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Closure (§6 P-4): canAct only when nothing here can block `act.*`
// ---------------------------------------------------------------------------

function computeClosure(
  snapshot: CanonicalSnapshotView,
  explicitTargets: readonly SfAddress[],
): SelectCanonicalNextClosure {
  if (explicitTargets.length > 0) {
    return { canAct: false, reason: "explicit-target-pending" };
  }
  if (!snapshot.allNonAdvisoryClosed) {
    return { canAct: false, reason: "open-required-concern" };
  }
  return { canAct: true, reason: "closed" };
}

// ---------------------------------------------------------------------------
// The arbiter
// ---------------------------------------------------------------------------

/**
 * The single owner of `decision.next` (DC2, §10.0). Fixed four-stage
 * priority: explicit targets > top unsatisfied concern > continuation
 * (fills-only) > batch fold (presentation-only). See the file banner for the
 * full contract and the type duplication rationale.
 */
export function selectCanonicalNext(input: SelectCanonicalNextInput): SelectCanonicalNextResult {
  const {
    explicitTargets,
    concerns,
    snapshot,
    continuation,
    batchFold,
    currentNext = null,
    profileBinding,
    cwd,
    taskHandle,
    qref,
    pathDirectReadWindows,
  } = input;
  const identity: CallIdentity = {
    ...(cwd === undefined ? {} : { cwd }),
    ...(taskHandle === undefined ? {} : { taskHandle }),
    ...(qref === undefined ? {} : { qref }),
  };

  // Gate: an inferred low-confidence profile, or an inactive/absent snapshot
  // (flag off, no workspace, IR unavailable, ...), means SF has no standing
  // to touch `next` at all — untouched pass-through (§3.6.2 / §4.4).
  if (sfObservationOnlyLocal(profileBinding)) return passThrough(currentNext, "observation-only");
  if (snapshot === undefined || !snapshot.active) return passThrough(currentNext, "inactive");

  // Priority 1: caller-named explicit targets always win, never reordered.
  if (explicitTargets.length > 0) {
    const next = buildExplicitNext(explicitTargets, identity);
    const bound = new Set(explicitTargets.map(addressKey));
    return {
      next,
      fills: selectFills(continuation, bound),
      candidates: collectCandidates(concerns),
      rationale: { priority: 1 },
      closure: computeClosure(snapshot, explicitTargets),
    };
  }

  // Priority 2: the top unsatisfied non-advisory concern. Priority 4 (fold)
  // is applied here, last, as a shape transform over the address(es) this
  // step already selected — it never overrides which concern was picked.
  const top = pickTopUnsatisfiedConcern(concerns, snapshot);
  if (top !== undefined) {
    const built = buildConcernNext(top, concerns, snapshot, batchFold, identity, pathDirectReadWindows);
    const bound = new Set(built.usedAddresses.map((path) => addressKey({ path })));
    return {
      next: built.call,
      fills: selectFills(continuation, bound),
      candidates: collectCandidates(concerns),
      rationale: { priority: built.folded ? 4 : 2, concernId: top.id },
      closure: computeClosure(snapshot, explicitTargets),
    };
  }

  // Priority 3: continuation may only fill slack. Priority 4 (fold) has
  // nothing selected to operate on here, so it does nothing either — `next`
  // stays exactly what it already was.
  const fills = selectFills(continuation, boundAddressesOfCall(currentNext));
  return {
    next: currentNext,
    fills,
    candidates: collectCandidates(concerns),
    rationale: fills.length > 0 ? { priority: 3 } : { priority: "none" },
    closure: computeClosure(snapshot, explicitTargets),
  };
}
