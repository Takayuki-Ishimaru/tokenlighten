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
import type { Kind, ToolName } from "@tokenlighten/types";

import {
  buildRefusal,
  containsPlaceholder,
  isRefusalBody,
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
  isSearchFamilyKind,
  projectSearchBody,
  searchRefusalBody,
  searchRefusalCodeFor,
} from "./searchFamily.js";

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
}

const _protocolCall = new AsyncLocalStorage<ProtocolCallContext>();

export function runWithProtocolCall<T>(context: ProtocolCallContext, fn: () => T): T {
  return _protocolCall.run(context, fn);
}

export function protocolCallContext(): ProtocolCallContext | undefined {
  return _protocolCall.getStore();
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
function isReceiptBody(body: Record<string, unknown>): boolean {
  // §2.3, and A.4's "NOT HERE" note: `query_mismatch` is NOT a receipt form in
  // v1. It is reclassified to `refusal` with `retry:"new-task"` and its
  // executable re-pack `next` — the receipt union has five forms and none of
  // them says "you asked a different question". Classified here rather than in
  // the body projector because WHICH member a response is is a `kind` question
  // (D4), and a receipt that is really a refusal is the wrong member however
  // its body is later shaped.
  if (body["query_mismatch"] === true) return false;
  return receiptOf(body) !== undefined;
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
  if (isReceiptBody(body)) return "read.receipt";

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
  const text = result.content[0]?.text;
  if (typeof text !== "string") return emitOpaqueText(result, context);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emitOpaqueText(result, context);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    // Defensive: every helper in this tree emits JSON. A non-JSON payload is a
    // bug elsewhere and must not be turned into a second bug here.
    return emitOpaqueText(result, context);
  }

  const kind = kindForCall(context, body, result.isError === true);
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

  // P3a S1: the payload is FINAL here. Everything downstream of this line —
  // serialization, the ONE byte measurement, the shed ladder, the [R5-10]
  // served-range settlement (now against the POST-shed payload, which is the
  // honest ledger order) and the §2.5 `isError` stamp — belongs to `emit.ts`.
  // The split is not cosmetic: it is what makes "one measurement point" a
  // structural property instead of a convention this function has to keep.
  return emitFinalizedPayload(payload, kind, context);
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
export function servedWindowsOf(payload: Record<string, unknown>): {
  unattributed: boolean;
  windows: Array<{ path: string; start: number; end: number }>;
} {
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
    const scopePath = typeof own === "string" && own !== "" ? own : inheritedPath;

    // `body` is the v1 evidence field; `content` and `code` are the pre-v1
    // dialects still spoken by members this projector passes through.
    const carried = [record["body"], record["content"], record["code"]]
      .find((candidate) => typeof candidate === "string" && candidate !== "");
    if (carried !== undefined) {
      if (scopePath === undefined) {
        unattributed = true;
      } else {
        // A body with no parsable range covers the file: whole-file serves
        // (`mode=full`, `small_file`) declare no window of their own, and
        // claiming less than everything here would retract a genuine serve.
        const range = parseServedRange(record["range"]) ?? parseServedRange(record["served_range"]);
        windows.push(range !== undefined
          ? { path: scopePath, start: range[0], end: range[1] }
          : { path: scopePath, start: 1, end: Number.MAX_SAFE_INTEGER });
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

const TOOL_NAMES: ReadonlySet<string> = new Set(["read_file", "edit_file", "search_files"]);

/** True iff `value` is in ToolCall position: `{tool: <advertised>, arguments: {}}`. */
function isToolCallShaped(value: unknown): value is { tool: string; arguments: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { tool?: unknown; arguments?: unknown };
  return typeof record.tool === "string" && TOOL_NAMES.has(record.tool)
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
    if (isToolCallShaped(child) && containsPlaceholder(child.arguments)) {
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
