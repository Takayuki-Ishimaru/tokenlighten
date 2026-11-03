// ---------------------------------------------------------------------------
// TL_PACK_BODYLESS_DISCOVER (2026-11-03) — a low-confidence FIRST reply ships
// the candidate list, not the bodies.
//
// WHY. A billing analysis of Claude Code sessions (2026-11-03) found cost
// dominated by NEW tokens entering context: cache writes are 42-78% of a
// session's cost, re-reading cached context 3-11%. On a large repository the
// first `tl_read_file` reply sent 29.7 KB of which 18% was used in the answer;
// where the locator guessed wrong (flask, "add a new config key": the first
// reply was the unrelated `docs/conf.py`, with bodies) the agent abandoned TL
// and every body was pure added cost. The same pack under a tight byte cap
// (7.2 KB) already answers with the body-less candidate form `trimToCap` Phase
// E leaves behind — paths, ranges, symbols, handles, `remaining` — at about
// 2.3 KB, and the agent pulls the body it wants with one `targets` read.
//
// THE RULE (every clause must hold; `bodylessDiscoverSkipReason` names the
// first one that does not):
//
//   1. The flag is on (`packBodylessDiscoverEnabled`, default ON; `0`/`off`
//      restores today's pack byte-for-byte).
//   2. The pack answers a wire request that carried a `query` and NAMED NO
//      TARGET: no `path`, no `symbol`, and either no `paths` or paths the
//      server itself derived from the pathless query (`autoDiscoveredLocation`);
//      and the query's own text names no workspace file either
//      (`queryNamedWorkspaceFiles` — "check control/mixer.cpp and mixer.hpp
//      against CONTRACT.md", "Explain what checkLimit does in src/main.ts";
//      the same resolver `augmentQueryNamedFileSurfaces` seeds those files
//      from — passed in as `requestNamesFile`, or a served row whose
//      provenance is `query-named-file`/`caller-supplied`). A file the caller
//      spelled is a stated requirement, not a guess: the locator did not
//      choose it, so its bodies — and the dependency rows that answer the
//      question about it (replay corpus cfi1, rs4, ir0151g) — ride as before.
//      An explicit `targets`/`paths` read is the caller asking for those bytes
//      and is never touched.
//   3. It is the task's FIRST reply: no `taskBinding` (no `task.handle`, no
//      `qref`) and not a qref replay. A `next` cursor or handle continuation
//      keeps its bodies.
//   4. Not `force_serve` ("my context was compacted, send the bodies").
//   5. It is the pack itself, not a receipt (`pack_unchanged`, awaiting-input
//      idempotency, subset receipt) — receipts already carry no fresh body.
//   6. It is a code pack: no `artifact_sections`, not `artifact_build`, not a
//      truncated diff pack (`coverage_reason:"diff-truncated"`). Office, CSV
//      and archive reads are unchanged.
//   7. TL is NOT confident: the decision THE WIRE WOULD CARRY is `discover`
//      AND `coverage === "partial"` (any `coverage_reason`: `candidate-list`,
//      `concerns-uncovered`, `missing-roles`, `index-warming`, or none). The
//      wire decision is `projectTaskDecision` over the canonical verdict
//      (`deriveCanonicalTaskDecision`) and the projected evidence — the same
//      projection `protocol/taskPackSizePreview.ts` runs inside the builder,
//      on a copy — because the wire degrades more than the contract says: a
//      `choose-candidate` await over an answer pack whose candidate set cannot
//      be put on the wire, or an act whose floor is breached, ships as
//      `discover` with a restoring `next` (decisionWire.ts §2.1.1), and that
//      reply is exactly the low-confidence first reply this rule is for
//      (measured: the TokenLighten repository's "How does the CLI decide which
//      workspace files tl-setup writes?" — canonical `await-input`, wire
//      `discover` with an `ambiguous-target` gap). `act.answer`/`act.edit`,
//      `await_input` and `done` on the wire are untouched. A `discover` over
//      focused or complete coverage is a progressing read of a located set and
//      keeps its bodies.
//   8. The `next` that `discover` carries is NOT a paging read of the set the
//      pack already located (`isFixedWindowRead`): a cursor, a handle or
//      handles, or `targets`/`paths` whose every entry names a window — a
//      `range`/`ranges`, a `symbol` or a `handle`. Such a `next` is the
//      server's own page plan over files it has bounded — the structure map's
//      owed member windows, a change frontier's obligations paged behind a
//      cursor, `next[]` sibling pages — and the rows it ships beside it are
//      page one of that plan, not a guess; stripping them re-owes the page
//      and a chain that used to end in `act.answer` ends in `discover`
//      (copilotCompactWorkflow / readCallBatchContinuation / readCallCwdlessNext,
//      2026-11-03). A `next` that re-reads whole candidate files
//      (`targets:[{path}]`, the W9 `paths:[…]` bundle), re-packs the `query`,
//      or searches (`tl_search_files`) is the guess this rule is for.
//   9. (per row) A row the pack's own contract cites as the PROOF of a
//      point-specific obligation keeps its body: `execution_contract.
//      evidence_model.claims[]` with `status:"supported"` and a kind other than
//      the generic `surface-content` (`explicit-identifier`, `behavior-body`,
//      `concern` — the request items —, `change-obligation`, the wiring and
//      artifact kinds), by `evidence_handles`. Such a row is not a guess: the
//      pack has already accepted it as the evidence for a point the request
//      named, its `next` was computed on that footing (the follow-up fetches
//      only the OTHER points), and the autofollowed or agent-driven follow-up
//      then certifies without ever re-fetching it (measured 2026-11-03,
//      concernStatusPolicyMatrix 4 concerns / derived-name: pack 1's
//      `sessionRenewal.ts:2-4` proved request item ri-4; withheld, the chain
//      certified `act.answer` over its one-line anchor and the implementing
//      body never shipped). The same distinction W-DEMOTE draws between a
//      semantic primary and a supporting row. `surface-content` cites every
//      bodied row and so says nothing about which row the request points at;
//      it is ignored. A compacted contract (`contractForTrim`, after an
//      over-cap shed) carries no `evidence_model`, so on such a pack no row is
//      exempt by this clause.
//
// WHAT IT DOES. Every surface that carries a fresh `code` body and is
// addressable (a `handle` and a `"<start>-<end>"` `range`) loses the body:
// `code` and `appended_windows` go, `content_completeness:"partial"` is
// stamped, and `remaining_ranges` becomes the union of its range, its appended
// windows and whatever was already owed — so the wire row is A.8.2 E-8's
// sanctioned body-less shape (`handle` + `path` + `range` + `remaining`, with
// `role`/`symbol`/`why` kept) and `tl_read_file targets:[{handle,range}]`
// fetches the body in one call. `code_unchanged` pointers (`prior` on the
// wire) are not bodies and stay. A surface with no handle or no parseable
// range keeps its body (fail closed: withholding it would leave a bare,
// unreachable row). `anchors_served` goes with the body it described.
// `decision.next` is the contract's, derived independently of bodies, so the
// candidate form keeps its one executable continuation.
//
// WHERE IT RUNS. From `dedupeTrimAndPersist`, right after the last contract
// rebuild (`rebuildFinalExecutionContract`, so the decision read here is the
// one the wire projects) and BEFORE every producer that records what the pack
// served from its BODIED rows: `persistPackFingerprints` (the cross-pack block
// fingerprints `applyPackDedupe` turns into `code_unchanged` pointers, and the
// staged source capsules a later pack restores a body from),
// `recordEpochTaskContract` (the monotone task-contract ledger's served roles,
// concern tokens and definitions), the receipt passes, the SF pre-booking seam
// and the single booking pass (`shippedSurfaces` is body presence). A body
// stripped after any of them would let a later same-epoch pack restate or
// certify over bytes the caller never received (measured 2026-11-03:
// concernStatusPolicyMatrix's 4-concern derived-name cell certified
// `act.answer` without ever serving the renewal concern when this pass still
// ran at the booking seam — hop 2 restated the never-shipped body). Every
// downstream producer therefore reads the pack that ships; a stripped row
// books no fingerprint, no served range, no edit admissibility and no
// certified context, and its handle stays readable. The auxiliary enum
// contexts, which size themselves against the pack's spare capacity, are not
// attached when this pass withheld bodies.
// `applyCanonicalTaskDecision` is re-run afterwards, the same way
// `applySemanticFrontierDemotion` does, so the decision describes what ships.
// Not an SF demotion: rows are NOT marked `SF_WITHHELD_BODY_KEY`, so
// `demoted_count` cannot claim them. THE LATE HALF: at `buildTaskPack`'s
// common exit, `restoreBodylessDiscoverIfConfident` puts every withheld body
// back when a builder's own tail has firmed the reply up to `act.*` or
// `await_input` (see its doc for the measured case and why the ledgers that
// already booked the pack without them stay as they are).
//
// MEASURED (this change, 2026-11-03, a stdio driver over the server from
// source, following `decision.next`; bytes are the reply text):
//   - TokenLighten repository, "Where is TOKENLIGHTEN_TOOL_SURFACE read and
//     what values does it accept?": first reply 25,450 B → 3,935 B (`discover`,
//     partial/index-warming, 11 rows, 20,999 body bytes withheld — three of
//     the files were bench scripts), same `next`; the chain still ends in
//     `act.answer` over server.ts at turn 3; 45,794 B → 33,634 B over three
//     turns (the withheld bodies the agent did need moved to the later reads).
//   - TokenLighten repository, "How does the CLI decide which workspace files
//     tl-setup writes?": first reply 2,825 B → 2,031 B (`discover`,
//     `ambiguous-target`), same `next`; 13,213 B → 12,882 B over two turns.
//   - flask "Explain url_for and what happens on BuildError" (9,011 B,
//     `act.answer`, focused) and express "How does res.redirect('back') handle
//     the 'back' location?" (3,555 B, `act.answer`): byte-identical.
// After this pass, `buildAnswerTaskPack`'s `materializeExplicitAnswerAnchorEvidence`
// (deliberately post-certification) may still fill a body-less row with the
// ONE line that holds an explicitly named identifier (84-196 B on the first
// case), narrowing `remaining` around it — the proof line, not the body.
// See bodylessDiscover.spec.ts.
// ---------------------------------------------------------------------------

import type { TaskExecutionContract } from "@tokenlighten/types";

import { packUnchangedPriorLabel, projectEvidence, projectTaskDecision } from "../../protocol/decisionWire.js";
import { packBodylessDiscoverEnabled } from "../../util/flags.js";
import { trace } from "../../util/trace.js";
import { isArtifactTaskPackSurface } from "./artifactSections.js";
import { applyCanonicalTaskDecision, deriveCanonicalTaskDecision } from "./canonicalDecision.js";
import type { TaskPackArgs, TaskPackResult, TaskPackSurface } from "./model.js";
import { surfaceProvenance } from "./sfWithholdingMarks.js";

/**
 * The `decision.kind` the wire would carry for `result` as it stands: the
 * canonical verdict projected through `projectTaskDecision` over the projected
 * evidence, exactly as `protocol/taskPackSizePreview.ts` does inside the
 * builder. Runs on a JSON copy so the projection's own bookkeeping (go-review
 * relocation marks, SF withholding notes) never touches the pack that ships;
 * `undefined` when the pack carries no contract to decide from.
 *
 * THE COPY CARRIES A `qref` PLACEHOLDER when the pack has none yet. The
 * dispatcher mints `qref` for every query-bearing pack AFTER this seam
 * (server.ts: `rememberTaskPackQuery`, then `recordTaskPackExecution` derives
 * the decision over the pack WITH it), and the W9 read-only candidate bundle
 * (`discoveryBundleNext`) exists only with one — so an answer pack whose
 * candidate set is still `await-input` here ships as `discover` with that
 * bundle as its `next`. Measured: the TokenLighten repository's "How does the
 * CLI decide which workspace files tl-setup writes?" first reply, 2,825 B,
 * `discover` + `ambiguous-target`, three bodied candidate rows, `next` the
 * three-path bundle — invisible to this rule without the placeholder. Only
 * `.kind` is read, never the placeholder's bytes.
 */
export function wireDecision(result: TaskPackResult): { kind: string; next: unknown; gaps?: unknown } | undefined {
  if (result.execution_contract === undefined) return undefined;
  const copy = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  if (typeof copy["qref"] !== "string" || copy["qref"] === "") copy["qref"] = "q-bodyless-preview";
  const contract = copy["execution_contract"] as TaskExecutionContract | undefined;
  const evidence = projectEvidence(copy["surfaces"], packUnchangedPriorLabel(copy));
  const canonical = deriveCanonicalTaskDecision(copy as unknown as TaskPackResult);
  const decision = projectTaskDecision({ result: copy, contract, canonicalKind: canonical?.kind, evidence });
  if (decision === undefined) return undefined;
  const wire = decision as unknown as Record<string, unknown>;
  return { kind: decision.kind, next: wire["next"], ...(wire["gaps"] !== undefined ? { gaps: wire["gaps"] } : {}) };
}

/** `wireDecision(result)?.kind`, for callers that only ask which kind the wire would carry. */
export function wireDecisionKind(result: TaskPackResult): string | undefined {
  return wireDecision(result)?.kind;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** True when `entry` names a bounded window of a known file rather than a whole file. */
function namesWindow(entry: unknown): boolean {
  const record = asRecord(entry);
  if (record === undefined) return false;
  return typeof record["handle"] === "string"
    || typeof record["range"] === "string"
    || (Array.isArray(record["ranges"]) && record["ranges"].length > 0)
    || typeof record["symbol"] === "string";
}

/**
 * Clause 8: is `next` (one call or a `next[]` list) a paging read of windows
 * the pack already located — a cursor, a handle or handles, or targets that
 * every one name a window? A whole-file re-read, a query re-pack or a search
 * is not; neither is an empty list.
 */
export function isFixedWindowRead(next: unknown): boolean {
  if (Array.isArray(next)) return next.length > 0 && next.every(isFixedWindowRead);
  const call = asRecord(next);
  if (call === undefined || call["tool"] !== "tl_read_file") return false;
  const args = asRecord(call["arguments"]);
  if (args === undefined) return false;
  if (typeof args["cursor"] === "string") return true;
  if (typeof args["handle"] === "string") return true;
  if (Array.isArray(args["handles"]) && args["handles"].length > 0) return true;
  for (const key of ["targets", "paths"]) {
    const list = args[key];
    if (Array.isArray(list) && list.length > 0) return list.every(namesWindow);
  }
  return typeof args["path"] === "string" && namesWindow(args);
}

/** The one env switch; see the module header. */
export const BODYLESS_DISCOVER_FLAG = "TL_PACK_BODYLESS_DISCOVER";

export interface BodylessDiscoverContext {
  /** The request the pack answers, as `dedupeTrimAndPersist` received it. */
  readonly args: TaskPackArgs | undefined;
  /** True when the pack going out is a receipt (`pack_unchanged`, idempotency, subset), not the built pack. */
  readonly receipt: boolean;
  /**
   * Clause 2's prose half: does the query's own text name a workspace file
   * (`queryNamedWorkspaceFiles`)? A thunk, so the resolver's walk is paid only
   * once every cheaper clause has held. Absent (a direct builder caller), only
   * the served rows' provenance answers it.
   */
  readonly requestNamesFile?: () => boolean;
  /**
   * 2026-11-03: the spans the request's own anchors resolved to
   * (anchorFirst.ts `recallAnchorResolution`: the declaration of a name it
   * spells, the exact occurrence of a literal it quotes or brackets). A row
   * that overlaps one keeps its body: the server did not guess it, the request
   * pointed at it (`[default: (unlimited)]` in tests/test_options.py). A thunk,
   * read only once the rule applies.
   */
  readonly anchoredSpans?: () => ReadonlyArray<{ readonly path: string; readonly startLine: number; readonly endLine: number }>;
  /**
   * 2026-11-03: true when the server would follow this pack's `discover` in
   * the same call (server.ts `autofollowSkipReason`: TL_EFF_AUTOFOLLOW on and
   * no byte ceiling). A `next` that re-issues the request is then not a turn
   * the agent pays for: the follow-up merges into this reply, so withholding
   * the bodies here only leaves the merged reply without them
   * (evaluation0929.compoundTopicPoints' mixed-kind control). Absent: false.
   */
  readonly autofollowPossible?: boolean;
}

/** True when `decision` is the shape `autofollowSkipReason` follows: one tl_read_file `next` re-issuing the request's own query, no new epoch, no ambiguous target, no plan. */
function reissuesRequest(decision: { next: unknown; gaps?: unknown }, args: TaskPackArgs, result: TaskPackResult): boolean {
  const call = asRecord(decision.next);
  const callArgs = asRecord(call?.["arguments"]);
  if (call?.["tool"] !== "tl_read_file" || callArgs === undefined) return false;
  if (typeof args.query !== "string" || callArgs["query"] !== args.query) return false;
  if (asRecord(callArgs["task"])?.["epoch"] !== undefined) return false;
  if (Array.isArray(decision.gaps) && decision.gaps.some((gap) => asRecord(gap)?.["code"] === "ambiguous-target")) return false;
  return (result as unknown as Record<string, unknown>)["plan"] === undefined;
}

/** True when `surface`'s window overlaps one of `spans` in its file. */
function overlapsAnchoredSpan(
  surface: TaskPackSurface,
  spans: ReadonlyArray<{ readonly path: string; readonly startLine: number; readonly endLine: number }>,
): boolean {
  const own = parseLineSpan(surface.range);
  if (own === undefined) return false;
  return spans.some((span) => span.path === surface.path && span.startLine <= own[1] && span.endLine >= own[0]);
}

/**
 * Clause 9: the handles the pack's contract cites as the proof of a
 * point-specific obligation — a supported `evidence_model` claim of any kind but
 * the generic `surface-content`. Empty when the contract carries no model (a
 * compacted contract) or nothing is proved.
 */
export function provedClaimHandles(result: TaskPackResult): ReadonlySet<string> {
  const handles = new Set<string>();
  const model = result.execution_contract?.evidence_model;
  if (model === undefined || !Array.isArray(model.claims)) return handles;
  for (const claim of model.claims) {
    if (claim === null || typeof claim !== "object") continue;
    if (claim.status !== "supported" || claim.kind === "surface-content") continue;
    for (const handle of claim.evidence_handles ?? []) {
      if (typeof handle === "string" && handle !== "") handles.add(handle);
    }
  }
  return handles;
}

/** The two `why` segments that say the CALLER spelled this row's path (segment-exact, as `callerNamedSurface` reads them). */
const CALLER_NAMED_SEGMENTS: ReadonlySet<string> = new Set(["query-named-file", "caller-supplied"]);

/** True when some served code row's provenance says the caller named its file. */
function servesCallerNamedRow(result: TaskPackResult): boolean {
  if (!Array.isArray(result.surfaces)) return false;
  for (const surface of result.surfaces) {
    if (surface === null || typeof surface !== "object" || isArtifactTaskPackSurface(surface)) continue;
    const why = surfaceProvenance(surface);
    if (why === undefined) continue;
    if (why.split(";").some((segment) => CALLER_NAMED_SEGMENTS.has(segment.trim()))) return true;
  }
  return false;
}

/**
 * Why `applyBodylessDiscover` leaves `result` alone, or `undefined` when every
 * clause of the rule holds. Exported so a spec can assert the exact clause.
 */
export function bodylessDiscoverSkipReason(
  result: TaskPackResult,
  context: BodylessDiscoverContext,
): string | undefined {
  if (!packBodylessDiscoverEnabled()) return "flag-off";
  const args = context.args;
  if (args === undefined) return "no-request-args";
  if (typeof args.query !== "string" || args.query.trim() === "") return "no-query";
  if (args.path !== undefined || args.symbol !== undefined) return "explicit-target";
  if ((args.paths?.length ?? 0) > 0 && args.autoDiscoveredLocation !== true) return "explicit-target";
  if (servesCallerNamedRow(result)) return "explicit-target";
  if (args.taskBinding !== undefined || args.taskQueryRefReplay === true) return "continuation";
  if (args.forceServe === true) return "force-serve";
  if (context.receipt) return "receipt";
  if ((result.artifact_sections?.length ?? 0) > 0 || result.task_profile === "artifact_build") return "artifact-pack";
  if (result.coverage_reason === "diff-truncated") return "diff-pack";
  if (result.coverage !== "partial") return "coverage-not-partial";
  // The prose half of clause 2, after every cheaper clause: the resolver walks.
  if (context.requestNamesFile?.() === true) return "explicit-target";
  const decision = wireDecision(result);
  if (decision?.kind !== "discover") return "decision-not-discover";
  if (isFixedWindowRead(decision.next)) return "paging-continuation";
  if (context.autofollowPossible === true && reissuesRequest(decision, args, result)) return "autofollow";
  return undefined;
}

/** `"<start>-<end>"` → `[start, end]`; `undefined` for anything else. */
function parseLineSpan(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/** The union of `spans` over touching/overlapping neighbours, as `"<start>-<end>"` strings. */
function mergeLineSpans(spans: readonly [number, number][]): string[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
      continue;
    }
    out.push([start, end]);
  }
  return out.map(([start, end]) => `${start}-${end}`);
}

/**
 * What `withholdBody` took off a surface, kept so `restoreBodylessDiscoverIfConfident`
 * can put it back byte-for-byte. Weakly keyed on the surface object itself, so
 * a pack that is garbage-collected takes its stash with it (no reset needed).
 */
interface WithheldBody {
  readonly code: string;
  readonly appended_windows: TaskPackSurface["appended_windows"];
  readonly anchors_served: TaskPackSurface["anchors_served"];
  readonly content_completeness: TaskPackSurface["content_completeness"];
  readonly remaining_ranges: TaskPackSurface["remaining_ranges"];
}

const withheldBodies = new WeakMap<object, WithheldBody>();

/**
 * Withhold the body of one addressable surface, leaving the row reachable.
 * Returns false (and changes nothing) when the surface has no fresh body or
 * no window to re-fetch it by.
 */
function withholdBody(surface: TaskPackSurface): boolean {
  if (typeof surface.code !== "string" || surface.code === "") return false;
  if (typeof surface.handle !== "string" || surface.handle === "") return false;
  const spans: [number, number][] = [];
  const own = parseLineSpan(surface.range);
  if (own === undefined) return false;
  spans.push(own);
  for (const entry of surface.remaining_ranges ?? []) {
    const span = parseLineSpan(entry);
    if (span !== undefined) spans.push(span);
  }
  for (const window of surface.appended_windows ?? []) {
    const span = parseLineSpan(window.range);
    if (span !== undefined) spans.push(span);
  }
  withheldBodies.set(surface, {
    code: surface.code,
    appended_windows: surface.appended_windows,
    anchors_served: surface.anchors_served,
    content_completeness: surface.content_completeness,
    remaining_ranges: surface.remaining_ranges,
  });
  delete surface.code;
  delete surface.appended_windows;
  delete surface.anchors_served;
  surface.content_completeness = "partial";
  surface.remaining_ranges = mergeLineSpans(spans);
  return true;
}

/** True when `applyBodylessDiscover` withheld this surface's body and nothing has restored it since. */
export function isBodylessDiscoverWithheld(surface: object): boolean {
  return withheldBodies.has(surface);
}

/**
 * THE LATE HALF OF THE RULE (2026-11-03). `applyBodylessDiscover` runs early —
 * before every producer that records what the pack served (fingerprints, the
 * epoch task contract, the booking pass), which is what keeps those ledgers
 * honest — but the builders' own tails still run after it, and one of them
 * can firm the decision up: `buildAnswerTaskPack`'s post-certification
 * `materializeExplicitAnswerAnchorEvidence` adds the one line that names an
 * identifier, and the pack re-certifies `act.answer`. Measured
 * (concernStatusPolicyMatrix, 4 concerns / derived-name): hop 0 shipped
 * `act.answer` over `coverage:"complete"` with the renewal module's body
 * withheld and only its one-line anchor served — an answer missing the very
 * body it certified over. An `act.*` or `await_input` reply must carry the
 * bodies it certifies over (§2.1.1's floors; the choose-candidate bodies).
 *
 * So, at `buildTaskPack`'s common exit, if the decision the wire would carry
 * is no longer `discover`, every body this rule withheld goes back exactly as
 * it was (code, appended windows, anchor flag, completeness, remaining), and
 * the decision is restated. The ledgers that already recorded the pack
 * without those bodies stay as they are: they now UNDER-claim (the bytes ship
 * but are booked as unserved), which is the safe direction — a later pack
 * re-serves rather than restates them, never the reverse. Returns the number
 * of bodies restored; 0 when nothing was withheld or the reply is still a
 * `discover`.
 */
export function restoreBodylessDiscoverIfConfident(result: TaskPackResult, workspace: string): number {
  if (!Array.isArray(result.surfaces)) return 0;
  const withheld = result.surfaces.filter((surface): surface is TaskPackSurface =>
    surface !== null && typeof surface === "object" && withheldBodies.has(surface));
  if (withheld.length === 0) return 0;
  const decision = wireDecision(result);
  if (decision?.kind === "discover") return 0;
  for (const surface of withheld) {
    const stash = withheldBodies.get(surface)!;
    withheldBodies.delete(surface);
    surface.code = stash.code;
    if (stash.appended_windows === undefined) delete surface.appended_windows;
    else surface.appended_windows = stash.appended_windows;
    if (stash.anchors_served === undefined) delete surface.anchors_served;
    else surface.anchors_served = stash.anchors_served;
    if (stash.content_completeness === undefined) delete surface.content_completeness;
    else surface.content_completeness = stash.content_completeness;
    if (stash.remaining_ranges === undefined) delete surface.remaining_ranges;
    else surface.remaining_ranges = stash.remaining_ranges;
  }
  applyCanonicalTaskDecision(result);
  try {
    trace("bodyless_discover_restored", {
      restored: withheld.length,
      decision: decision?.kind ?? null,
      refs: withheld.map((surface) => surface.handle),
    }, workspace);
  } catch {
    /* the trace channel is best-effort */
  }
  return withheld.length;
}

/**
 * Apply the rule in the module header to the pack that is about to ship.
 * Returns the number of bodies withheld (0 when any clause fails).
 */
export function applyBodylessDiscover(
  result: TaskPackResult,
  context: BodylessDiscoverContext,
  workspace: string,
): number {
  const skip = bodylessDiscoverSkipReason(result, context);
  if (skip !== undefined) return 0;
  if (!Array.isArray(result.surfaces)) return 0;
  let withheld = 0;
  let kept = 0;
  const refs: string[] = [];
  const anchored = context.anchoredSpans?.() ?? [];
  // Clause 9: the rows the contract has already accepted as proof.
  const proved = provedClaimHandles(result);
  for (const surface of result.surfaces) {
    if (surface === null || typeof surface !== "object") continue;
    if (isArtifactTaskPackSurface(surface)) continue;
    if (typeof surface.code !== "string" || surface.code === "") continue;
    if (overlapsAnchoredSpan(surface, anchored) || proved.has(surface.handle)) {
      kept += 1;
      continue;
    }
    if (withholdBody(surface)) {
      withheld += 1;
      refs.push(surface.handle);
    } else {
      kept += 1;
    }
  }
  if (withheld === 0) return 0;
  // The decision was derived against a pack that still carried these bodies.
  // `applyCanonicalTaskDecision` re-derives rather than accumulates, so one
  // more pass restates it over what this response actually sends.
  applyCanonicalTaskDecision(result);
  try {
    trace("bodyless_discover", {
      withheld,
      kept_unaddressable: kept,
      coverage_reason: result.coverage_reason ?? null,
      refs,
    }, workspace);
  } catch {
    /* the trace channel is best-effort */
  }
  return withheld;
}
