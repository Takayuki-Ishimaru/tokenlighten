// ---------------------------------------------------------------------------
// protocol v1 — the envelope, the discrimination contract, and the cross-tool
// leaf types.
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §10.3
// (Appendix A, Revision 4, user-approved 2026-08-13). This file implements the
// A.9.1 `protocol.ts` row. Where a doc comment below cites §n or A.n, the cited
// text is the authority; this file transcribes it and does not extend it.
//
// The §1 normative doc comment, carried here because A.9.1 requires it to live
// with the envelope:
//
//  - §1.1 Version identity. The protocol version is ONE integer with ONE value
//    (`1`) and one server process. It governs the WHOLE envelope: a
//    substructure version never authorises a change the protocol version
//    forbids, and never needs to advance for a change the protocol version
//    already covers (§1.6). Substructure `version` fields are removed from the
//    wire at v1 (D12); they may survive as TypeScript literal types for the
//    compile-time marker, but `JSON.stringify` never sees them.
//  - §1.2 Announcement. `v` rides every payload, and the version is announced
//    at `initialize`, at `tools/list` `_meta`, and on every response. A payload
//    without `v` is not a protocol-v1 payload.
//  - §1.3 The unknown-field rule is ASYMMETRIC. A CLIENT tolerates unknown
//    RESPONSE fields (they are additive under §1.4(a)); the SERVER refuses
//    unknown REQUEST properties (§1.3.1) rather than silently dropping them,
//    because a dropped argument changes what the call does. A client that does
//    not recognise `kind` MUST stop and report — it must not infer, retry,
//    probe fields, or perform an edit.
//  - §1.3 absence convention. Absence has meaning and is documented per field
//    (A.8). `[]`, `{}`, `""` and `null` are never emitted in place of absence.
//  - §1.4 Compatibility is three-tier: (a) adding an optional field or an enum
//    member is additive and free; (d) renaming or REMOVING a field or an enum
//    value is breaking — free before v1 publishes, breaking after it. Several
//    obligations in A.9.2 exist only because of that asymmetry.
//  - §1.5 Deprecation is a procedure, not a silent removal.
//  - §1.7 v1 covers the three advertised MCP tools. Other package contracts
//    with their own `schemaVersion` are outside it.
// ---------------------------------------------------------------------------

import type { ImpactSurface } from "./locate-impact.js";
import type {
  ReadTaskPackResult,
  ReadTextResult,
  ReadMapResult,
  ReadBatchResult,
  ReadArtifactResult,
  ReadReceiptResult,
  ReadClosureResult,
} from "./read-result.js";
import type {
  SearchMatchesResult,
  SearchReferencesResult,
  SearchTreeResult,
} from "./search-result.js";
import type {
  EditApplied,
  EditReclassified,
  EditRolledBack,
  EditStateUnknown,
} from "./edit-result.js";

// ---------------------------------------------------------------------------
// A.1.1 The envelope
// ---------------------------------------------------------------------------

/** §1.1, D1. One integer, one value, one server process. */
export type ProtocolVersion = 1;

/**
 * The two fields every protocol-v1 payload carries, first, in this order.
 * §1.2(1): a payload without `v` is not a protocol-v1 payload.
 * §1.3: a client that does not recognise `kind` MUST stop and report —
 * it must not infer, retry, probe fields, or perform an edit.
 */
export type Envelope = {
  v: ProtocolVersion;
  kind: Kind;
};

// ---------------------------------------------------------------------------
// A.1.2 The carrier — D13(a)
// ---------------------------------------------------------------------------

/**
 * The MCP `tools/call` result TokenLighten returns. Exactly one content item.
 * `isError` is present-and-true, or ABSENT — never `false` (§2.5, A.8 rule E-2).
 *
 * Every response is the JSON serialization of one union member of A.5, carried
 * in `content[0].text`. There is no `structuredContent` and no advertised
 * `outputSchema` in v1 (D13(a); the flip condition is recorded at A.1.2(2)).
 */
export type WireResponse = {
  content: [{ type: "text"; text: string }];
  isError?: true;
};

// ---------------------------------------------------------------------------
// A.5 The fifteen response members — the discrimination contract
// ---------------------------------------------------------------------------

/**
 * §3.2, D4 (extended by F3 to 15). The SOLE discrimination contract.
 *
 * CASING EXEMPTION (A.7.0, exemption 1): `Kind` keeps its dot namespace and its
 * `snake_case` leaves EXACTLY as-is. [R4-6] normalised every other enum to
 * kebab-case and deliberately spared this one: D4 costed `kind` in bytes at
 * these exact spellings and §7.1's exception budget is arithmetic over them,
 * and the vocabulary is quoted verbatim in §2.5/§3.2/§4.3/§6.1 and in the guide.
 */
export type Kind =
  | "read.task_pack" | "read.text"    | "read.map"        | "read.batch"
  | "read.artifact"  | "read.receipt" | "read.closure"
  | "search.matches" | "search.references" | "search.tree"
  | "edit.applied"   | "edit.reclassified" | "edit.rolled_back"
  | "edit.state_unknown"
  | "refusal";

/**
 * Every read_file success member (A.5.1–A.5.7). One of the four families of
 * `ProtocolResult`.
 */
export type ReadResult =
  | ReadTaskPackResult
  | ReadTextResult
  | ReadMapResult
  | ReadBatchResult
  | ReadArtifactResult
  | ReadReceiptResult
  | ReadClosureResult;

/** Every search_files success member (A.5.8–A.5.10). */
export type SearchResult =
  | SearchMatchesResult
  | SearchReferencesResult
  | SearchTreeResult;

/**
 * §2.4 — the edit outcome union, discriminated by SIDE-EFFECT STATE
 * (A.5.11–A.5.14). Merges the two parallel unions that existed before v1.
 */
export type EditResult =
  | EditApplied
  | EditReclassified
  | EditRolledBack
  | EditStateUnknown;

/**
 * The whole v1 response surface: fifteen members in four families
 * (`ReadResult`, `SearchResult`, `EditResult`, `Refusal`).
 *
 * §6.1(g): a downstream SDK's exhaustive switch imports THIS type and nothing
 * else. Adding a member breaks that one import site, which is what makes the
 * tier-2 classifier meaningful.
 */
export type ProtocolResult = ReadResult | SearchResult | EditResult | Refusal;

// ---------------------------------------------------------------------------
// A.2.1 `ToolCall` / `EditToolCall`
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * CASING EXEMPTION (A.7.0, exemption 2): these are the names the server
 * advertises to MCP, not protocol vocabulary this document may re-spell —
 * renaming them renames the tools.
 */
export type ToolName = "read_file" | "edit_file" | "search_files";

/**
 * An open map of JSON values, deliberately NOT a closed per-tool struct.
 * §2.1.2 (F5) makes this load-bearing: the pagination cursor is an opaque
 * server-issued token that rides as `arguments.cursor` with no protocol-level
 * structure. A closed struct could not carry it, and a future advertised
 * argument could not ride at all.
 *
 * INVARIANT TC-1 (openness is bounded by the request contract). Open at the
 * TYPE level, closed at the VALIDATION level: every key MUST be an advertised
 * property of `tool` at its path (§1.3.1(2)). The server's own emitted calls
 * are subject to the server's own validator.
 *
 * INVARIANT TC-2 (self-validation), testable. For every `ToolCall` the server
 * emits, feeding it back through `requestShapeRefusal(tool, properties,
 * arguments)` MUST return `null`. This is the mechanical form of "a `next` is
 * either fully executable or it is not emitted"; A.9.2 row 3 names the test.
 */
export type ToolArguments = { readonly [property: string]: JsonValue };

export type ToolCallOf<T extends ToolName> = { tool: T; arguments: ToolArguments };

/** Executable. Never a template: §2.6 abolishes placeholder-bearing calls. */
export type ToolCall = ToolCallOf<ToolName>;

export type EditToolCall = ToolCallOf<"edit_file">;

// ---------------------------------------------------------------------------
// A.2.2 `WorkspaceMarker`
// ---------------------------------------------------------------------------

/**
 * The fingerprint of the workspace state a claim was proved against.
 * Carried over from `TaskWorkspaceState` (task-pack.ts) with `version: 1`
 * removed per D12/§1.6. No field is added and none is renamed.
 *
 * It has exactly TWO homes in v1, and naming both is what closes the census's
 * positional-drift finding: `CertificateRef.workspace` (A.2.4) and
 * `SideEffectCore.workspace` (A.5.11–A.5.14 preamble). There is no third home,
 * and in particular NO top-level `workspace_state` field.
 */
export type WorkspaceMarker = {
  fingerprint: string;
  scope: "served-evidence" | "evidence-plus-inventory";
  evidence_files: number;
  inventory_files: number;
  inventory_complete: boolean;
};

// ---------------------------------------------------------------------------
// A.2.7 The three delivery types — §4.4
// ---------------------------------------------------------------------------

/**
 * §4.4(1) — SEMANTIC. "What can this server not decide?"
 *
 * OB-GAP IS DISCHARGED (P2 / C2-7b). The §3.4 E2 pass ran PER VALUE over the
 * four values the provisional 3-value narrowing had dropped, and the union is
 * now FIVE — final, not provisional:
 *
 *   | dropped value                 | E2 result             | disposition   |
 *   |-------------------------------|-----------------------|---------------|
 *   | `invalid-request`             | LIVE emitter          | MINTED        |
 *   | `unsupported-operation`       | LIVE emitter          | MINTED        |
 *   | `permission-required`         | emitter-0 + reader-0  | DELETED       |
 *   | `external-execution-required` | emitter-0 + reader-0  | DELETED       |
 *
 * The two live emitters are `buildCapabilityGaps` in
 * `features/task-pack/readCodeTaskPack.ts` — a malformed `paths[]` entry
 * (`recoverable:true`) and a `route.action === "fallback_native"` decision
 * (`recoverable:false`). Both are MINTED rather than coerced: routing either
 * onto `missing-evidence` would assert "the server looked and it is not there"
 * about a request that was simply invalid, or about an operation this server
 * does not perform at all — the exact class §4.4 exists to keep apart. Minting
 * is additive under §1.4(a) and therefore free pre-publish.
 *
 * The two deleted values had NO emitter and NO reader anywhere in the server,
 * and neither is a `RefusalCode` either, so nothing constructs the concept and
 * no re-route is owed; removal is free pre-v1 and breaking post-v1 (§1.4(d)).
 * `TaskCapabilityGap.kind` is narrowed to the same five in the same commit, so
 * the producer type cannot express a value the wire cannot carry.
 *
 * Checklist rows: A.9.2 rows 15 + 24 — both CLOSED.
 */
export type CapabilityGap = {
  code:
    | "missing-evidence"
    | "ambiguous-target"
    | "invalid-request"
    | "unsupported-operation"
    | "workspace-changed";
  /**
   * Handles/paths/identifiers the gap is about. Emitted iff the server can name
   * them; absence means the gap is not localisable, NOT that it is unimportant.
   */
  refs?: string[];
};

/**
 * §4.4(2) — DELIVERY. "What did this response not carry, and how do I get it?"
 *
 * F5 recoverability split: `next` is REQUIRED on `wire`/`records`, FORBIDDEN on
 * `source` and `capped`, and optional on `time` (A.8 rule E-5). E-4: `limit` is
 * emitted iff the response withheld something it could otherwise have carried —
 * absence of `limit` IS completeness (§4.4).
 *
 * The two `next`-less arms are NOT interchangeable: `source` = the underlying
 * content ran out, `capped` = it exists and this response could not reach it
 * ([R5-9], ratified 2026-08-14).
 */
export type Limit =
  // recoverable by another call — `next` is REQUIRED (§2.1.2, F5)
  | { cause: "wire" | "records"; omitted?: OmittedClass[]; next: ToolCall }
  // not recoverable by another call — `next` MUST be absent
  | { cause: "source";           omitted?: OmittedClass[] }
  /**
   * [R5-9] A SERVER CAP CUT THIS RESPONSE AND NO CONTINUATION IS CONSTRUCTIBLE.
   * `next` is FORBIDDEN, exactly as on `source` — and that is the only thing the
   * two arms share. `source` says THE UNDERLYING CONTENT RAN OUT; `capped` says
   * THE CONTENT EXISTS and this server cannot name a call that reaches it.
   *
   * Minted because the distinction was being lied about: a byte/record cap with
   * no nameable continuation was emitted as `source`, and the shipped guide
   * teaches `source` = terminal, so every mislabel was an active STOP
   * instruction to the caller about content that was still there. Emitting
   * `wire`/`records` instead would be the opposite failure — §4.4's
   * loop-against-a-wall, a `next` that cannot return what it promises.
   *
   * A caller's honest recovery is a NARROWER REQUEST OF ITS OWN CHOOSING (a
   * `path`, a `depth`, a smaller query) — a choice only the caller can make,
   * which is precisely why the server does not make it for them.
   */
  | { cause: "capped";           omitted?: OmittedClass[] }
  // recoverable iff the server can name a narrower call
  | { cause: "time";             omitted?: OmittedClass[]; next?: ToolCall };

/**
 * §4.4 adjudicates `omitted` as a COARSE ENUM, not a per-item ledger: today's
 * per-item `omitted[] {path|handle, reason}` arrays are deleted in v1.
 * Derived from the shed records by A.6.2's rung mapping.
 */
export type OmittedClass = "metadata" | "evidence" | "results";

/**
 * The surface-role vocabulary the wire already carries on every served surface.
 * NOT a new enum and not a minted one (A.0 rule 3): it is the existing
 * `ImpactSurface` (locate-impact.ts), already the declared type of the surface
 * `role` field and of `StructuralOutline`'s `surfaces` form (A.5.3).
 * Ten values, kebab-free by construction — every member is a single word.
 *
 * NOTE (A.2.7): `search.matches`'s `symbols` form has a DIFFERENT field of the
 * same name — `SymbolLocation.role` carries values like `"interface Order"` —
 * and it stays `role?: string`. The two are deliberately not unified.
 */
export type SurfaceRole = ImpactSurface;

/**
 * §4.4(3) — PER-SOURCE CONTINUATION.
 *
 * E-8 (A.8.2, an impossible-state assertion): `!body` implies `prior` or
 * `remaining`.
 */
export type Evidence = {
  handle: string;

  /**
   * Required on FRESH evidence (§3.3's addressing triple). Absent only on
   * `PriorEvidence`, where absence means the caller already holds the
   * addressing (receipt compaction, §2.3).
   */
  path?: string;

  /** As `path`. */
  range?: string;

  /**
   * The served bytes. Emitted iff these bytes are served in THIS response;
   * absence means the bytes are not here, and `prior` or `remaining` says why
   * (E-8).
   */
  body?: string;

  /**
   * These bytes were served earlier IN THIS SESSION, by the call named here.
   * Absence means this is not a re-serve claim. §2.1.1: `prior` is a VERIFIABLE
   * claim — a `prior` naming nothing the client received is a false floor.
   */
  prior?: string;

  /** Unserved windows of THIS handle. Absence means this handle is fully served, at the windows requested. */
  remaining?: string[];

  /**
   * [R4-2], adjudicated 2026-08-13. The server's classification of this
   * surface. Emitted on FRESH evidence WHEN the server classified the surface;
   * absent when it did not, and carried on `pack-unchanged` receipt surfaces as
   * part of handle/path/range/role addressing (§2.3).
   *
   * Absence means the surface was NOT CLASSIFIED — not that its role is
   * `"unknown"`, which is an emitted value with its own meaning. A caller that
   * passed `surfaceRoles` and gets evidence with no `role` learns that the
   * selector did not bind, which is the readback [R4-2] exists to give it.
   * Additive under §1.4(a).
   */
  role?: SurfaceRole;
};

/** Evidence that serves NEW content. §3.3: all three of handle/path/range. */
export type FreshEvidence = Evidence & { path: string; range: string };

/** Evidence the caller already holds. §2.3/§3.3: compaction is legitimate here
 *  and only here; `prior` names the earlier call that put the bytes on the wire. */
export type PriorEvidence = Evidence & { prior: string; body?: undefined };

// ---------------------------------------------------------------------------
// A.5.15 `refusal`
// ---------------------------------------------------------------------------

/**
 * §2.6, cross-tool. `isError: true` (§2.5), on every refusal without exception.
 *
 * `Refusal` is the fourth family of `ProtocolResult` and lives here rather than
 * in a per-tool file (§2.2): its `for` field names which tool refused, and a
 * per-tool refusal type would recreate the two-parallel-unions defect §2.4
 * exists to remove.
 *
 * What is deliberately ABSENT:
 *  - `error` — v1 has no `error` field on `Refusal`. Machine tokens that rode
 *    `error` become `code`; prose becomes `detail` (A.9.2 row 6).
 *  - `terminal`, `terminal_reason`, `unlock`, `retry_same_call` — they collapse
 *    into `retry` + `code` (§2.6). `terminal_reason`'s value set is absorbed by
 *    `RefusalCode`.
 *  - `required_action` — deleted by F6; §2.6 carries the exhaustive mapping of
 *    its four values onto `decision.kind` and `Refusal.retry`.
 *  - `next_call_is_template` — no `next` is EVER a template (§2.6 abolishes
 *    placeholder-bearing calls). A server that cannot construct an executable
 *    call emits `decision: {kind:"await_input", …}` instead.
 */
export type Refusal =
  /**
   * The `challenge` arm. `certificate_id` is REQUIRED here and only here —
   * USER-ADJUDICATED 2026-08-13, implemented in C2-4.
   *
   * §2.6 makes the agent AUTHOR the challenge "from the advertised
   * `edit_file`/`read_file` request schema plus the refusal's
   * `retry:\"challenge\"`", and `challenge.certificate_id` is a required
   * argument of that call (the server refuses a challenge whose id does not
   * match the active task, `state/session.ts:2150`). A `retry:"challenge"` with
   * no certificate to name is therefore not a transition — it is a dead end
   * wearing a transition's label. Making the requirement TYPE-LEVEL is what
   * stops a construction site from emitting one: the runtime half degrades such
   * a refusal to `retry:"new-task"`, which is always available under §2.6's
   * standing re-pack rule.
   *
   * This field is NOT advisory. It is the one piece of refusal payload a client
   * legitimately branches on, which is exactly why it is declared here rather
   * than riding the advisory passthrough it used to.
   */
  | (RefusalCore & { retry: "challenge"; certificate_id: string })
  /**
   * Every other transition. `certificate_id` MAY still be present — the
   * prepared fence stamps it on terminal and re-pack refusals as provenance —
   * but nothing depends on it there.
   */
  | (RefusalCore & { retry: Exclude<RetryTransition, "challenge">; certificate_id?: string });

/** The fields every `Refusal` carries regardless of its `retry` transition. */
type RefusalCore = {
  v: ProtocolVersion;
  kind: "refusal";
  for: ToolName;
  code: RefusalCode;

  /**
   * Emitted iff the server can construct a FULLY EXECUTABLE call (§2.6).
   * Absence means the caller composes the recovery from `retry` + `code`;
   * it NEVER means a template was withheld.
   */
  next?: ToolCall;

  /** §1.3.1(5): path-qualified offending property. Absence means the refusal is not about a named property. */
  field?: string;

  /**
   * §1.3.1(4): at most ONE candidate, Damerau-Levenshtein <= 2 against the
   * advertised keys AT THAT PATH. Stays singular and stays bound to `field`
   * (i.e. to `fields[0]`); a per-offender suggestion array is the budget
   * blow-out §1.3.1(4) refuses. Absence means nothing qualified — NOT that the
   * server did not look.
   */
  did_you_mean?: string;

  /**
   * §1.3.1(4): the advertised keys AT THAT PATH, budget-gated. Absence means
   * the list did not fit the refusal budget; the caller reads `tools/list`,
   * which it already has.
   */
  keys?: string[];

  /**
   * O-2, the multiple-offender slot. Emitted IFF the refusal names MORE THAN
   * ONE offending property; then `field === fields[0]` and `fields` is in
   * document order. When exactly one property offends, `field` alone carries it
   * and `fields` is absent (the C-5 rule, preserved).
   *
   * Named `fields`, not `unknown_arguments` (A.5.15): `Refusal` is cross-tool
   * and `code` is not restricted to `unknown-arguments`, so a slot named after
   * one code could not carry the plural of an out-of-enum value refusal
   * (§1.3.1(6)), which has the same multiplicity. The reason the plural exists
   * at all is ORCHESTRATOR CONDITION ② (one-round-trip recovery), not
   * completeness: naming only the first of three typos converts a recursive
   * validator into a serial one.
   */
  fields?: string[];

  /** Prose. Shed first under budget pressure (A.8 rule E-7). */
  detail?: string;

  /** Owed work after recovery, unchanged. Absence means the recovery completes the request. */
  remaining?: string;
};

/**
 * §2.6, 5 values, closed. Kebab-cased by [R4-6] (adjudicated 2026-08-13).
 *
 * `retry:"none"` does NOT mean "nothing you can do": §2.6 makes a fresh
 * `taskEpoch` re-pack always available and needing no sanction. That is a
 * standing guide rule, stated once, not a field paid for on every refusal.
 */
export type RetryTransition =
  | "call"        // fix the named argument and re-issue
  | "challenge"   // attach a `challenge` and re-issue the same call
  | "new-task"    // different task; re-pack a new epoch
  | "user-input"  // the server cannot proceed without a human choice
  | "none";       // no transition on THIS call shape is sanctioned

// ---------------------------------------------------------------------------
// A.7.1 `RefusalCode` — harvested, 132 values
//
// PROVENANCE OF 132: the P1b harvest returned 133; P2 / C2-7b removed 3 values
// D10 had already left with zero emitters (`task-pack-disabled`,
// `small-file-disabled`, `edit-intents-disabled` — see the in-place notes
// below), leaving 130 landed; [R5-29] minted 2 (`is-a-directory`,
// `write-intent-ambiguous`, ratified 2026-08-14), giving 132.
//
// READ 132 AS A FLOOR, NOT A CEILING. The number is what an exhaustive harvest
// of the tree at the P1b HEAD returned; it is EVIDENCE, not a proof. The proof
// of exhaustiveness is A.9.2 row 3 — typing `toolStructuredError()`'s boundary
// to `ProtocolResult` makes `tsc` the check, so after P2 the enum is exhaustive
// IFF the build passes. A code found later is ADDITIVE under §1.4(a) and costs
// nothing; a code here that turns out never to be emitted is removable pre-v1
// and breaking post-v1, which is why the reader-zero pass belongs inside P2.
//
// MEMBERSHIP RULE (derived from §2.4, not invented): `RefusalCode` contains
// exactly the values that can appear as `Refusal.code` on a response whose
// `kind` is `refusal` — §2.4's "nothing was attempted" row. Consequently OUT:
//  - `rollback-failed` and the `workspace-state-unknown` sentinel — §2.4
//    promotes both to KINDS (`edit.rolled_back`, `edit.state_unknown`);
//  - per-item `omitted[]`/`skipped[]` reasons — they ride inside a SUCCESS
//    payload's per-item ledger and become `Limit` + `OmittedClass` (§4.4);
//  - locate abstains (`LocateAbstainData.reason`) — a `hit:false` locate is a
//    valid, complete `search.matches` result (§4.3);
//  - `ReferenceTruncationReason` — pagination, i.e. `Limit.cause:"records"`;
//  - implementation-only error-code unions that never reach the MCP wire;
//  - host-profile reasons governed by a separate package contract (§1.7);
//  - `profile_binding.reason` — prose, not a code.
// ---------------------------------------------------------------------------

export type RefusalCode =
  | RequestShapeCode | HandleCode    | TypestateCode | WriteCode
  | IntentCode       | ReadLimitCode | DocumentCode  | ArchiveCode
  | ArtifactCode     | CredentialCode;

/** Request shape and dispatch routing. §1.3.1, C-5/C-6. */
export type RequestShapeCode =
  | "unknown-arguments"                 // validation/requestShape.ts (grep "unknown-arguments"); server.ts (grep "unknown-arguments")
  | "invalid-input"                     // server.ts (grep "invalid-input"); applyEditsMulti.ts (grep "invalid-input")
  | "invalid-cwd"                       // server.ts (grep "invalid-cwd")
  | "invalid-lane"                      // server.ts (grep "invalid-lane")
  | "cwd-required-for-edit"             // server.ts (grep "cwd-required-for-edit")
  | "cwd-required-for-create"           // server.ts (grep "cwd-required-for-create")
  | "workspace-boundary"                // server.ts (grep "workspace-boundary"); write/pathlessEdit.ts (grep "workspace-boundary")
  | "mixed-batch-workspace-ambiguous"   // server.ts (grep "mixed-batch-workspace-ambiguous")
  | "elided-content";                   // server.ts (grep "elided-content")

/** Handle addressing (§3.3: a handle is a server-side capability token). */
export type HandleCode =
  | "handle-unknown"                          // server.ts (grep "handle-unknown")
  | "handle-workspace-missing"                // server.ts (grep "handle-workspace-missing")
  | "handle-workspace-mismatch"               // server.ts (grep "handle-workspace-mismatch")
  | "handle-required"                         // server.ts (grep "handle-required")
  | "handle-required-lockdown"                // server.ts (grep "handle-required-lockdown")
  | "directory-handle-unknown"                // server.ts (grep "directory-handle-unknown")
  | "directory-handle-workspace-mismatch"     // server.ts (grep "directory-handle-workspace-mismatch")
  | "directory-handle-wrong-kind";            // server.ts (grep "directory-handle-wrong-kind")

/** Execution typestate and the prepared fence (§2.6 progressivity). */
export type TypestateCode =
  | "execution-typestate"                                    // state/session.ts (grep "execution-typestate")
  | "prepared-discovery-closed"                              // state/session.ts (grep "prepared-discovery-closed")
  | "discovery-loop-brake"                                   // state/session.ts (grep "discovery-loop-brake")
  | "prescribed-step-executed-target-still-inadmissible"     // state/session.ts (grep "prescribed-step-executed-target-still-inadmissible")
  | "create-target-not-servable"                             // state/session.ts (grep "create-target-not-servable")
  | "create-target-exists"                                   // server.ts (grep "create-target-exists")
  | "repeated-all-served-find";                              // features/search/find/servedFindEscalation.ts (grep "repeated-all-served-find")

/** Write preconditions and edit validation. Nothing was attempted. */
export type WriteCode =
  | "write-not-enabled"                   // applyEditsMulti.ts (grep "write-not-enabled"); write/rangeEdit.ts (grep "write-not-enabled")
  | "hash-mismatch"                       // write/preconditions.ts (grep "hash-mismatch")
  | "scope-violation"                     // write/preconditions.ts (grep "scope-violation")
  | "out-of-scope"                        // write/preconditions.ts (grep "out-of-scope")
  | "blast-radius-precondition-required"  // write/blastRadius.ts (grep "blast-radius-precondition-required"); applyEditsMulti.ts (grep "blast-radius-precondition-required")
  | "range-out-of-bounds"                 // applyEditsMulti.ts (grep "range-out-of-bounds")
  | "range-invalid"                       // tools/readCodeModes.ts (grep "range-invalid")
  | "served-content-stale"                // applyEditsMulti.ts (grep "served-content-stale")
  /**
   * [R5-29] AMBIGUOUS WRITE INTENT: `content` for a file that already exists,
   * with neither `search` nor `create:true`. The request has two readings the
   * server may not choose between — replace the whole body, or edit part of it.
   * Minted 2026-08-14; emitters `server.ts:8961` (the `edits[]` batch mirror)
   * and `server.ts:9337` (the single edit), both formerly `invalid-input`.
   */
  | "write-intent-ambiguous"              // server.ts (grep "write-intent-ambiguous")
  | "search-not-unique"                   // server.ts (grep "search-not-unique"); applyEditsMulti.ts (grep "search-not-unique")
  | "empty-search"                        // applyEditsMulti.ts (grep "empty-search"); write/textEdit.ts (grep "empty-search")
  | "ambiguous"                           // applyEditsMulti.ts (grep "ambiguous"); write/textEdit.ts (grep "ambiguous")
  | "not-found"                           // applyEditsMulti.ts (grep "not-found"); server.ts (grep "not-found")
  | "overlapping-ranges"                  // applyEditsMulti.ts (grep "overlapping-ranges")
  | "edits-item-missing-target"           // server.ts (grep "edits-item-missing-target")
  | "edits-item-shape"                    // server.ts (grep "edits-item-shape")
  | "precondition-unsupported-for-batch"  // server.ts (grep "precondition-unsupported-for-batch")
  | "write-error"                         // applyEditsMulti.ts (grep "write-error"); tools/readAndEdit.ts (grep "write-error")
  | "read-error"                          // tools/searchReplaceEdit.ts (grep "read-error")
  | "index-error"                         // write/pathlessEdit.ts (grep "index-error")
  | "secret-file"                         // applyEditsMulti.ts (grep "secret-file"); write/rangeEdit.ts (grep "secret-file")
  | "path-escape"                         // applyEditsMulti.ts (grep "path-escape")
  | "file-too-large"                      // applyEditsMulti.ts (grep "file-too-large"); write/rangeEdit.ts (grep "file-too-large")
  | "path-outside-workspace";             // intents/appendEnumMember.ts (grep "path-outside-workspace"); tools/readCodeSmallFile.ts (grep "path-outside-workspace")

/** `edit_file intent=…`. */
export type IntentCode =
  | "intent-unknown"                 // intents/index.ts (grep "intent-unknown")
  | "intent-unsupported"             // intents/appendUnionMember.ts (grep "intent-unsupported"); intents/renameSymbolReferences.ts (grep "intent-unsupported")
  | "intent-lang-unsupported"        // intents/appendUnionMember.ts (grep "intent-lang-unsupported")
  | "intent-ambiguous"               // intents/removeDuplicateBranch.ts (grep "intent-ambiguous")
  | "intent-no-duplicate-in-scope"   // intents/removeDuplicateBranch.ts (grep "intent-no-duplicate-in-scope")
  | "intent-incompatible-with-batch" // server.ts (grep "intent-incompatible-with-batch")
  | "intent-requires-handle";        // server.ts (grep "intent-requires-handle")
  // D10 deleted `edit-intents-disabled` with its flag (intents are
  // unconditional now), leaving the value with zero emitters. Removed in
  // P2 / C2-7b: free pre-publish under §1.4(d), breaking after.

/** Read-side caps, governor stops, and mode gates. */
export type ReadLimitCode =
  | "symbol-cap-reached"              // server.ts (grep "symbol-cap-reached")
  | "cap-exceeded"                    // server.ts (grep "cap-exceeded")
  | "per-task-cap-reached"            // server.ts (grep "per-task-cap-reached"); util/fullGovernor.ts (grep "per-task-cap-reached")
  | "per-path-cap-reached"            // util/fullGovernor.ts (grep "per-path-cap-reached")
  | "candidate-pack-full-repeat"      // util/fullGovernor.ts (grep "candidate-pack-full-repeat")
  | "tiny-task-cap-reached"           // util/fullGovernor.ts (grep "tiny-task-cap-reached")
  | "allowfull-task-cap-reached"      // util/fullGovernor.ts (grep "allowfull-task-cap-reached")
  | "artifact-full-downgraded"        // server.ts (grep "artifact-full-downgraded")
  | "not-tiny"                        // tools/readCodeSmallFile.ts (grep "not-tiny")
  | "broad-overview-query"            // features/task-pack/readCodeTaskPack.ts (grep "broad-overview-query")
  // D10 deleted `task-pack-disabled` (server.ts:4607), `small-file-disabled`,
  // and `edit-intents-disabled` with their flags (the gated serves are
  // unconditional now), leaving all three values with zero emitters. Removed
  // here in P2 / C2-7b: free pre-publish under §1.4(d), breaking after.
  | "not-a-directory"                 // tools/exploreTree.ts (grep "not-a-directory")
  /**
   * [R5-29] The read target IS a directory. Minted 2026-08-14; emitter
   * `server.ts:7145`, which coerced it onto `invalid-input` because no member
   * fit: `not-a-directory` directly above is the INVERSE case (a directory was
   * expected and a file arrived), and `directory-handle-wrong-kind` is scoped
   * to HANDLE addressing, while no handle is involved here.
   */
  | "is-a-directory"                  // server.ts (grep "is-a-directory")
  | "markdown-section-read-failed"    // server.ts (grep "markdown-section-read-failed")
  | "markdown-section-ambiguous"      // server.ts (grep "markdown-section-ambiguous")
  | "markdown-section-not-found";     // server.ts (grep "markdown-section-not-found")

/** Office / PDF / zip extraction. */
export type DocumentCode =
  | "not-a-document"                  // tools/extractOfficeText.ts (grep "not-a-document")
  | "too-large"                       // tools/extractOfficeText.ts (grep "too-large"); office/zipPreflight.ts (grep "too-large")
  | "corrupt"                         // tools/extractOfficeText.ts (grep "corrupt")
  | "not-a-zip"                       // office/zipPreflight.ts (grep "not-a-zip")
  | "part-too-large"                  // office/zipPreflight.ts (grep "part-too-large")
  | "too-many-entries"                // office/zipPreflight.ts (grep "too-many-entries")
  | "zip-bomb"                        // office/zipPreflight.ts (grep "zip-bomb")
  | "office-encryption-unsupported"   // office/decrypt.ts (grep "office-encryption-unsupported")
  | "office-password-required"        // office/decrypt.ts (grep "office-password-required")
  | "office-password-invalid"         // office/decrypt.ts (grep "office-password-invalid")
  | "office-decrypted-too-large"      // office/decrypt.ts (grep "office-decrypted-too-large")
  | "office-encrypted-too-large"      // office/decrypt.ts (grep "office-encrypted-too-large")
  | "office-verification-failed"      // write/artifactEdit.ts (grep "office-verification-failed")
  | "pdf-encrypted"                   // office/pdf.ts (grep "pdf-encrypted")
  | "pdf-password-invalid"            // office/pdf.ts (grep "pdf-password-invalid")
  | "pdf-no-text-layer"               // office/pdf.ts (grep "pdf-no-text-layer")
  | "pdf-parse-failed"                // office/pdf.ts (grep "pdf-parse-failed")
  | "pdf-edit-failed"                 // write/artifactEdit.ts (grep "pdf-edit-failed")
  | "pdf-encryption-not-preserved"    // write/artifactEdit.ts (grep "pdf-encryption-not-preserved")
  | "pdf-form-not-found"              // write/artifactEdit.ts (grep "pdf-form-not-found")
  | "pdf-verification-failed";        // write/artifactEdit.ts (grep "pdf-verification-failed")

/** Archive read (`ArchiveFailureCode`, archive.ts) plus the ZIP-edit codes from
 *  write/artifactEdit.ts's `fail()` (:95). */
export type ArchiveCode =
  | "archive-not-found"               // packages/types/src/mcp/archive.ts (grep "archive-not-found"); server.ts (grep "archive-not-found")
  | "archive-unsupported"             // packages/types/src/mcp/archive.ts (grep "archive-unsupported")
  | "archive-corrupt"                 // packages/types/src/mcp/archive.ts (grep "archive-corrupt")
  | "archive-encrypted"               // packages/types/src/mcp/archive.ts (grep "archive-encrypted")
  | "archive-password-invalid"        // packages/types/src/mcp/archive.ts (grep "archive-password-invalid")
  | "archive-encryption-unsupported"  // packages/types/src/mcp/archive.ts (grep "archive-encryption-unsupported")
  | "archive-too-large"               // packages/types/src/mcp/archive.ts (grep "archive-too-large")
  | "archive-too-many-entries"        // packages/types/src/mcp/archive.ts (grep "archive-too-many-entries")
  | "archive-bomb"                    // packages/types/src/mcp/archive.ts (grep "archive-bomb")
  | "archive-unsafe-path"             // packages/types/src/mcp/archive.ts (grep "archive-unsafe-path")
  | "archive-entry-not-found"         // packages/types/src/mcp/archive.ts (grep "archive-entry-not-found")
  | "archive-entry-binary"            // packages/types/src/mcp/archive.ts (grep "archive-entry-binary")
  | "archive-read-only-container"     // server.ts (grep "archive-read-only-container")
  | "archive-member-read-only"        // server.ts (grep "archive-member-read-only")
  | "archive-duplicate-member"        // write/artifactEdit.ts (grep "archive-duplicate-member")
  | "archive-entry-limit"             // write/artifactEdit.ts (grep "archive-entry-limit")
  | "archive-expanded-too-large"      // write/artifactEdit.ts (grep "archive-expanded-too-large")
  | "archive-member-exists"           // write/artifactEdit.ts (grep "archive-member-exists")
  | "archive-member-not-found"        // write/artifactEdit.ts (grep "archive-member-not-found")
  | "archive-member-path-invalid"     // write/artifactEdit.ts (grep "archive-member-path-invalid")
  | "archive-member-too-large"        // write/artifactEdit.ts (grep "archive-member-too-large")
  | "archive-password-required"       // write/artifactEdit.ts (grep "archive-password-required")
  | "archive-read-error"              // write/artifactEdit.ts (grep "archive-read-error")
  | "archive-verification-failed"     // write/artifactEdit.ts (grep "archive-verification-failed")
  | "archive-write-failed";           // write/artifactEdit.ts (grep "archive-write-failed")

/** Structured artifact edit (xlsx/docx/pptx/pdf/zip). */
export type ArtifactCode =
  | "artifact-edit-required"                  // server.ts (grep "artifact-edit-required")
  | "artifact-edit-incompatible-arguments"    // server.ts (grep "artifact-edit-incompatible-arguments")
  | "artifact-precondition-unsupported"       // server.ts (grep "artifact-precondition-unsupported")
  | "artifact-edit-invalid"                   // write/artifactEdit.ts (grep "artifact-edit-invalid")
  | "artifact-edit-too-many-mutations"        // write/artifactEdit.ts (grep "artifact-edit-too-many-mutations")
  | "artifact-kind-mismatch"                  // write/artifactEdit.ts (grep "artifact-kind-mismatch")
  | "artifact-output-too-large"               // write/artifactEdit.ts (grep "artifact-output-too-large")
  | "artifact-search-not-found"               // write/artifactEdit.ts (grep "artifact-search-not-found")
  | "artifact-search-not-unique"              // write/artifactEdit.ts (grep "artifact-search-not-unique")
  | "artifact-too-large"                      // write/artifactEdit.ts (grep "artifact-too-large")
  | "xlsx-edit-failed"                        // write/artifactEdit.ts (grep "xlsx-edit-failed")
  | "xlsx-edit-unavailable"                   // write/artifactEdit.ts (grep "xlsx-edit-unavailable")
  | "xlsx-sheet-not-found";                   // write/artifactEdit.ts (grep "xlsx-sheet-not-found")

/** `CredentialFailureCode` — packages/mcp-server/src/security/credentials.ts:1. */
export type CredentialCode =
  | "credential-ref-invalid"    // security/credentials.ts (grep "credential-ref-invalid")
  | "credential-not-found"      // security/credentials.ts (grep "credential-not-found")
  | "credential-invalid";       // security/credentials.ts (grep "credential-invalid")
