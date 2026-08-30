// ---------------------------------------------------------------------------
// protocol v1 — the single decision (§2.1) and the leaf types it owns.
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13), A.2.3–A.2.6, A.3, A.7.2. Implements the A.9.1 `decision.ts` row.
// ---------------------------------------------------------------------------

import type { ToolCall, EditToolCall, CapabilityGap, WorkspaceMarker } from "./protocol.js";

// ---------------------------------------------------------------------------
// A.2.3 `TaskRef` — identity and replay token are TWO things, so two fields
// ---------------------------------------------------------------------------

/**
 * §3.0's first open question, resolved: `qref` is both an identity AND a replay
 * token, and one field cannot be both because their INVALIDATION RULES ARE
 * OPPOSITE. A task's identity is stable across re-packs (it is what makes
 * "same-task restatement auto-binds candidates" coherent, and what
 * `certificate.task_fingerprint` binds to); a replay token is a server-issued
 * capability that dies with the session, rotates on a new epoch, and is not
 * reconstructible by the caller. A client holding one field would either treat
 * a rotated token as a changed task (false) or a stale token as still
 * redeemable (false).
 */
export type TaskRef = {
  /**
   * Stable identity of the question this pack answers. Survives re-packs of
   * the same task; changes when the task changes. Never redeemable as an
   * argument.
   */
  id: string;

  /**
   * Opaque, session-lived replay token. Pass back as the `qref` request
   * property to re-pack without resending `query`. Emitted iff the server can
   * honour a replay for this task; absence means re-packing requires resending
   * `query` — NOT that the task changed.
   * NOT an identity: two responses with different `replay` may share one `id`.
   */
  replay?: string;

  /** §4.4: surface IDENTIFICATION, deliberately distinct from content
   *  completeness. Not absorbed into Evidence/Limit/CapabilityGap.
   *  Home CONFIRMED by the [R4-3] adjudication (2026-08-13): coverage rides
   *  `task`, and is not a seventh top-level field (§3.0). It is a property of
   *  that identification — not of the decision (which would make it invalidated
   *  by workspace mutation, which it is not) and not of the payload (which is
   *  `Limit`'s axis). */
  coverage: "complete" | "focused" | "partial";

  /** Emitted iff `coverage !== "complete"`. [R4-3] */
  coverage_reason?: CoverageReason;
};

/** Harvested verbatim from `ReadCodeTaskPackOutput.coverage_reason` (task-pack.ts). */
export type CoverageReason =
  | "single-site"
  | "candidate-list"
  | "missing-roles"
  | "concerns-uncovered"
  | "diff-truncated";

// ---------------------------------------------------------------------------
// A.2.4 `CertificateRef`
// ---------------------------------------------------------------------------

/**
 * §3.0's second open question, resolved: the certificate-binding workspace
 * fingerprint lives HERE, not on `TaskRef`. Three grounds — (1) §3.0's own
 * reasoning followed through ("it binds a certificate"); (2) lifetime: a
 * workspace mutation invalidates a certificate but does not change which
 * question was asked, so on `TaskRef` the fingerprint would make task identity
 * move whenever any file moved; (3) reuse: §4.2.1(3) puts a workspace marker in
 * the side-effect-report minimal core, and side-effect reports carry no
 * `TaskRef` at all.
 *
 * DELIBERATELY NOT HERE: `action_frontier`. In v1 that content is
 * `decision.act.edit.frontier` and nowhere else — carrying it on the
 * certificate too would be an E4 second authority for the bounded effect area,
 * which is the field class §3.4 exists to remove.
 *
 * No optional fields (A.8.2).
 */
export type CertificateRef = {
  /** The single carrier. §3.4 E3 records `certificate_id` triple-carried across
   *  `certificate_id` / `challenge.certificate_id` /
   *  `unlock.challenge.certificate_id`; v1 has exactly this one. */
  id: string;

  /**
   * The obligation ids this certificate names. REQUIRED and non-empty:
   * §2.1.1's `act.answer` floor is stated per obligation, so a certificate
   * that does not name its obligations makes the floor uncheckable.
   */
  obligations: [string, ...string[]];

  /**
   * Proved capability limits that remain material to the answer/edit.
   * Entries retain the `explicit-gap:` prefix and are bounded by the projector.
   */
  gaps?: [string, ...string[]];

  /** The workspace state this certificate was proved against (A.2.2). */
  workspace: WorkspaceMarker;
};

// ---------------------------------------------------------------------------
// A.2.5 `Candidate`
// ---------------------------------------------------------------------------

/**
 * One choice offered to the caller by `decision.await_input`. Grounded in the
 * live object-array form the census records (`candidates[]` with
 * `.handle`/`.path`/`.kind`) and in the second live form (`write/pathlessEdit.ts`:
 * `{path, line}`, capped at MAX_CANDIDATES = 3).
 *
 * NOT THIS TYPE: `concern_ambiguities[].candidates` is `string[]` — concern
 * ids, not surfaces. It is a different field that shares a name, and it rides
 * `plan`, not `decision.await_input.candidates`.
 */
export type Candidate = {
  /** Present on both live forms; the only field a caller can always use to
   *  tell two candidates apart. */
  path: string;

  /** Join key into this response's `evidence[]`. Emitted iff a body or surface
   *  for this candidate was minted this response. Absent on the pathless-edit
   *  form, which has no handle to give — the candidate is then identified by
   *  `path` (+`line`) only and there is nothing to join to. */
  handle?: string;

  /** 1-based line, from the pathless-edit form. Emitted iff the candidate is a
   *  site WITHIN a file rather than a whole file. */
  line?: number;

  /** What distinguishes this candidate. Emitted iff the server can name it;
   *  absence means the candidates differ only by location.
   *  Bare `string` DELIBERATELY: the value set is not declared anywhere today,
   *  and §10.1(b)'s rule — a type with no fields worth declaring is evidence the
   *  field should be a string — applies to an enum whose members cannot be
   *  harvested. Not one of §10.1(c)'s eight enums, so it is not required to be
   *  closed at v1. */
  kind?: string;

  /** The served body, emitted iff the server inlined this candidate's content.
   *  Absence means the caller must fetch it before choosing, or choose on path
   *  alone. */
  body?: string;
};

// ---------------------------------------------------------------------------
// A.2.6 `FrontierEntry`
// ---------------------------------------------------------------------------

/**
 * One entry of the bounded effect area an `act.edit` decision sanctions.
 * §0.2 forbids widening what an agent may edit, so the live three-way split
 * (`frontier` / `write_targets` / `also_admissible`) must survive the move to
 * a flat array. It survives as `writable`.
 *
 * WHY NOT REUSE `role`: `frontier_index[].role` carries the SURFACE role
 * vocabulary (`SurfaceRole`), which answers a different question (*what kind of
 * surface is this?*) from `writable` (*may an agent edit here?*) and would
 * silently overload the one field §0.2 forbids getting wrong. `SurfaceRole`
 * rides `Evidence.role` instead ([R4-2]), where it is a classification and not
 * a permission.
 */
export type FrontierEntry = {
  handle: string;
  path: string;

  /**
   * `true`  — today's `frontier.write_targets`: an edit here is sanctioned.
   * `false` — today's `frontier.also_admissible`: admissible evidence, NOT a
   *           write target.
   * The array as a whole is today's `frontier`. No entry is admissible that
   * is absent from the array, and no entry is writable that is not marked so.
   */
  writable: boolean;
};

/**
 * A.2.6's create-side counterpart: WHERE a file that does not exist yet goes.
 *
 * WHY IT IS NOT A `FrontierEntry` ([R5-23], ruling 6, adjudicated 2026-08-14).
 * `FrontierEntry`'s addressing triple requires a `handle`, and a file that does
 * not exist has none. Widening the triple with an optional `handle` (option (a))
 * was REJECTED: it would weaken §3.3's addressing guarantee for every OTHER
 * entry to accommodate the one that cannot satisfy it. So the create target
 * rides beside the frontier on the same member, and §2.1.1's floor reads
 * "`frontier` non-empty OR a create target" (option (b)).
 *
 * `directory_evidence` is the proof, not decoration: the target directory was
 * resolved from exactly one existing directory and these are the sibling files
 * that were served as the imitation evidence. A create target with no evidence
 * is not proved and is not emitted (`resolveExplicitArtifactCreateTarget`).
 */
export type CreateTarget = {
  /** Workspace-relative path of the file to create. */
  path: string;
  /** The served siblings that prove the directory, and that the new file imitates. */
  directory_evidence: string[];
};

// ---------------------------------------------------------------------------
// A.3 The decision (§2.1, §2.1.1, §2.1.2)
// ---------------------------------------------------------------------------

/**
 * §2.1 — the single authority, emitted exactly ONCE per response.
 * One-to-one with `CanonicalTaskDecisionKind`
 * (features/task-pack/canonicalDecision.ts:17-22):
 *   discover     <- "discover"
 *   await_input  <- "await-input"
 *   act.answer   <- "act-answer"
 *   act.edit     <- "act-edit"
 *   done         <- "terminal-closed"
 *
 * CASING EXEMPTION (A.7.0, exemption 1): the decision-kind vocabulary keeps the
 * same dot+`snake_case`-leaf convention as `Kind`. It is adjudicated verbatim in
 * §2.1/§2.1.1 with the D-1…D-5 invariants stated on THESE spellings, and §2.6's
 * binding table names `decision.kind: "act.answer"` literally. Renaming
 * `await_input` here would be a second adjudication of §2.1, which §10.2 forbids.
 *
 * Structural properties the union enforces, restated so they are checkable:
 *  - D-1. `next` is representable ONLY on `discover`. A `next` on `act.*` or
 *    `done` is a type error (§2.1, the P0a single-decision fence).
 *  - D-2. `certificate` is representable only on `act.answer` / `act.edit`.
 *  - D-3. `frontier` is representable only on `act.edit` — an `act.answer`
 *    cannot carry an edit frontier at all (§2.1: "answering is not editing").
 *    Since [R5-23] (ruling 6) the same member also carries `create_target`, and
 *    the two are alternatives, not additions: `frontier` addresses files that
 *    exist, `create_target` names the one that does not. D-3 is unchanged in
 *    what it FORBIDS — neither field is representable off `act.edit` — and the
 *    "at least one of them" half moved from the TYPE to FLOOR-EDIT below,
 *    because a disjunction over two optional members is a runtime property.
 *  - D-4. `gaps` is representable only on `discover` (§4.4: `CapabilityGap`
 *    lives on `decision.gaps` and nowhere else).
 *  - D-5. `done` has no payload beyond its tag.
 *
 * The `act` delivery floors (§2.1.1), as predicates over the whole response R:
 *
 *   FLOOR-ANSWER(R) :=
 *     R.decision.kind === "act.answer" IMPLIES
 *       ∀ o ∈ R.decision.certificate.obligations :
 *          ∃ e ∈ R.evidence :
 *             e serves o  AND  ( typeof e.body === "string"
 *                                OR ( typeof e.prior === "string"
 *                                     AND e.prior names a call whose response
 *                                         the client received in THIS session ) )
 *
 *   FLOOR-EDIT(R) :=
 *     R.decision.kind === "act.edit" IMPLIES
 *       (   R.decision.frontier !== undefined
 *           AND R.decision.frontier.length >= 1        )
 *       OR  R.decision.create_target !== undefined
 *
 *     AMENDED BY [R5-23] (ruling 6, 2026-08-14). It used to read
 *     `frontier.length >= 1` alone, which made a create-only `act.edit`
 *     STRUCTURALLY UNEMITTABLE: `projectFrontier` builds entries from
 *     handle-joined paths, a create target contributes none, and the decision
 *     degraded to `discover` while the same response separately handed the
 *     caller `edit_file create:true path=…`. The floor is a disjunction now
 *     because "where may I write" has two honest spellings, not because the
 *     floor was weakened — an `act.edit` carrying NEITHER is still a breach.
 *
 *   DEGRADE(R) :=
 *     a shed that would falsify FLOOR-ANSWER or FLOOR-EDIT MUST produce
 *     R.decision = { kind: "discover", next: <non-empty> } — never an `act`
 *     member with a shorn floor.
 *
 * `next` as a set (§2.1.2, F5):
 *
 *   NEXT-INDEPENDENCE :=
 *     when decision.discover.next is an array, every member is executable NOW
 *     against the state the client holds, in any order, and no member's
 *     `arguments` reference another member's result.
 *
 * Later stages are not representable: there is no ordering field and no
 * `stages`.
 */
export type TaskDecision =
  | {
      kind: "discover";
      next: ToolCall | ToolCall[];
      /** Optional, non-binding explanation for a server-derived bundled re-pack. */
      advisory?: string;
      /** Emitted iff >=1 capability gap blocks the decision. Absence means
       *  nothing semantic is missing; the discovery is a delivery matter. */
      gaps?: CapabilityGap[];
    }
  /** `code` is REQUIRED and its enum is CLOSED AT FIVE (A.7.2, [R4-1]
   *  adjudicated 2026-08-13): every awaiting-input branch in the tree has its
   *  own token, so none has to claim `choose-candidate` falsely. */
  | {
      kind: "await_input";
      code: AwaitInputCode;
      /** Emitted iff the choice is between enumerable alternatives. Absence
       *  means the question is not a pick-one (e.g. a policy question). */
      candidates?: Candidate[];
    }
  | { kind: "act.answer"; certificate: CertificateRef }
  | {
      kind: "act.edit";
      certificate: CertificateRef;
      /** The bounded effect area over files that EXIST.
       *
       *  STILL NON-EMPTY WHEN PRESENT, now OPTIONAL ([R5-23], ruling 6). An
       *  empty array satisfies a plain `FrontierEntry[]` while satisfying
       *  nothing a caller can act on, so the tuple stays — the compile-level
       *  "no empty frontier" property is preserved exactly. What changed is
       *  that a create-only edit may OMIT the key rather than being forced to
       *  fabricate an entry for a file with no handle; FLOOR-EDIT above is
       *  what then requires `create_target` in its place. */
      frontier?: [FrontierEntry, ...FrontierEntry[]];
      /** WHERE a new file goes, when the edit this decision sanctions is a
       *  create ([R5-23], ruling 6). Emitted iff the pack proved a target from
       *  exactly one existing directory; absence means every write target
       *  already exists and rides `frontier`.
       *
       *  SINGLE AUTHORITY. When the decision is `act.edit` this is the ONLY
       *  copy on the response — the top-level `create_target` a task pack
       *  otherwise discloses is suppressed, because two carriers for "where
       *  may I write" is the E4 second-authority class §2.1 exists to remove. */
      create_target?: CreateTarget;
      /** Emitted iff the server can construct the exact edit call (§2.1.1).
       *  Absence means the caller composes the edit itself from `frontier`; it
       *  is NOT a signal that editing is unsanctioned. */
      apply?: EditToolCall;
    }
  | { kind: "done" };

// ---------------------------------------------------------------------------
// A.7.2 `AwaitInputCode` — CLOSED at five. [R4-1] adjudicated 2026-08-13
// ---------------------------------------------------------------------------

/**
 * §2.1: REQUIRED on `decision.await_input`. Five values, closed.
 * One harvested; four MINTED by the [R4-1] adjudication of 2026-08-13 — the
 * one place in the appendix where a value did not already exist as a token.
 * Every member names a branch that exists in the tree today, and each minted
 * name is taken from what that branch's own prose asks the caller for.
 *
 * Branch → value (A.7.2's table), which P2's emitter walk must follow exactly:
 *  1. `candidateChoicePending`  (readCodeTaskPack.ts:14601) → `choose-candidate`
 *  2. `concernChoicePending`    (:14603)                    → `name-intended-target`
 *  3. `grantServedTerminal`     (:14605)                    → `act-on-served-evidence`
 *  4. *else*                    (:14607)                    → `no-grounded-call-remains`
 *  5. `conflicting.length > 0`  (evidenceShadow.ts:303)  → `resolve-evidence-conflict`
 *
 * Naming rule, stated so a reviewer can check it rather than trust it: three of
 * the four minted names are the imperative the branch's own prose already
 * carries, reduced to kebab-case. The fourth is CONDITION-SHAPED rather than
 * ask-shaped, deliberately: branch 4's only imperative is "request user input",
 * which is what EVERY member of this enum means, so naming it that would carry
 * no information; its distinguishing content is the condition the prose states.
 *
 * HONESTY NOTE on branch 3, recorded rather than adjudicated: its prose GRANTS
 * the terminal action ("act on the served evidence") rather than posing a
 * question, yet the code routes it through `awaitingUserInput`. Whether that
 * branch belongs on `await_input` at all — versus `act.answer`/`act.edit` with
 * a §2.1.1 floor, or `discover` — is an emitter question P2 answers with the
 * walk, not a schema question (A.9.2 row 21).
 */
export type AwaitInputCode =
  | "choose-candidate"          // harvested
  | "name-intended-target"      // minted
  | "act-on-served-evidence"    // minted
  | "no-grounded-call-remains"  // minted
  | "resolve-evidence-conflict"; // minted
