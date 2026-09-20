// ---------------------------------------------------------------------------
// protocol v1 — the `read_file` response family, authored (C2-3).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §10.3 Appendix A
// (Revision 4, user-approved 2026-08-13) A.4, A.5.1–A.5.7, A.2.7, A.8, plus
// §4.4 (the gaps / limits / evidence trichotomy) and §3.4.1 (CONDITION ①).
//
// WHAT THIS MODULE IS. `protocol/envelope.ts` decides WHICH member a response
// is (D4's `kind`). This module decides what that member's BODY looks like: it
// takes the shape today's emitters produce and returns the shape A.5.x
// specifies. It runs inside the same funnel, for the same reason C2-2 put the
// E4 deletions there — the read family has ~40 emit sites across `server.ts`,
// `tools/`, `features/task-pack/` and `state/`, every one of which is ALSO an
// in-process authority some runtime guard reads. Reshaping at the producers
// would change what the fence, the governor and the ledger see, which is a
// semantics change §0.2 forbids. Reshaping at the funnel changes the WIRE and
// nothing else.
//
// THE THREE RULES THIS MODULE APPLIES.
//
//  RULE K (A.5.3–A.5.10 preamble, A.9.2 row 7). The top-level `kind` is the
//  sole discrimination contract. Every body that shipped a top-level `kind` of
//  its own vocabulary has it relocated INTO the payload as `content.form`
//  (`read.artifact`) or `outline.form` (`read.map`) or `entries[].form`
//  (`read.batch`). C2-2 held those values under an interim top-level `form`;
//  this module is the migration that comment promised, and the interim hold is
//  deleted from `projectSuccessBody` for the read family.
//
//  RULE T (A.5.3–A.5.10 preamble, §4.4). Response-level truncation is `limit`
//  and appears in no other form; absence of `limit` IS completeness. Per-source
//  truncation survives ONLY as `Evidence.remaining` and as `read.batch`'s
//  per-entry `truncated`. The per-item `omitted[] {path|handle, reason}` ledger
//  is deleted and becomes `limit.omitted: OmittedClass[]`.
//
//  E-1 (A.8.1). An optional field is emitted iff its condition holds: `[]`,
//  `{}`, `""` and `null` are never emitted in place of absence.
//
// DISCLOSED DEVIATIONS. Where A.5.x's field list would delete a field the agent
// guide binds a capability to, the field is KEPT and the keep is DECLARED at
// its call site with a reason, per the C2-2 precedent (keep reversibly, raise a
// Revision-5 row). Every such keep is in one of the `KEPT_*` tables below, so
// the deviation set is one grep rather than a reading exercise.
// ---------------------------------------------------------------------------

import type {
  Evidence, Kind, Limit, OmittedClass, Receipt, TaskVerifyObligation, ToolCall,
} from "@tokenlighten/types";

import { emittableToolCall, parseProseToolCall } from "./refusal.js";
// PI-03 attestation tier (default OFF). `clientAcknowledgedPrior` is false for
// every unattested call, so the two uses below are dead code on the default
// path — which is exactly the property that keeps this projector's bytes
// unchanged without the flag.
import { clientAcknowledgedPrior } from "../state/contextAttestation.js";
// W-LEDGER (DESIGN-v0.15-sf-turn-economy.md §2). `TL_RECEIPT_COVERAGE` is
// default OFF, so `projectCoveredBy` below returns `undefined` for every call
// on the default path and this projector's bytes are unchanged without the
// flag — the same dead-code-by-default property `clientAcknowledgedPrior` has.
// W-VERIFY-CLOSURE (DESIGN-v0.15-sf-verification-first.md §4). `TL_SF_VERIFY_FIRST`
// is default OFF, so `verifyClosureGate` returns `undefined` on its FIRST LINE for
// every call on the default path — the same dead-code-by-default property, and the
// structural reason flag-off is byte-identical rather than merely tested to be.
import { receiptCoverageEnabled, sfVerifyFirstEnabled } from "../util/flags.js";
import { recordedVerifyObligations } from "../state/session.js";
import type { CoveredSpan } from "./coverageReceipt.js";
// FX-OH F2: the demote pass's own withholding marks — the ONLY driver of
// `nextTargetsWithheldFrontierRow`, and empty with `TL_SF_DEMOTE` off.
import {
  semanticFrontierEvidenceWitnessId,
  semanticFrontierWithholdingMarks,
} from "./semanticFrontierTraceContext.js";

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** E-1: copy `keys` from `from` onto `onto` iff the value is present and non-empty. */
function keep(onto: Body, from: Body, keys: readonly string[]): void {
  for (const key of keys) {
    const value = from[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    onto[key] = value;
  }
}

/**
 * A served window's range, in either dialect the read emitters produce.
 *
 * `"12-48"` is the dominant spelling, but `mode=symbol` carries the symbol's
 * bounds as the OBJECT `getSymbolWithContext` computed them
 * (`{start: found.startLine, end: found.endLine}`) and hands that object
 * straight to the wire. Reading only the string form made every symbol serve
 * project to `evidence: []` — a `read.text` response whose A.5.2 required set
 * (>=1 `FreshEvidence`) was empty while the bytes were sitting in the body.
 */
function rangeOf(value: unknown): string | undefined {
  const declared = str(value);
  if (declared !== undefined) return declared;
  if (!isRecord(value)) return undefined;
  const start = value["start"];
  const end = value["end"];
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return `${start}-${end}`;
}

/**
 * The served bytes, in either dialect the read emitters produce.
 *
 * `content` is the slice/full spelling; `code` is the SYMBOL spelling, used by
 * the direct `mode=symbol` serve (`server.ts`'s
 * `{...symbolData, code: symbolCode, handle, sha}`), by
 * `buildSymbolDowngradePayload`'s trimmed head, and — per segment — by the
 * `ranges[]` batch (`servedSegments`'s fresh arm emits `code`, its already-held
 * arm emits `code_unchanged`). Reading only `content` left those entries with
 * neither `body` nor `prior`, which is an E-8 violation on the wire: a bare
 * entry asserts addressing and says nothing about where the bytes are.
 *
 * The emitters are NOT renamed: each of these keys is read in-process by a
 * governor, a ledger or a fence, and renaming a producer to suit the projector
 * is the semantics change §0.2 forbids. The projector learns the dialect.
 */
function servedBody(source: Body): string | undefined {
  return str(source["content"]) ?? str(source["code"]);
}

function lineCount(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return text.endsWith("\n") ? lines - 1 : lines;
}

// ---------------------------------------------------------------------------
// A.2.7 `Limit` — Rule T's single carrier
// ---------------------------------------------------------------------------

/**
 * §4.4: `omitted[]` is "a coarse enum, not a per-item ledger", in three values.
 * The mapping from today's per-item ledgers:
 *
 *   - a dropped SOURCE (a path/handle a batch or a pack could not carry) is
 *     `"evidence"` — it is a thing the caller would have read;
 *   - a dropped ROW/RECORD inside a served source (csv/xlsx rows, a capped
 *     entry list) is `"results"`;
 *   - a dropped PROJECTION of the response about itself (heading indexes,
 *     ledgers, prose) is `"metadata"`.
 */
function omittedClasses(body: Body): OmittedClass[] {
  const classes = new Set<OmittedClass>();
  const omitted = body["omitted"];
  if (Array.isArray(omitted) && omitted.length > 0) classes.add("evidence");
  if (typeof body["surface_drops"] === "number" && body["surface_drops"] > 0) classes.add("evidence");
  if (body["artifact_sections_trimmed"] !== undefined) classes.add("evidence");
  if (body["truncated"] === true || body["content_completeness"] === "partial") classes.add("evidence");
  if (truncatedMember(body)) classes.add("evidence");
  if (body["headings_truncated"] === true) classes.add("metadata");
  return [...classes];
}

/**
 * True iff a member of a multi-window serve was cut, on a body whose OWN
 * `truncated` is unset.
 *
 * Rule T keeps a per-entry `truncated` only on `read.batch` (§4.3). A `read.text`
 * multi-section serve (`items[]`) carries the same per-entry flag and has no
 * per-entry slot in A.2.7, so the fact is lifted to the response level, where
 * Rule T's single carrier can state it: a response that shipped a cut section
 * did withhold something, and absence of `limit` would claim otherwise.
 */
function truncatedMember(body: Body): boolean {
  for (const key of ["items", "segments", "windows"]) {
    const entries = body[key];
    if (!Array.isArray(entries)) continue;
    if (entries.some((entry) => isRecord(entry) && entry["truncated"] === true)) return true;
  }
  // Same rule one level down: §4.6d's inlined artifact section nests its own
  // `truncated` under `section`, where the body's own flag never sees it.
  const section = body["section"];
  if (isRecord(section) && section["truncated"] === true) return true;
  return false;
}

/**
 * §2.1.2 (F5): a `next` is executable or it is not emitted. Prose `next`
 * strings (`"read_file mode=slice handle=h1 ranges=[...]"`) are the dominant
 * shape in the read family, so they are PARSED rather than dropped — dropping
 * them would leave a `wire` limit with no continuation, which E-5 forbids.
 *
 * Derivation order, most specific first:
 *   1. the body's own `next` (already a `ToolCall`, or parseable prose);
 *   2. a same-handle zoom over the windows this response left unserved;
 *   3. the paths a batch dropped.
 *
 * THERE IS NO BARE-HANDLE RUNG. `{mode:"slice", handle}` with no range and no
 * `ranges` re-serves exactly the window this response already served, so it is
 * a `next` that cannot make progress — the dead-end class the 2026-08-08
 * forensics closed and the one §2.1.2 (F5) exists to forbid. The reachable case
 * is a serve truncated mid-line in a file with no later line to name (a
 * single-line oversized .txt): the honest encoding is the `source` arm, which
 * promises no recovery, plus the body's own `hint` naming `mode=full`. A
 * `limit.next` that re-serves the caller's own bytes is worse than no `next`,
 * because the caller spends a turn to learn nothing.
 */
function deriveNext(body: Body): ToolCall | undefined {
  const explicit = emittableToolCall(body["next"]);
  if (explicit !== undefined) return explicit;
  const prose = str(body["next"]);
  if (prose !== undefined) {
    const parsed = parseProseToolCall(prose);
    if (parsed !== undefined) return parsed;
  }
  // Rung 1b: several read emitters spell the SAME field `next_call` and give it
  // the structured form outright (the markdown overview's "read the first
  // section" call, server.ts:5422). It is read only on a body that already
  // withheld something — `limitFrom` is the only caller — so this cannot invent
  // a continuation for a complete response.
  const explicitCall = emittableToolCall(body["next_call"]);
  if (explicitCall !== undefined) return explicitCall;
  const handle = str(body["handle"]);
  const remaining = stringArray(body["remaining_ranges"]);
  if (handle !== undefined && remaining.length > 0) {
    return { tool: "read_file", arguments: { mode: "slice", handle, ranges: remaining.slice(0, 8) } };
  }
  const omitted = body["omitted"];
  if (Array.isArray(omitted)) {
    const paths = omitted
      .map((entry) => (isRecord(entry) ? str(entry["path"]) : undefined))
      .filter((path): path is string => path !== undefined);
    if (paths.length > 0) {
      return { tool: "read_file", arguments: { mode: "full", paths: paths.slice(0, 8) } };
    }
  }
  return undefined;
}

/**
 * Rule T, applied: one `Limit` or nothing.
 *
 * E-4: emitted iff the response withheld something it could otherwise have
 * carried. E-5: `wire`/`records` REQUIRE `next`; `source` and `capped` FORBID
 * it.
 *
 * [R5-9] THE ENCODING GAP THIS FUNCTION DECLARED IS NOW CLOSED (ratified
 * 2026-08-14). It used to read: "a byte-cap truncation whose continuation this
 * server cannot name has no representation in A.2.7's union — `wire` promises
 * recoverability it cannot deliver, and `source` claims the file itself ended",
 * and it resolved that by emitting `source`, on the reasoning that F5's split
 * is a promise about RECOVERABILITY and `source` is the arm that promises none.
 * That reasoning was half right. `source` does promise nothing — but it also
 * ASSERTS something, and the assertion was false: the shipped guide teaches
 * "`source` never has one", i.e. terminal, so a capped serve told the caller to
 * stop looking for bytes that were still in the file. `capped`
 * (`packages/types/src/mcp/protocol.ts`) is the arm minted for it: no `next`,
 * and no claim that the content is gone.
 *
 * THE NO-`next` ARM HAS TWO POPULATIONS, AND ONLY ONE OF THEM WAS MISLABELLED.
 *
 *  1. A CAP FIRED — `truncated`, `content_completeness:"partial"`,
 *     `remaining_ranges`, `surface_drops`, `byte_budget`/`map_cap_bytes`,
 *     `headings_truncated`, a cut member. The bytes are still in the file and
 *     this response could not carry them: `capped`. The two reachable shapes
 *     are the single-line oversized file (cut mid-line, with no later line a
 *     range could name) and a heading index capped on a response that served
 *     its content whole. Both keep their own prose affordance (`hint`,
 *     `headings_note`/`sections_hint`) on the body, so `capped` withholds a
 *     call, not the knowledge of what to do.
 *
 *  2. A REFERENCE RESOLVED TO NOTHING — the only signal is an `omitted[]`
 *     entry, and it reaches this arm precisely BECAUSE it names no path
 *     (`deriveNext`'s rung 3 turns any `omitted[].path` into a `mode=full`
 *     continuation, which exits above as `wire`). The measured case is a
 *     `handles:[…]` batch carrying an unknown handle: the server never learned
 *     a path for it, so there is nothing to reach and no call that would reach
 *     it. That stays `source` — it always was correct, and rewriting it to
 *     `capped` would assert a cap that never fired.
 *
 * A read that simply reaches EOF is in NEITHER population: it is COMPLETE and
 * carries no `limit` at all (Rule T — absence of `limit` IS completeness).
 */
function limitFrom(body: Body, withheld: boolean): Limit | undefined {
  if (!withheld) return undefined;
  const omitted = omittedClasses(body);
  const next = deriveNext(body);
  // FX-OH F2: a `next` that merely pulls a withheld SUPPORTING/caller-named row
  // is not a continuation this response may prescribe — see
  // `nextTargetsWithheldFrontierRow`. The limit degrades to the no-`next` arm,
  // which for a cap-fired body is exactly `{cause:"capped", omitted:[...]}`.
  if (next === undefined || nextTargetsWithheldFrontierRow(body, next)) {
    const cause = capFired(body) ? "capped" : "source";
    return omitted.length > 0 ? { cause, omitted } : { cause };
  }
  return omitted.length > 0 ? { cause: "wire", omitted, next } : { cause: "wire", next };
}

// ---------------------------------------------------------------------------
// FX-OH F2 (2026-09-04) — A WITHHELD SUPPORTING ROW IS NOT THE RESPONSE'S
// `limit.next`.
//
// THE DEFECT, MEASURED. On the sealed SF05 replay `TL_SF_STRUCTURAL_CONCERNS`
// added a caller-named row for a 50 KB document and `TL_SF_DEMOTE` then made
// it the pack's arbitrated `next` — so `limit` became
// `{cause:"wire", omitted:["evidence"], next:{…}}`: an EXECUTABLE invitation
// (+341 B) to spend a turn fetching a body the response had deliberately not
// sent. With `TL_SF_DEMOTE` alone off, the identical pack shipped the honest
// `{cause:"capped", omitted:["evidence"]}` — 41 B, no pull — and the wire's own
// continuations then terminated in 2 hops instead of 4.
//
// THE RULE. `limit.next` is read by the shipped guide as "run this verbatim".
// A row this response WITHHELD (W-DEMOTE's supporting tier, or the caller-named
// join's bounded row) is by definition not the frontier: it already carries its
// own `handle` + `remaining`, so a caller that decides it wants those bytes can
// zoom them itself. Promoting one to the response level turns an addressable
// option into an instruction.
//
// SCOPE, AND WHY THE DEFAULT WIRE CANNOT MOVE. The predicate is driven ENTIRELY
// by `semanticFrontierWithholdingMarks()`, which `decisionWire.ts`'s demote pass
// publishes only while `TL_SF_DEMOTE` is active. With the flag off both mark
// sets are empty and this function returns `false` on its first line — so a
// flag-off response is byte-identical by construction, not by review.
// ---------------------------------------------------------------------------

/** Every `path`/`handle` a continuation call addresses, in one pass. */
function toolCallAddresses(next: ToolCall): { paths: Set<string>; handles: Set<string> } {
  const paths = new Set<string>();
  const handles = new Set<string>();
  const args = next.arguments;
  if (!isRecord(args)) return { paths, handles };
  const addPath = (value: unknown): void => { const v = str(value); if (v !== undefined) paths.add(v); };
  const addHandle = (value: unknown): void => { const v = str(value); if (v !== undefined) handles.add(v); };
  addPath(args["path"]);
  addHandle(args["handle"]);
  for (const entry of Array.isArray(args["targets"]) ? args["targets"] : []) {
    if (!isRecord(entry)) continue;
    addPath(entry["path"]);
    addHandle(entry["handle"]);
  }
  for (const entry of Array.isArray(args["paths"]) ? args["paths"] : []) {
    if (isRecord(entry)) addPath(entry["path"]);
    else addPath(entry);
  }
  for (const entry of Array.isArray(args["handles"]) ? args["handles"] : []) {
    if (isRecord(entry)) addHandle(entry["handle"]);
    else addHandle(entry);
  }
  return { paths, handles };
}

/**
 * True iff `next` addresses an evidence row THIS response withheld a body from
 * (W-DEMOTE, or the caller-named frontier join) that still carries its own
 * `remaining` — i.e. a row the caller can already zoom on its own handle.
 *
 * Inert with `TL_SF_DEMOTE` off: the mark sets are then empty.
 */
function nextTargetsWithheldFrontierRow(body: Body, next: ToolCall): boolean {
  const marks = semanticFrontierWithholdingMarks();
  if (marks.demoted.size === 0 && marks.named.size === 0) return false;
  const evidence = body["evidence"];
  if (!Array.isArray(evidence)) return false;
  const { paths, handles } = toolCallAddresses(next);
  if (paths.size === 0 && handles.size === 0) return false;
  for (const row of evidence) {
    if (!isRecord(row)) continue;
    const handle = str(row["handle"]);
    const path = str(row["path"]);
    const addressed = (handle !== undefined && handles.has(handle))
      || (path !== undefined && paths.has(path));
    if (!addressed) continue;
    // A row with nothing outstanding is not a withheld row, whatever the mark
    // says: the caller holds it, so a `next` at it would be a no-progress call
    // the `deriveNext` contract already forbids for other reasons.
    if (stringArray(row["remaining"]).length === 0) continue;
    const id = semanticFrontierEvidenceWitnessId(row as Record<string, unknown>);
    if (id !== undefined && (marks.demoted.has(id) || marks.named.has(id))) return true;
  }
  return false;
}

/**
 * True iff a SERVER CAP cut this response — the [R5-9] discriminator between
 * the two no-`next` arms.
 *
 * Checked POSITIVELY, signal by signal, rather than by excluding the
 * unresolvable-reference case. `completeness` is deliberately NOT consulted
 * even though `withheldSomething` accepts it: `readCodePack.ts:194` derives it
 * FROM `omitted[]` (`omitted.length === 0 ? "complete" : items.length === 0 ?
 * "empty" : "partial"`), so it fires identically for both populations and can
 * discriminate neither.
 */
function capFired(body: Body): boolean {
  if (body["truncated"] === true) return true;
  if (body["content_completeness"] === "partial") return true;
  if (stringArray(body["remaining_ranges"]).length > 0) return true;
  if (typeof body["surface_drops"] === "number" && body["surface_drops"] > 0) return true;
  if (body["map_cap_bytes"] !== undefined || body["byte_budget"] !== undefined) return true;
  if (body["headings_truncated"] === true) return true;
  if (body["artifact_sections_trimmed"] !== undefined) return true;
  if (truncatedMember(body)) return true;
  return false;
}

/**
 * True iff this body withheld content it could otherwise have carried (E-4).
 *
 * `headings_truncated` counts. Rule T's invariant is "absence of `limit` IS
 * completeness", and a response whose heading index was capped at 40 of 1501
 * entries withheld 1461 of them; omitting `limit` there asserts completeness
 * about a response that is not complete, which is the silent-truncation class
 * this module exists to close. `omittedClasses` already maps it to `"metadata"`
 * — that mapping was unreachable before this line, because nothing else in a
 * heading-only truncation trips the gate.
 */
function withheldSomething(body: Body): boolean {
  if (body["truncated"] === true) return true;
  if (body["content_completeness"] === "partial") return true;
  if (body["completeness"] === "partial" || body["completeness"] === "empty") return true;
  if (Array.isArray(body["omitted"]) && (body["omitted"] as unknown[]).length > 0) return true;
  if (stringArray(body["remaining_ranges"]).length > 0) return true;
  if (typeof body["surface_drops"] === "number" && body["surface_drops"] > 0) return true;
  if (body["map_cap_bytes"] !== undefined || body["byte_budget"] !== undefined) return true;
  if (body["headings_truncated"] === true) return true;
  if (truncatedMember(body)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// A.4 `Receipt` — the five forms, and the tag that replaced five booleans
// ---------------------------------------------------------------------------

/**
 * [R5-10] THE CONTINUATION DUTY, and why it lives here.
 *
 * The ruling (2026-08-14): "a receipt may only be issued for the fact of having
 * SERVED: only bytes that actually reached the consumer on the wire can ground
 * `served_by`. A serve dropped by a cap is UNSERVED and remains
 * discovery-eligible."
 *
 * F-1 is the receipt-side half. A prepared-fence stop on a read of a file the
 * session had NEVER served shipped exactly this, and nothing more:
 *
 *     {"v":1,"kind":"read.receipt","receipt":{"receipt":"decision-unchanged",
 *      "certificate":{"id":"ready-…"},"certified_query":"…"}}
 *
 * No decision, no next, no retry. The emitter (`state/session.ts`'s
 * `preparedDiscoveryReceipt`) had in fact built a `next_call` and an `unlock`;
 * three funnel steps removed both, each individually correct:
 *
 *   1. `frontierNextCall` returns a CHALLENGE TEMPLATE when the fence is
 *      answer-terminal with an empty frontier — `expected_action_change:
 *      "<state the concrete decision …>"`.
 *   2. `envelope.ts`'s `scrubTemplateCalls` deletes any placeholder-bearing
 *      call outright (§2.6: "a `next` is either fully executable or it is not
 *      emitted"), taking the only `next_call` with it.
 *   3. `projectSuccessBody` deletes `unlock` (§3.4 E4), and `projectReceipt`
 *      below keeps only `receipt` + `KEPT_ON_RECEIPT`, taking `decision` too.
 *
 * Every step defensible; the composition is a dead end. So the duty is made
 * STRUCTURAL rather than left to the emitters to remember: `receiptOf` carries
 * whatever executable continuation the body arrived with, and `projectReceipt`
 * REPAIRS a withholding receipt that still has none with the one transition
 * this server honours unconditionally, ahead of every fence check
 * (`guardExecutionDiscovery`'s `taskEpoch:"new"` branch). A receipt can
 * therefore no longer be emitted without a way forward — not because each of
 * the ~40 emit sites is careful, but because this projector cannot express it.
 */
function toolCallFrom(value: unknown): ToolCall | undefined {
  const direct = emittableToolCall(value);
  if (direct !== undefined) return direct;
  // The prose dialect (`"read_file mode=slice handle=h1 ranges=[…]"`) is what
  // several serve paths put on `next`; `emittableToolCall` re-validates the
  // parse, so a prose call this server would refuse is still not emitted.
  const text = str(value);
  if (text === undefined) return undefined;
  const parsed = parseProseToolCall(text);
  return parsed === undefined ? undefined : emittableToolCall(parsed);
}

/** The executable continuation a receipt body arrived carrying, if any. */
function receiptContinuation(body: Body): ToolCall | undefined {
  return toolCallFrom(body["next_call"]) ?? toolCallFrom(body["next"]);
}

/**
 * The [R5-10] floor: a new task epoch, SCOPED to what this call asked for.
 *
 * Unconditionally honoured — `guardExecutionDiscovery` acts on `taskEpoch:"new"`
 * BEFORE it looks the fence up — and placeholder-free, so it survives
 * `scrubTemplateCalls`. It is the executable spelling of the `unlock` prose
 * §3.4 E4 deletes.
 *
 * The SCOPING is what makes it a route rather than an escape. An unscoped
 * re-pack clears the fence but serves nothing in particular; naming the path
 * this very call was refused for means the bytes arrive on the follow-up. The
 * targets come from the funnel's inbound `args`, which `ProtocolCallContext`
 * carries for exactly this ("Read by the family projectors to SYNTHESISE a
 * continuation that echoes what the caller actually asked for") — and reading
 * the REQUEST rather than rewriting the fence's prescription is what keeps the
 * in-process CONDITION ① contract untouched.
 */
function epochResetCall(context: ReadProjectionContext | undefined): ToolCall | undefined {
  const args = context?.args ?? {};
  const targets: string[] = [];
  const single = str(args["path"]);
  if (single !== undefined) targets.push(single);
  for (const entry of stringArray(args["paths"])) {
    if (entry !== "" && !targets.includes(entry)) targets.push(entry);
  }
  const workspace = context?.workspace;
  // [T2] (2026-08-27) The same "echo what the caller actually asked for"
  // principle extends to `query`: when the call that reached this floor was
  // ITSELF a `mode:"task_pack"` request, its own `query` is the caller's
  // actual (possibly brand-new-task) question, and forwarding it verbatim -
  // never an excerpt, the same convention `state/session.ts`'s
  // `preparedDiscoveryReceipt` uses for its own mismatch `next_call` - turns
  // a QUERY-ONLY call (see the comment on `targets` below) from "start over,
  // blind" into "here is your question, freshly scoped". A call in any OTHER
  // mode, or a `search_files` call (no `mode` at all), has no comparable
  // free-text field to echo, so `query` is simply absent there (E-1).
  const query = str(args["mode"]) === "task_pack" ? str(args["query"]) : undefined;
  return emittableToolCall({
    tool: "read_file",
    arguments: {
      mode: "task_pack",
      taskEpoch: "new",
      ...(query !== undefined ? { query } : {}),
      // Handle-addressed and query-only calls leave no path to name; the
      // unscoped re-pack is still executable and still clears the fence.
      ...(targets.length > 0 ? { paths: targets.slice(0, EPOCH_RESET_PATH_CAP) } : {}),
      ...(workspace !== undefined && workspace !== "" ? { cwd: workspace } : {}),
    },
  });
}

/** Most paths the [R5-10] floor will name. */
const EPOCH_RESET_PATH_CAP = 8;

/** The funnel context `projectReadBody` needs to mint the [R5-10] floor. */
export interface ReadProjectionContext {
  /** The workspace root this call resolved against. */
  readonly workspace?: string;
  /**
   * VF-5/VF-7: the workspace root, published ONLY for the verify-first
   * closure gate (`verifyClosureGate`'s kit-less session-obligation
   * fallback). Deliberately separate from `workspace` above -- see
   * `ProtocolCallContext.verifyClosureWorkspace`'s own doc comment
   * (protocol/envelope.ts) for why reusing `workspace` here is unsafe.
   */
  readonly verifyClosureWorkspace?: string;
  /** This call's INBOUND arguments, as received. */
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * True iff `receipt` already discharges the [R5-10] duty on its own terms.
 *
 * `closure-complete` is exempt, and alone in that: it withholds nothing — it
 * reports that every registered check closed. The other four all say "you are
 * not getting what you asked for", which is precisely the claim that has to
 * name a way forward.
 */
function receiptHasContinuation(receipt: Receipt): boolean {
  if (receipt.receipt === "closure-complete") return true;
  if (receipt.next !== undefined) return true;
  // Form 1 of the duty: an evidence restatement. `pack-unchanged` addresses
  // every surface it withholds and names the prior call for each, which is a
  // consumer's complete picture of what it holds and where it came from.
  if (receipt.receipt === "pack-unchanged") return receipt.evidence.length > 0;
  // 2026-08-22 fence-serves-unserved-scope: `decision-unchanged`'s REQUIRED
  // `certificate` member (A.4) is its own Form-1 restatement — the caller
  // already holds the prepared act's frontier from the response that
  // installed the fence, so this receipt needs no synthesised `next`. Before
  // this, an absent `next` here minted `epochResetCall` below: a
  // `taskEpoch:"new"` re-pack built from THIS call's own (unrelated) inbound
  // args, which re-armed the fence with a fresh certificate on every
  // discovery call it stopped. Measured: 27 such re-packs / 290 KB in one
  // bench run (T09 rep1 alone: 8 receipts -> 8 re-packs). Ordinary
  // read_file/search_files discovery no longer reaches this receipt at all
  // (`state/session.ts`'s `guardExecutionDiscovery` now serves it directly);
  // what remains is a `task_pack` re-ask a live certificate declined for
  // cause (partial surface, changed file) — a query MISMATCH is its own
  // `refusal` with `retry:"new-task"`, never this receipt (see envelope.ts's
  // `isReceiptBody`, confirmed live by [T2]'s own investigation) — and the
  // epoch-reset floor was never a fit for that shape
  // either, since `context.args` is scoped to THIS call, not to the task the
  // certificate holds.
  if (receipt.receipt === "decision-unchanged") return true;
  // DESIGN-v0.15 §6.2 (R4): a satisfied `code-unchanged` receipt is complete
  // WITHOUT a `next`. Its residency claim (`handle` + `sha`, required by
  // `receiptOf` above — never absent) IS the caller's complete picture of
  // what it holds and at what revision, exactly as `served_by`/`covered_by`
  // restate WHO served it when the producer supplied them; "the rest of the
  // FILE is still unread" is a fact `summary.unserved` may carry, never a
  // duty of THIS request (§3.3's "既読通知の終端": a satisfied read-request
  // ends with no unrequested `next`). A page of a still-OPEN parent request
  // is not this case at all — `server.ts`'s `openParentReceiptContinuation`
  // attaches that parent's own cursor as a real `next` BEFORE this function
  // ever runs, so `receipt.next !== undefined` above already exempts it.
  // Before this, an absent `next` here minted the [R5-10] `epochResetCall`
  // floor for even a fully independent, satisfied receipt — the exact
  // unrequested continuation R4 exists to remove.
  if (receipt.receipt === "code-unchanged") return true;
  return false;
}

/**
 * W-LEDGER: project the emitter's `covered_by` — "which earlier calls put
 * which lines of this window on the wire" — onto a `code-unchanged` receipt.
 *
 * `code-unchanged`'s residency claim is `handle` + `sha`, which is a claim
 * about ONE serving call. `covered_by` is the PLURAL of the existing scalar
 * `served_by`, and it exists because the ledger this receipt can now be
 * decided from (`state/session.ts`'s `servedRangeLedger`, per PATH and
 * cumulative) may name several earlier calls for one window — a whole-file
 * request answered by three prior slices has no single `served_by` to name.
 *
 * THIS FUNCTION IS A GATE, NOT A BUILDER. It never derives coverage; it only
 * forwards what `protocol/coverageReceipt.ts` already decided from the ledger,
 * and it drops anything it cannot recognise. Three refusals, in order:
 *
 *   - flag off  => `undefined`, before the body is even inspected. This is the
 *     second of the two independent gates the module header describes; the
 *     first is in `coverageReceiptFor` itself.
 *   - not an array of records with a `range` string => that entry is dropped.
 *     A `covered_by` entry with no addressing claims residency it cannot
 *     address, which is exactly what A.4 forbids.
 *   - nothing survived => `undefined`, never `[]` (E-1, A.8.1: an empty array
 *     is never emitted in place of absence).
 */
function projectCoveredBy(body: Body): CoveredSpan[] | undefined {
  if (!receiptCoverageEnabled()) return undefined;
  const declared = body["covered_by"];
  if (!Array.isArray(declared)) return undefined;
  const spans: CoveredSpan[] = [];
  for (const entry of declared) {
    if (!isRecord(entry)) continue;
    const range = str(entry["range"]);
    if (range === undefined) continue;
    const servedBy = str(entry["served_by"]);
    spans.push({ range, ...(servedBy !== undefined ? { served_by: servedBy } : {}) });
  }
  return spans.length > 0 ? spans : undefined;
}

/**
 * §2.3 / A.4: a receipt is a response that carries a `Receipt`.
 *
 * The emitters mint `receipt: "<form>"` at their own exit (that is what makes
 * `envelope.ts`'s classifier a tag test rather than a five-boolean probe); this
 * function is the CONSTRUCTOR that turns the tagged body into the A.4 union,
 * and it is also the honesty gate: a form whose required set (A.4's [R4-4]
 * table) is not satisfied is NOT a receipt, and the response keeps its
 * content-bearing member rather than shipping a receipt that asserts residency
 * it cannot address.
 *
 * `closure-unchanged` is absent and its name is not reserved — D3(a).
 *
 * [R5-10] (2026-08-14): every WITHHOLDING form additionally carries the
 * continuation it was emitted with — see `receiptContinuation` below.
 */
export function receiptOf(body: Body, workspaceRoot?: string): Receipt | undefined {
  const tag = str(body["receipt"]);
  if (tag === undefined) return undefined;

  // [R5-10]: carried on every withholding form, from whichever field the
  // emitter used. Resolved once, before the switch, so no form can forget it.
  const next = receiptContinuation(body);

  switch (tag) {
    case "pack-unchanged": {
      // Residency: `task` + >=1 `PriorEvidence`, each carrying `prior` and no
      // `body` — A.4: "Entries carry addressing + `prior`, never a body (§4.4
      // receipt convergence)".
      //
      // The compact re-serve emits addressing-only surfaces with no per-surface
      // residency marker, because on THIS response every surface is prior-held
      // by construction: that is the receipt's entire claim. `prior` therefore
      // names the earlier call the way A.2.7 asks — the task_pack call this
      // response is the unchanged re-issue of — rather than being left absent,
      // which would make the entries indistinguishable from evidence whose
      // bytes were simply shed.
      const task = body["task"];
      const evidence = body["evidence"];
      if (!isRecord(task) || !Array.isArray(evidence)) return undefined;
      // A.4: `pack-unchanged` is "the exact prior pack RE-ISSUED". A pack whose
      // DECISION moved is not that, even when every byte is identical — the
      // post-challenge revocation rewrite turns a `prepared` pack into a
      // discovery contract over the same surfaces, and shipping that as
      // "unchanged" would hide the one thing that actually changed. A.4 has a
      // separate form for the other direction (`decision-unchanged`), which is
      // the proof that v1 treats bytes and decisions as different claims.
      const decision = body["decision"];
      if (isRecord(decision)) {
        const kind = str(decision["kind"]);
        if (kind === "discover" || kind === "await_input") return undefined;
      }
      const replay = str((task as Body)["replay"]);
      const earlier = replay !== undefined
        ? `read_file mode=task_pack qref=${replay}`
        : "read_file mode=task_pack (earlier in this session)";
      const prior = evidence
        .filter(isRecord)
        .filter((entry) => str(entry["handle"]) !== undefined && str(entry["body"]) === undefined)
        .map((entry) => {
          const projected: Body = { handle: entry["handle"], prior: str(entry["prior"]) ?? earlier };
          // PI-03 `client_acknowledged_prior`: the addressing restatement
          // (`path`/`range`/`role`) is this receipt's MICRO-RESTATE tier — the
          // bytes that exist because the server cannot prove the caller still
          // holds what it was served. A VERIFIED trusted-client-host
          // attestation that NAMES THIS HANDLE is that proof, and `Evidence`
          // already declares the resulting shape legal: `path`'s own type doc
          // reads "absence means the caller already holds the addressing
          // (receipt compaction, §2.3)".
          //
          // The frozen fields are untouched — nothing is added, renamed or
          // re-typed; three optional fields are simply not emitted. `handle`
          // and `prior` always survive, so the entry still addresses what it
          // withholds and [R5-10]'s form-1 duty (a non-empty evidence
          // restatement) is never violated. Per-HANDLE, not per-response: a
          // client that attests to holding A and B licenses nothing about C.
          if (!clientAcknowledgedPrior(str(entry["handle"]))) {
            keep(projected, entry, ["path", "range", "role"]);
          }
          return projected;
        });
      if (prior.length === 0) return undefined;
      return {
        receipt: "pack-unchanged",
        task,
        evidence: prior,
        ...(next !== undefined ? { next } : {}),
      } as unknown as Receipt;
    }

    case "code-unchanged": {
      // Residency: `handle` + `sha`; `served_by` is optional provenance.
      const handle = str(body["handle"]);
      const sha = str(body["sha"]);
      if (handle === undefined || sha === undefined) return undefined;
      // PI-03 `client_acknowledged_prior`: `served_by` is PROVENANCE — "which
      // earlier call put these bytes in your context" — and it exists to help
      // a caller that may not remember. An attestation naming this handle is
      // that memory, proven, so the provenance line becomes restatement of
      // something the client just asserted it holds. `handle` + `sha` (the
      // residency claim itself) and `next` are never dropped.
      const servedBy = clientAcknowledgedPrior(handle) ? undefined : str(body["served_by"]);
      // W-LEDGER: the plural of `served_by`, forwarded only under
      // `TL_RECEIPT_COVERAGE`. An attestation that already names this handle
      // makes the whole provenance tier restatement, so it is dropped with
      // `served_by` for the same reason.
      const coveredBy = clientAcknowledgedPrior(handle) ? undefined : projectCoveredBy(body);
      // F10 (2026-09-02 review fix): `covered_by` is now declared on the
      // `code-unchanged` member of `Receipt` (types/src/mcp/receipts.ts), so
      // this is a properly typed construction of that member — no `unknown`
      // detour needed to reach the union.
      const codeUnchanged: Extract<Receipt, { receipt: "code-unchanged" }> = {
        receipt: "code-unchanged",
        handle,
        sha,
        ...(servedBy !== undefined ? { served_by: servedBy } : {}),
        ...(coveredBy !== undefined ? { covered_by: coveredBy } : {}),
        ...(next !== undefined ? { next } : {}),
      };
      return codeUnchanged;
    }

    case "decision-unchanged":
    case "prepared-discovery-closed": {
      // Non-residency: `certificate`. A.4 is explicit that this form asserts
      // NOTHING about file bytes — the 2026-08-13 honesty fix — so it carries
      // no handle and no sha, and `certified_query` is its one disclosure.
      //
      // [R5-10a] (ratified 2026-08-14) — PASS-THROUGH, AND NOW IT HAS SOMETHING
      // TO PASS. A.4 types `certificate` as a full `CertificateRef`
      // (`{id, obligations, workspace}`). This code has always forwarded
      // whatever record the emitter supplied; the `{id}` fallback fired only
      // because `state/session.ts`'s `preparedDiscoveryReceipt` supplied a
      // scalar `certificate_id` and no record.
      //
      // The deviation note that used to sit here justified that by saying the
      // fence "retains only the certificate id". THAT WAS FALSE at HEAD —
      // `ExecutionFenceState.obligationIds` is populated from the certificate
      // at contract-record time — and the ruling fixed the EMITTER, not this
      // projector, which needed no change. The residual deviation is narrower
      // and still disclosed: `workspace` is absent, because the fence carries a
      // `taskFingerprint` rather than a `WorkspaceMarker` and re-asserting a
      // possibly stale marker is a separate decision.
      //
      // The `{id}` fallback is kept as the honest floor for a fence with no
      // obligations: less than the declared type, never an invented list.
      const declared = body["certificate"];
      const certificate = isRecord(declared) ? declared : undefined;
      const id = certificate !== undefined ? str(certificate["id"]) : str(body["certificate_id"]);
      if (id === undefined) return undefined;
      const certifiedQuery = str(body["certified_query"]);
      return {
        receipt: "decision-unchanged",
        certificate: certificate ?? { id },
        ...(certifiedQuery !== undefined ? { certified_query: certifiedQuery } : {}),
        ...(next !== undefined ? { next } : {}),
      } as unknown as Receipt;
    }

    case "kit-unchanged": {
      // FX-N0 (2026-09-03): the `Receipt` union still declares this arm
      // (`packages/types/src/mcp/receipts.ts`), but no in-tree producer ever
      // sets `body["receipt"] = "kit-unchanged"` in a live request/response
      // (grep-verified over `src/`) — this projector arm is reached today
      // only by tests that construct the tag directly (e.g.
      // `servedReceiptElisionHonesty.spec.ts`) to pin the wire's declared
      // receipt-form vocabulary. Kept, not deleted, so that vocabulary stays
      // provable; see `protocol/budget/requiredSets.ts`'s `kit-unchanged`
      // row for the fuller citation.
      const kitRef = str(body["kit_ref"]);
      if (kitRef === undefined) return undefined;
      return { receipt: "kit-unchanged", kit_ref: kitRef, ...(next !== undefined ? { next } : {}) };
    }

    case "closure-complete": {
      const done = body["done"];
      const total = body["total"];
      if (typeof done !== "number" || typeof total !== "number") return undefined;
      // W-VERIFY-CLOSURE (§3.4). THE COMPLETION CLAIM IS WITHHELD while any
      // verify obligation is `unproven`/`served-untested`. Declining the tag is
      // the documented behaviour of this function ("a tag whose A.4 required
      // set is not satisfied yields no `Receipt`, and the response then keeps
      // its content-bearing member"), and it is what makes `envelope.ts`'s
      // `isReceiptBody` fall through to `mode === "closure"` — the response
      // ships as the open `read.closure` it actually is, carrying `remaining`
      // and `gaps`. Default OFF: `verifyWithholdsCompletion` is `false` for
      // every call without the flag, so this line adds no bytes and no branch.
      if (verifyWithholdsCompletion(body, workspaceRoot)) return undefined;
      return { receipt: "closure-complete", done, total };
    }

    default:
      return undefined;
  }
}

/**
 * A.5.6: the member is `{v, kind, receipt}` and nothing else. No `limit` — "a
 * receipt withholds nothing, it re-asserts what the caller holds".
 *
 * DISCLOSED DEVIATIONS, two fields.
 *
 * `verification` (the kit) rides receipts today because a kit is delivered per
 * EDITED FILE, not per response shape, and the guide binds harness construction
 * to it ("build harnesses from those handles"). Dropping it here would silently
 * delete a delivery the guide promises. Revision-5 row: A.5.6 has no slot for
 * it, and A.6.1 leaves the kit placement open (O-a).
 *
 * `concern_note` (added 2026-08-14) is NOT in the class A.5.6's "a receipt
 * withholds nothing" rule is about. `summary` and the prose `note` restate the
 * SAME residency fact the receipt already asserts, so dropping them loses
 * nothing; `concern_note` states an UNRELATED one — that the session's query
 * has a hit OUTSIDE the window being vouched for — and the guard that produces
 * it is one-shot per (session, path). The receipt emitter forwards it
 * deliberately for exactly this reason ("a receipt replaces the BYTES, never
 * the guidance", server.ts's B2d note), and this list silently undid that: the
 * caller's only warning was consumed by a response that then did not carry it.
 */
const KEPT_ON_RECEIPT = ["verification", "concern_note"] as const;

/**
 * [T2] (2026-08-27, prepared-fence P0) Structural backstop, not the primary
 * fix. `protocol/envelope.ts`'s `isReceiptBody` already refuses to classify
 * ANY body with `query_mismatch: true` as a receipt at all - it is routed to
 * `kind:"refusal"` before `receiptOf`/`projectReceipt` ever run, and
 * `protocol/refusal.ts`'s `retryOf` gives that refusal `retry:"new-task"`
 * plus its own executable `next`. Confirmed live, not just by reading both
 * files: a `read_file mode=task_pack` call whose query trips
 * `state/session.ts`'s `newTaskQueryMismatch` comes back as `kind:"refusal"`
 * with a followable `next`, never as a bare `read.receipt`. So a
 * `decision-unchanged` RECEIPT carrying `required_action:"re-pack-new-epoch"`
 * should never actually reach this projector today.
 *
 * This check exists anyway because `receiptHasContinuation`'s blanket `true`
 * for `decision-unchanged` (2026-08-22 fence-serves-unserved-scope, above) is
 * a property of the RECEIPT TAG alone. It has no way to know whether
 * `envelope.ts`'s routing in front of it covers every one of the read
 * family's ~40 emit sites today, or will keep covering all of them after the
 * next change to either module. If a `required_action:"re-pack-new-epoch"`
 * body ever DOES reach here, the blanket rule would ship a receipt that both
 * misdescribes a stale certificate as sufficient and gives no way back -
 * exactly the dead end [R5-10] exists to close. Holding the invariant at the
 * projection layer itself is cheap insurance against depending entirely on a
 * sibling module's routing staying exhaustive.
 */
function decisionUnchangedNeedsForcedFloor(body: Body, receipt: Receipt): boolean {
  if (receipt.receipt !== "decision-unchanged") return false;
  if (receipt.next !== undefined) return false;
  return body["required_action"] === "re-pack-new-epoch";
}

function projectReceipt(
  body: Body,
  receipt: Receipt,
  context: ReadProjectionContext | undefined,
): Body {
  // [R5-10], the structural half. A withholding receipt that reached here with
  // no continuation is not shipped bare: it is repaired with the epoch reset,
  // which is a real transition this server honours and not a consolation
  // field. If even that cannot be minted (no injected request-shape validator
  // would accept it), the receipt still ships — a receipt without a next is
  // strictly better than dropping the response — but that path is unreachable
  // in the server process, where `setEmittedToolCallValidator` is always
  // installed, and `receiptHonesty.spec.ts` pins the reachable one.
  //
  // [T2] `forcedFloor` narrows `receiptHasContinuation`'s blanket
  // `decision-unchanged` pass for the one shape it should never have covered
  // - see `decisionUnchangedNeedsForcedFloor`'s comment just above.
  const forcedFloor = decisionUnchangedNeedsForcedFloor(body, receipt);
  const discharged = receiptHasContinuation(receipt) && !forcedFloor
    ? receipt
    : (() => {
        const reset = epochResetCall(context);
        return reset === undefined ? receipt : { ...receipt, next: reset };
      })();
  const projected: Body = { receipt: discharged };
  keep(projected, body, KEPT_ON_RECEIPT);
  // [T2] Only when the forced floor actually fired: `required_action` is the
  // one piece of the discarded internal body that tells the caller WHY the
  // certificate restatement was not enough on its own - "re-pack-new-epoch".
  // Scoped to this branch rather than added to KEPT_ON_RECEIPT, so the
  // ordinary decision-unchanged stop (which always has an internal
  // `required_action`, just never a recovery need) stays exactly as compact
  // as the wire-baseline fixtures pin it.
  if (forcedFloor) keep(projected, body, ["required_action"]);
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.2 `read.text`
// ---------------------------------------------------------------------------

/**
 * DISCLOSED DEVIATIONS on `read.text` (A.5.2 lists `evidence` + `limit` only).
 * Each row states the guide-bound capability the deletion would lose:
 *
 *  - `sha`         the hash a caller pins an edit to (`precondition:
 *                  "expected-hash"`, and `edit_file`'s own `expectedSha`).
 *                  `Evidence` has no sha field, so there is nowhere else for it.
 *  - `total_lines` the EOF-honesty field the 2026-08-08 X-wave added after
 *                  read-back silence was measured as an availability defect.
 *  - `read_back`   same wave: the created-file read-back affordance.
 *  - `content_mode` A.9.2 row 16's rename of `contentMode` — it says whether
 *                  the body is the file, an outline, or deferred.
 *  - `note`, `concern_note`, `hint`  prose that carries elision markers; A.8
 *                  E-7 makes prose sheddable, not deletable.
 *  - `headings`    the markdown navigation index (R1, 2026-07-25): without it a
 *                  partial doc serve cannot name where anything else lives.
 *  - `invalid_ranges` names windows the caller asked for that do not parse;
 *                  deleting it turns a caller error into a silent drop.
 *  - `edit_hints`  small_file's bounded edit intents, which the guide's
 *                  `intent` argument pairs with.
 *  - `archive`     member provenance: the only thing that tells a caller this
 *                  handle addresses a VIRTUAL member of a read-only container
 *                  rather than a workspace file. The guide binds to it
 *                  ("virtual member handles stay immutable").
 *  - `verification` see KEPT_ON_RECEIPT.
 *  - `sections_hint` the instruction that tells a caller `sections:[...]` EXISTS
 *                  for this doc (`docSliver.ts`'s `MARKDOWN_SECTIONS_HINT`). The
 *                  heading index names WHERE things are; only this names the
 *                  call that fetches them, and the checked-in wire baseline
 *                  `__tests__/fixtures/wire-baselines/read.text.slice.json`
 *                  pins it verbatim.
 *  - `headings_truncated`, `headings_total`, `headings_note`
 *                  the heading index's own truncation disclosure.
 *                  `limit.omitted:["metadata"]` proves only THAT metadata was
 *                  shed; `headings_total` is the exact pre-cap count and has no
 *                  other carrier, and without the flag a capped index reads as
 *                  a complete one. R1's navigation contract is unusable without
 *                  knowing the map is partial.
 *  - `focus`       WHY this window was selected for a semantic query
 *                  (`server.ts`'s `...(focus ? { focus } : {})`). `Evidence`
 *                  carries `why` per-surface on a task pack but a `read.text`
 *                  serve has no per-window slot for it, so deleting it makes a
 *                  query-driven serve indistinguishable from an arbitrary one.
 */
const KEPT_ON_TEXT = [
  "sha", "total_lines", "read_back", "content_mode",
  "note", "concern_note", "hint", "headings", "invalid_ranges", "edit_hints",
  "archive", "verification",
  "sections_hint", "headings_truncated", "headings_total", "headings_note", "focus",
  // `style` — whether a markdown section's heading is `setext` or `atx`
  // (server.ts's markdown-section serve). An edit that REPLACES a section must
  // reproduce its heading, and the two styles are not interchangeable text: a
  // setext heading is two lines (`Deployment` + `----------`) and an atx one is
  // one (`## Deployment`). Without it a caller doing the guide's
  // handle+content section replace has to re-derive the style from the served
  // body, and gets it wrong whenever the body it holds starts below the rule.
  "style",
] as const;

/**
 * One `Evidence` per served window (A.2.7, §3.3's addressing triple).
 *
 * The four dialects this collapses, per A.5.2:
 *   `segments[]`  -> one entry each (the multi-window slice serve);
 *   `items[]`     -> one entry each (the `sections:[a,b]` serve, server.ts's
 *                    `mode:"markdown-sections"`);
 *   `continued`   -> a SECOND entry on the same handle, which is what the
 *                    inline continuation always was;
 *   `code_unchanged` on a segment -> `prior`, never a body.
 * `remaining_ranges` rides the FIRST entry for that handle: it is a per-HANDLE
 * fact, and `sanctionFromEvidence` (CONDITION ①) reads it per handle.
 *
 * `items[]` IS PER-SOURCE-ADDRESSED, WHICH THE OTHER TWO ARE NOT. A multi-window
 * slice serves one file, so `segments[]` inherits the body's single handle; a
 * multi-SECTION serve mints one handle per section and the body carries none
 * (server.ts spreads the single-section case to the top level instead). So the
 * entry's own `handle` wins where it has one, and only `path` — genuinely one
 * file — comes from the body. Reading the body's handle for every item would
 * have addressed every section with the same (absent) handle, which is the
 * false-addressing class §3.3 exists to prevent.
 */
function textEvidence(body: Body): Evidence[] {
  const handle = str(body["handle"]) ?? "";
  /**
   * S2 (C2-9): ABSENT, NOT EMPTY.
   *
   * This used to be `str(body["path"]) ?? ""`, which turned "the source body
   * names no path" into `path: ""` on the wire. §3.3 makes `path` part of the
   * addressing triple, so an empty string is not a degraded address — it is a
   * FALSE one, and worse than absence, because a client branches on a present
   * key. §6.1(d)'s "no fresh `Evidence` without `path` + `range`" passes on
   * `""`, so nothing else in the bed could see it. Measured on three live
   * corpus responses (mdh1, sln1, scw1) during the C2-9 observation pass.
   *
   * `projectEvidence` (decisionWire.ts) already had this right — it spreads
   * `...(typeof record["path"] === "string" ? { path } : {})` — so this is the
   * two projectors agreeing rather than a new rule.
   */
  const path = str(body["path"]);
  /** `{ path }` when the body names one, `{}` when it does not. */
  const pathOf = (own?: string): { path?: string } => {
    const value = own ?? path;
    return value === undefined ? {} : { path: value };
  };
  const remaining = stringArray(body["remaining_ranges"]);
  const evidence: Evidence[] = [];

  const push = (entry: Evidence): void => {
    if (entry.handle === "") return;
    evidence.push(entry);
  };

  // `segments[]` is the multi-window slice serve; `windows[]` is the prepared
  // fence's already-served claim (`state/session.ts`'s `heldSelfMaterialReceipt`),
  // which is the SAME per-window shape with every window prior-held. Neither is
  // an A.4 receipt form — A.4's `code-unchanged` addresses one handle, not a
  // window list — so the honest v1 carrier for both is per-window `Evidence`,
  // which is exactly what §4.4(3)'s per-source axis is for.
  const segments = body["segments"] ?? body["windows"] ?? body["items"];
  if (Array.isArray(segments) && segments.length > 0) {
    for (const raw of segments) {
      if (!isRecord(raw)) continue;
      const range = rangeOf(raw["range"]);
      if (range === undefined) continue;
      const content = servedBody(raw);
      const priorBy = raw["code_unchanged"] === true
        ? str(raw["served_by"]) ?? "an earlier call this session"
        : undefined;
      push({
        handle: str(raw["handle"]) ?? handle,
        ...pathOf(str(raw["path"])),
        range,
        ...(content !== undefined ? { body: content } : {}),
        ...(priorBy !== undefined ? { prior: priorBy } : {}),
      });
    }
  } else {
    // Single-window serve. `mode=full` / `mode=small_file` carry no `range`,
    // and FreshEvidence requires one (§3.3), so the served window is derived
    // from what actually shipped rather than from the file's own length — a
    // truncated full serve names the lines the caller HOLDS, not the lines the
    // file has.
    const content = servedBody(body)
      ?? (Array.isArray(body["outline"]) ? stringArray(body["outline"]).join("\n") : undefined);
    // `served_range` wins over `range` where both exist. A symbol serve the cap
    // TRIMMED carries `range` = the symbol's full bounds and `served_range` =
    // the lines that actually shipped; naming the former would claim bytes the
    // caller does not hold, which is the same over-claim the truncated-full
    // derivation below avoids by measuring what shipped.
    const declared = str(body["served_range"]) ?? rangeOf(body["range"]);
    const range = declared
      ?? (content !== undefined ? `1-${Math.max(1, lineCount(content))}` : undefined);
    if (range !== undefined) {
      push({
        handle,
        ...pathOf(),
        range,
        ...(content !== undefined ? { body: content } : {}),
      });
    } else if (body["total_lines"] === 0 && body["content"] === "") {
      // DESIGN-v0.15 §5.1 (R2): A GENUINELY EMPTY FILE. `servedBody` (via
      // `str()`) collapses an explicit `content: ""` to `undefined` — the
      // same absent-vs-empty rule that keeps `""` out of `path`/`range` as a
      // false address — which is exactly right there, but here it also erases
      // the ONLY signal this window ever shipped: with `content` undefined
      // there is no body AND no derivable range, so the branch above pushes
      // nothing and a `content:"full"` read of a 0-byte file projected
      // `evidence: []`, failing A.5.2's required set (>=1 `FreshEvidence`).
      // `total_lines: 0` is the producer's OWN verified fact
      // (`buildFullServePayload` sets it only after actually reading and
      // eliding the file down to nothing), so this is honest by construction,
      // not a guess from an absent key. The file has no real line to name, so
      // the range is a bare `0-0` sentinel — never a valid 1-based line and
      // never confusable with one.
      push({ handle, ...pathOf(), range: "0-0", body: "" });
    } else if (
      handle !== ""
      && remaining.length > 0
      && typeof body["total_lines"] === "number"
      && body["total_lines"] > 0
    ) {
      // GATE-A (2026-09-14, R2 property case 24): A GOVERNED DOWNGRADE THAT
      // SHIPPED NEITHER BYTES NOR AN OUTLINE.
      //
      // `buildFullDowngradePayload`'s per-task-cap arm (server.ts) replaces a
      // content head with `{mode:"skeleton", skeleton, remaining_ranges, next,
      // note}`. `envelope.ts::isSkeletonOnlyBody` routes that to `read.map` —
      // but only when the outline is NON-EMPTY, and `extractSymbolsFromFile`
      // returns `[]` for a file whose declarations it cannot name (measured: a
      // 237-line file of `const 行N = "…";` rows). Such a body then arrived
      // here with no `content`, no `range` and no segments, so nothing was
      // pushed and the response shipped `evidence: []` — A.5.2's required set
      // (>=1 `FreshEvidence`) violated, which FIXALL-B's
      // `emitRequiredSetViolationRefusal` now converts into a visible
      // `invalid-input` refusal instead of a silent malformed payload. The
      // caller asked a real question about a real file and got neither an
      // answer nor a recovery.
      //
      // The honest entry is BODYLESS AND ADDRESSED: the window is what the
      // caller addressed (the whole file — this arm is only ever reached by a
      // governed whole-file read), no `body` because nothing shipped, and the
      // per-handle `remaining` the loop below attaches carries the unserved
      // spans. That is A.2.7's sanctioned bodyless shape and satisfies E-8
      // (`!body` implies `prior` or `remaining`) by construction, so the
      // pre-filled `limit.next` zoom stays reachable instead of being replaced
      // by a dead-end refusal.
      push({ handle, ...pathOf(), range: `1-${body["total_lines"]}` });
    }
  }

  const continued = body["continued"];
  if (isRecord(continued)) {
    const range = str(continued["range"]);
    const content = str(continued["content"]);
    if (range !== undefined) {
      push({ handle, ...pathOf(), range, ...(content !== undefined ? { body: content } : {}) });
    }
  }

  if (remaining.length > 0 && evidence.length > 0) {
    evidence[0] = { ...evidence[0]!, remaining };
  }
  // E-8 (A.8.2) — `!body` implies `prior` or `remaining` — holds by
  // construction for every dialect above: a fresh segment/window carries
  // `content` or `code`, a held one carries `code_unchanged` -> `prior`, and a
  // truncated serve carries `remaining_ranges`.
  //
  // ONE REACHABLE EXCEPTION, DECLARED (Revision-5 candidate). A slice whose
  // range starts PAST EOF echoes the window the caller asked for and serves
  // nothing: no bytes exist, none were served earlier, and none remain. A.2.7
  // has no arm for "this window is empty" — `remaining` would promise a later
  // fetch that will return the same nothing, and `prior` would be a false
  // residency claim — so the entry rides bare, which is the only one of the
  // four encodings that asserts nothing untrue. It is NOT filtered out: the
  // echo is the caller's own recovery signal ("8-12 is past the end of a
  // 7-line file"), and deleting it would answer an out-of-bounds read with
  // silence, which `editCodeHandle.spec.ts`'s EOF-clamp case pins precisely.
  return evidence;
}

function projectText(body: Body): Body {
  const evidence = textEvidence(body);
  const projected: Body = { evidence };
  const limit = limitFrom(body, withheldSomething(body));
  if (limit !== undefined) projected["limit"] = limit;
  keep(projected, body, KEPT_ON_TEXT);
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.3 `read.map`
// ---------------------------------------------------------------------------

/**
 * DISCLOSED DEVIATIONS on `read.map` (A.5.3 lists `outline` + `limit` only):
 * none at the member level. `sha` survives INSIDE the `digest` form, which is
 * where A.5.3 itself puts it.
 */
function structuralOutline(body: Body): Body | undefined {
  if (Array.isArray(body["surfaces"])) {
    const surfaces = (body["surfaces"] as unknown[])
      .filter(isRecord)
      .map((entry) => {
        const projected: Body = {};
        keep(projected, entry, ["role", "handle", "path"]);
        return projected;
      })
      .filter((entry) => entry["handle"] !== undefined);
    const outline: Body = {
      form: "surfaces",
      surfaces,
      coverage: body["coverage"] === "complete" ? "complete" : "partial",
    };
    // A.8.2: `missing` iff coverage is partial.
    if (outline["coverage"] === "partial") keep(outline, body, ["missing"]);
    return outline;
  }

  if (Array.isArray(body["files"])) {
    const files = (body["files"] as unknown[])
      .filter(isRecord)
      .map((entry) => {
        const projected: Body = {};
        keep(projected, entry, ["path", "handle", "language", "signatures"]);
        return projected;
      });
    const outline: Body = { form: "files", files };
    keep(outline, body, ["note"]);
    return outline;
  }

  if (isRecord(body["digest"])) {
    const outline: Body = { form: "digest" };
    // `note`: SHOULD-FIX 57 — a digest computed over STRIPPED text must be able
    // to say so; the counts it reports describe that text, not the bytes on
    // disk. E-1, so an ordinary digest pays nothing.
    keep(outline, body, ["handle", "path", "sha", "digest", "note"]);
    return outline;
  }

  // Rule K, A.9.2 row 7: `mode=overview` on a markdown path shipped a
  // top-level `kind:"markdown"`. That is not one of D4's fifteen members, and
  // because the family projectors SPREAD over the envelope's own `{v, kind}`
  // it overwrote the discriminator — `kind:"markdown"` reached the wire, no
  // predicate recognised the response, and every field stayed exactly as
  // pre-v1. Relocated into `outline.form`, which is the address Rule K names
  // for this family and the one place a private vocabulary cannot collide.
  if (str(body["kind"]) === "markdown" && Array.isArray(body["sections"])) {
    const outline: Body = { form: "markdown" };
    // `note`: SHOULD-FIX 57 — same reason as the `signatures` form above; the
    // markdown overview route reads through the served-bytes policy too.
    keep(outline, body, ["handle", "path", "sha", "title", "summary", "note"]);
    outline["sections"] = body["sections"];
    // A.8.2: emitted iff the section list was capped. `limit` states THAT rows
    // were shed; only this states the pre-cap total, and without it a capped
    // index is indistinguishable from a complete one.
    if (body["truncated"] === true) keep(outline, body, ["sections_total"]);
    return outline;
  }

  if (isRecord(body["repo"]) && Array.isArray(body["packages"])) {
    const outline: Body = { form: "overview" };
    keep(outline, body, ["repo", "packages"]);
    // A.8.2 / §3.4 E1: the four empty-only arrays are OMIT-WHEN-EMPTY, which
    // `keep` enforces; `recommended_reading_order` stays required.
    keep(outline, body, ["tools", "commands", "cli_commands", "flows"]);
    outline["recommended_reading_order"] = Array.isArray(body["recommended_reading_order"])
      ? body["recommended_reading_order"]
      : [];
    return outline;
  }

  // BOTH emitted shapes of the signatures projection (see `StructuralOutline`'s
  // widened `signatures`): `getFileSkeleton`'s rendered blob, and
  // `buildFullDowngradePayload`'s per-task-cap rows. The structured rows are
  // carried through UNFLATTENED — that arm replaced a content head with an
  // outline precisely so the caller could pick a range from it, and rendering
  // the rows to prose would leave a downgrade that names no zoom target.
  const signatureRows = Array.isArray(body["signatures"]) && body["signatures"].length > 0
    ? body["signatures"]
    : Array.isArray(body["skeleton"]) && body["skeleton"].length > 0
      ? body["skeleton"]
      : undefined;
  const signatureText = str(body["signatures"]) ?? str(body["skeleton"]);
  if (signatureText !== undefined || signatureRows !== undefined) {
    const outline: Body = { form: "signatures" };
    // `note`: SHOULD-FIX 57 (AB1, round 11) — the SINGLE-target
    // `content:"outline"` serve lands here, and a skeleton projected from
    // STRIPPED text must be able to say so (the batch arm already could, via
    // its per-entry `note`). E-1, so an ordinary skeleton pays nothing.
    keep(outline, body, ["handle", "path", "note"]);
    outline["language"] = str(body["language"]) ?? "text";
    outline["signatures"] = signatureText ?? signatureRows ?? "";
    // A.8.2: emitted iff the skeleton was truncated.
    if (body["truncated"] === true) keep(outline, body, ["profile_used", "hint"]);
    return outline;
  }

  return undefined;
}

function projectMap(body: Body): Body {
  const outline = structuralOutline(body);
  if (outline === undefined) return body;
  const projected: Body = { outline };
  const limit = limitFrom(body, withheldSomething(body));
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.4 `read.batch`
// ---------------------------------------------------------------------------

/**
 * A.5.4's `file-downgraded` arm, ENUMERATED FROM THE EMITTERS (the pre-publish
 * obligation A.5.4 names: the declaration's doc comment ends in "etc.").
 *
 * The emitter is `resolveFullReadForPath` (server.ts:2598), shared by the batch
 * and single-path `mode=full` paths. It produces four payload classes:
 *   (a) the office redirect `{ok:false, reason:"artifact-full-downgraded",
 *       path, alternatives[], next}` — see the note below;
 *   (b) `buildFullDowngradePayload`'s code_unchanged repeat read;
 *   (c) its per-task-cap skeleton serve;
 *   (d) its W1 head serve.
 * `reason` is the eight-literal union at server.ts:2447-2455 plus (a)'s own
 * `"artifact-full-downgraded"`.
 */
const DOWNGRADE_FIELDS = [
  "downgraded_from", "reason", "path", "handle", "sha", "bytes",
  "content", "code_unchanged", "summary", "note", "allow_full_would_help",
  "total_lines", "skeleton", "remaining_ranges", "next", "alternatives",
] as const;

function batchEntry(raw: Body): Body | undefined {
  const path = str(raw["path"]);
  const handle = str(raw["handle"]);
  const range = str(raw["range"]);

  // Rule K + D6: a batch entry that reports its own failure carries `ok:false`
  // (the office redirect). It is a DOWNGRADE, not a served file.
  const downgraded = raw["ok"] === false || raw["downgraded_from"] !== undefined;
  if (downgraded) {
    const entry: Body = { form: "file-downgraded" };
    keep(entry, raw, DOWNGRADE_FIELDS);
    if (entry["path"] === undefined && path !== undefined) entry["path"] = path;
    return entry;
  }

  if (handle !== undefined && range !== undefined) {
    const entry: Body = { form: "handle", handle, path: path ?? "", range, truncated: raw["truncated"] === true };
    // server.ts's handles-batch loop (C10.2 completion / D2, Guard 2
    // 2026-07-12b) builds `note`/`concern_note` onto exactly this item shape
    // with the explicit comment that the single-handle mode=slice path
    // already forwards them and "this batch item shape had dropped it" --
    // but this allowlist dropped them AGAIN, one layer later. `synthesized_range`
    // (the DESIGN-v0.9 SS4.2-adjacent single-file-range marker) is the same
    // shape of gap. All three are E-1 (emitted iff present), so an ordinary
    // item that never set them pays nothing extra on the wire.
    //
    // 2026-08-27 (field-eval integration, T2): `remaining_ranges` and `next`
    // close the same gap for the one case that MATTERS most — a DEAD END.
    // `server.ts`'s handles-batch loop attaches both to this exact item shape
    // (`...(sliceResult.data.remaining_ranges ...)`, `...(sliceResult.data.next
    // ...)`), fed by `readCodeModes.ts`'s ordinary range-slice byte-cap branch,
    // which sets them WITHOUT `downgraded_from`. The symbol-cap downgrade sets
    // `downgraded_from` and so takes the `file-downgraded` branch above, whose
    // `DOWNGRADE_FIELDS` already keeps both — which is precisely why the gap
    // went unnoticed: only the NON-downgraded truncation lost them. The result
    // was a wire entry carrying `truncated:true` and no way to resume, against
    // the protocol's standing promise that a recoverable truncation ALWAYS
    // carries an executable `next`. E-1 like the rest: an untruncated item
    // pays nothing.
    keep(entry, raw, [
      "content", "sha", "note", "concern_note", "synthesized_range",
      "remaining_ranges", "next",
    ]);
    return entry;
  }

  if (range !== undefined) {
    const entry: Body = { form: "range", path: path ?? "", range, truncated: raw["truncated"] === true };
    keep(entry, raw, ["purpose", "content"]);
    return entry;
  }

  if (path !== undefined) {
    const entry: Body = { form: "file", path, truncated: raw["truncated"] === true };
    // `note`: SHOULD-FIX 57 (AB1, round 11). `projectBatch` keeps NO top-level
    // prose, so a batch can only state a per-entry fact per entry — and the
    // `content:"outline"` batch (BLOCKER 52's route) serves a skeleton PROJECTED
    // FROM STRIPPED TEXT. Same E-1 addition, and the same reasoning, as the
    // `form:"handle"` arm above, whose own comment records that this allowlist
    // had already dropped `note` once.
    keep(entry, raw, ["handle", "content", "sha", "fullFileExpansion", "note"]);
    // DESIGN-v0.15 §5.1 (R2): a GENUINELY EMPTY (0-byte) batch item. `keep()`
    // is E-1's shared "absent iff empty" rule and drops `content: ""` like
    // every other empty string, which for every OTHER item is correct (an
    // empty string is never a real address or a real body fragment) but here
    // it is the item's ENTIRE truthful content — dropping it left a batch
    // entry with `path`+`truncated` and nothing a caller could tell apart
    // from "no content was ever attempted". `total_lines: 0` is the
    // producer's OWN verified fact (`buildFullServePayload` sets it only
    // after actually reading and eliding the file down to nothing), so
    // restoring both here states what shipped rather than guessing from an
    // absent key. Every non-empty item is unaffected (`entry["content"]` is
    // already set by `keep()` above, so this never overwrites it).
    if (entry["content"] === undefined && raw["content"] === "" && raw["total_lines"] === 0) {
      entry["content"] = "";
      entry["total_lines"] = 0;
    }
    return entry;
  }

  return undefined;
}

/**
 * AB1 residual R4 / MX-B group (2026-09-14). Rule T (this file's own header)
 * deletes the per-item `omitted[] {path|handle, reason}` ledger from the
 * wire in favor of the coarse `limit.omitted` class rollup — correctly, for a
 * member that was simply never reached (cap-exceeded, not-found, handle-* —
 * no `entries[]` shape could honestly represent "not even attempted"). An
 * UNDECODABLE member is different: the server definitively resolved it and
 * knows exactly why no bytes shipped, which is precisely the fact
 * `file-downgraded` (A.5.4's own frozen `BatchEntry` form) already exists to
 * state — the SAME form `read.batch`'s over-budget/governed-full downgrade
 * already uses for "this source exists; here is why you got none". Two
 * spellings reach here (server.ts's two undecodable-batch producers): the
 * handles batch's short, machine-stable tag, and the skeleton/outline
 * batch's full prose from `undecodableTextMessage` (server.ts) — recognized
 * by its fixed, always-present "not decodable as UTF-8" clause (the
 * template literal's only invariant substring; `relPath`/the inner reason
 * both vary) rather than re-derived.
 */
function isUndecodableOmission(reason: string): boolean {
  // `includes`, not `startsWith`: `undecodableTextMessage` (server.ts) is the
  // fixed template `Cannot read ${relPath} as text: not decodable as UTF-8
  // (${reason}) — re-save...` — the "not decodable as UTF-8" clause is its
  // only invariant substring (relPath and the inner reason both vary), and
  // it never sits at position 0 because relPath comes first.
  return reason === "not-decodable-text" || reason.includes("not decodable as UTF-8");
}

function projectBatch(body: Body): Body {
  const items = Array.isArray(body["items"]) ? body["items"] : [];
  const entries = items
    .filter(isRecord)
    .map(batchEntry)
    .filter((entry): entry is Body => entry !== undefined);
  // See `isUndecodableOmission`'s doc comment. `path` is REQUIRED to
  // synthesize a `file-downgraded` entry (A.5.4's own required set); an
  // omitted item with no path attached (should not occur for this reason,
  // but the producer's own array type keeps it optional) is left as a
  // coarse `limit.omitted` class only, exactly as before this fix — never a
  // partial or dishonest entry.
  const rawOmitted = Array.isArray(body["omitted"]) ? body["omitted"] : [];
  for (const raw of rawOmitted) {
    if (!isRecord(raw)) continue;
    const reason = str(raw["reason"]);
    if (reason === undefined || !isUndecodableOmission(reason)) continue;
    const path = str(raw["path"]);
    if (path === undefined) continue;
    const entry: Body = { form: "file-downgraded", path, reason: "not-decodable-text" };
    keep(entry, raw, ["handle"]);
    // The closed `FullDowngradeReason` enum cannot carry the full "why" (nul
    // ratio, offending byte position, decode failure mode, ...); `note`
    // already can (A.8 rule E-7) and is where every other per-entry prose
    // fact in this projector lives (`batchEntry`'s own `note` comment
    // above). The short-tag producer states the same fact generically so
    // every disclosed entry's `note` names the SAME family regardless of
    // which producer built it.
    entry["note"] = reason === "not-decodable-text" ? "not decodable as UTF-8 text" : reason;
    entries.push(entry);
  }
  const projected: Body = { entries };
  // A.8.2: `locate` iff this was a query-driven pack.
  keep(projected, body, ["locate"]);
  // Rule T: the `completeness` rollup is DELETED; `omitted[]`'s per-item ledger
  // becomes `limit.omitted` (still true for every OTHER reason; see above).
  const limit = limitFrom(body, withheldSomething(body));
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.5 `read.artifact`
// ---------------------------------------------------------------------------

/** `extractOfficeText`'s four-value `kind` vocabulary (extractOfficeText.ts:62). */
const DOCUMENT_FORMS: ReadonlySet<string> = new Set(["docx", "xlsx", "pptx", "pdf"]);

/** Rule K: the top-level `kind` vocabulary becomes `content.form`. */
function artifactContent(body: Body): Body | undefined {
  const form = str(body["kind"]) ?? str(body["form"]);

  if (Array.isArray(body["entries"]) && str(body["format"]) !== undefined) {
    const content: Body = { form: "archive" };
    keep(content, body, ["format", "entries", "total_entries", "total_uncompressed_bytes"]);
    content["read_only"] = true;
    return content;
  }

  if (Array.isArray(body["sheets"])) {
    const content: Body = { form: "xlsx.roster", sheets: body["sheets"] };
    // TWO EMITTER DIALECTS FOR ONE FACT, both projected onto A.5.5's single
    // `inlined` slot. An explicit `mode=artifact` with no `sheet` flattens the
    // picked sheet onto the body (`inlined_sheet` + top-level range/columns/
    // rows); the IMPLICIT route — a bare `read_file path=x.xlsx`, §4.6d's
    // known-artifact-section execution — nests the same table under `section`
    // and stamps `inlined:["artifact-section:<path>#<sheet>"]`. Reading only
    // the first dialect dropped the entire inlined table on the implicit
    // route: the caller got a list of sheet NAMES where the server had already
    // extracted and paid for the sheet's rows.
    const inlinedSheet = str(body["inlined_sheet"]);
    const section = isRecord(body["section"]) ? body["section"] : undefined;
    if (inlinedSheet !== undefined) {
      const inlined: Body = { sheet: inlinedSheet };
      keep(inlined, body, ["range", "columns", "rows", "note"]);
      content["inlined"] = inlined;
    } else if (section !== undefined && str(section["sheet"]) !== undefined) {
      const inlined: Body = { sheet: section["sheet"] };
      keep(inlined, section, ["range", "columns", "rows"]);
      keep(inlined, body, ["note"]);
      content["inlined"] = inlined;
    }
    return content;
  }

  if (form === "xlsx" && Array.isArray(body["rows"])) {
    const content: Body = { form: "xlsx.table" };
    keep(content, body, ["sheet", "range", "columns", "rows"]);
    return content;
  }

  if ((form === "csv" || form === "tsv") && Array.isArray(body["rows"])) {
    const content: Body = { form: "csv" };
    // round-18A finding 1 / ruling (v): `file_range` (the PHYSICAL file line
    // span `csvTable` computed, distinct from `range`'s logical row numbers)
    // must survive this projection — it is what `protocol/envelope.ts`'s
    // `servedWindowsOf` csv clause corroborates against; dropping it here
    // would make `bookCsvArtifactServe`'s staged booking permanently inert
    // again (retracted at settlement for want of corroboration), the exact
    // "SAFE but inert" state round-17 finding 3 was in before FX-P1.
    keep(content, body, ["range", "file_range", "columns", "rows", "total_rows", "total_columns", "dialect", "note"]);
    return content;
  }

  if (Array.isArray(body["sections"])) return { form: "docx", sections: body["sections"] };
  if (Array.isArray(body["slides"])) return { form: "pptx", slides: body["slides"] };
  if (Array.isArray(body["pages"])) return { form: "pdf", pages: body["pages"] };

  // `extractOfficeText`'s FLAT dialect: one markdown-ish text blob plus the
  // document kind, with no per-page/per-section structure to project
  // (`{text, kind, truncated, warnings}` — extractOfficeText.ts:58-67). It is
  // what `mode=full allowFull:true` on a docx/xlsx/pptx/pdf returns, and what
  // `mode=artifact` returns for a docx/pptx with no section split. Rule K puts
  // the kind vocabulary in `content.form`; the blob rides `content.text`,
  // beside the structured arms rather than instead of them, because the
  // structured arms are per-source projections of the SAME extraction and a
  // caller branching on `form` must reach both the same way.
  if (form !== undefined && DOCUMENT_FORMS.has(form) && str(body["text"]) !== undefined) {
    return { form, text: body["text"] };
  }
  if (Array.isArray(body["rows"])) {
    const content: Body = { form: "csv" };
    keep(content, body, ["range", "file_range", "columns", "rows", "total_rows", "total_columns", "dialect", "note"]);
    return content;
  }
  return undefined;
}

/**
 * DISCLOSED DEVIATION on `read.artifact`: `archive`, the member provenance
 * block (`{path, member, format, read_only}`) an archive-scoped serve carries.
 * A.5.5 has no slot for it, and it is the only thing that tells a caller a
 * handle addresses a VIRTUAL member rather than a workspace file — which the
 * guide binds to ("virtual member handles stay immutable").
 */
const KEPT_ON_ARTIFACT = ["archive"] as const;

function projectArtifact(body: Body): Body {
  const content = artifactContent(body);
  if (content === undefined) return body;
  const projected: Body = {};
  keep(projected, body, ["path", "handle", "sha"]);
  projected["content"] = content;
  // A.8.2: `visuals` iff the source is xlsx/docx/pptx AND carries >=1 chart or
  // media. The emitter already applies that condition; E-1 applies the rest.
  keep(projected, body, ["visuals"]);
  projected["warnings"] = Array.isArray(body["warnings"]) ? body["warnings"] : [];
  keep(projected, body, KEPT_ON_ARTIFACT);
  const limit = limitFrom(body, withheldSomething(body));
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// W-VERIFY-CLOSURE — the verify-first closure gate
// NORMATIVE SOURCE: DESIGN-v0.15-sf-verification-first.md §3.2-§3.4 and §4
// (wire table rows 3-4); DESIGN-v0.15-semantic-frontier-plan.md §4.3.1
// (new fields optional + flag-gated + byte-identical when off).
//
// THE ONE THING THIS GATE DOES. TL CANNOT RUN TESTS. §3.4 is explicit that
// `act.answer`/`act.edit` therefore keep firing — refusing an edit because a
// test has not been run would be both over-reaching and dishonest. What
// changes is the CLAIM OF COMPLETION: while any verify obligation is
// `unproven` or `served-untested`, this closure does not say `done`, and it
// does not become the `closure-complete` receipt. It lists what is owed
// (`remaining`) and what is unproven (`gaps`) instead.
//
// WHY IT LIVES IN `receiptOf` AND `projectClosure`, AND NOWHERE ELSE.
// `envelope.ts`'s `isReceiptBody` IS `receiptOf(body) !== undefined`, and its
// own contract already says so: "a tag whose A.4 required set is not satisfied
// yields no `Receipt`, and the response then keeps its content-bearing member
// rather than shipping a residency claim it cannot address". A withheld
// `closure-complete` is exactly that case — the completion claim is not
// satisfied — so declining the tag here makes `kindOf` fall through to
// `mode === "closure"` and the response ships as the open `read.closure` it
// actually is. No emitter changes, no new kind, no new receipt form, and the
// execution typestate (`state/session.ts`) is not consulted or touched: this
// gate reads ONE response body and returns a verdict.
//
// EVIDENCE SOURCES, IN PRIORITY ORDER (§3.1 "reuse existing producers"):
//   1. `verify_obligations` carried on the body (W-VERIFY-GEN's
//      `change_contract.verify_obligations`, wherever the emitter parks it).
//      CONSUMED AS A FIELD — this gate never re-derives what that producer
//      decided, and never inspects how it decided it.
//   2. Otherwise, DERIVED from the verification kit this closure already
//      carries (`verification.surfaces[].references`/`code`/`body`,
//      `compile_facts[].path`) plus `summary.files`. That kit IS the
//      "verification-manifest" source §3.1 names; nothing new is discovered.
// Absence of both leaves the response untouched: absence is "not computed",
// never "verified" (`TaskVerifyObligation`'s own doc comment).
// ---------------------------------------------------------------------------

// Round-11 (2026-09-03) ratified correction — THE CENTRAL DEFECT FIX: a
// referencing test being SERVED is not the same claim as TL having OBSERVED
// it run. Counting `"served"` as done was the exact bug ("verification
// counted as done when it was merely READ"). §3.4 (amended) now names THREE
// states a closure may not call done — `"served"` and `"served-untested"`
// are both unsatisfied; only `"observed"` (a real TL-observed
// execution/verification fact — a before/after compile-facts comparison, or
// a verification receipt TL itself produced) counts toward `done`. Since
// neither `served` nor `served-untested` ever counts, ageing one into the
// other cannot flip completion either way (VF-3's monotonicity requirement
// falls out of this for free).
const VERIFY_UNSATISFIED: ReadonlySet<string> = new Set(["unproven", "served-untested", "served"]);
const VERIFY_KINDS: ReadonlySet<string> = new Set([
  "referencing-test", "compile-facts", "workspace-command", "diff-review",
]);
const VERIFY_SATISFIED_BY: ReadonlySet<string> = new Set([
  "served", "served-untested", "observed", "unproven",
]);
const VERIFY_SOURCES: ReadonlySet<string> = new Set([
  "verification-manifest", "change-contract", "workspace-declared",
]);

/** Bounded like every other list on this member; `remaining` is not a report. */
const VERIFY_MAX_OBLIGATIONS = 12;
const VERIFY_MAX_LISTED = 8;
const VERIFY_GAP_MAX_CHARS = 200;
/** `open` is a rollup, not a transcript: server.ts caps its own at 8. */
const VERIFY_OPEN_CAP = 16;

type VerifyObligation = TaskVerifyObligation;

interface VerifyGate {
  /** Every obligation this closure knows about, after the §3.3 ageing pass. */
  readonly obligations: readonly VerifyObligation[];
  /** The subset that blocks completion (`unproven` / `served-untested`). */
  readonly unsatisfied: readonly VerifyObligation[];
  /** One line per unsatisfied entry, built from `kind`/`targets` (§3.4). */
  readonly gaps: readonly string[];
  /**
   * `observed` ONLY — what may legitimately count toward `done` (§3.2bis
   * correction 1). `served`, `served-untested` and `unproven` are all in
   * `VERIFY_UNSATISFIED` above and every one of them WITHHOLDS completion:
   * having put bytes on the wire is not having observed them execute.
   */
  readonly satisfiedCount: number;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * VF-10 (round-11, 2026-09-03): a `verifyObligationKey` used to dedupe
 * carried/derived obligations by (kind, sorted targets) so the same claim
 * riding two sources is never double-counted toward `total`.
 */
function verifyObligationKey(entry: VerifyObligation): string {
  return `${entry.kind}:${entry.targets.map(normalizeRel).slice().sort().join("|")}`;
}

function dedupeVerifyObligations(list: readonly VerifyObligation[]): VerifyObligation[] {
  const seen = new Set<string>();
  const out: VerifyObligation[] = [];
  for (const entry of list) {
    const key = verifyObligationKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** A carried obligation, validated field by field. An invalid entry is DROPPED,
 *  never coerced: a malformed claim must not become a completion verdict. */
function carriedObligation(value: unknown): VerifyObligation | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value["id"]);
  const kind = str(value["kind"]);
  const satisfiedBy = str(value["satisfied_by"]);
  const source = str(value["source"]);
  if (id === undefined || kind === undefined || satisfiedBy === undefined || source === undefined) {
    return undefined;
  }
  if (!VERIFY_KINDS.has(kind) || !VERIFY_SATISFIED_BY.has(satisfiedBy) || !VERIFY_SOURCES.has(source)) {
    return undefined;
  }
  const targets = stringArray(value["targets"]).map(normalizeRel);
  const evidence = Array.isArray(value["evidence"])
    ? value["evidence"].filter(isRecord).map((entry) => ({
      ...(str(entry["handle"]) !== undefined ? { handle: str(entry["handle"]) as string } : {}),
      ...(str(entry["path"]) !== undefined ? { path: normalizeRel(str(entry["path"]) as string) } : {}),
      ...(str(entry["note"]) !== undefined ? { note: str(entry["note"]) as string } : {}),
    }))
    : undefined;
  return {
    id,
    kind: kind as VerifyObligation["kind"],
    targets,
    satisfied_by: satisfiedBy as VerifyObligation["satisfied_by"],
    ...(evidence !== undefined && evidence.length > 0 ? { evidence } : {}),
    source: source as VerifyObligation["source"],
  };
}

/** Source 1: whatever the change contract carried onto this response. */
function carriedVerifyObligations(body: Body): VerifyObligation[] | undefined {
  const holders: unknown[] = [
    body["verify_obligations"],
    isRecord(body["change_contract"]) ? body["change_contract"]["verify_obligations"] : undefined,
    isRecord(body["verification"]) ? body["verification"]["verify_obligations"] : undefined,
  ];
  for (const holder of holders) {
    if (!Array.isArray(holder)) continue;
    const parsed = holder
      .map(carriedObligation)
      .filter((entry): entry is VerifyObligation => entry !== undefined);
    // VF-6: dedupe by (kind, targets) BEFORE the cap is applied, so the cap
    // truncates real distinct obligations rather than exact duplicates.
    if (parsed.length > 0) return dedupeVerifyObligations(parsed);
  }
  return undefined;
}

/**
 * §3.3, THE TRANSITION THAT MAKES `served` HONEST. `served` means "TL sent the
 * evidence bytes ON THIS CALL". An obligation that arrives already marked
 * `served` was served EARLIER, and a closure being built now is precisely the
 * moment at which no intervening observation has been recorded — so it ages to
 * `served-untested`. Bytes that ride THIS response (a kit surface with `code`)
 * are freshly served and do not age.
 *
 * SERVING IS NOT RUNNING: nothing in this pass can promote an obligation to
 * `observed`. Only a TL-OBSERVABLE FACT does that (§3.2), and re-reading a test
 * file is not one — a later `read_file` that serves the same test leaves a
 * `served-untested` obligation exactly where it was.
 */
function ageServed(obligation: VerifyObligation, freshlyServed: boolean): VerifyObligation {
  if (obligation.satisfied_by !== "served" || freshlyServed) return obligation;
  return { ...obligation, satisfied_by: "served-untested" };
}

/**
 * Source 2: the verification kit this closure already carries.
 *
 * `VerificationSurface.references` is "edited rel paths this file references",
 * so the kit itself says which edited file each referencing test covers. An
 * edited file no test surface references has NO referencing-test evidence at
 * all, which §3.1(4) files as `unproven` — carried as a `diff-review`
 * obligation, the evidence class whose proof (a `search_files action=diff` or a
 * re-edit) TL CAN observe.
 */
/**
 * VF-6: reports how many candidate obligations the `MAX_VERIFY_OBLIGATIONS`
 * cap dropped, so the caller can disclose that count instead of silently
 * truncating (see `verifyClosureGate`).
 */
interface DerivedVerifyObligations {
  readonly obligations: VerifyObligation[];
  readonly droppedByCap: number;
}

function derivedVerifyObligations(body: Body): DerivedVerifyObligations {
  const kit = isRecord(body["verification"]) ? body["verification"] : undefined;
  if (kit === undefined) return { obligations: [], droppedByCap: 0 };
  const surfaces = Array.isArray(kit["surfaces"]) ? kit["surfaces"].filter(isRecord) : [];
  const compileFacts = Array.isArray(kit["compile_facts"]) ? kit["compile_facts"].filter(isRecord) : [];
  const summary = isRecord(body["summary"]) ? body["summary"] : undefined;

  const edited: string[] = [];
  const push = (value: string): void => {
    const rel = normalizeRel(value);
    if (rel !== "" && !edited.includes(rel)) edited.push(rel);
  };
  for (const path of stringArray(summary?.["files"])) push(path);
  for (const fact of compileFacts) {
    const path = str(fact["path"]);
    if (path !== undefined) push(path);
  }
  for (const surface of surfaces) {
    for (const ref of stringArray(surface["references"])) push(ref);
  }
  if (edited.length === 0) return { obligations: [], droppedByCap: 0 };

  const tests = surfaces.filter((surface) => str(surface["role"]) === "test");
  const boundedEdited = edited.slice(0, VERIFY_MAX_OBLIGATIONS);
  const obligations: VerifyObligation[] = [];
  for (const path of boundedEdited) {
    // VF-10 (round-11): EXACT normalized-path match only. `references`
    // already names the surfaces verificationPack.ts decided are related, at
    // generation time (itself using basename/stem matching, per design
    // §3.1) — re-deriving a SECOND, independent basename match here at the
    // closure gate can only ever WIDEN that decision unsafely (matching an
    // unrelated file that happens to share a basename in another directory),
    // never narrow it. This fallback path only re-reads what the kit said.
    const cover = tests.find((surface) =>
      stringArray(surface["references"]).some((ref) => normalizeRel(ref) === path));
    if (cover === undefined) {
      // §3.1(4): no TL-observable verification evidence exists for this file.
      // `unproven` carries NO `evidence[]` — there is nothing to cite.
      obligations.push({
        id: `verify:diff-review:${path}`,
        kind: "diff-review",
        targets: [path],
        satisfied_by: "unproven",
        source: "change-contract",
      });
      continue;
    }
    const testPath = normalizeRel(str(cover["path"]) ?? "");
    const handle = str(cover["handle"]);
    const fresh = typeof cover["code"] === "string";
    // `body:"omitted"` = never served (2026-07-31 forensics) => no evidence at
    // all. `body:"served-earlier"` = the bytes rode an EARLIER response, which
    // is `served` about to age. `code` present = served on THIS response.
    const servedAtAll = fresh || str(cover["body"]) === "served-earlier";
    const raw: VerifyObligation = servedAtAll
      ? {
        id: `verify:referencing-test:${path}`,
        kind: "referencing-test",
        targets: [path, testPath].filter((entry) => entry !== ""),
        satisfied_by: "served",
        evidence: [{
          ...(handle !== undefined ? { handle } : {}),
          ...(testPath !== "" ? { path: testPath } : {}),
          note: fresh ? "test body served on this response" : "test body served on an earlier response",
        }],
        source: "verification-manifest",
      }
      : {
        id: `verify:referencing-test:${path}`,
        kind: "referencing-test",
        targets: [path, testPath].filter((entry) => entry !== ""),
        satisfied_by: "unproven",
        source: "verification-manifest",
      };
    obligations.push(ageServed(raw, fresh));
  }
  return {
    obligations: dedupeVerifyObligations(obligations),
    droppedByCap: Math.max(0, edited.length - boundedEdited.length),
  };
}

/** §3.4: `kind` + `targets` + what would prove it. Never a synthesized
 *  expectation, never an instruction TL cannot observe the outcome of. */
function verifyGapLine(obligation: VerifyObligation): string {
  const targets = obligation.targets.join(", ");
  const cited = (obligation.evidence ?? [])
    .map((entry) => entry.path ?? entry.handle)
    .filter((entry): entry is string => entry !== undefined);
  let proof: string;
  if (obligation.satisfied_by === "served-untested") {
    const where = cited.length > 0 ? cited.join(", ") : "the referencing test";
    proof = `${where} was served but no run was observed — TL cannot execute it; run it in your shell`;
  } else if (obligation.kind === "referencing-test") {
    proof = "no referencing-test body has been served — read the test, or add one, then run it";
  } else if (obligation.kind === "diff-review") {
    proof = "no referencing test covers this edit — prove it with a diff review (search_files action=diff) or add a test";
  } else if (obligation.kind === "compile-facts") {
    proof = "compile facts were not compared across the edit — re-request them, then rebuild";
  } else {
    proof = "no workspace-declared verification command was proven — name one, then run it";
  }
  const line = `${obligation.kind} ${targets}: ${proof}`;
  return line.length > VERIFY_GAP_MAX_CHARS ? `${line.slice(0, VERIFY_GAP_MAX_CHARS - 1)}…` : line;
}

/**
 * The gate's verdict for ONE closure body, or `undefined` for "changes
 * nothing".
 *
 * `undefined` on: the flag off (BYTE-IDENTICAL, structurally — nothing below
 * this line runs), a body that is not a closure, no obligations computable,
 * and — the case that matters — every obligation `served`/`observed`. Total
 * and side-effect-free by construction: it reads one body and allocates.
 */
function verifyClosureGate(body: Body, workspaceRoot?: string): VerifyGate | undefined {
  if (!sfVerifyFirstEnabled()) return undefined;
  try {
    if (str(body["mode"]) !== "closure") return undefined;
    const carried = carriedVerifyObligations(body);
    let obligationsFull: VerifyObligation[];
    let droppedByCap: number;
    if (carried !== undefined) {
      // A carried obligation was decided on an EARLIER call by construction, so
      // its `served` ages here (§3.3). This gate consumes the field; it never
      // reaches into how W-VERIFY-GEN produced it.
      obligationsFull = carried.map((entry) => ageServed(entry, false));
      droppedByCap = 0;
    } else {
      const derived = derivedVerifyObligations(body);
      if (derived.obligations.length === 0 && workspaceRoot !== undefined) {
        // VF-5: THIS response carries no `verification` kit at all (a
        // kit-less closure — e.g. a bare `task.pull:"closure"` call after an
        // edit, with no fresh surfaces to derive obligations from). Fall back
        // to the task epoch's recorded `change_contract.verify_obligations`
        // (state/session.ts's `recordExecutionContract`/`recordedVerifyObligations`)
        // rather than treating an unproven task as if it had nothing left to
        // verify. Parsed through the SAME `carriedObligation` shape-check a
        // wire-carried array gets, and aged exactly like one: these were
        // recorded on an earlier call, never served fresh on this one.
        const recorded = recordedVerifyObligations(workspaceRoot);
        const fromSession = recorded === undefined
          ? undefined
          : dedupeVerifyObligations(
            recorded.map(carriedObligation).filter((entry): entry is VerifyObligation => entry !== undefined),
          );
        if (fromSession !== undefined && fromSession.length > 0) {
          obligationsFull = fromSession.map((entry) => ageServed(entry, false));
          droppedByCap = 0;
        } else {
          obligationsFull = derived.obligations;
          droppedByCap = derived.droppedByCap;
        }
      } else {
        obligationsFull = derived.obligations;
        droppedByCap = derived.droppedByCap;
      }
    }
    const obligations = obligationsFull.slice(0, VERIFY_MAX_OBLIGATIONS);
    droppedByCap += Math.max(0, obligationsFull.length - obligations.length);
    if (obligations.length === 0) return undefined;
    const unsatisfied = obligations.filter((entry) => VERIFY_UNSATISFIED.has(entry.satisfied_by));
    if (unsatisfied.length === 0) return undefined;
    // VF-6: the per-response `gaps` list is capped at VERIFY_MAX_LISTED; when
    // either that cap or the per-task VERIFY_MAX_OBLIGATIONS cap actually
    // dropped something, disclose the count rather than truncating silently.
    const listed = unsatisfied.slice(0, VERIFY_MAX_LISTED);
    const droppedFromList = Math.max(0, unsatisfied.length - listed.length);
    const gaps = listed.map(verifyGapLine);
    if (droppedFromList > 0) {
      gaps.push(`+${droppedFromList} more unsatisfied verify obligation(s) not shown (per-response cap)`);
    }
    if (droppedByCap > 0) {
      gaps.push(`+${droppedByCap} verify obligation(s) omitted by the per-task cap (MAX_VERIFY_OBLIGATIONS=${VERIFY_MAX_OBLIGATIONS})`);
    }
    return {
      obligations,
      unsatisfied,
      gaps,
      satisfiedCount: obligations.length - unsatisfied.length,
    };
  } catch {
    // A gate that throws must not turn a closure into a failure: the pre-gate
    // behaviour (say `done` if the emitter said `done`) is the honest fallback
    // for a gate that could not run, and it is what the flag-off path does.
    return undefined;
  }
}

/**
 * True iff this body's `closure-complete` claim is withheld (§3.4).
 *
 * Read by `receiptOf`, which `envelope.ts`'s `isReceiptBody` delegates to — so
 * declining the tag here is what re-classifies the response as the open
 * `read.closure` it is. It changes NO typestate: the execution fence records
 * its own phase from the contract, never from a receipt tag.
 */
/**
 * VF-7 hand-off accessor: pure predicate over a would-be closure body — the
 * SAME gate `projectClosure`/`receiptOf`'s `closure-complete` arm already
 * consult. Exported so `server.ts` (FX-C) can guard `markClosureSatisfied`
 * with it.
 *
 * B5 (2026-09-03): the ordering gap this comment used to describe — the
 * `mode==="closure"` branch computing `closureIsComplete` from
 * `computeClosureStateSafe` alone and calling `markClosureSatisfied` BEFORE
 * this module's verify-first gate ever ran — is CLOSED. FX-G-A's
 * `emitClosure` (server.ts, the one closure it wraps around every
 * `mode==="closure"` return) builds the actual response body first, computes
 * `closureVerified = closureIsComplete && !verifyWithholdsCompletion(body,
 * workspace)` against THIS function, and calls `markClosureSatisfied` only
 * when `closureVerified` is true — otherwise it calls `clearClosureSatisfied`.
 * The session decision and the wire decision are the same computation now;
 * nothing further is owed here.
 */
export function verifyWithholdsCompletion(body: Body, workspaceRoot?: string): boolean {
  return verifyClosureGate(body, workspaceRoot) !== undefined;
}

// ---------------------------------------------------------------------------
// A.5.7 `read.closure`
// ---------------------------------------------------------------------------

/**
 * `complete: false` is DELETED (A.5.7): it is exactly the universal
 * completeness flag §4.4 withdraws. Completeness here is `open.length === 0`.
 *
 * DISCLOSED DEVIATIONS: `verification` (see KEPT_ON_RECEIPT), and `summary`
 * KEPT IN ITS OBJECT FORM `{edits, files, checks_closed, checks_open}` rather
 * than flattened to A.5.7's `summary?: string`. ADJUDICATED by the orchestrator
 * 2026-08-13: flattening now is irreversible information loss; flattening later
 * is free. Revision-5 row.
 */
const KEPT_ON_CLOSURE = ["verification"] as const;

const VERIFY_WITHHELD_NOTE =
  "closure NOT complete — verification obligations remain unproven; see `remaining`/`gaps`. "
  + "TL cannot run tests: serving a test is not running it, so only your own run closes these.";

function projectClosure(body: Body, workspaceRoot?: string): Body {
  const open = stringArray(body["open"]);
  const done = typeof body["done"] === "number" ? body["done"] : 0;
  const total = typeof body["total"] === "number" ? body["total"] : 0;
  // W-VERIFY-CLOSURE (§3.4). `undefined` on the default path — see
  // `verifyClosureGate` — so everything below collapses to the pre-gate shape.
  const gate = verifyClosureGate(body, workspaceRoot);
  const projected: Body = gate === undefined
    ? { open, done, total }
    : {
      // A.5.7's completeness rule IS `open.length === 0`, so withholding the
      // claim means naming the open obligations, not deleting a flag. The ids
      // are the field's own semantics ("obligation ids still open").
      open: [...open, ...gate.unsatisfied.map((entry) => entry.id)].slice(0, VERIFY_OPEN_CAP),
      // HONEST ARITHMETIC: every verify obligation counts in `total`, and only
      // `served`/`observed` ones count in `done`. A withheld `closure-complete`
      // arrives here with done === total; it leaves with done < total.
      done: done + gate.satisfiedCount,
      total: total + gate.obligations.length,
    };
  // A.8.2: `applicability` iff no checks are registered. A gate verdict IS a
  // registered check, so the two can never ride together.
  keep(projected, body, gate === undefined ? ["applicability", "note", "summary"] : ["summary"]);
  keep(projected, body, KEPT_ON_CLOSURE);
  if (gate !== undefined) {
    // The withheld branch's own prose replaces the emitter's — a body that
    // reached here as `closure-complete` carries CLOSURE_SATISFIED_NOTE
    // ("closure complete — verify with tests/git diff"), which is the exact
    // claim this gate is refusing to make.
    projected["note"] = VERIFY_WITHHELD_NOTE;
    projected["remaining"] = gate.unsatisfied.slice(0, VERIFY_MAX_LISTED);
    projected["gaps"] = [...gate.gaps];
    // VF-8/VF-9: `summary.checks_open`/`checks_closed` must agree with the
    // `open`/`done`/`total` this SAME withhold just computed — a caller that
    // reads only `summary` must never see a closed task while `open`/`gaps`
    // say otherwise. Only the two gate-driven fields are touched; every
    // other summary field (edits, files, ...) is the emitter's, untouched.
    const summary = projected["summary"];
    if (isRecord(summary)) {
      projected["summary"] = {
        ...summary,
        checks_closed: projected["done"],
        checks_open: (projected["open"] as string[]).length,
      };
    }
  }
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.1 `read.task_pack`
// ---------------------------------------------------------------------------

/**
 * A.6.1 `ProfilePlan` — the ONE container for the rare extensions (§3.1).
 * `verification` STAYS at `ProfilePlan.verification` (A.6.1's O-a is open and
 * this work item does not relocate it).
 */
const PLAN_MEMBERS = [
  "evidence_model", "wiring", "artifact_sections", "change_contract", "verification",
  // A.6.1's MEMBERSHIP RULE, exercised: "a future extension lands here,
  // additively (§1.4(a)); it does not become a seventh top-level field (§3.0)".
  // `concerns[]` is the multi-concern decomposition — rare by construction, and
  // guide-bound ("batch every ready independent concern in exactly ONE
  // `edit_file` `edits[]` call"). `TaskRef.coverage_reason:"concerns-uncovered"`
  // refers to it, so deleting it would leave a coverage reason naming a
  // structure the response no longer carries.
  "concerns",
  // Same rule, same reason: `artifact_requirements` is the list of artifact
  // INPUTS the task requires, and `artifact_sections` (already a member above)
  // is what was inlined FROM them. Splitting the pair across two levels would
  // put a requirement and its fulfilment at different addresses; deleting the
  // requirements would leave the guide's "artifact packs need content-bearing
  // `artifact_sections` per source" rule with no way to say what the sources
  // were meant to be.
  "artifact_requirements",
  // Same rule again (added 2026-08-14). `internalized` is the RECURSIVE-CLOSURE
  // RECEIPT: the sparse ledger of safe read/search operations the builder ran
  // on the caller's behalf BEFORE returning (`op`/`status`/`evidence`/`handle`,
  // `model.ts:307-312`). It is the only thing on the response that distinguishes
  // "this surface was in the query's own scope" from "the server spent a find
  // to pull it in" — which is exactly what a caller reasoning about whether an
  // unread sibling is still owed has to know (`closureSatisfiedEditGate`'s D10
  // case pins that reasoning). Rare by construction, so A.6.1's membership rule
  // applies verbatim: it lands in `plan`, not as an additional top-level field.
  "internalized",
  // S4 (C2-9), 2026-08-14. `inlined` is the ARTIFACT-SECTION PROVENANCE STAMP
  // LIST — `["artifact-section:<path>#<sheet-or-slide>", …]` — and it lands
  // under `plan` for the same A.6.1 membership reason `artifact_sections` and
  // `artifact_requirements` do: it is the third member of that one triple.
  // `artifact_requirements` says what the task NEEDS, `artifact_sections`
  // carries what was EXTRACTED, and `inlined` is the receipt proving the
  // extraction in this response came from THAT source at THAT selector.
  // Splitting the triple across levels would put a claim and its proof at
  // different addresses; dropping the proof — which is what the projector did
  // until now — leaves an inlined table a caller cannot attribute, and leaves
  // the guide's "artifact packs need content-bearing `artifact_sections` per
  // source" rule with no way to check the "per source" half. Rare by
  // construction (artifact-sourced packs only), so A.6.1's rule applies
  // verbatim: `plan`, not a seventh top-level field (§3.0).
  "inlined",
  // S4, completed. `section` is the SINGULAR spelling of `artifact_sections`:
  // the artifact_build flow emits `{section, inlined}` when exactly one
  // artifact was inlined and `{artifact_sections, inlined}` when several
  // (`readCodeTaskPack.ts:3796-3798` — one `visit()`, one ternary, same
  // bundle). Carrying only the plural made `inlined` attest a section the
  // response did not carry, which is the split-claim-and-proof this list's
  // membership rule exists to prevent, and it is the shape the replay corpus's
  // ws3/csa3 cases replay (one xlsx, one csv). REVISION-5 ROW, RAISED NOT
  // SILENTLY FIXED: A.6.1 names `artifact_sections` only, so a singular alias
  // beside it is a deviation — the honest alternative (make the emitter always
  // emit the plural) is a SEMANTICS change to a shipped shape and therefore
  // §0.2's forbidden class here; the alias is additive (§1.4(a)) and reversible
  // before publication.
  "section",
] as const;

/**
 * DISCLOSED DEVIATIONS on `read.task_pack` (A.5.1 lists task/profile/evidence/
 * decision/plan/limit). Each keeps a capability the agent guide binds:
 *
 *  - `profile_binding`  the guide instructs "omit if unknown and observe
 *                       `profile_binding`". `profile` carries the SELECTED
 *                       value; the binding carries requested-vs-selected,
 *                       source and confidence, which is the readback.
 *  - `frontier_index`   the guide's "write only `edit_frontier`" rule reads it
 *                       when the decision is not an `act.edit`.
 *  - `checks` / `verify` the closure obligations a later `mode=closure` reports
 *                       against, and the verification commands.
 *  - `roots`            the multi-root pollution disclosure (09e honesty).
 *  - `server_build`     §1.2's build stamp, orthogonal to `v` (D1).
 *  - `qref`             ALSO on `task.replay`; kept for one release because the
 *                       guide teaches `qref` by name. Revision-5 row.
 *  - `create_target`    WHERE a new file goes, proved from a unique existing
 *                       directory. A.2.6's `FrontierEntry` requires
 *                       `handle`+`path`+`writable` and a file that does not
 *                       exist yet HAS no handle, so a create target is
 *                       unrepresentable in `decision.frontier`. Without this
 *                       field an `act.edit` decision states the task is ready
 *                       to write while the wire names no place to write — the
 *                       guide's `create:true` + `cwd` rule has nothing to bind
 *                       to, and the caller's only recovery is the
 *                       `cwd-required-for-create` round trip this field exists
 *                       to prevent.
 *                       SINCE [R5-23] (ruling 6) THIS IS THE FALLBACK CARRIER,
 *                       NOT THE ONLY ONE — see `carriesCreateTargetInDecision`
 *                       below. When the decision IS an `act.edit`, the target
 *                       rides inside it and this copy is suppressed; the field
 *                       survives here for every OTHER decision kind, where
 *                       there is no `act.edit` member to carry it and the
 *                       resolved target would otherwise be lost.
 *  - `answer_resolution` a stale or colloquial identifier the caller ASKED
 *                       ABOUT, resolved to the symbol that actually owns the
 *                       responsibility. The evidence entry names the resolved
 *                       symbol; only this names the requested one, so without
 *                       it an answer pack silently answers a different question
 *                       than the one asked.
 */
const KEPT_ON_TASK_PACK = [
  "profile_binding", "frontier_index", "checks", "verify", "roots", "server_build", "qref",
  "create_target", "answer_resolution", "advisory", "scope_inferred", "fast_path",
] as const;

/**
 * [R5-23] / ruling 6's DUAL-CARRY RULE, read off the projected decision.
 *
 * §2.1 makes the decision the single authority, and §3.4 E4's second-authority
 * class is exactly "the same fact emitted twice, in two places a client can
 * disagree about". So the two carriers of "where may I write" are made
 * MUTUALLY EXCLUSIVE rather than merely consistent: an `act.edit` that names
 * its own create target owns it, and the top-level disclosure is not emitted.
 *
 * Read from `decision`, not from a second computation of the same predicate:
 * the projector suppresses the copy exactly when the decision it is about to
 * ship carries one, so the two can never disagree even if the promotion
 * upstream declines (a malformed target `projectCreateTarget` drops, say) — the
 * top-level copy then stays, and the fact survives on the wire either way.
 */
function carriesCreateTargetInDecision(body: Body): boolean {
  const decision = body["decision"];
  if (decision === null || typeof decision !== "object") return false;
  const record = decision as Record<string, unknown>;
  return record["kind"] === "act.edit" && record["create_target"] !== undefined;
}

function projectTaskPack(body: Body): Body {
  const projected: Body = {};
  keep(projected, body, ["task"]);
  projected["profile"] = body["profile"] === "answer" ? "answer" : "generic";
  projected["evidence"] = Array.isArray(body["evidence"]) ? body["evidence"] : [];
  keep(projected, body, ["decision"]);

  // A partially covered pack must retain its unresolved-obligation disclosure.
  // In particular, an exhausted no-grounded-call-remains decision has no
  // `gaps` member, so dropping `missing` would turn a real terminal gap into
  // a silent dead end on the wire.
  const task = isRecord(body["task"]) ? body["task"] : undefined;
  if (task?.["coverage"] === "partial") keep(projected, body, ["missing"]);

  const plan: Body = {};
  keep(plan, body, PLAN_MEMBERS);
  if (Object.keys(plan).length > 0) projected["plan"] = plan;

  const limit = limitFrom(body, withheldSomething(body));
  if (limit !== undefined) projected["limit"] = limit;

  keep(
    projected,
    body,
    carriesCreateTargetInDecision(projected)
      ? KEPT_ON_TASK_PACK.filter((member) => member !== "create_target")
      : KEPT_ON_TASK_PACK,
  );
  return projected;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Project one read-family success body onto its A.5.x member.
 *
 * Returns the body UNCHANGED for members this module does not author (the
 * search and edit families, which are C2-4's and C2-5's), and for a read body
 * whose shape it cannot recognise — a projector that guesses is worse than one
 * that declines, because a wrong `form` is a lie a client branches on.
 */
export function projectReadBody(kind: Kind, body: Body, context?: ReadProjectionContext): Body {
  switch (kind) {
    case "read.task_pack": return projectTaskPack(body);
    case "read.text":      return projectText(body);
    case "read.map":       return projectMap(body);
    case "read.batch":     return projectBatch(body);
    case "read.artifact":  return projectArtifact(body);
    case "read.closure":   return projectClosure(body, context?.verifyClosureWorkspace);
    case "read.receipt": {
      // VF-5/VF-7: `verifyClosureWorkspace` lets a kit-less closure-complete
      // receipt fall back to the task epoch's recorded verify obligations
      // (see `verifyClosureGate`) -- separate from `context.workspace`,
      // which mints the [R5-10] floor below.
      const receipt = receiptOf(body, context?.verifyClosureWorkspace);
      return receipt === undefined ? body : projectReceipt(body, receipt, context);
    }
    default: return body;
  }
}

/** True iff `kind` is a member this module authors. */
export function isReadFamilyKind(kind: Kind): boolean {
  return kind.startsWith("read.");
}
