// ---------------------------------------------------------------------------
// protocol v1 — the envelope spine (C2-2).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §1.2 (the three
// announcement points), §2.5 (the `ok`/`isError` resolution), §3.2/D4 (the
// fifteen-member `kind` vocabulary), and §10.3 Appendix A (Revision 4,
// user-approved 2026-08-13) A.1.1 / A.5 / A.8.
//
// WHAT THIS MODULE IS. Every response the three advertised tools emit leaves
// through ONE funnel (`server.ts`'s `callToolUninstrumented`). This module is
// the finalizer that funnel runs: it decides the response's `Kind`, deletes the
// body `ok` boolean (D6), normalises a refusal into the one `Refusal` shape
// (§2.6), and stamps `"v":1` + `kind` as the first two keys of the payload.
//
// WHY A FUNNEL AND NOT 287 CALL SITES. D1 requires `v` on EVERY response and D4
// requires `kind` on every response. `server.ts` alone has 97 `toolOk`, 120
// `toolStructuredError` and 70 `toolError` sites; a per-site stamp is 287
// opportunities to omit the envelope, and §1.2 is explicit that "a payload
// without `v` is not a protocol-v1 payload". One finalizer makes the envelope
// unconditional by construction, which is the same argument §2.5 makes for
// deleting `ok` rather than enforcing a biconditional between two fields.
//
// HOW AN EMITTER DECLARES ITS KIND. Three levels, most specific first:
//   1. `declareKind(kind)` — the emitter names its member outright. Use this
//      when the mode/action alone cannot decide (family migrations in
//      C2-3/C2-4/C2-5 will use it directly).
//   2. `noteResolvedMode(mode)` / `noteResolvedAction(action)` — the dispatcher
//      publishes the mode/action it ACTUALLY resolved, after its `auto`
//      promotions. `kindForCall` maps it per A.3/A.5.
//   3. Fallback — the request's own `mode`/`action` argument.
// All three ride an `AsyncLocalStorage` slot bound once per call, so concurrent
// calls on one server process cannot cross-contaminate (the same mechanism
// `state/session.ts`'s lane binding and `util/handles.ts`'s declared-workspace
// binding already use).
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";
import { posix as posixPath } from "node:path";
import type { Evidence, Kind, ToolCall, ToolName, ToolSurface } from "@tokenlighten/types";
// DESIGN-v0.15 §8.2 (R7 Part B, this wave's own R7 residual close-out — see
// DESIGN-v0.15-exploration-continuation-wave0-ledger.md §7.2's wiring-table row
// 5): `canonicalToolCall` is the ONE place every emitted `next`/`next_call`
// (success or refusal, `emittableToolCall`-routed or not) funnels through —
// see this file's own `canonicalizeEmittedToolCalls` and `refusal.ts`'s
// `emittableToolCall`, both of which call it directly. Making IT surface-aware
// is therefore sufficient to keep a `code`-surface connection's minted
// continuations inside its own advertised capability, with no second filter
// site to keep in sync. `isSupportedArchivePath` is a leaf format utility
// (no dependency on this module or on `server.ts`), so importing it here adds
// no cycle — `server.ts` is what imports FROM `envelope.ts`, never the reverse.
import { isSupportedArchivePath } from "../tools/archive.js";

import {
  buildRefusal,
  containsPlaceholderForCall,
  isRefusalBody,
  parseProseToolCall,
} from "./refusal.js";
import {
  carryDisclosures,
  SUCCESS_DISCLOSURE_KEYS,
  SUCCESS_DISCLOSURE_POLICY,
} from "./disclosure.js";
import { emitFinalizedPayload, emitOpaqueText } from "./emit.js";
import { isEditFamilyKind, projectEditBody } from "./editFamily.js";
import { isReadFamilyKind, projectReadBody, receiptOf } from "./readFamily.js";
import {
  applySearchDedup,
  isSearchFamilyKind,
  projectSearchBody,
  searchRefusalBody,
  searchRefusalCodeFor,
} from "./searchFamily.js";
import { bindLedgerCertificate, bindLedgerCertificateFromScope, ledgerCertificateBinding } from "./ledgerCertificateBinding.js";
import { isAdvertisedToolName } from "./advertisedTools.js";
import {
  finalizeSemanticFrontierAttestation,
  semanticFrontierPathId,
  type SemanticFrontierWireObservation,
} from "../features/task-pack/semanticFrontier.js";
import { isTraceEnabled, responseWitnessHmac, trace, traceBounded } from "../util/trace.js";
// FX-W3 (ruling (aa), 2026-09-04): `servedWindowsOf` no longer re-derives file
// spans by re-parsing a served body for marker-shaped lines at all — see its
// own doc comment. `sentinelComment.ts`'s detector (below) is the one text
// classifier this module still consults, and only to recognise TL's own
// synthetic renderings (skeleton/scope views), never to widen anything.
import { isTokenlightenSentinelLine } from "../util/sentinelComment.js";
import {
  runWithSemanticFrontierTrace,
  semanticFrontierDecisionWitnessId,
  semanticFrontierEvidenceWitnessId,
  takeSemanticFrontierTraceState,
} from "./semanticFrontierTraceContext.js";
import type { SemanticFrontierWithholdingMarks } from "./semanticFrontierTraceContext.js";
// W-DEMOTE follow-up (§6 P-2): the pure counters function this trace wires
// in below; decisionWire.ts's own doc comment on it says this is the file
// meant to call it, unchanged.
import { semanticFrontierDemotionCounters } from "./decisionWire.js";
import { batchHintsEnabled, sfDemoteEnabled } from "../util/flags.js";

/** §1.1, D1. One integer, one value, one server process. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * §1.2 point 2/3: the `_meta` key the `initialize` result and the `tools/list`
 * `read_file` definition both carry. Namespaced so a multi-server host can tell
 * whose protocol version it is reading (the same argument §1.2 makes for
 * `read.task_pack` over a bare `task_pack`).
 */
export const PROTOCOL_META_KEY = "tokenlighten/protocol" as const;

/** The `_meta` fragment both announcement points embed verbatim. */
export const PROTOCOL_META: Readonly<Record<string, number>> = Object.freeze({
  [PROTOCOL_META_KEY]: PROTOCOL_VERSION,
});

// ---------------------------------------------------------------------------
// The per-call kind channel
// ---------------------------------------------------------------------------

export interface ProtocolCallContext {
  /** Canonical advertised tool this call dispatched to. */
  readonly tool: string;
  /**
   * The INBOUND arguments of this call, as received.
   *
   * Read by the family projectors to SYNTHESISE a continuation (`limit.next`)
   * that echoes what the caller actually asked for. A rendered body is not a
   * substitute: `find`'s `query` renders a `queries:["a","b"]` call as
   * `"a OR b"`, and sending that back as a single `query` would prescribe a
   * different search — the class TC-2 exists to catch and §2.1.2 to forbid.
   */
  readonly args?: Readonly<Record<string, unknown>>;
  /** The read_file mode the dispatcher actually resolved (post-`auto` promotion). */
  mode?: string;
  /** The search_files action the dispatcher actually resolved. */
  action?: string;
  /** An outright declaration; wins over mode/action derivation. */
  kind?: Kind;
  /**
   * The workspace root this call RESOLVED against, published by the edit
   * dispatcher (C2-5).
   *
   * Read by `editFamily.ts` to mint `SideEffectCore.workspace` — the §4.2.1(3)
   * marker that binds a side-effect report to the tree it describes. It rides
   * the context rather than the body because the body must not gain a field
   * whose only purpose is to be deleted again, and `util/handles.ts`'s
   * `declaredWorkspace()` cannot serve: its scope closes with `dispatchTool`,
   * one frame before the finalizer runs.
   */
  workspace?: string;
  /**
   * D1 (F-C2a): the workspace root read_file/search_files dispatch resolved
   * against, published ONLY for protocol/codec/pipeline.ts's trace
   * emissions (`wire_codec_shadow`/`wire_codec_v2_cell`) -- DELIBERATELY
   * SEPARATE from `workspace` above.
   *
   * `workspace` cannot be reused for this: it is read by `emit.ts`'s
   * served-range-ledger settling (`settleServedRanges`) AND by
   * `readFamily.ts`'s `projectReadBody` (via the `workspace` this module
   * passes it at line ~672) to decide whether a `read.receipt`'s
   * continuation echoes `cwd` — both WIRE-AFFECTING, and both previously
   * saw `undefined` on every read_file/search_files call because nothing
   * but edit_file's finishEdit ever populated `workspace`. Populating
   * `workspace` itself for read/search (an earlier version of this fix)
   * changed a `read.receipt`'s `next.arguments` shape and broke
   * wireBaselines.spec.ts's pinned bytes — exactly the regression D1's own
   * "ZERO wire-byte change" requirement forbids. This field was read by
   * NOTHING except pipeline.ts until the disclosed exception immediately
   * below.
   *
   * DISCLOSED SECOND READER (TL_SEARCH_DEDUP, W-T-D wave, default OFF):
   * `projectSuccessBody`'s search-family branch also reads this field, to
   * give `searchFamily.ts`'s `applySearchDedup` the workspace root it needs
   * to key the per-task dedup ledger — the ONLY workspace root a read/search
   * call publishes into this context by the time the funnel runs.  This does
   * NOT repeat the read.receipt regression above: `applySearchDedup` is the
   * identity function whenever `searchDedupEnabled()` is false (the shipped
   * default), so the search-family wire stays byte-identical with the flag
   * off, and `read.*` responses never call it at all — only the two
   * search-family kinds this field already exists for are affected, and only
   * behind the flag.
   *
   * INTERNAL AND NON-WIRE for every OTHER purpose, same posture as
   * `emittedBytes` below.
   */
  codecTraceWorkspace?: string;
  /**
   * VF-5/VF-7 hand-off: the workspace root a `read_file` call resolved
   * against, published ONLY for `protocol/readFamily.ts`'s verify-first
   * closure gate (`verifyClosureGate`'s kit-less session-obligation
   * fallback, and `receiptOf`'s `closure-complete` withhold check) -- a
   * THIRD, dedicated slot, deliberately separate from both `workspace`
   * (edit-only; reusing it for read/search broke wireBaselines.spec.ts's
   * pinned bytes, per `codecTraceWorkspace`'s own doc comment above) and
   * `codecTraceWorkspace` (trace-only; read by nothing wire-affecting).
   * Read by nothing else, so populating it changes no wire byte on any
   * path that does not also flip TL_SF_VERIFY_FIRST on.
   */
  verifyClosureWorkspace?: string;
  /**
   * FX-N (ruling (s), 2026-09-03): the workspace root a `read_file` /
   * `search_files` call resolved against, published so `emit.ts`'s [R5-10]
   * settlement runs for the READ family too.
   *
   * A FOURTH dedicated slot, for the same reason `verifyClosureWorkspace` and
   * `codecTraceWorkspace` are their own: `workspace` is EDIT-only (see
   * `noteWorkspaceRoot`'s doc comment) and is read by `readFamily.ts`'s
   * `projectReadBody` to decide whether a `read.receipt`'s continuation echoes
   * `cwd` -- populating it on a read moves pinned wire bytes
   * (wireBaselines.spec.ts). This slot is read by exactly ONE consumer,
   * `emit.ts`'s ledger half, so setting it changes no wire byte on any path.
   *
   * WHY IT MUST EXIST. Before FX-N the retraction half of [R5-10] was
   * unreachable for reads: `settleServedRanges` ran only under
   * `context.workspace`, so a `read_file` that booked a provisional serve span
   * and then shed to `refusal/cap-exceeded` left that span standing, and the
   * next slice of the same file answered `read.receipt{code-unchanged}` naming
   * the REFUSAL as the serving call (round-16 finding 1a, `r16_y`). It also
   * left the union/residency writes that ride the same booking standing, which
   * granted `edit_file` write authority over a file no byte of which had ever
   * been sent (1b) and laundered an FX-L `withheld` address to `shipped` (1c).
   */
  readServeWorkspace?: string;
  /**
   * FX-O1 (ruling (t), 2026-09-03): the workspace-relative FILE PATH a serve
   * site staged bytes for, published by the staging sites whose wire payload
   * carries no `path` of its own.
   *
   * WHY IT EXISTS. `servedWindowsOf` attributes a served body to a file by the
   * `path` it finds in scope on the payload. Two production serve shapes carry
   * a body with no `path` anywhere above it — `mode=symbol`'s assembled scope
   * view (`{...symbolData, code, handle, sha}`) and `mode=auto`'s small-content
   * serve (`{content, language, handle, sha}`) — so both projected to
   * `unattributed: true`, and the settlement's `unattributed` arm FAILED OPEN:
   * it promoted every pending staged path, including a residue left behind by
   * an earlier call that threw before reaching the funnel (round-17 finding 2).
   * Ruling (t) makes that arm fail CLOSED, which would have retracted those two
   * shapes' own honest bookings — so the staging sites now name the path they
   * staged for, on the call's own context, and the projector attributes the
   * pathless body to it. `unattributed` is then unreachable for a shipped body.
   *
   * AMBIGUITY IS A NON-ANSWER. A call that stages for two different paths sets
   * this to `""`, which `emit.ts` reads as "no attribution" — a pathless body
   * in a multi-path response cannot be assigned to one of them, and guessing
   * would book bytes against a file the wire never named. Non-wire, like the
   * four workspace slots above: read by exactly one consumer, the funnel.
   */
  serveAttributionPath?: string;
  /** Resolved workspace root inherited by executable continuations. */
  continuationWorkspace?: string;
  /** Opaque task identity minted while projecting this response. */
  continuationTaskHandle?: string;
  /**
   * P3a S1: body bytes this call's response measured at the ONE emission point
   * (`budget/measure.ts`, via `emit.ts`). Written by `noteEmission`, once, on
   * every funnel exit that carries a text body — including the three opaque
   * early returns, which is what makes "every response is measured" a property
   * rather than a claim about the paths someone remembered.
   *
   * INTERNAL AND NON-WIRE. It rides the per-call `AsyncLocalStorage` slot, so
   * it is per-call state (not process-global) and cannot cross-contaminate
   * concurrent calls; no projector reads it and no payload carries it. S4's
   * reserve assertion and S6's fence attach to it.
   */
  emittedBytes?: number;
  /** B-6 internal novelty result from the shared served-bytes ledger. */
  servedBytesNovel?: boolean;
  /** Producer provenance for a served-bytes ledger entry; never serialized. */
  servedBytesSource?: import("../util/packServeLog.js").ServedBytesLedgerEntry["source"];
  /**
   * V11-07: the resolved MCP client id, when reachable at codec time (see
   * protocol/codec/clientProfile.ts's module header). `undefined` on every
   * call today -- nothing sets it yet; `resolveClientProfile` treats that
   * as the conservative "unknown" fallback.
   */
  clientId?: string;
  /**
   * I-7 (2026-08-30 forensics attribution wave): set by read_file/
   * search_files dispatch (server.ts, both `guardExecutionDiscovery` call
   * sites) when the session's execution fence was ALREADY `phase:"prepared"`
   * the moment THIS call arrived -- i.e. discretionary agent spend after an
   * answer/edit certificate, not evidence the certificate required. The T03
   * forensics episode this exists for (bench/workflows/experiments/
   * 2026-08-30-v0131-forensics/REPORT.md's I-1 section) found exactly this
   * class of spend invisible in TL_TRACE: "rep0 ended with a 16,156-byte
   * forced slice, and rep2 added two searches, one refusal, and a
   * 20,546-byte slice" had to be hand-reconstructed from raw transcripts.
   *
   * Read only by emit.ts's `post_ready_followup` trace emission at the
   * funnel tail, alongside the FINAL `onWire` kind and `used` byte count --
   * both unknowable this early, which is why this rides the context instead
   * of being traced directly at the guard call site. `edit_file` never sets
   * it (guardExecutionEdit is a separate typestate-observed path), so the
   * emission site's `!== undefined` check alone excludes edits with no
   * special-casing. Never serialized onto the wire.
   */
  postReadyDiscovery?: {
    readonly forceServe: boolean;
    readonly scopeClass: "handle" | "path" | "query" | "none";
  };
  /**
   * W-BATCH-HINT candidate 3 (TL_BATCH_HINTS, default OFF): set by read_file/
   * search_files dispatch (server.ts, both `guardExecutionDiscovery` call
   * sites) from `recordReadFamilySingleTargetCall`'s (state/session.ts)
   * return value — true iff THIS call is single-target AND it brought the
   * session's consecutive-single-target-read-family-call streak to
   * SERIAL_SINGLE_TARGET_HINT_THRESHOLD or beyond. `undefined`/`false` for
   * every multi-target call, every edit_file call (which never sets this at
   * all), and every call made before the flag turned this tracking on.
   * Consumed once, at the funnel tail, by `applySerialSingleTargetHint` —
   * which additionally gates on `kind` so the hint never rides an
   * `edit_file`/refusal/receipt-shaped response even if this happened to be
   * true for one (it structurally cannot be, since edit_file never sets it,
   * but the kind gate is the honest, non-coincidental reason). Never
   * serialized onto the wire itself.
   */
  serialSingleTargetHint?: boolean;
}

const _protocolCall = new AsyncLocalStorage<ProtocolCallContext>();

export function runWithProtocolCall<T>(context: ProtocolCallContext, fn: () => T): T {
  return _protocolCall.run(context, () => runWithSemanticFrontierTrace(fn));
}

export function protocolCallContext(): ProtocolCallContext | undefined {
  return _protocolCall.getStore();
}

/** Publish an internal source for the served-bytes ledger at the final funnel. */
export function noteServedBytesSource(
  source: ProtocolCallContext["servedBytesSource"],
): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && source !== undefined) context.servedBytesSource = source;
}

/** Publish the read_file mode this dispatch resolved to (after `auto` promotion). */
export function noteResolvedMode(mode: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && mode !== "") context.mode = mode;
}

/** Publish the search_files action this dispatch resolved to. */
export function noteResolvedAction(action: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && action !== "") context.action = action;
}

/**
 * Publish that this read/search call arrived while the session's execution
 * fence was already prepared -- see `ProtocolCallContext.postReadyDiscovery`'s
 * doc comment for why this rides the context rather than tracing directly at
 * the call site.
 */
export function notePostReadyDiscovery(fields: {
  forceServe: boolean;
  scopeClass: "handle" | "path" | "query" | "none";
}): void {
  const context = _protocolCall.getStore();
  if (context !== undefined) context.postReadyDiscovery = fields;
}

/** Publish whether TL_BATCH_HINTS's serial-single-target-read-family-call streak fired on THIS call — see `ProtocolCallContext.serialSingleTargetHint`'s own doc comment. */
export function noteSerialSingleTargetHint(fires: boolean): void {
  const context = _protocolCall.getStore();
  if (context !== undefined) context.serialSingleTargetHint = fires;
}

/** Name this response's `Kind` outright. Wins over every derivation below. */
export function declareKind(kind: Kind): void {
  const context = _protocolCall.getStore();
  if (context !== undefined) context.kind = kind;
}

/**
 * Publish the workspace root this call resolved against (C2-5).
 *
 * Called by the edit dispatch, as late as it can be: `workspace` is a `let`
 * there — a handle may make the call ADOPT its own mint root — so a note taken
 * at binding time could name a tree the write never touched, and the marker
 * would bind the report to the wrong state.
 */
export function noteWorkspaceRoot(root: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && root !== "") context.workspace = root;
}

/** VF-5/VF-7: publish `ProtocolCallContext.verifyClosureWorkspace` (see its own doc comment). */
export function noteVerifyClosureWorkspace(root: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && root !== "") context.verifyClosureWorkspace = root;
}

/**
 * FX-N (ruling (s)): publish `ProtocolCallContext.readServeWorkspace` -- the
 * root a read/search dispatch resolved against, consumed ONLY by `emit.ts`'s
 * [R5-10] settlement. See that field's own doc comment for why this is a
 * dedicated slot rather than a second writer of `noteWorkspaceRoot`'s
 * edit-only `workspace`.
 */
export function noteReadServeWorkspace(root: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && root !== "") context.readServeWorkspace = root;
}

/**
 * FX-O1 (ruling (t)): name the file a serve site just STAGED bytes for, so a
 * payload that carries the body without a `path` is still attributable.
 *
 * Called from the raw-read staging sites, beside their `recordServedRange`
 * loop. Monotone toward "ambiguous": the first path wins, a SECOND, different
 * path collapses the slot to `""` and the funnel then attributes nothing —
 * see `ProtocolCallContext.serveAttributionPath`'s doc comment. Calling it
 * from a site whose payload DOES name its path is harmless and deliberate:
 * the attribution is consulted only where the walk found no `path` at all.
 */
export function noteServeAttribution(filePath: string): void {
  const context = _protocolCall.getStore();
  if (context === undefined || filePath === "") return;
  if (context.serveAttributionPath === undefined) {
    context.serveAttributionPath = filePath;
    return;
  }
  if (context.serveAttributionPath !== filePath) context.serveAttributionPath = "";
}

/**
 * D1 (F-C2a): publish the workspace root read_file/search_files dispatch
 * resolved against, for protocol/codec/pipeline.ts's trace emissions ONLY.
 * See `ProtocolCallContext.codecTraceWorkspace`'s own doc comment for why
 * this is a dedicated field/setter rather than reusing `noteWorkspaceRoot`
 * above -- `workspace` is read by wire-affecting projectors this one must
 * never touch.
 */
export function noteCodecTraceWorkspace(root: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && root !== "") context.codecTraceWorkspace = root;
}

/** Publish the resolver-approved workspace inherited by wire continuations. */
export function noteContinuationWorkspace(root: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && root !== "") context.continuationWorkspace = root;
}

/** Publish the opaque task handle minted for continuations in this response. */
export function noteContinuationTaskHandle(handle: string): void {
  const context = _protocolCall.getStore();
  if (context !== undefined && handle !== "") context.continuationTaskHandle = handle;
}

function semanticTraceRecordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * W-DEMOTE follow-up (§6 P-2), TL_SF_DEMOTE only. `exemptPaths` is derived
 * from this SAME observed wire array, never from internal snapshot/ledger
 * state — decisionWire.ts's own doc comment on `semanticFrontierDemotionCounters`
 * is explicit that `re_suppression_count` must be independently checkable
 * "from the PROJECTED wire shape alone".
 *
 * FX-R3d (D10, 2026-09-04): a path is exempt iff some entry for it SHIPS
 * BYTES — a `body` (served now) or a `prior` (proven already held). It used to
 * be the negation of the demoted SHAPE, which additionally made a path exempt
 * on the strength of a bare or capped bodyless row; such a row proves nothing
 * is held, so pairing it with a genuinely demoted row of the same path would
 * have reported a re-suppression that did not happen. The live case this
 * counter exists for is unaffected: D3(b)'s `drv_baro.h` exempted its demoted
 * `1-23` row via a bodied `1-49` sibling, which is a body.
 */
function semanticFrontierWireExemptPaths(evidence: readonly Evidence[]): Set<string> {
  const exempt = new Set<string>();
  for (const entry of evidence) {
    const holdsBytes = entry.body !== undefined || entry.prior !== undefined;
    if (holdsBytes && typeof entry.path === "string") exempt.add(entry.path);
  }
  return exempt;
}

/**
 * Facts are read from the codec/fail-closed result, never the producer body.
 *
 * `marks` (FX-R3d, D10) is the producer's own record of which rows had a body
 * withheld and by WHICH mechanism, carried here as opaque witness ids by
 * `projectEvidence`. It is intersected with the final wire below: the counters
 * report what this response actually did, not what its shape resembles.
 */
function observeSemanticFrontierWire(
  text: string,
  marks: SemanticFrontierWithholdingMarks,
): SemanticFrontierWireObservation {
  try {
    const body = semanticTraceRecordOf(JSON.parse(text));
    if (body === undefined) return { wire_observed: false, wire_kind: null, decision_kind: null };
    const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : [];
    let evidenceBodyBytes = 0;
    let evidencePriorBytes = 0;
    const evidencePathIds: string[] = [];
    const evidenceWitnessIds: string[] = [];
    const typedEvidence: Evidence[] = [];
    for (const entry of evidence) {
      const item = semanticTraceRecordOf(entry);
      if (item === undefined) continue;
      if (typeof item["body"] === "string") evidenceBodyBytes += Buffer.byteLength(item["body"], "utf8");
      if (typeof item["prior"] === "string") evidencePriorBytes += Buffer.byteLength(item["prior"], "utf8");
      if (typeof item["path"] === "string") evidencePathIds.push(semanticFrontierPathId(item["path"]));
      evidenceWitnessIds.push(semanticFrontierEvidenceWitnessId(item));
      typedEvidence.push(item as unknown as Evidence);
    }
    const decision = semanticTraceRecordOf(body["decision"]);
    // Absent when TL_SF_DEMOTE is off, so the legacy/off trace shape stays
    // byte-identical to before this wave — never a defaulted 0 (§4.4).
    const demotion = sfDemoteEnabled()
      ? semanticFrontierDemotionCounters(typedEvidence, semanticFrontierWireExemptPaths(typedEvidence), marks)
      : undefined;
    return {
      wire_observed: true,
      ...(typeof body["kind"] === "string" ? { wire_kind: body["kind"] } : {}),
      decision_kind: typeof decision?.["kind"] === "string" ? decision["kind"] : null,
      evidence_count: evidence.length,
      evidence_body_bytes: evidenceBodyBytes,
      evidence_prior_bytes: evidencePriorBytes,
      // Preserve one opaque identity per final evidence entry.  Two ranges of
      // the same path are two delivered records, so deduping here would make
      // the trace undercount post-codec evidence.
      evidence_path_ids: evidencePathIds,
      evidence_witness_ids: evidenceWitnessIds,
      ...(semanticFrontierDecisionWitnessId(decision?.["next"]) !== undefined
        ? { decision_next_witness_id: semanticFrontierDecisionWitnessId(decision?.["next"]) }
        : {}),
      ...(demotion !== undefined
        ? {
          demoted_count: demotion.demotedCount,
          re_suppression_count: demotion.reSuppressionCount,
          withheld_named_count: demotion.withheldNamedCount,
        }
        : {}),
    };
  } catch {
    return { wire_observed: false, wire_kind: null, decision_kind: null };
  }
}

function emitSemanticFrontierFinalTrace(context: ProtocolCallContext, result: FinalizableResult): void {
  const state = takeSemanticFrontierTraceState();
  if (state === undefined || !isTraceEnabled()) return;
  const workspace = context.codecTraceWorkspace ?? context.workspace;
  if (workspace === undefined || workspace === "") return;
  const text = result.content[0]?.text;
  const observation = typeof text === "string"
    ? observeSemanticFrontierWire(text, state.marks)
    : { wire_observed: false, wire_kind: null, decision_kind: null };
  const event = finalizeSemanticFrontierAttestation(state.seed, observation, state.witnesses);
  // The event never receives the response, query, address, handle, or nonce.
  // It carries only a nonce-keyed witness which the paid runner recomputes
  // from its captured actual MCP response before accepting the attestation.
  const responseWitness = typeof text === "string" ? responseWitnessHmac(text) : undefined;
  if (responseWitness !== undefined) event["response_witness"] = responseWitness;
  // W-DEMOTE follow-up (§6 P-2): a re-suppression is supposed to be
  // impossible by construction (isSemanticFrontierDemotionEligible is
  // opt-in; I-2/D4 fail closed). This assertion is trace-only — it never
  // throws into the response — so the paid verifier can catch a regression
  // from the trace stream alone even though nothing here can block the call.
  const reSuppressionCount = event["re_suppression_count"];
  if (typeof reSuppressionCount === "number" && reSuppressionCount > 0) {
    const demotedCount = event["demoted_count"];
    trace("sf_demote_invariant_violation", {
      re_suppression_count: reSuppressionCount,
      demoted_count: typeof demotedCount === "number" ? demotedCount : 0,
    }, workspace);
  }
  traceBounded("semantic_frontier_attestation", event, workspace, {
    schema_version: event["schema_version"],
    eligible: event["eligible"],
    attempted: event["attempted"],
    committed: event["committed"],
    guard_enabled: event["guard_enabled"],
    marker_count: event["marker_count"],
    suppression_reasons: event["suppression_reasons"],
    wire_observed: event["wire_observed"],
    wire_kind: event["wire_kind"] ?? null,
    decision_kind: event["decision_kind"] ?? null,
    ...(responseWitness === undefined ? {} : { response_witness: responseWitness }),
    ...(event["demoted_count"] !== undefined ? { demoted_count: event["demoted_count"] } : {}),
    ...(event["re_suppression_count"] !== undefined ? { re_suppression_count: event["re_suppression_count"] } : {}),
    ...(event["withheld_named_count"] !== undefined ? { withheld_named_count: event["withheld_named_count"] } : {}),
    truncated_count: event["truncated_count"],
  });
}

// ---------------------------------------------------------------------------
// A.3 / A.5: mode + action -> Kind
// ---------------------------------------------------------------------------

/** A.5.2 `read.text` — today's slice / full / symbol / small_file / sections serves. */
const READ_TEXT_MODES: ReadonlySet<string> = new Set([
  "slice", "full", "symbol", "small_file", "sections", "auto", "",
]);

/** A.5.3 `read.map` — the structural family (skeleton / map / overview / surfaces). */
const READ_MAP_MODES: ReadonlySet<string> = new Set([
  "skeleton", "map", "overview", "surfaces", "digest",
]);

/** A.5.4 `read.batch` — multi-target serves that report per-item completeness. */
const READ_BATCH_MODES: ReadonlySet<string> = new Set(["pack", "batch", "handles"]);

/** A.5.5 `read.artifact` — Office/PDF/archive extraction and archive member reads. */
const READ_ARTIFACT_MODES: ReadonlySet<string> = new Set(["artifact", "archive"]);

/** A.5.8 `search.matches` — find / symbols / locate / diff. */
const SEARCH_MATCH_ACTIONS: ReadonlySet<string> = new Set([
  "find", "symbols", "locate", "diff", "",
]);

// ---------------------------------------------------------------------------
// W-BATCH-HINT candidate 3 (TL_BATCH_HINTS, default OFF — DESIGN-v0.15-sf-
// turn-economy.md §3). server.ts's own `READ_BATCH_HINT_TEXT`/
// `composeReadBatchHint` already nudge a caller re-reading the SAME path in
// serial slices; this is the sibling for a serial run of single-target calls
// across the read family generally — read_file with one target/handle OR
// search_files action=find with one query, path- and tool-agnostic, firing
// from the THRESHOLD'th (SERIAL_SINGLE_TARGET_HINT_THRESHOLD, state/
// session.ts) consecutive single-target call regardless of path — the exact
// shape a task-handle-replay route produced 32 times running in the r4 SF05
// treatment session this candidate answers.
//
// R28-FIX (2026-09-05 review): this constant used to be a byte-identical
// copy of `READ_BATCH_HINT_TEXT`, which was inaccurate on three counts —
// this mechanism fires from the 3rd+ call, not the 2nd; it fires for
// search_files find, not only read_file; and it fires across DIFFERENT
// paths, not "on this path". Reworded to describe the actual mechanism.
// The MARKER substring ("fold the remaining ranges into ONE targets") is
// kept verbatim on purpose: `bench/workflows/run_semantic_frontier_smoke.mjs`
// scans for it (`BATCH_HINT_MARKER`) to detect either hint, and this
// module's own dedup guard below keys on the same substring
// (`BATCH_HINT_DEDUP_MARKER`) rather than full-text equality, because the
// two hints' texts no longer match byte-for-byte. Not imported from
// server.ts (server.ts is this module's OWN caller, via the funnel
// `finalizeProtocolResponse` below, so an import back would be circular).
// ---------------------------------------------------------------------------
export const SERIAL_SINGLE_TARGET_HINT_TEXT =
  "3rd+ consecutive single-target read_file or search_files find call this session — fold the remaining ranges into ONE targets:[...] call (read_file) or queries:[...] call (search_files, <=5, OR-matched) instead of serial single-target calls";

/**
 * Shared substring both this hint and server.ts's `READ_BATCH_HINT_TEXT`
 * carry on purpose (also bench/workflows/run_semantic_frontier_smoke.mjs's
 * own `BATCH_HINT_MARKER` — keep all three byte-identical). Used as the
 * dedup key in `applySerialSingleTargetHint` below: whichever of the two
 * hints occupies the response's `hint` field first wins the one slot — the
 * dedup key is deliberately the MARKER substring, not full-text equality,
 * because the two hints' full texts differ (R28-FIX above).
 */
const BATCH_HINT_DEDUP_MARKER = "fold the remaining ranges into ONE targets";

/** The `Kind`s this hint may ride — every read-family SUCCESS shape; never a receipt, a refusal, or any edit_file kind. */
const SERIAL_SINGLE_TARGET_HINT_KINDS: ReadonlySet<Kind> = new Set([
  "read.text", "read.map", "read.batch", "read.artifact", "search.matches",
]);

/**
 * Attaches (or merges into an existing) `hint` field carrying the SAME
 * marker text `composeReadBatchHint` (server.ts) emits, when
 * `context.serialSingleTargetHint` fired for this call and `kind` is one of
 * the qualifying read-family success shapes. Merges with "; " (the same
 * idiom server.ts's own `note` composition uses) rather than overwriting, and
 * never duplicates the text if the response already carries it (e.g. this
 * exact response ALSO qualified for server.ts's own per-path serial-slice
 * hint, which shares this wording).
 */
function applySerialSingleTargetHint(
  context: ProtocolCallContext,
  kind: Kind,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (context.serialSingleTargetHint !== true) return body;
  if (!SERIAL_SINGLE_TARGET_HINT_KINDS.has(kind)) return body;
  const existing = typeof body["hint"] === "string" ? body["hint"] : undefined;
  if (existing !== undefined && existing.includes(BATCH_HINT_DEDUP_MARKER)) return body;
  return {
    ...body,
    hint: existing !== undefined && existing !== ""
      ? `${existing}; ${SERIAL_SINGLE_TARGET_HINT_TEXT}`
      : SERIAL_SINGLE_TARGET_HINT_TEXT,
  };
}

/**
 * §2.3 / A.4 receipt detection — the tag test C2-2 promised.
 *
 * The five-boolean probe this replaced is gone: every emitter that produces a
 * receipt now mints `receipt: "<form>"` at its own exit (`server.ts`'s served
 * content receipt and full-downgrade repeat, `readCodeTaskPack.ts`'s compact
 * re-serve, `state/session.ts`'s prepared-discovery receipt, `mode=closure`'s
 * complete branch). The booleans survive as IN-PROCESS authority — several
 * runtime guards read them — and are deleted from the WIRE by
 * `projectReadBody`, which is the same division of labour §3.4 E4 uses.
 *
 * `receiptOf` is the honesty gate as well as the constructor: a tag whose A.4
 * required set is not satisfied yields no `Receipt`, and the response then
 * keeps its content-bearing member rather than shipping a residency claim it
 * cannot address.
 */
function isReceiptBody(body: Record<string, unknown>, workspaceRoot?: string): boolean {
  // §2.3, and A.4's "NOT HERE" note: `query_mismatch` is NOT a receipt form in
  // v1. It is reclassified to `refusal` with `retry:"new-task"` and its
  // executable re-pack `next` — the receipt union has five forms and none of
  // them says "you asked a different question". Classified here rather than in
  // the body projector because WHICH member a response is is a `kind` question
  // (D4), and a receipt that is really a refusal is the wrong member however
  // its body is later shaped.
  if (body["query_mismatch"] === true) return false;
  return receiptOf(body, workspaceRoot) !== undefined;
}

/**
 * A text serve with no fresh body is not `read.text`: every one of its windows
 * is an already-served residency claim. Keep the producer's segment accounting
 * long enough to derive the one code-unchanged receipt shape, including the
 * exact unserved continuation a cap left behind.
 */
function priorOnlyTextReceipt(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof body["receipt"] === "string") return undefined;
  const segments = Array.isArray(body["segments"])
    ? body["segments"]
    : Array.isArray(body["windows"])
      ? body["windows"]
      : undefined;
  if (segments === undefined || segments.length === 0) return undefined;

  let handle = typeof body["handle"] === "string" ? body["handle"] : undefined;
  let sha = typeof body["sha"] === "string" ? body["sha"] : undefined;
  const servedBy: string[] = [];
  const remember = (label: unknown): void => {
    if (typeof label === "string" && label !== "" && !servedBy.includes(label)) servedBy.push(label);
  };
  remember(body["served_by"]);

  for (const segment of segments) {
    if (segment === null || typeof segment !== "object" || Array.isArray(segment)) return undefined;
    const row = segment as Record<string, unknown>;
    // `code`/`content`/`body` are the three live raw evidence spellings. An
    // empty string is not fresh evidence, but it also cannot prove residency.
    if ([row["code"], row["content"], row["body"]]
      .some((value) => typeof value === "string" && value !== "")) return undefined;
    if (row["code_unchanged"] !== true && typeof row["prior"] !== "string") return undefined;
    const rowHandle = typeof row["handle"] === "string" ? row["handle"] : undefined;
    const rowSha = typeof row["sha"] === "string" ? row["sha"] : undefined;
    if (handle === undefined) handle = rowHandle;
    else if (rowHandle !== undefined && rowHandle !== handle) return undefined;
    if (sha === undefined) sha = rowSha;
    else if (rowSha !== undefined && rowSha !== sha) return undefined;
    remember(row["served_by"] ?? row["prior"]);
  }
  if (handle === undefined || sha === undefined) return undefined;

  const remaining = Array.isArray(body["remaining_ranges"])
    ? body["remaining_ranges"].filter((range): range is string => typeof range === "string" && range !== "")
    : [];
  return {
    ...body,
    handle,
    sha,
    receipt: "code-unchanged",
    code_unchanged: true,
    ...(servedBy.length > 0
      ? { served_by: servedBy.length <= 2 ? servedBy.join(" + ") : `${servedBy[0]!} +${servedBy.length - 1} more` }
      : {}),
    // v0.14 §7.4: continuations are structured at every producer; the
    // final recursive pass only canonicalizes and attributes this executable call.
    ...(remaining.length > 0
      ? {
          next: {
            tool: "read_file",
            arguments: { targets: [{ handle, ranges: remaining }], content: "auto" },
          },
        }
      : {}),
  };
}

/**
 * A.5.3: this body carries a projection and no served window, so it is a
 * `read.map`. Deliberately narrow — `skeleton`/`signatures` present, `content`
 * and every multi-window carrier absent — because a body with BOTH is a text
 * serve that happens to ship an outline alongside, and misclassifying that
 * would delete the bytes it served.
 */
function isSkeletonOnlyBody(body: Record<string, unknown>): boolean {
  // BOTH shapes of the projection, because both emitters are live. The
  // rendered STRING is `getFileSkeleton`'s spelling; the STRUCTURED ARRAY of
  // `{name, kind, line, range, …}` is `extractSymbolsFromFile`'s, which is what
  // `buildFullDowngradePayload`'s per-task-cap arm serves
  // (`server.ts:2338/2348`) — the one governed downgrade B2c converted from a
  // content head to an outline. Reading only the string form classified that
  // arm as `read.text`, whose required set is >=1 `FreshEvidence` with a body
  // it deliberately does not have: the response then shipped `evidence: []`,
  // asserting that a serve which withheld the file's bytes served nothing at
  // all, with the outline it DID compute deleted by the text projector.
  const skeleton = body["skeleton"];
  const signatures = body["signatures"];
  const projection = typeof skeleton === "string" || typeof signatures === "string"
    || (Array.isArray(skeleton) && skeleton.length > 0)
    || (Array.isArray(signatures) && signatures.length > 0);
  if (!projection) return false;
  return typeof body["content"] !== "string"
    && !Array.isArray(body["segments"])
    && !Array.isArray(body["windows"])
    && !Array.isArray(body["items"]);
}

/**
 * A.5.11–A.5.14 + A.9.2 row 13: which side-effect state an edit response
 * reports. The discriminant is WHAT HAPPENED TO THE CALLER'S FILES, and the
 * order below is the order of that question's answers, most severe first.
 *
 * ROW 13, CLOSED. Today's wire carries two flags for three states, held apart
 * by a comment: `workspace_state:"workspace-state-unknown"` is emitted ONLY
 * alongside `code:"rollback-failed"`. C2-2's transitional probe read the pair
 * in the wrong order — it mapped `rollback-failed` to `edit.rolled_back`, but
 * that code means the RESTORE ITSELF FAILED, which is §2.4's
 * `edit.state_unknown` ("edits were attempted, the revert failed, on-disk state
 * is not provable"). `edit.rolled_back` is the CLEAN case. Both spellings of
 * the failure now route to the same member and the sentinel strings are deleted
 * from the body by `editFamily.ts`.
 *
 * RULING 3 (user-adjudicated 2026-08-14): a clean rollback KEEPS ITS LEDGER and
 * is `edit.rolled_back`. The ledger's presence is the discriminant, and it is
 * structural rather than conventional: a batch whose FIRST write failed wrote
 * nothing, restores nothing, and carries an empty ledger — for that one the
 * §2.4 row "nothing was attempted" is true and `refusal` is the honest member.
 */
function editKindOf(body: Record<string, unknown>): Kind | undefined {
  // §2.4/D5: these are KINDS, not refusal codes, and they are the reason
  // `isError:true` is not the same question as "was this refused?".
  if (
    body["code"] === "rollback-failed"
    || body["workspace_state"] === "workspace-state-unknown"
    || body["code"] === "workspace-state-unknown"
  ) {
    return "edit.state_unknown";
  }
  if (Array.isArray(body["rollback"]) && body["rollback"].length > 0) return "edit.rolled_back";
  // PQ2 fix-wave (orchestrator-directed, 2026-08-14): the applied signature is
  // EXPLICIT, not a default. Every write-success emitter sets `ok: true`
  // (`applyEditsMulti.ts` result types; the D6 deletion strips it from the wire
  // AFTER classification), so a body carrying it is a completed side effect and
  // must win the kind outright — even when refusal-ish fields ride alongside.
  // A body with neither a ledger marker nor the applied signature is NOT a
  // side-effect report; the caller decides between `refusal` and the
  // non-refusal fallback. Returning undefined here is what removed the old
  // `edit !== "edit.applied"` carve-out in `kindForCall`, which let an applied
  // shape fall through to the refusal test — the one door §4.2.1(1) left open.
  if (body["ok"] === true) return "edit.applied";
  return undefined;
}

/**
 * The tools whose responses can report a SIDE EFFECT.
 *
 * `edit_file`, and only `edit_file`. C2-5 had to widen this set to the four
 * deprecated write aliases (`search_replace_edit`, `apply_edits_multi`,
 * `create_file`, `read_and_edit`), because `CANON` did not map them onto
 * `edit_file` and a write through one of them therefore classified as
 * `read.text` — a completed effect on the caller's disk wearing a read's
 * member, an SE-STABLE violation reached through a different door than the one
 * §4.2.1 guards. D11 deleted those four names outright, so the widening is
 * deleted with them: there is exactly one door again.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit_file"]);

/**
 * The response's `Kind`. `body` is the parsed payload; `isError` is the
 * transport flag the emitter set before the §2.5 mapping is re-derived.
 */
export function kindForCall(
  context: ProtocolCallContext,
  body: Record<string, unknown>,
  isError: boolean,
): Kind {
  if (context.kind !== undefined) return context.kind;

  // §2.4/D5 first: a side-effect report is never a refusal, even though two of
  // the four carry `isError:true`. Ordering matters — the ledger-bearing
  // rollback body also carries `ok:false`, so the generic refusal test would
  // claim it and assert that nothing was attempted.
  if (WRITE_TOOLS.has(context.tool)) {
    // PQ2 fix-wave: a recognized side-effect kind ALWAYS wins — including
    // `edit.applied`, whose old carve-out let an applied-shaped body fall
    // through to `isRefusalBody` and ship as "nothing was attempted". The
    // refusal test now only ever sees bodies that report no side effect.
    const edit = editKindOf(body);
    if (edit !== undefined) return edit;
    if (isRefusalBody(body, isError)) return "refusal";
    return "edit.applied";
  }

  if (isRefusalBody(body, isError) || body["query_mismatch"] === true) return "refusal";

  // A.9.2 rows 9 + 10 (C2-4): two `search_files` branches report a FAILURE
  // through `toolOk` with neither `isError` nor `ok:false` — a failed `git diff`
  // carrying `error`, and `buildCompactTree`'s symlink-escape guard carrying
  // `refused:true`. Both are invisible to `isRefusalBody` and both are refusals
  // under D6. Classified here, with the rest of the `Kind` question.
  if (context.tool === "search_files"
    && searchRefusalCodeFor(context.action ?? "", body) !== undefined) {
    return "refusal";
  }

  // §2.3: a receipt is a success (isError unset) in every family, including the
  // prepared fence's stop on a `search_files` call — `Kind` names the payload's
  // family, not the tool that was called, and there is no `search.receipt`.
  if (isReceiptBody(body, context.verifyClosureWorkspace)) return "read.receipt";

  if (context.tool === "search_files") {
    const action = context.action ?? "";
    if (action === "references") return "search.references";
    if (action === "tree") return "search.tree";
    if (SEARCH_MATCH_ACTIONS.has(action)) return "search.matches";
    return "search.matches";
  }

  const mode = context.mode ?? "";
  if (mode === "task_pack") return "read.task_pack";
  if (mode === "closure") return "read.closure";
  if (READ_ARTIFACT_MODES.has(mode)) return "read.artifact";
  if (READ_BATCH_MODES.has(mode)) return "read.batch";
  if (READ_MAP_MODES.has(mode)) return "read.map";
  // A.5.2 vs A.5.3: a governed `mode=full` DOWNGRADE that serves a skeleton
  // instead of bytes is a projection, not a window — the member is what the
  // response IS, not what the caller asked for. Without this the response would
  // claim `read.text`, whose required set is >=1 `FreshEvidence` with a body it
  // does not have (F3's whole point: the required sets are disjoint).
  if (isSkeletonOnlyBody(body)) return "read.map";
  if (READ_TEXT_MODES.has(mode)) return "read.text";
  return "read.text";
}

// ---------------------------------------------------------------------------
// §2.5 the transport signal
// ---------------------------------------------------------------------------

/** A.8 rule E-3: `isError` is present iff the kind is one of exactly three. */
export function isErrorForKind(kind: Kind): boolean {
  return kind === "refusal" || kind === "edit.rolled_back" || kind === "edit.state_unknown";
}

// ---------------------------------------------------------------------------
// The finalizer
// ---------------------------------------------------------------------------

export interface FinalizableResult {
  content: Array<{ type: string; text: string }>;
  isError?: true;
}

/**
 * Stamp the envelope on one dispatched response.
 *
 * Order is normative, not incidental:
 *  1. classify (`Kind`) — the outcome, D4;
 *  2. refusal normalisation (§2.6) or success projection (§3.4 E4 + D6);
 *  3. `v` and `kind` are written FIRST so §1.2's "first field of every payload"
 *     holds for `v` and a truncated transcript slice still self-describes;
 *  4. `isError` is re-derived from `kind` per §2.5's mapping table — the
 *     emitter's own flag is advisory input to step 1 and authority nowhere;
 *  5. (P3a S1) the TAIL — serialize, measure, ladder, settle the ledger,
 *     assemble — is `emit.ts`. Everything above decides WHAT the response says;
 *     that module decides what its BYTES are, and it is the only place in this
 *     server that measures a response. The three early returns below route
 *     through `emitOpaqueText` for exactly that reason: a funnel exit that
 *     skipped the measurement point would re-open the class it closes.
 */
export function finalizeProtocolResponse(
  canonical: string,
  result: FinalizableResult,
): FinalizableResult {
  const context = _protocolCall.getStore() ?? { tool: canonical };
  const finalizeOpaque = (): FinalizableResult => {
    const finalized = emitOpaqueText(result, context);
    emitSemanticFrontierFinalTrace(context, finalized);
    return finalized;
  };
  const text = result.content[0]?.text;
  if (typeof text !== "string") return finalizeOpaque();

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return finalizeOpaque();
    }
    body = parsed as Record<string, unknown>;
  } catch {
    // Defensive: every helper in this tree emits JSON. A non-JSON payload is a
    // bug elsewhere and must not be turned into a second bug here.
    return finalizeOpaque();
  }

  // L3: receipt conversion happens before classification so an all-prior
  // segment response cannot escape as `read.text` with zero fresh evidence.
  if (context.tool === "read_file" && READ_TEXT_MODES.has(context.mode ?? "")) {
    body = priorOnlyTextReceipt(body) ?? body;
  }

  const kind = kindForCall(context, body, result.isError === true);
  // W-BATCH-HINT candidate 3: flag-gated here too (not just at the two
  // server.ts call sites that set `context.serialSingleTargetHint`) so this
  // funnel's own dead-code-by-default property — the same one
  // `clientAcknowledgedPrior`/`projectCoveredBy` document above — holds for
  // this lever independently of whether server.ts's own gate ever drifts.
  if (batchHintsEnabled()) {
    body = applySerialSingleTargetHint(context, kind, body);
  }
  // §4.2.1(1) SE-STABLE, STRUCTURAL. The three side-effect kinds are
  // refusal-conversion-FORBIDDEN. The enforcement lives in `kindForCall`'s
  // WRITE_TOOLS branch: a recognized side-effect kind returns before the
  // refusal test ever runs (PQ2 fix-wave removed both the `edit.applied`
  // carve-out there and the tautological `!isSideEffectKind(kind)` conjunct
  // that used to ride on this ternary — `kind === "refusal"` already excludes
  // the side-effect kinds by that construction). The regression lives in
  // `editFamilyStability.spec.ts`: an applied-shaped body carrying refusal-ish
  // fields classifies `edit.applied` under either transport flag. A
  // side-effect report that cannot be shaped still ships as its own kind with
  // whatever it can carry — never as a claim that nothing happened.
  const payload = kind === "refusal"
    // A.9.2 rows 9 + 10: the two funnel-converted search failures carry no
    // `code` of their own, so the A.7.1 code is stamped BEFORE `buildRefusal`
    // resolves it — inside the funnel, never appended after it (P3a).
    ? buildRefusal(
        toolNameOf(canonical),
        context.tool === "search_files" ? searchRefusalBody(context.action ?? "", body) : body,
      )
    : { v: PROTOCOL_VERSION, kind, ...projectSuccessBody(kind, body, context) };
  // Read/search dispatch records the authoritative resolved root in the
  // trace-only context slot; edit dispatch uses the normal workspace slot.
  // Both are server-validated identities, unlike caller-visible JSON fields.
  const resolvedWorkspace = context.workspace ?? context.codecTraceWorkspace;
  // Canonical continuations are part of the carrier certified by the ledger.
  const canonicalPayload = canonicalizeEmittedToolCalls(payload);
  const producerBinding = ledgerCertificateBinding(result);
  if (producerBinding !== undefined) {
    const taskReplay = (body.task as { replay?: unknown } | undefined)?.replay;
    bindLedgerCertificate(canonicalPayload, {
      ...producerBinding,
      ...(resolvedWorkspace !== undefined && resolvedWorkspace !== ""
        ? { workspaceIdentity: resolvedWorkspace }
        : {}),
      ...(typeof taskReplay === "string" && taskReplay.length > 0 ? { taskReplay } : {}),
    });
  } else if (resolvedWorkspace !== undefined && resolvedWorkspace !== "") {
    // toolOk JSON-serializes the producer body, so the WeakMap/symbol marker
    // is gone before this finalizer runs. Reassociate exactly one indexed
    // producer binding using the funnel's resolved workspace/lane identity;
    // absent/ambiguous/foreign candidates remain a refusal.
    const lane = typeof context.args?.lane === "string" ? context.args.lane : undefined;
    bindLedgerCertificateFromScope(canonicalPayload, resolvedWorkspace, lane);
  }

  // P3a S1: the payload is FINAL here. Everything downstream of this line —
  // serialization, the ONE byte measurement, the shed ladder, the [R5-10]
  // served-range settlement (now against the POST-shed payload, which is the
  // honest ledger order) and the §2.5 `isError` stamp — belongs to `emit.ts`.
  // The split is not cosmetic: it is what makes "one measurement point" a
  // structural property instead of a convention this function has to keep.
  const finalized = emitFinalizedPayload(canonicalPayload, kind, context);
  // This is deliberately outside emit.ts: its return value is the only place
  // all codec/shedding/fail-closed exits have converged.  The observer parses
  // those final bytes and consumes its seed, so no producer-time estimate can
  // survive a wire-shape change or leak into a later call.
  emitSemanticFrontierFinalTrace(context, finalized);
  return finalized;
}

/**
 * D-4: all model-visible ToolCall carriers use the compact canonical input
 * surface. Dispatch still accepts the legacy spellings during the migration,
 * but emitting them would force a caller to rely on compatibility behavior.
 */
// W2-3: exported so `emit.ts`'s `failClosed` can re-run the SAME canonicalizer
// on the refusal it mints — see that call site's comment for why a second,
// parallel canonicalizer must not be written instead.
export function canonicalizeEmittedToolCalls(value: Record<string, unknown>): Record<string, unknown> {
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate === null || typeof candidate !== "object") return candidate;
    const record = candidate as Record<string, unknown>;
    const copied: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === "arguments") {
        copied[key] = child;
        continue;
      }
      if (key === "next" && typeof child === "string") {
        const parsed = parseProseToolCall(child);
        if (parsed !== undefined) copied[key] = visit(parsed);
        continue;
      }
      copied[key] = visit(child);
    }
    const tool = copied["tool"];
    const argumentsValue = copied["arguments"];
    if (
      (tool === "read_file" || tool === "edit_file" || tool === "search_files")
      && argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ) {
      // Route object-shaped continuations through the public constructor too:
      // otherwise the final recursive pass would normalize syntax but miss
      // cwd/task attribution for direct mint sites. DESIGN-v0.15 §8.2 (R7 Part
      // B): under a `code` surface this constructor can also SWAP `tool`
      // itself (a full-only read replaced by a `search_files` directory
      // listing — see `fullOnlyPathRecovery`), so `tool` is re-stamped from
      // the SAME call, never just `arguments` alone — leaving the old `tool`
      // paired with the new shape would emit an inconsistent, unexecutable
      // continuation.
      const canonical = canonicalToolCall(tool, argumentsValue as Record<string, unknown>);
      copied["tool"] = canonical.tool;
      copied["arguments"] = canonical.arguments;
    }
    return copied;
  };
  return visit(value) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 §8.2 (R7 Part B) — surface-aware minting.
//
// `server.ts` resolves `ACTIVE_TOOL_SURFACE` exactly once, at module load
// (CLI `--tool-surface` / env `TOKENLIGHTEN_TOOL_SURFACE`), and this module is
// one of ITS dependencies (`server.ts` imports `canonicalToolCall` from here),
// so this file cannot import that resolution back without a cycle. Instead
// `server.ts` pushes the resolved value here, at that SAME module-load
// moment, via `setEnvelopeToolSurface` — a plain setter, not a second
// resolution, so the two can never disagree. Defaults to "full" (server.ts's
// own default) so a caller of `canonicalToolCall` before that push runs
// (there is none in practice: this module has no side effects of its own at
// import time) keeps the historical, unfiltered behavior.
// ---------------------------------------------------------------------------
let envelopeToolSurface: ToolSurface = "full";

/** Called once by `server.ts`, at the same moment it resolves `ACTIVE_TOOL_SURFACE`. */
export function setEnvelopeToolSurface(surface: ToolSurface): void {
  envelopeToolSurface = surface;
}

/**
 * `select`'s artifact-addressing keys — the DATA-argument-shaped mirror of
 * `server.ts`'s own exported `ARTIFACT_SELECT_KEYS` (`kind`/`format`/`sheet`/
 * `rows`/`columns`/`slides`/`pages`). Duplicated by VALUE, not imported: this
 * module is a dependency of `server.ts`, so importing the other way would
 * cycle. Keep the two lists in sync by hand — `toolSurfaceReachability.spec.ts`
 * is the corpus-replay check that would catch a drift.
 */
const FULL_ONLY_SELECT_ARGUMENT_KEYS = ["kind", "format", "sheet", "rows", "columns", "slides", "pages"] as const;

/** Office document extensions `server.ts`'s own inline `isOffice` checks name — the binary-artifact half of "full-only path" (the other half is `isSupportedArchivePath`). */
const FULL_ONLY_DOCUMENT_EXT_RE = /\.(?:docx|xlsx|pptx|pdf)$/i;

/**
 * True when READING THIS PATH would land in Office/archive handling by
 * FILE EXTENSION ALONE, regardless of whether the call ALSO carried an
 * advertised full-only field — the auto-detection gates `server.ts`'s own
 * `officeOrArchiveSurfaceRefusal` protects (wave-0 ledger §7.2: 9 such
 * gates). Stripping `archive`/`select` from a target whose PATH is itself
 * `data.zip`/`report.pdf` does not make reading it meaningful on a `code`
 * surface — the dispatcher would refuse it again the moment it ran.
 */
function isFullOnlyPath(path: string): boolean {
  return isSupportedArchivePath(path) || FULL_ONLY_DOCUMENT_EXT_RE.test(path);
}

interface SurfacedCall {
  tool: string;
  arguments: Record<string, unknown>;
}

/** Directory-listing recovery for a path this surface can never read — no query to guess, so `tree` (which needs none) is the one recovery that is always constructible. */
function fullOnlyPathRecovery(removedPath: string): SurfacedCall {
  return { tool: "search_files", arguments: { action: "tree", scope: { path: posixPath.dirname(removedPath) } } };
}

/** Strip `edit_file`'s two full-only top-level blocks. Structural only: an artifact-only edit with nothing left is a pre-existing narrower gap (edit_file next-calls do not mint bare artifact edits today) left to the schema's own `unknown-arguments`/`edits`-required refusal rather than a fabricated recovery. */
function withoutFullOnlyEditFileArguments(tool: string, args: Record<string, unknown>): SurfacedCall {
  if (args["artifact"] === undefined && args["credentials"] === undefined) return { tool, arguments: args };
  const next = { ...args };
  delete next["artifact"];
  delete next["credentials"];
  return { tool, arguments: next };
}

/** Strip `search_files.scope.archive`/`.credentialRef`; if the survives-stripping `scope.path` is itself full-only-shaped, the call would still dead-end on this surface — recover with a directory listing instead. */
function withoutFullOnlySearchFilesArguments(tool: string, args: Record<string, unknown>): SurfacedCall {
  const scope = recordOf(args["scope"]);
  if (scope === undefined) return { tool, arguments: args };
  if (scope["archive"] === undefined && scope["credentialRef"] === undefined) {
    const path = typeof scope["path"] === "string" ? scope["path"] : undefined;
    return path !== undefined && isFullOnlyPath(path) ? fullOnlyPathRecovery(path) : { tool, arguments: args };
  }
  const restScope = { ...scope };
  delete restScope["archive"];
  delete restScope["credentialRef"];
  const path = typeof restScope["path"] === "string" ? restScope["path"] : undefined;
  if (path !== undefined && isFullOnlyPath(path)) return fullOnlyPathRecovery(path);
  return { tool, arguments: { ...args, scope: restScope } };
}

/**
 * Strip `read_file`'s full-only surface: each target's `archive`/
 * `credentialRef`, `select`'s artifact-addressing keys, `budget.rows`/
 * `.cells`, and `scope.archive`/`.credentialRef`. A target whose PATH is
 * itself full-only-shaped is DROPPED ENTIRELY (field-stripping alone cannot
 * make `data.zip` a plain-text file); if every target is dropped this way,
 * the whole call is replaced by a directory listing of the first removed
 * path's parent — never a `read_file targets:[{archive:…}]` a `code` surface
 * cannot execute.
 */
function withoutFullOnlyReadFileArguments(tool: string, args: Record<string, unknown>): SurfacedCall {
  const out: Record<string, unknown> = { ...args };

  const targets = Array.isArray(out["targets"]) ? out["targets"] : undefined;
  const removedPaths: string[] = [];
  if (targets !== undefined) {
    const kept: unknown[] = [];
    for (const raw of targets) {
      const target = recordOf(raw);
      if (target === undefined) { kept.push(raw); continue; }
      const path = typeof target["path"] === "string" ? target["path"] : undefined;
      if (path !== undefined && isFullOnlyPath(path)) {
        removedPaths.push(path);
        continue;
      }
      if (target["archive"] !== undefined || target["credentialRef"] !== undefined) {
        const restTarget = { ...target };
        delete restTarget["archive"];
        delete restTarget["credentialRef"];
        kept.push(restTarget);
        continue;
      }
      kept.push(target);
    }
    if (kept.length === 0 && removedPaths.length > 0) return fullOnlyPathRecovery(removedPaths[0]!);
    out["targets"] = kept;
  }

  const scope = recordOf(out["scope"]);
  if (scope !== undefined && (scope["archive"] !== undefined || scope["credentialRef"] !== undefined)) {
    const restScope = { ...scope };
    delete restScope["archive"];
    delete restScope["credentialRef"];
    if (Object.keys(restScope).length > 0) out["scope"] = restScope; else delete out["scope"];
  }

  const select = recordOf(out["select"]);
  if (select !== undefined && FULL_ONLY_SELECT_ARGUMENT_KEYS.some((k) => select[k] !== undefined)) {
    const restSelect = { ...select };
    for (const k of FULL_ONLY_SELECT_ARGUMENT_KEYS) delete restSelect[k];
    if (Object.keys(restSelect).length > 0) out["select"] = restSelect; else delete out["select"];
  }

  const budget = recordOf(out["budget"]);
  if (budget !== undefined && (budget["rows"] !== undefined || budget["cells"] !== undefined)) {
    const restBudget = { ...budget };
    delete restBudget["rows"];
    delete restBudget["cells"];
    if (Object.keys(restBudget).length > 0) out["budget"] = restBudget; else delete out["budget"];
  }

  return { tool, arguments: out };
}

/**
 * The ONE surface gate every minted continuation passes through (see the
 * module-doc block above `envelopeToolSurface`). `full` is a strict no-op —
 * returns `{tool, arguments}` UNCHANGED, not merely equivalent, so every
 * existing full-surface caller keeps its exact prior identity.
 */
function applyToolSurface(tool: string, args: Record<string, unknown>): SurfacedCall {
  if (envelopeToolSurface === "full") return { tool, arguments: args };
  if (tool === "edit_file") return withoutFullOnlyEditFileArguments(tool, args);
  if (tool === "search_files") return withoutFullOnlySearchFilesArguments(tool, args);
  if (tool === "read_file") return withoutFullOnlyReadFileArguments(tool, args);
  return { tool, arguments: args };
}

/** Construct an executable wire continuation through the one canonicalizer. */
export function canonicalToolCall(tool: "read_file" | "edit_file" | "search_files", args: Record<string, unknown>): ToolCall {
  const attributed = attributedContinuationArguments(canonicalToolArguments(tool, args));
  const surfaced = applyToolSurface(tool, attributed);
  return { tool: surfaced.tool, arguments: surfaced.arguments } as ToolCall;
}

/**
 * Continuations inherit only the call identity needed to execute in the same
 * workspace/task. This is deliberately narrow: lane is copied only when the
 * caller supplied it, and state-version/qref are never manufactured.
 */
function attributedContinuationArguments(args: Record<string, unknown>): Record<string, unknown> {
  const context = protocolCallContext();
  if (context === undefined) return args;
  const inbound = context.args;

  const attributed = { ...args };
  const resolvedCwd = context.continuationWorkspace ?? context.workspace;
  if (attributed["cwd"] === undefined) {
    if (typeof resolvedCwd === "string" && resolvedCwd !== "") attributed["cwd"] = resolvedCwd;
    else if (typeof inbound?.["cwd"] === "string") attributed["cwd"] = inbound["cwd"];
  }
  // Empty lane is the canonical default and must stay absent on the wire;
  // echoing lane:"" reintroduces the absent-vs-empty duality in continuations.
  if (
    attributed["lane"] === undefined
    && typeof inbound?.["lane"] === "string"
    && inbound["lane"] !== ""
  ) {
    attributed["lane"] = inbound["lane"];
  }

  const inboundTask = recordOf(inbound?.["task"]);
  const inboundHandle = typeof inboundTask?.["handle"] === "string"
    ? inboundTask["handle"]
    : typeof inbound?.["task_handle"] === "string"
      ? inbound["task_handle"]
      : context.continuationTaskHandle;
  if (inboundHandle !== undefined) {
    const task = recordOf(attributed["task"]);
    const explicitLegacyHandle = typeof attributed["task_handle"] === "string";
    // `taskEpoch` is the legacy spelling of the same producer declaration.
    // Check it before injecting the inherited handle: otherwise the later
    // canonicalTask pass sees the injected `{task:{handle}}` and silently
    // drops the caller's fresh-epoch request.
    const declaredEpoch = task?.["epoch"] !== undefined || attributed["taskEpoch"] !== undefined;
    if (task !== undefined) {
      if (
        task["handle"] === undefined
        && !declaredEpoch
        && !explicitLegacyHandle
      ) {
        attributed["task"] = { ...task, handle: inboundHandle };
      }
    } else if (
      attributed["task"] === undefined
      && !declaredEpoch
      && !explicitLegacyHandle
    ) {
      attributed["task"] = { handle: inboundHandle };
    }
  }
  return attributed;
}

function canonicalToolArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (typeof args["lane"] === "string" && args["lane"] !== "") base["lane"] = args["lane"];
  if (args["cwd"] !== undefined) base["cwd"] = args["cwd"];
  const task = canonicalTask(args);
  if (task !== undefined) base["task"] = task;
  else if (args["task"] !== undefined) base["task"] = args["task"];
  const budget = recordOf(args["budget"]) ?? canonicalBudget(args);
  if (budget !== undefined) base["budget"] = budget;

  if (tool === "read_file") return { ...base, ...canonicalReadArguments(args) };
  if (tool === "edit_file") return { ...base, ...canonicalEditArguments(args) };
  return { ...base, ...canonicalSearchArguments(args) };
}

function canonicalTask(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const task: Record<string, unknown> = { ...(recordOf(args["task"]) ?? {}) };
  const names: ReadonlyArray<readonly [string, string]> = [
    ["task_handle", "handle"], ["taskEpoch", "epoch"], ["taskProfile", "profile"],
    ["expected_state_version", "expected_state_version"], ["challenge", "challenge"],
    ["force_serve", "force_serve"],
  ];
  for (const [from, to] of names) if (args[from] !== undefined) task[to] = args[from];
  if (args["mode"] === "closure" && task["pull"] === undefined) task["pull"] = "closure";
  return Object.keys(task).length > 0 ? task : undefined;
}

function canonicalBudget(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const budget: Record<string, unknown> = {};
  const names: ReadonlyArray<readonly [string, string]> = [
    ["maxBytes", "bytes"], ["maxTokens", "tokens"], ["limit", "items"],
    ["maxRows", "rows"], ["maxCells", "cells"], ["allowFull", "allowFull"],
  ];
  for (const [from, to] of names) if (args[from] !== undefined) budget[to] = args[from];
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function canonicalReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // DESIGN-v0.15 §5.2 (R2): `read_file.cursor` is carried verbatim, exactly as
  // `canonicalSearchArguments` below already carries the search cursor. An
  // opaque token has no legacy spelling to project from and nothing to derive:
  // dropping it here (the pre-R2 behaviour) silently turned the one canonical
  // continuation into a `{cwd}`-only call the dispatcher then refused.
  if (args["cursor"] !== undefined) out["cursor"] = args["cursor"];
  if (args["query"] !== undefined) out["query"] = args["query"];
  if (args["qref"] !== undefined) out["qref"] = args["qref"];
  const targets = canonicalReadTargets(args);
  if (targets.length > 0) out["targets"] = targets;
  const mode = args["mode"];
  const content = args["content"];
  if (content === "full" || content === "outline" || content === "auto") out["content"] = content;
  // A legacy handles[] continuation requests the complete bodies behind its
  // minted handles, even when it did not spell mode:"full" explicitly.
  else if (Array.isArray(args["handles"])) out["content"] = "full";
  else if (mode === "full") out["content"] = "full";
  else if (mode === "skeleton" || mode === "map" || mode === "overview" || mode === "digest") out["content"] = "outline";
  else if (mode !== "task_pack" && mode !== "closure" && targets.length > 0) out["content"] = "auto";

  const select = {
    ...(recordOf(args["select"]) ?? {}),
    ...pick(args, ["kind", "comments", "sheet", "rows", "columns", "sections", "slides", "pages"]),
  };
  if (args["as"] !== undefined) select["format"] = args["as"];
  if (Object.keys(select).length > 0) out["select"] = select;
  const scope = { ...(recordOf(args["scope"]) ?? {}), ...pick(args, ["includeClosure", "surfaceRoles"]) };
  if (Object.keys(scope).length > 0) out["scope"] = scope;
  return out;
}

function canonicalReadTargets(args: Record<string, unknown>): Record<string, unknown>[] {
  const common = pick(args, ["credentialRef", "range", "ranges", "symbol", "profile", "lang"]);
  const targetFor = (source: unknown): Record<string, unknown> | undefined => {
    const target = typeof source === "string" ? { path: source } : recordOf(source);
    if (target === undefined) return undefined;
    const copied = { ...common, ...pick(target, ["path", "handle", "credentialRef", "range", "ranges", "symbol", "purpose", "profile", "lang", "archive"]) };
    const archive = recordOf(copied["archive"]);
    if (copied["path"] === undefined && archive?.["path"] !== undefined) copied["path"] = archive["path"];
    return copied["path"] !== undefined || copied["handle"] !== undefined ? copied : undefined;
  };
  // The emitter can visit a continuation more than once (notably refusal
  // projection followed by the final envelope).  Preserve already-canonical
  // targets as well as compatibility `paths`, so canonicalization is
  // idempotent rather than silently narrowing an executable continuation.
  const canonical = Array.isArray(args["targets"]) ? args["targets"].map(targetFor) : [];
  const explicit = Array.isArray(args["paths"]) ? args["paths"].map(targetFor) : [];
  const handles = Array.isArray(args["handles"])
    ? args["handles"].map((handle) => targetFor({ handle }))
    : [];
  const direct = targetFor(args["path"] !== undefined || args["handle"] !== undefined || args["archive"] !== undefined
    ? { path: args["path"], handle: args["handle"], archive: args["archive"] }
    : undefined);
  return [...canonical, ...explicit, ...handles, ...(direct === undefined ? [] : [direct])]
    .filter((target): target is Record<string, unknown> => target !== undefined);
}

function canonicalEditArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rawEdits = Array.isArray(args["edits"]) ? args["edits"] : [args];
  const edits = rawEdits.map(canonicalEdit).filter((edit): edit is Record<string, unknown> => edit !== undefined);
  if (edits.length > 0) out["edits"] = edits;
  if (args["artifact"] !== undefined) out["artifact"] = args["artifact"];
  if (args["operation_id"] !== undefined) out["operation_id"] = args["operation_id"];
  const credentials: Record<string, unknown> = { ...(recordOf(args["credentials"]) ?? {}) };
  if (args["credentialRef"] !== undefined) credentials["in"] = args["credentialRef"];
  if (args["outputCredentialRef"] !== undefined) credentials["out"] = args["outputCredentialRef"];
  if (Object.keys(credentials).length > 0) out["credentials"] = credentials;
  return out;
}

function canonicalEdit(value: unknown): Record<string, unknown> | undefined {
  const source = recordOf(value);
  if (source === undefined) return undefined;
  const edit = pick(source, ["path", "handle", "range", "search", "replace", "content", "create", "from", "expectedSha", "precondition", "allowPathFallback", "target", "scopeHandle", "directoryHandle", "review"]);
  const intent = pick(source, ["from", "to", "symbol", "lang", "includeComments"]);
  if (source["mode"] === "rename") {
    intent["kind"] = "rename";
    delete edit["from"];
  } else if (typeof source["intent"] === "string") {
    intent["kind"] = source["intent"];
    delete edit["from"];
  }
  else if (recordOf(source["intent"]) !== undefined) Object.assign(intent, source["intent"]);
  if (Object.keys(intent).length > 0) edit["intent"] = intent;
  return Object.keys(edit).length > 0 ? edit : undefined;
}

function canonicalSearchArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const scope = {
    ...(recordOf(args["scope"]) ?? {}),
    ...pick(args, ["path", "credentialRef", "lang", "regex", "depth", "includeClosure", "surfaceRoles", "includeScores", "archive"]),
  };
  let action = args["action"];
  if (action === "symbols") {
    action = "find";
    scope["kind"] = "symbol";
  } else if (action === "locate") {
    action = "tree";
    scope["includeClosure"] = true;
  }
  if (action !== undefined) out["action"] = action;
  const queries = Array.isArray(args["queries"])
    ? args["queries"]
    : typeof args["query"] === "string" ? [args["query"]] : [];
  if (queries.length > 0) out["queries"] = queries;
  if (args["cursor"] !== undefined) out["cursor"] = args["cursor"];
  if (Object.keys(scope).length > 0) out["scope"] = scope;
  return out;
}

function pick(source: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) if (source[name] !== undefined) out[name] = source[name];
  return out;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** `"12-40"` / `"L12-L40"` -> `[12, 40]`. */
function parseServedRange(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = /^L?(\d+)\s*-\s*L?(\d+)$/.exec(value.trim());
  if (parsed === null) return undefined;
  const start = Number(parsed[1]);
  const end = Number(parsed[2]);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : undefined;
}

/**
 * [R5-10]: which file windows THIS payload actually puts bytes on the wire for.
 *
 * A structural walk rather than a per-member reader, for the same reason the
 * envelope itself is a funnel: `read.text`, `read.task_pack`, `read.batch` and
 * `read.artifact` all carry bodies, in four different nestings, and a fifth
 * member would otherwise be a fifth place to remember. The walk looks for the
 * one thing every dialect agrees on — a non-empty string body under an
 * addressed entry — and inherits `path` from the nearest enclosing scope,
 * because the single-window serves declare it once at the top level.
 *
 * Bodies it cannot attribute to a path set `unattributed`, which keeps every
 * pending span. Retraction is only ever asserted for a payload whose served
 * bytes are fully accounted for.
 *
 * EXPORTED FOR `emit.ts` ONLY (P3a S1). The projection logic stays here, with
 * the other projectors; the CALL moved to the funnel tail so the ledger settles
 * against the post-shed payload rather than the pre-shed one.
 */
/**
 * FX-O1 (ruling (t), 2026-09-03): is this served string TokenLighten's own
 * SYNTHETIC RENDERING of a file rather than a window of the file's lines?
 *
 * Two response shapes carry an assembled view whose lines do NOT map to file
 * lines: `mode=symbol`'s scope view (`// tokenlighten:scope path=… symbol=…`,
 * then imports, signatures, a `// target:` marker and the body — `server.ts`'s
 * own comment at the symbol booking site says so in as many words) and
 * `mode=skeleton`'s signature map (`// tokenlighten:skeleton path=… lang=…`,
 * JSON-encoded into a batch entry's `content`). Deriving file spans from those
 * bytes would book coordinates from a different space; a skeleton is not a body
 * at all (ruling (s): "skeleton (map/outline) は本体ではない").
 *
 * Detected through `util/sentinelComment.ts`'s own detector — the single owner
 * of that vocabulary, which already recognises the `//`, `#` and `/* … *\/`
 * forms — on the FIRST line, tolerating the leading `"` a JSON-encoded skeleton
 * entry carries. A real file whose first line happens to be a TokenLighten
 * sentinel is misread as synthetic; the cost is one redundant re-serve of that
 * file, never a claim about bytes that did not ship.
 */
function _isSyntheticRendering(text: string): boolean {
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  return isTokenlightenSentinelLine(firstLine.replace(/^"+/, ""));
}

export function servedWindowsOf(
  payload: Record<string, unknown>,
  attributedPath?: string,
): {
  unattributed: boolean;
  windows: Array<{ path: string; start: number; end: number }>;
} {
  // F-A1-6: a `refusal` payload is structurally evidence-free — `Refusal` /
  // `RefusalCore` (types/mcp/protocol.ts:443) has no `body`/`content`/`path`
  // field anywhere in it — but its REQUIRED `code: RefusalCode` (e.g.
  // "cwd-required-for-edit") is a short non-empty string, which is exactly
  // what the generic walk below treats as a served body when it finds no
  // sibling `body`/`content`. A bare refusal has no enclosing `path` to
  // attribute that string to either, so the unguarded walk reported
  // `unattributed: true` for every refusal — which makes `settleServedRanges`
  // (state/session.ts:4175) fail OPEN, so a call that provisionally booked a
  // span and then got shed to refusal (unreachable at production budgets;
  // reachable via `budgetOverrideBytes`, emit.ts's failClosed tail) never
  // retracted it. A refusal carries zero served bytes by construction, so the
  // honest projection is the same one any other body-less, evidence-free
  // response gets: attributed (not `unattributed`), with an empty window
  // list — `settleServedRanges` then retracts every pending span for this
  // call, exactly as an ordinary refusal is meant to (emit.ts's own comment:
  // "a refusal carries nothing, so a serve path that booked before refusing
  // books nothing").
  //
  // Narrowest fix: gated on the payload's OWN `kind`, not on the presence of
  // a `code` key, so a genuine evidence-embedded `code` field elsewhere on
  // the protocol (the pre-v1 symbol-serve dialect — `{...symbolData, code:
  // symbolCode, handle, sha}`, readFamily.ts:100/112, which always carries
  // its own `path`) is completely untouched by this guard; the general walk
  // below is unchanged for every non-refusal kind.
  if (payload["kind"] === "refusal") return { unattributed: false, windows: [] };

  const windows: Array<{ path: string; start: number; end: number }> = [];
  let unattributed = false;

  const visit = (value: unknown, inheritedPath: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedPath);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const own = record["path"];
    // FX-O1 (ruling (t)): `attributedPath` is the LAST resort — the path a
    // staging site named on the call context for exactly the shapes whose
    // payload carries a body and no `path` anywhere above it (see
    // `noteServeAttribution`). A payload that names its own path is unaffected.
    const scopePath = typeof own === "string" && own !== ""
      ? own
      : inheritedPath ?? (attributedPath !== undefined && attributedPath !== "" ? attributedPath : undefined);

    // `body` is the v1 evidence field; `content` and `code` are the pre-v1
    // dialects still spoken by members this projector passes through.
    //
    // FX-O1 (ruling (t), 2026-09-03) — `code` NEEDS ADDRESSING BESIDE IT.
    // The two real `code` dialects both carry it: `mode=symbol`'s scope view is
    // `{...symbolData, code, handle, sha, range}` and a verification-kit
    // surface is `{path, role, handle, code}`. But `code` is ALSO an ordinary
    // enum field elsewhere on the protocol — `decision.discover.gaps[].code`
    // (a `CapabilityGapCode` such as `"missing-evidence"`) rides an ordinary
    // task_pack, has no addressing of any kind, and was read here as a served
    // body with nothing to attribute it to. Every pack carrying a gap therefore
    // projected `unattributed: true`, which the old fail-open arm hid
    // completely and the fail-closed arm would have turned into a retraction of
    // that pack's own honest bookings. The `refusal` guard above is the same
    // class of false positive, caught earlier and narrower.
    const addressed = (typeof record["handle"] === "string" && record["handle"] !== "")
      || typeof record["range"] === "string"
      || typeof record["served_range"] === "string";
    const carried = [record["body"], record["content"], addressed ? record["code"] : undefined]
      .find((candidate) => typeof candidate === "string" && candidate !== "");
    if (carried !== undefined) {
      if (scopePath === undefined) {
        unattributed = true;
      } else {
        // FX-W3 (ruling (aa), 2026-09-04) — THE DECLARED WINDOW, VERBATIM.
        // NEVER RE-DERIVED BY PARSING THE BODY.
        //
        // FX-N/FX-O1 used to EXTEND the declared window past what `range`
        // says by re-running `servedSpansOfDisplayedText` over the wire body
        // itself, to bridge the gap between a `mode=full`/`small_file`
        // serve's DISPLAY-line-synthesized `range` (`readFamily.ts`'s
        // single-window arm writes `1-<lineCount(body)>`) and the FILE
        // coordinates a real elision genuinely reaches (the replay corpus's
        // `seh6` fixture: a 40-line file whose lines 9-29 are one comment
        // block ships 20 display lines, declares `range:"1-20"`, and honestly
        // booked FILE spans 1-8 and 30-40 — read literally, `1-20` retracts
        // 30-40 outright).
        //
        // Round-17 and round-21A both broke that widening, two different
        // ways: an ordinary `range:"1-200"` slice the wire governor trims to
        // 7 lines satisfies the SAME numeric shape the rule looked for, by
        // construction (the shed narrows `range` to the surviving body); and
        // — the deeper defect — the re-parse cannot tell a genuine elision
        // marker from a caller's OWN file content that merely LOOKS like one
        // (`/* doc elided L5-250 */` as a literal, non-comment line).
        // Combined with an ordinary `budget.bytes` shed, that let a lane
        // which genuinely received only the first 76 of 300 lines end up
        // with a corroborated reach over lines it never saw in any form
        // (round-21A finding 1).
        //
        // RULING (aa): this projector NEVER widens — it reports exactly what
        // the wire declares, in file coordinates where the shape allows it,
        // and nothing else. The gap `seh6` needs bridged is instead closed
        // downstream, in `state/session.ts`'s `_settleSessionServeBookings` —
        // the SAME module that already holds each call's own TRUE recorded
        // extent (`WorkspaceSession.pendingRenderedExtent`, written by
        // `recordServedRange` from its OWN `provenance.range` argument, never
        // from wire text) — which widens a window THIS projector already
        // attributed to a path, and ONLY when `emit.ts` has independently
        // confirmed no wire-level shedding touched this response at all. A
        // window this function never produced (an unattributed or
        // out-of-scope path) can never be manufactured downstream either:
        // `_settleSessionServeBookings` only ever widens an EXISTING entry of
        // `windows`, never adds one.
        const range = parseServedRange(record["range"]) ?? parseServedRange(record["served_range"]);
        const synthetic = _isSyntheticRendering(carried as string);
        if (range === undefined) {
          // No declared window. A whole-file serve is the ordinary case and
          // covers the file — claiming less would retract a genuine serve. A
          // SYNTHETIC body with no window is a skeleton/outline batch entry:
          // ruling (s) says a skeleton is not a body, so it corroborates
          // nothing (round-17 finding 6 — it used to corroborate the whole
          // file, the same coordinate-space confusion in a second place).
          if (!synthetic) windows.push({ path: scopePath, start: 1, end: Number.MAX_SAFE_INTEGER });
        } else {
          // Both the synthetic (scope-view `range` IS file coordinates) and
          // ordinary cases take the declared window VERBATIM now — see the
          // comment above for where the `seh6` widening moved to.
          windows.push({ path: scopePath, start: range[0], end: range[1] });
        }
      }
    }

    // -------------------------------------------------------------------
    // FX-P1 (DESIGN-v0.15 ruling (u), 2026-09-03; round-17 finding 3) — A
    // TEXT ARTIFACT'S ROWS ARE BYTES ON THE WIRE.
    //
    // The walk above looks for a STRING body (`body`/`content`/`code`). A
    // csv/tsv `read.artifact` carries its evidence as a STRUCTURED table —
    // `{form:"csv", range:"2-61", columns:[…], rows:[[…],…]}` under the
    // response's own `path` — so it matched nothing and every `read.artifact`
    // payload projected `windows: []` (measured live, round-17 `r17_g`/`r17_c`).
    // FX-O2 then staged an honest booking for those rows and watched it be
    // retracted at settlement for want of corroboration: SAFE but inert.
    //
    // RULING (u)/(v), AS IMPLEMENTED (round-18A finding 1, 2026-09-03
    // correction). A `read.artifact` of a TEXT artifact that ships `rows` for
    // a row `range` IS bytes on the wire, and corroborates EXACTLY the
    // PHYSICAL file line span those rows occupy — no widening, no reach
    // extension. That span is carried on the wire as `file_range`
    // (`csvArtifactShape`/`bookCsvArtifactServe` in server.ts, and
    // `csvTable`/`office/csv.ts`, which is the ONE place that computes it) —
    // NOT `range`, whose LOGICAL row numbers diverge from file lines whenever
    // the file has a blank line (skipped when numbering rows) or an RFC4180
    // quoted field with an embedded newline: reading `range` here as a file
    // window let this corroboration CONFIRM a span the producer never
    // shipped, which is the direction ruling (t)/(v) exist to close (measured
    // live: `scratchpad/r18/a3_csv.mts`, `r18/b_csv_blank.mts` — a later
    // identical-range TEXT read answered `code-unchanged` for file lines that
    // were never on the wire). `file_range` is absent whenever the producer
    // could not establish a reliable mapping (fail-closed on the staging
    // side too — `bookCsvArtifactServe` books nothing in that case), so a
    // missing `file_range` corroborates nothing here, by construction the
    // same producer and this clause agree. Nothing here can WIDEN a staged
    // span: the settlement intersects, so a producer that staged less keeps
    // less.
    //
    // BINARY CONTAINERS GRANT NOTHING, and that is the dividing line ruling
    // (s) drew. `form:"xlsx.table"` also carries `rows` + `range`, but those
    // are SHEET coordinates in an OOXML container an `edit_file`
    // search/replace cannot target at all; docx/pptx/pdf/zip members are the
    // same. They keep `recordArtifactServedRange`'s separate sheet/range dedup
    // ledger and are excluded here by naming the ONE text form explicitly
    // rather than by testing for `rows`.
    //
    // A `budget`-shed csv response narrows its own `range`/`file_range` with
    // its rows (the bounded-head and columns-only rungs each rebuild the
    // table before booking), so the window this reads is already the
    // post-shed truth.
    const artifactRows = record["rows"];
    if (
      scopePath !== undefined
      && Array.isArray(artifactRows)
      && artifactRows.length > 0
      && (record["form"] === "csv" || (record["mode"] === "artifact" && record["kind"] === "csv"))
    ) {
      const fileRange = parseServedRange(record["file_range"]);
      if (fileRange !== undefined && fileRange[0] >= 1) {
        windows.push({ path: scopePath, start: fileRange[0], end: fileRange[1] });
      }
    }

    for (const [key, child] of Object.entries(record)) {
      // Not payload content: an emitted call's own arguments can carry a
      // `content` string (an edit's replacement text) that no consumer is
      // being served.
      if (key === "arguments") continue;
      visit(child, scopePath);
    }
  };

  visit(payload, undefined);
  return { unattributed, windows };
}

/**
 * `Refusal.for` — WHICH advertised tool refused.
 *
 * Three names in, three names out: after D11 the only tools that reach this
 * function are the three advertised ones, so `for` can only ever name a tool
 * the caller can actually see in `tools/list` (A.5.15). The C2-5 alias mapping
 * that sent the four deprecated write aliases at `edit_file` is deleted with
 * them.
 */
function toolNameOf(canonical: string): ToolName {
  if (canonical === "search_files") return "search_files";
  return WRITE_TOOLS.has(canonical) ? "edit_file" : "read_file";
}

/**
 * §3.4 E4 + D6 applied to a SUCCESS body.
 *
 * The ten E4 rows are deleted here rather than at each producer because every
 * one of them is a PROJECTION the server still computes and still enforces
 * in-process: `route` feeds the 15-rule oracle
 * (`features/task-pack/canonicalDecision.ts:427-505`), `continuation` and
 * `execution_contract.next_call` feed the fence, and deleting them from the
 * producers would be a semantics change §0.2 forbids. v1 deletes the WIRE
 * copies and keeps the single authority — `decision` — which
 * `decisionWire.ts` has already attached by the time this runs.
 */
function projectSuccessBody(
  kind: Kind,
  body: Record<string, unknown>,
  context: ProtocolCallContext,
): Record<string, unknown> {
  let projected: Record<string, unknown> = { ...body };

  // D6: body `ok` is deleted outright. `kind` carries the outcome.
  delete projected["ok"];

  // §3.4 E4 rows 1, 2 and 3 (the `continuation` half of the dual emit).
  delete projected["route"];
  delete projected["continuation"];
  // Row 2 is the task-pack prose call (`task-pack.ts:12-13`, derived at
  // `canonicalDecision.ts:217`), and it is an E4 row BECAUSE `decision` now
  // carries the same call authoritatively. Scoped to responses that carry a
  // `decision` for exactly that reason: `mode=full`'s `truncated` + `next`
  // chain is a DIFFERENT field with no second authority beside it — §4.4 lists
  // it as a `Limit{cause:"wire"}` re-expression, which is C2-3's migration, not
  // an E4 deletion. Deleting it here would remove the only way to follow a
  // truncated serve.
  if (typeof projected["next"] === "string" && projected["decision"] !== undefined) {
    delete projected["next"];
  }

  // §2.6/F6: `required_action` and the three progressivity fields it co-varies
  // with collapse into `decision.kind` on a success and into `Refusal.retry` on
  // a refusal. `next_call_is_template` goes with them — §2.6 removes the class
  // the marker exists for rather than freezing the marker.
  delete projected["required_action"];
  delete projected["next_call_is_template"];
  delete projected["terminal"];
  delete projected["terminal_reason"];
  delete projected["unlock"];

  // §3.4 E4 rows 4-9: the execution-contract re-encodings. `decisionWire.ts`
  // has already lifted their information into `decision`.
  const contract = projected["execution_contract"];
  if (contract !== null && typeof contract === "object" && !Array.isArray(contract)) {
    const lean: Record<string, unknown> = { ...(contract as Record<string, unknown>) };
    delete lean["state"];
    delete lean["readiness"];
    delete lean["next_action"];
    delete lean["discovery_complete"];
    delete lean["semantic_closure"];
    delete lean["max_additional_discovery_calls"];
    delete lean["next_call"];
    // A.2.7: a capability gap is a property of the DECISION and lives on
    // `decision.discover.gaps` and nowhere else.
    delete lean["capability_gaps"];
    // D12: substructure `version` never reaches the wire.
    delete lean["version"];
    projected["execution_contract"] = lean;
  }

  // -------------------------------------------------------------------------
  // A.5.1–A.5.7 (C2-3): the read family's authored bodies.
  //
  // RULE K lands HERE and nowhere else for this family: the top-level `kind`
  // vocabularies (`"xlsx"`, `"archive"`, …) are read by `projectReadBody` and
  // relocated into `content.form` / `outline.form` / `entries[].form`, so the
  // C2-2 interim that preserved them under a top-level `form` is deleted rather
  // than layered on. The read projector also applies RULE T (`truncated` /
  // `completeness` / `omitted[]` / `content_completeness` -> one `Limit`) and
  // §2.3's `receipt` tag.
  // -------------------------------------------------------------------------
  if (isReadFamilyKind(kind)) {
    // `workspace` + the inbound `args` ride along for the [R5-10]
    // receipt-continuation floor only (`projectReadBody`'s `read.receipt`
    // arm), which scopes its epoch-reset `next` to what this call asked for.
    projected = projectReadBody(kind, projected, {
      workspace: context.workspace,
      verifyClosureWorkspace: context.verifyClosureWorkspace,
      args: context.args,
    });
  } else if (isSearchFamilyKind(kind)) {
    // -----------------------------------------------------------------------
    // A.5.8–A.5.10 (C2-4): the search family's authored bodies.
    //
    // RULE K for this family is the `matches: {form, …}` wrapper — a NEW object
    // that covers `find`/`symbols`/`locate`/`diff`, which ship flat today — so
    // the C2-2 interim that held a top-level `kind` under `form` no longer
    // applies here and is scoped to `edit_file` below (C2-5's migration).
    // -----------------------------------------------------------------------
    projected = projectSearchBody(kind, projected, context.action ?? "", context.args ?? {});
    // TL_SEARCH_DEDUP (DESIGN-v0.15-sf-turn-economy.md §4, W-T-D, default
    // OFF): additive, on top of the A.5.8-A.5.10 projection above, never
    // instead of it. `codecTraceWorkspace` is read here as a SECOND consumer
    // beyond its originally-documented trace-only use (see that field's own
    // doc comment) — disclosed there — because it is the only workspace root
    // this funnel has for a read/search call by this point
    // (`noteWorkspaceRoot`'s `context.workspace` is populated by the edit
    // dispatcher only). Reading it here is still zero-effect with the flag
    // off: `applySearchDedup` is the identity function in that case.
    if (context.codecTraceWorkspace !== undefined) {
      projected = applySearchDedup(kind, projected, context.action ?? "", context.args ?? {}, context.codecTraceWorkspace);
    }
  } else if (isEditFamilyKind(kind)) {
    // -----------------------------------------------------------------------
    // A.5.11–A.5.14 (C2-5): the edit family's authored bodies, and the §4.2.1
    // floor.
    //
    // RULE K for this family stays the flat `form` relocation the C2-2 interim
    // introduced — an edit body that ships a top-level `kind` of its own
    // (`"xlsx"`, `"file"`) would SHADOW the protocol discriminator (D4) — and
    // the interim is no longer an interim: `editFamily.ts`'s allowlist carries
    // `form` deliberately. Unlike `search.matches`, this family has no INTERNAL
    // discrimination to nest it under; the member is one member.
    // -----------------------------------------------------------------------
    if (typeof projected["kind"] === "string" && projected["form"] === undefined) {
      projected["form"] = projected["kind"];
    }
    delete projected["kind"];
    projected = projectEditBody(kind, projected, context.workspace);
  }

  // -------------------------------------------------------------------------
  // THE ENVELOPE-LEVEL DISCLOSURE CLASS SURVIVES EVERY FAMILY PROJECTION.
  //
  // `dispatchWithWorkspaceNotes` stamps these four onto the top-level payload
  // INSIDE this funnel, just before finalization: `cwd_corrected` (the `.claire`
  // -> `.claude` adoption the caller did not ask for), `root_note` (Guard 1's
  // cross-workspace-bleed disclosure), `workspace` (the ambiguous-root
  // disclosure) and `workspace_crossing` (the nested-workspace boundary).
  //
  // They are NOT member content — they belong to no A.5.x field list, and every
  // per-family projector would therefore drop them, which is exactly what makes
  // this the wrong place to be silent.
  //
  // Restored for EVERY family (not just search): C2-3's read projectors drop
  // them today, which `readSessionGuards.spec.ts:178/210` and
  // `writeSessionGuards.spec.ts:294` were already red against before that
  // commit.
  //
  // [R5-21] ADJUDICATED 2026-08-14 (ruling 4), IMPLEMENTED P3a S1. The Rev-5
  // row this comment used to end with — "A.8 needs an envelope-level home for
  // server-authored disclosures that are about the CALL rather than the result"
  // — is now A.8.3, and the loop that used to sit here (a near-copy of the one
  // in `buildRefusal`) is now one call into the one mechanism. The rationale,
  // the four keys, and why the two paths keep separate POLICIES while sharing
  // one implementation live in `disclosure.ts`'s header.
  // -------------------------------------------------------------------------
  carryDisclosures(projected, body, SUCCESS_DISCLOSURE_KEYS, SUCCESS_DISCLOSURE_POLICY);

  // §2.6: placeholder-bearing calls are ABOLISHED, not marked. Deleting
  // `next_call_is_template` above without this would be strictly worse than
  // pre-v1 — an unmarked `edit_file` template whose `<exact text to replace>`
  // a caller sends as real bytes, which is the exact failure the marker was
  // added for. v1 removes the class: "a `next` is either fully executable or it
  // is not emitted."
  scrubTemplateCalls(projected);

  // NOT deleted here, deliberately: the edit family's per-member field lists,
  // which belong to C2-5. Beyond the read and search projections above, this
  // function is the §3.4 E4 ten-row deletion and D6 and nothing else — an
  // unlisted deletion would be a prune without an evidence class (§3.4's own
  // rule).
  return projected;
}

/** True iff `value` is in ToolCall position: `{tool: <advertised>, arguments: {}}`. */
function isToolCallShaped(value: unknown): value is { tool: string; arguments: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { tool?: unknown; arguments?: unknown };
  return typeof record.tool === "string" && isAdvertisedToolName(record.tool)
    && record.arguments !== null && typeof record.arguments === "object" && !Array.isArray(record.arguments);
}

/**
 * Delete every placeholder-bearing ToolCall-positioned value, at any depth.
 *
 * ONLY ToolCall-shaped objects are considered, and the walk never descends into
 * an `arguments` object. Both restrictions are load-bearing: a served evidence
 * `body` routinely contains `<T>`, `<div>`, `Array<string>` — scrubbing on a
 * bare angle-bracket match would delete served code.
 */
function scrubTemplateCalls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scrubTemplateCalls(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "arguments") continue;
    if (isToolCallShaped(child) && containsPlaceholderForCall(child.tool, child.arguments)) {
      delete record[key];
      // C2-6 (nested-scrub fix, C2-5 handoff): `next_call_is_template:true`
      // is a PAIRED marker — it exists to describe `next_call` (or `next`,
      // the other name `nextOf()` reads) IN THIS SAME OBJECT. The top-level
      // marker is already deleted unconditionally just above in
      // `projectSuccessBody`, but a template call NESTED inside another
      // field (e.g. a `read_back` preview attached to a `create`) is
      // scrubbed here, one or more levels down — where that unconditional
      // top-level deletion never reaches. Left behind, the marker survives
      // pointing at nothing: a dangling flag at best, and at worst read as
      // "the (now-deleted) call still needs placeholder substitution".
      // Deleting it here, at every depth the scrub itself recurses to,
      // closes the class instead of re-fixing it one nesting shape at a
      // time.
      if ((key === "next_call" || key === "next") && record["next_call_is_template"] !== undefined) {
        delete record["next_call_is_template"];
      }
      continue;
    }
    scrubTemplateCalls(child);
  }
}
