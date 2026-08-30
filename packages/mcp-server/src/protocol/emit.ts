// ---------------------------------------------------------------------------
// protocol v1 — THE EMISSION PIPELINE (P3a S1).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §3 (module layout),
// §4.1 (the measurement point), §4.3 (the measure-driven ladder), §0.3 (the
// calibration invariant); DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2.1,
// §4.3, §4.4, A.6.2, A.8.
//
// -------------------------------- WHERE THIS SITS ---------------------------
//
// `envelope.ts`'s `finalizeProtocolResponse` is the one funnel every response
// from the three advertised tools leaves through. That function decides the
// response's `Kind` and PROJECTS the emitter's body into its A.5.x member. This
// module is its TAIL: everything from "the payload is final" to "these are the
// bytes on the wire".
//
// WHY THE TAIL, AND NOT `toolOk`. Plan §3.2 proposed narrowing
// `toolOk(data: unknown)` to `toolOk(result: ProtocolResult)` so that the
// pipeline became non-bypassable by construction. That is REFUTED at this HEAD:
// `server.ts`'s ~251 call sites pass PRE-projection ad-hoc bodies
// (`Record<string, unknown>` and object literals), and typing happens later, at
// the funnel. The funnel exists precisely so the call sites need no port — see
// `envelope.ts`'s "WHY A FUNNEL AND NOT 287 CALL SITES". So the measurement
// point goes where the bytes actually are: here. `toolOk` /
// `toolStructuredError` / `toolError` remain PRE-FUNNEL CONTENT CARRIERS and
// keep their signatures; `protocol/result.ts` says so at each of them.
//
// R1's residual closes here too. `supplyRefusalGuidance` (the "grower" that can
// ADD bytes to a refusal, `result.ts` -> `util/attachSupply.ts`) runs strictly
// earlier, inside `toolStructuredError`, so its output is measured naturally by
// this tail. And the funnel's three EARLY RETURNS — non-string content,
// non-object JSON, unparseable JSON — route through `emitOpaqueText` rather
// than around the pipeline, so no response leaves the funnel unmeasured.
//
// ------------------------- WHAT S1 SHIPS, AND WHAT IT DOES NOT --------------
//
// SHIPS: the measurement point (`budget/measure.ts`), the budget table
// (`budget/wireBudget.ts`), the required-set validator (`budget/validate.ts`,
// S2), the ladder runner (`budget/ladder.ts`, S3), the thirteen per-kind
// shedders (`budget/shedders/`, S3), the `ShedRecord[]` -> `Limit{cause:"wire"}`
// derivation (`budget/wireLimit.ts`, S3), and §4.3's fail-closed tail.
//
// DOES NOT SHIP (by stage assignment, not oversight):
//   S5  the §2.1.1 act-floor check and demote-to-`discover` — the slot is named
//       and always-holding in `budget/ladder.ts`
//   S6  the G8 grep fence over the measurement point, and the sweep
//
// §0.3 MAKES THE WHOLE PIPELINE A REFACTOR AT DEFAULT BUDGETS: byte-invisible
// on the wire. The budget table is calibrated so that no legitimate response is
// over budget, so the ladder runs zero steps, `mergeWireLimit` returns "do not
// touch", and the serialized string this module measures is the SAME string it
// returns. All fifteen §6.1(b) pins, the replay corpus and the conformance
// snapshot must therefore be byte-identical after every stage. Any wire delta
// at default budgets is a bug in this pipeline, not a new feature of it.
// ---------------------------------------------------------------------------

import type { Kind, ToolCall, ToolName } from "@tokenlighten/types";
import { createHash } from "node:crypto";

import { runLadder } from "./budget/ladder.js";
import { measureResponseBytes } from "./budget/measure.js";
import { budgetFor, type WireBudget } from "./budget/wireBudget.js";
import { shedderFor } from "./budget/shedders/index.js";
import type { ShedPayload } from "./budget/shedders/registry.js";
import { describeVerdict, validateProtocolBody, type ProtocolViolation } from "./budget/validate.js";
import { isKnownProtocolKind } from "./budget/requiredSets.js";
import {
  canonicalizeEmittedToolCalls,
  isErrorForKind,
  servedWindowsOf,
  type FinalizableResult,
  type ProtocolCallContext,
} from "./envelope.js";
import { buildRefusal } from "./refusal.js";
import { settleServedRanges } from "../state/session.js";
import { recordServedBytes } from "../util/packServeLog.js";
import { decisionInvariantStrictEnabled } from "../util/flags.js";
import { applyResponseCodec } from "./codec/pipeline.js";
import { ledgerCertificateBindingValid } from "./ledgerCertificateBinding.js";
import { trace, isTraceEnabled } from "../util/trace.js";

/**
 * The funnel tail: take a FINAL, already-projected payload to bytes.
 *
 * Order of operations, and why each step is where it is:
 *
 *  1. LADDER (`budget/ladder.ts`), which serializes and measures at the one
 *     sanctioned measurement point, one rung at a time, stopping at the first
 *     cut that fits — and returns the exact string it measured, so nothing is
 *     re-stringified downstream. This shape is the C-wave incident
 *     (`d7150ec3`, 2026-08-09) made mechanical: that ladder ran to its last
 *     rung, removed 3,158 B to close a 1,465 B overage, deleted the authority
 *     doc's surface entirely, and still left 1.7 KB of budget unused.
 *  2. FAIL CLOSED (see `failClosed`) if the ladder could not get under budget.
 *     Three outcomes, one per class of member, and no fourth.
 *  3. SETTLE THE SERVED-RANGE LEDGER against the POST-shed payload. [R5-10]
 *     put the ledger at the funnel because it grounds a claim about what
 *     reached the CONSUMER; a rung that drops an `Evidence.body` retracts that
 *     claim, so settling before the ladder would book bytes the caller never
 *     got. Byte-identical to the pre-P3a order whenever nothing sheds — which,
 *     at the calibrated budgets, is always.
 *  4. RECORD the emission on the call context (see `noteEmission`) and publish
 *     the shed history, then JUDGE the payload that actually ships against its
 *     §4.3 required set (see `enforceRequiredSet`). Recording first is
 *     deliberate: a strict-mode violation throws, and the byte record should
 *     already be on the context when it does.
 *  5. ASSEMBLE. `isError` is stamped iff A.8 rule E-3's three kinds — read off
 *     the kind that actually SHIPS, which a fail-closed conversion changes.
 *
 * KEY ORDER IS NOT INVENTED HERE. The caller hands over `{v, kind, …projection}`
 * already assembled, and every rung rebuilds objects in iteration order, so a
 * response that sheds nothing is serialized exactly as it arrived — by
 * identity, not by reconstruction. Reordering, re-spreading or normalising the
 * payload at this layer would be a byte change against the §6.1(b) pins even
 * when it changes no information.
 */
export function emitFinalizedPayload(
  payload: ShedPayload,
  kind: Kind,
  context: ProtocolCallContext,
  opts?: { budgetOverrideBytes?: number },
): FinalizableResult {
  if (!isKnownProtocolKind(kind)) return emitUnknownKindRefusal(kind, context);

  // THE BUDGET ROW, OR A TEST-ONLY OVERRIDE. Production callers pass no `opts`
  // at all; the override exists so a spec can drive the ladder past the point
  // §0.3's calibration makes unreachable (every row is >= 4x the largest cap
  // that can feed it) without editing the table the wire depends on. It is
  // read here and nowhere else, and it changes only WHEN the ladder engages —
  // never what a rung is allowed to cut.
  const declaredMaxBytes = typeof context.args?.["maxBytes"] === "number"
    && Number.isFinite(context.args["maxBytes"])
    && context.args["maxBytes"] > 0
    ? Math.floor(context.args["maxBytes"])
    : undefined;
  // A caller-declared maxBytes is the hard transport budget for this call;
  // maxTokens is converted to bytes by the request-side calibrated cap before
  // the funnel. Test overrides remain explicit and cannot affect production.
  const calibratedLimit = budgetFor(kind, formOf(payload, kind));
  const limit = opts?.budgetOverrideBytes
    ?? (declaredMaxBytes !== undefined
      ? Math.min(declaredMaxBytes, calibratedLimit)
      : calibratedLimit);
  const ladderContext = { ...(context.args !== undefined ? { args: context.args } : {}) };
  const stableEditKind = kind === "edit.applied"
    || kind === "edit.rolled_back"
    || kind === "edit.state_unknown";
  // A live caller cap tighter than the calibrated row re-enters the same
  // producer pipeline with that transport cap. SE-STABLE outcomes intentionally
  // bypass this re-entry and retain their state-preserving emergency reserve.
  const initialBudget = opts?.budgetOverrideBytes !== undefined
    ? limit
    : calibratedLimit;
  let ladder = runLadder({
    payload,
    kind,
    budget: initialBudget,
    context: ladderContext,
    validate: (candidate) => validateShedCandidate(candidate, kind),
  });
  if (!stableEditKind
    && opts?.budgetOverrideBytes === undefined
    && declaredMaxBytes !== undefined
    && declaredMaxBytes < calibratedLimit
    && ladder.used > limit) {
    const reentered = runLadder({
      payload: ladder.payload,
      kind,
      budget: limit,
      context: ladderContext,
      validate: (candidate) => validateShedCandidate(candidate, kind),
    });
    if (reentered.used < ladder.used) ladder = reentered;
  }

  let current = ladder.payload;
  let text = ladder.text;
  let used = ladder.used;
  let onWire = kind;

  // STILL OVER BUDGET AFTER THE LADDER — §4.3's tail, three outcomes and no
  // fourth. Unreachable at the calibrated table; reachable through
  // `budgetOverrideBytes`, which is how the sweep exercises it.
  if (used > limit) {
    const converted = failClosed(kind, context, limit, used, ladder.continuation);
    if (converted !== undefined) {
      current = converted;
      onWire = "refusal";
      text = JSON.stringify(current);
      used = measureResponseBytes(text);
    }
  }

  // §4.3 REQUIRED SET, judged on the payload that ships and BEFORE the ledger
  // half books anything: a response replaced by a refusal here must not leave
  // served-window bookings or emission rows behind that the refusal does not
  // carry (the same accounting rule the unknown-kind gate above follows).
  const requiredSetReplacement = enforceRequiredSet(current, onWire, context);
  if (requiredSetReplacement !== undefined) return requiredSetReplacement;
  if ((onWire === "read.task_pack") && !ledgerCertificateBindingValid(current)) {
    const detail = "protocol v1 ledger certificate binding violation; producer emitted an unverifiable act decision";
    if (decisionInvariantStrictEnabled()) throw new Error(detail);
    const tool = advertisedTool(context.tool);
    if (tool === undefined) throw new Error(detail);
    const refusal = buildRefusal(tool, { code: "invalid-input", retry: "none", detail });
    const refusalText = JSON.stringify(refusal);
    noteEmission(context, { limit: 0, used: measureResponseBytes(refusalText) });
    return { content: [{ type: "text", text: refusalText }], isError: true };
  }

  // [R5-10], THE LEDGER HALF. Anything the nine booking sites recorded that
  // this response does not actually carry is retracted, and those lines stay
  // discovery-eligible. Runs for every kind, refusals included: a refusal
  // carries nothing, so a serve path that booked before refusing books nothing.
  //
  // AGAINST THE POST-SHED PAYLOAD, which is why the ladder runs first: a rung
  // that dropped an `Evidence.body` retracts the claim that those bytes reached
  // the consumer, and `servedWindowsOf` sees the retraction automatically
  // because it books a window iff a body string is present at that node.
  if (context.workspace !== undefined && context.workspace !== "") {
    settleServedRanges(context.workspace, servedWindowsOf(current));
  }

  const shed = ladder.records;
  // V10-11: choose the wire REPRESENTATION of the payload already finalized
  // above -- a no-op unless TOKENLIGHTEN_RESPONSE_FORMAT/TL_WIRE_SHADOW is
  // explicitly set (protocol/codec/pipeline.ts), which is what keeps this a
  // byte-invisible refactor at default budgets, matching this file's own
  // "REFACTOR AT DEFAULT BUDGETS" invariant above. Re-measured through the
  // ONE sanctioned byte counter so `emittedBytes`/`used` describe what is
  // actually on the wire.
  text = applyResponseCodec(text, current, onWire, context, limit);
  used = measureResponseBytes(text);
  noteEmission(context, { limit, used, ...(shed.length > 0 ? { shed } : {}) }, text, kind, shed.length > 0);
  context.shedRecords = shed;

  // I-7 (2026-08-30 forensics attribution wave): the funnel tail is where the
  // FINAL kind/bytes that actually ship are known -- see
  // ProtocolCallContext.postReadyDiscovery's doc comment for the fire
  // condition. `workspace` is edit-only on this context; `codecTraceWorkspace`
  // is the one read_file/search_files dispatch always publishes (D1/F-C2a).
  const postReadyWorkspace = context.workspace ?? context.codecTraceWorkspace;
  if (context.postReadyDiscovery !== undefined && postReadyWorkspace !== undefined && isTraceEnabled()) {
    trace(
      "post_ready_followup",
      {
        tool: context.tool,
        kind_served: onWire,
        bytes: used,
        force_serve: context.postReadyDiscovery.forceServe,
        scope_class: context.postReadyDiscovery.scopeClass,
      },
      postReadyWorkspace,
    );
  }

  const finalized: FinalizableResult = {
    content: [{ type: "text", text }],
  };
  if (isErrorForKind(onWire)) finalized.isError = true;
  return finalized;
}

/**
 * §4.3's TAIL: what to do when the ladder ran out and the payload still will
 * not fit. Returns the converted payload, or `undefined` for "emit what you
 * have".
 *
 * THREE OUTCOMES, one per class of member:
 *
 *  1. SE-STABLE (`edit.applied`, `edit.rolled_back`, `edit.state_unknown`) —
 *     EMIT REGARDLESS, never convert. A refusal in their place asserts that
 *     nothing happened, about a disk where something did (§4.2.1(1)). The
 *     32 KiB reserve is what makes the floor fit (S4's proof); this branch is
 *     what happens if a future misconfiguration defeats it, and shipping an
 *     over-budget truth beats shipping a well-sized lie. (SIZE only: a
 *     side-effect body that fails its §4.3 REQUIRED SET is replaced by a
 *     state-unknown refusal in `enforceRequiredSet` — malformation leaves no
 *     truth to ship oversized.)
 *  2. `read.receipt` / `read.closure` — EMIT REGARDLESS, and RECORD A
 *     VIOLATION. §5.4 measures both at ~350 B and says a budget below ~400 B
 *     "cannot fit them => STARTUP MISCONFIGURATION". S4's floor check is where
 *     that is caught; if a response reaches here anyway, the honest report is
 *     the response plus a finding on the call context — converting a receipt
 *     the caller is waiting on into a refusal would answer a question about
 *     residency with a question about configuration.
 *  3. EVERYTHING ELSE — a fail-closed `refusal` NAMING THE LIMIT, with
 *     `retry:"call"` and the ladder's own narrower `next` when it built one.
 *     A `refusal` is already the conversion target and is emitted as it stands.
 *
 * THE CODE IS `cap-exceeded`, HARVESTED NOT MINTED. A.7.1 files it under
 * `ReadLimitCode` and its existing emitters are read-side byte caps
 * (`server.ts:2874`, `:3016`) — the wire budget is the same fact one layer out,
 * and A.7.1's membership rule is about what can appear as `Refusal.code`, not
 * about which sub-union a value was first grouped into. Minting a
 * `response-too-large` beside it would add a second spelling of one condition,
 * which is precisely what [R5-9] spent an adjudication removing elsewhere. The
 * cross-tool placement is recorded as an S3 note rather than fixed by a mint.
 */
function failClosed(
  kind: Kind,
  context: ProtocolCallContext,
  limit: number,
  used: number,
  next: ToolCall | undefined,
): ShedPayload | undefined {
  if (!shedderFor(kind).refusalConvertible || kind === "refusal") return undefined;

  if (kind === "read.receipt" || kind === "read.closure") {
    recordProtocolViolation(context, {
      kind,
      missing: [],
      violated: [`wire/floor-exceeds-budget:${used}>${limit}`],
    });
    return undefined;
  }

  const forTool = advertisedTool(context.tool);
  // No advertised tool means no `for`, and `for` is in A.5.15's required set —
  // so there is no honest refusal to convert INTO. Emit the over-budget
  // response rather than a malformed replacement for it.
  if (forTool === undefined) return undefined;

  // W2-3: `next` is `ladder.continuation` — a `ToolCall` minted mid-ladder,
  // BEFORE `finalizeProtocolResponse`'s one canonicalization pass
  // (envelope.ts:579) ever runs, because that pass already finished before
  // this function's caller (`emitFinalizedPayload`) started the ladder. A
  // refusal built here is therefore a BRAND NEW payload the earlier pass
  // never saw, and its embedded `next.arguments` stayed in whatever shape
  // the shedder minted it — legacy (`{mode:"slice",...}`) at this HEAD,
  // confirmed schema-INVALID against the D-2 advertised-only surface (a
  // live sweep at a tight budget, e.g. `budget:{bytes:300}`, reproduces it
  // 2-for-2). Re-running the SAME `canonicalizeEmittedToolCalls` the normal
  // path already uses — not a second, parallel implementation of it — on
  // this function's own return value closes that gap at its only other
  // mint point, without touching the ladder's input or any byte the normal
  // (non-fail-closed) path already produces.
  return canonicalizeEmittedToolCalls({
    ...buildRefusal(forTool, {
      code: "cap-exceeded",
      retry: "call",
      detail:
        `the ${kind} response measured ${used} B against a ${limit} B wire budget and could not be `
        + "reduced further without breaking its required set; re-issue a narrower call",
      ...(next !== undefined ? { next } : {}),
    }),
  }) as ShedPayload;
}

/** `context.tool` narrowed to A.1's three advertised names, or `undefined`. */
function advertisedTool(tool: string): ToolName | undefined {
  return tool === "read_file" || tool === "edit_file" || tool === "search_files" ? tool : undefined;
}

function isSideEffectKind(kind: Kind): boolean {
  return kind === "edit.applied" || kind === "edit.rolled_back" || kind === "edit.state_unknown";
}

type ProtocolInvariantContext = ProtocolCallContext & { protocolViolationCount?: number };

function recordProtocolViolation(context: ProtocolCallContext, violation: ProtocolViolation): void {
  context.protocolViolations = [...(context.protocolViolations ?? []), violation];
  const counted = context as ProtocolInvariantContext;
  counted.protocolViolationCount = (counted.protocolViolationCount ?? 0) + 1;
}

function emitUnknownKindRefusal(kind: unknown, context: ProtocolCallContext): FinalizableResult {
  const detail = `protocol v1 unknown runtime kind ${String(kind)}; re-issue the call`;
  const tool = advertisedTool(context.tool);
  if (tool === undefined) throw new Error(detail);
  const refusal = buildRefusal(tool, { code: "unknown-kind", retry: "none", detail });
  const text = JSON.stringify(refusal);
  const counted = context as ProtocolInvariantContext;
  counted.protocolViolationCount = (counted.protocolViolationCount ?? 0) + 1;
  noteEmission(context, { limit: 0, used: measureResponseBytes(text) });
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Wave-11 B4's production edge for the three side-effect kinds: the required
 * set failed on the payload that ships, so the truthful report is neither the
 * malformed body (it cannot testify to the write outcome) nor a transport
 * exception (it strips recovery) — it is a refusal that SAYS THE WRITE MAY
 * HAVE LANDED and routes the caller to verification. `recordProtocolViolation`
 * has already booked the audit row before this runs; emission accounting
 * mirrors `emitUnknownKindRefusal` above.
 */
function emitSideEffectViolationRefusal(
  kind: Kind,
  violation: ProtocolViolation,
  context: ProtocolCallContext,
): FinalizableResult {
  const detail =
    `protocol v1 required-set violation (fail-closed side-effect) on ${kind} — ` +
    `${describeVerdict(violation)}. The write may have reached disk: treat workspace state as ` +
    `unverified and re-read the edited paths (or run a diff) before continuing.`;
  const tool = advertisedTool(context.tool);
  if (tool === undefined) throw new Error(detail);
  const refusal = buildRefusal(tool, { code: "invalid-input", retry: "none", detail });
  const text = JSON.stringify(refusal);
  noteEmission(context, { limit: 0, used: measureResponseBytes(text) });
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The MEASURE-ONLY path, for the funnel's three early returns: a response whose
 * `content[0].text` is not a string, is not a JSON object, or does not parse.
 *
 * Returns `result` ITSELF — the same object, the same string — so the bytes are
 * identical by identity rather than by reconstruction. There is no `kind` on
 * this path, therefore no budget row, no ladder, and nothing to settle.
 *
 * WHY MEASURE AT ALL. R1's residual is the class "some responses leave the
 * funnel without passing the measurement point". A pipeline that measures only
 * the paths it also shapes leaves that class open, and every later stage that
 * reasons about "what this server emitted" would be reasoning about a subset it
 * cannot name. Routing the early returns through here closes it: after S1,
 * every funnel exit that carries a text body has been measured, and the
 * measurement is recorded on the call context rather than discarded.
 */
export function emitOpaqueText(
  result: FinalizableResult,
  context: ProtocolCallContext,
): FinalizableResult {
  const text = result.content[0]?.text;
  if (typeof text === "string") {
    const used = measureResponseBytes(text);
    noteEmission(context, { limit: 0, used });
  }
  return result;
}

/**
 * Record one emission on the per-call context.
 *
 * The context is an `AsyncLocalStorage` slot bound once per call, so this is
 * per-call state and not process-global: two concurrent calls on one server
 * cannot cross-contaminate, the same property `envelope.ts`'s kind declaration
 * and `state/session.ts`'s lane binding already rely on.
 *
 * S1 records the byte count and nothing else acts on it. S4's reserve
 * assertion and S6's fence attach HERE, which is the point of writing it down
 * now: one sink, one field, one place for a later stage to hook — rather than
 * three call sites each rediscovering how to measure.
 *
 * `limit: 0` on the opaque path is not a budget of zero; it is "this path has
 * no budget row", which is what `budgetFor` would have needed a `kind` to
 * answer.
 */
function carriesVerificationKit(text: string, kind: Kind | undefined): boolean {
  if (kind !== "edit.applied") return false;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return body.verification !== undefined;
  } catch {
    return false;
  }
}

function noteEmission(
  context: ProtocolCallContext,
  budget: WireBudget,
  text?: string,
  kind?: Kind,
  trimmed = false,
): void {
  context.emittedBytes = budget.used;
  if (text === undefined) return;
  const args = context.args;
  const epoch = typeof args?.["taskEpoch"] === "string" ? args["taskEpoch"] : undefined;
  const lane = typeof args?.["lane"] === "string" ? args["lane"] : undefined;
  const workspace = context.workspace;
  if (workspace === undefined || workspace === "") return;
  // B-F5 (2026-08-28): named "budget-shed", not "trim" — `trimmed` here is
  // exactly `shed.length > 0` from THIS call's own budget ladder (see the
  // one caller below), i.e. "the ladder cut at least one record to fit the
  // budget". Post-ready trim and prior-pack dedup set explicit provenance
  // before this funnel, while unannotated calls retain the historical
  // kind/body inference below.
  // Producer routes may know why a body was reduced or withheld before the
  // final envelope exists. Prefer that explicit provenance; retain the
  // historical kind/body inference for every unannotated call.
  const source = context.servedBytesSource
    ?? (kind === "read.receipt"
      ? "receipt"
      : trimmed
        ? "budget-shed"
        : carriesVerificationKit(text, kind)
          ? "verification-kit"
          : args?.["qref"] !== undefined
            ? "replay"
            : "fresh");
  const ledgerResult = recordServedBytes({
    workspaceRoot: workspace,
    epoch,
    lane,
    bytes: budget.used,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    source,
    forceServe: args?.["force_serve"] === true,
  });
  context.servedBytesNovel = ledgerResult.novel;
}

/**
 * The `form` a payload discriminates on, for the three kinds whose budget row
 * is keyed by (kind, form). Read off the LIVE projection, at the address Rule K
 * assigned it — `outline.form`, `matches.form`, and A.4's `receipt` tag.
 *
 * `undefined` for every other kind, and for a payload whose discriminator is
 * missing or not a string: `budgetFor` then falls back to the family maximum,
 * which is the fail-OPEN direction and the correct one under §0.3.
 */
function formOf(payload: ShedPayload, kind: Kind): string | undefined {
  switch (kind) {
    case "read.map":
      return stringField(payload["outline"], "form");
    case "search.matches":
      return stringField(payload["matches"], "form");
    case "read.receipt":
      // A.4's tag is the field named `receipt` INSIDE the `receipt` block:
      // `{"kind":"read.receipt","receipt":{"receipt":"pack-unchanged",…}}`.
      return stringField(payload["receipt"], "receipt");
    default:
      return undefined;
  }
}

/** `record[field]` when `record` is a plain object and the field is a string. */
function stringField(record: unknown, field: string): string | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * THE LADDER'S ACCEPTANCE GATE (plan §4.2), S1's stub now real.
 *
 * A rung proposes; this disposes. The candidate is judged against the SAME
 * required set the finished response is judged against, so a rung cannot buy
 * bytes by cutting something §4.3 requires — the C-wave failure mode, where a
 * ladder with no judge deleted the authority document's surface to close a
 * 1,465 B overage.
 *
 * The form is re-read off the CANDIDATE rather than reused from the pre-ladder
 * payload: no rung changes a discriminator today, and a rung that did would be
 * emitting a different member than the one the budget row was drawn for.
 *
 * A refused candidate is not a violation of anything — it never shipped — so it
 * is not recorded on the call context. Only `enforceRequiredSet` records.
 */
function validateShedCandidate(candidate: ShedPayload, kind: Kind): boolean {
  return validateProtocolBody(candidate, kind, formOf(candidate, kind)).ok;
}

/**
 * JUDGE THE PAYLOAD THAT SHIPS, and act on the verdict by environment.
 *
 * PRODUCTION RECORDS. A violation is written to the call context beside
 * `emittedBytes` and the response is emitted UNCHANGED. §0.3 makes P3a
 * byte-invisible; a validator that rewrote, truncated or converted a response
 * on its way out would be the exact class §4.2.1 forbids — a delivery mechanism
 * deciding what a result says — and it would do so on the strength of a table,
 * against a caller who is waiting for an answer. The honest terminations for a
 * response that cannot satisfy its member (§4.2's fail-closed refusal, §4.2.1's
 * SE-STABLE floor) are decisions for the PRODUCER, upstream of the funnel.
 *
 * TESTS THROW. `TL_DECISION_INVARIANT_STRICT=1` is set by both vitest configs
 * (`vitest.config.ts:27`, `packages/mcp-server/vitest.config.ts:40`) and by
 * nothing else, so every test run is a hard gate on this table while production
 * stays fail-open. That combination is what makes the 242-case replay corpus
 * and the fifteen §6.1(b) pins the validator's proving ground: they exercise
 * real bodies through this exact line, and a table that is wrong about any of
 * them fails a test rather than silently mislabelling the wire.
 *
 * The precedent is the house one — `editFamily.ts`'s projector wraps its work
 * in a try/catch and falls back rather than failing a response that already
 * happened. Non-side-effect kinds keep that fail-open posture with a test-only
 * hard edge. SIDE-EFFECT KINDS (wave-11 B4) carry a production edge as well: a
 * side-effect body that fails its required set cannot testify to what the
 * write did, so it is REPLACED by a structured refusal whose detail says the
 * workspace state is unverified (`emitSideEffectViolationRefusal`). It is a
 * refusal rather than a thrown error because a transport exception would strip
 * the caller of every protocol recovery affordance (`code`/`retry`/`detail`)
 * at the exact moment disk state is in doubt; and it is not budget conversion —
 * `failClosed`'s SE-STABLE rule ("ship the over-budget truth") still governs
 * SIZE, this edge governs MALFORMATION.
 */
function enforceRequiredSet(
  payload: ShedPayload,
  kind: Kind,
  context: ProtocolCallContext,
): FinalizableResult | undefined {
  const result = validateProtocolBody(payload, kind, formOf(payload, kind));
  if (result.ok) return undefined;

  const violation: ProtocolViolation = {
    kind: result.kind,
    ...(result.form === undefined ? {} : { form: result.form }),
    missing: result.missing,
    violated: result.violated,
  };
  recordProtocolViolation(context, violation);

  if (isSideEffectKind(kind)) return emitSideEffectViolationRefusal(kind, violation, context);
  if (decisionInvariantStrictEnabled()) {
    throw new Error(`protocol v1 required-set violation (strict) — ${describeVerdict(violation)}`);
  }
  return undefined;
}
