// ---------------------------------------------------------------------------
// protocol v1 — THE REQUIRED SETS, AS DATA (P3a S2).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §4.3
// ("Required fields are per union member", the table at :1954-1969), A.4
// (the receipt union, [R4-4]), A.5.1-A.5.15, A.8.1 (the global emission
// rules E-1..E-7); TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §4.2 (the validator
// gate) and §8.1 (the shape count).
//
// ----------------------------- WHAT THIS FILE IS ---------------------------
//
// §4.3's normative sentence is "the required set is defined per UNION MEMBER,
// on the `kind` discriminator, not per tool". This file is that sentence as a
// TABLE the machine can read, so the rule is enforced rather than restated:
// `validate.ts` walks it, `emit.ts` refuses any shed candidate that falls out
// of it, and `__tests__/wireRequiredSets.spec.ts` proves every real body on the
// committed wire satisfies it.
//
// ------------------------------ THE SHAPE SPACE ----------------------------
//
// 27 shapes = 12 single-form kinds + `read.map` (6) + `read.receipt` (5) +
// `search.matches` (4).
//
// Those three kinds — and ONLY those three — state their required set PER FORM,
// by explicit rule ([R4-4], approved 2026-08-13, DESIGN:1994-2004): F3 split
// `read.*` exactly where the required sets were disjoint enough to earn a
// top-level `kind`, and where it chose one `kind` the disjointness moved one
// level down onto the member's internal tag (`form` / `receipt`). The member
// ENVELOPE then requires only the tag, which is why every tagged row below is
// keyed inside its block (`outline` / `receipt` / `matches`) rather than at the
// response top level.
//
// TWO COUNT CORRECTIONS ARE FOLDED IN, both factual rather than editorial:
//
//  - `read.map` has SIX forms, not the five DESIGN:1980 lists. `markdown` is
//    declared at `packages/types/src/mcp/read-result.ts:193-224` and fully
//    implemented in `readFamily.ts`'s `structuralOutline()`; DESIGN's A.5.3
//    prose calling it "undeclared at HEAD" is stale. A validator that omitted
//    it would reject a legitimate, shipping body.
//  - `read.artifact` is ONE row, not seven. Its `content.form` tag is
//    structurally the same construct as `read.map`'s, but [R4-4] names three
//    members and this is not one of them, and PLAN-DRAFT §8.1's formula counts
//    it single. The per-form disjointness is not lost: it is expressed as a
//    CONDITIONAL requirement inside this one row (`ARTIFACT_CONTENT_SHAPES`),
//    which is also the only formulation that survives the fact that `docx` /
//    `pptx` / `pdf` / `xlsx` each have TWO legitimate arms — a structured one
//    and a plain-`text` fallback (`read-result.ts`'s `ArtifactContent`). A
//    (kind, form) lookup cannot express "either of these two key sets"; a
//    predicate can.
//
// `read.batch` is likewise one row. Its `form` tag is PER ARRAY ENTRY, not per
// response, so it does not fit a (kind, form) key at all; the per-entry sets
// live in `BATCH_ENTRY_KEYS` and are checked by this row's own predicate.
//
// ------------------------- PRESENCE, NOT CLOSED EQUALITY -------------------
//
// A row states what MUST be there. It never states what may not be: the wire
// legitimately carries disclosed-carry fields that no `packages/types`
// declaration mentions (`KEPT_ON_APPLIED` alone is 28 of them, and the
// `edit.applied` pin uses 7), and the boundary between "declared" and
// "disclosed-carry" moves every few weeks. So the check is
//
//     requiredKeys(kind, form) SUBSET-OF keys(emitted)
//
// and never the reverse. Rejecting an undeclared key would break every real
// `edit.applied`, `refusal` and `search.matches.find` response on the wire.
//
// A key counts as present when it is an own property whose value is not
// `undefined` — the same test `JSON.stringify` applies, so this table judges
// exactly the bytes that ship.
//
// Empty is not absent. A.8.1's E-1 ("`[]` is never emitted in place of
// absence") governs OPTIONAL fields; it does not make a required array
// non-empty. `search.matches.find.files`, `search.references.references` and
// `read.task_pack.evidence` are all required keys that legitimately hold `[]`
// — DESIGN:1985-1986 says so twice, naming the census's 830 B zero-hit `find`
// body and its 190 B empty-`references` body. Non-emptiness is required at
// exactly the four places DESIGN states a floor: `read.text`'s evidence tuple,
// `pack-unchanged`'s prior evidence, `SideEffectCore.paths`, and
// `CertificateRef.obligations`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// S2c — ADOPT-LANDED CALIBRATION (2026-08-14) AND THE R5-8 WAVE RE-TIGHTEN LIST
//
// `TL_DECISION_INVARIANT_STRICT=1` proved five landed, legitimate wire bodies
// against rows this table had derived from PIN COVERAGE ALONE — no §6.1(b)
// pin ever exercised these payload classes, so the table required keys the
// real emitters never send. Adopt-landed discipline: the table is calibrated
// to what ships, never the reverse; no producer changed for this pass.
//
// RE-TIGHTEN WHEN THE R5-8 WAVE LANDS (DESIGN A.13 ruling 9, [R5-8]). Ruling
// 9 commissions a post-P3a wave converting `read.batch`'s office-redirect
// class from a `file-downgraded` batch entry into a first-class `refusal`.
// The SAME "redirect vs. extract" feature area (office documents under
// `mode=full`) also surfaces a sibling on `read.artifact` — ruling 9's own
// text is scoped to A.5.4 and does not itself enumerate this A.5.5 arm, but
// the reasoning is identical, so it is tracked here pending its own erratum:
//
//   - `read.artifact`, content resolved to the plain-`text` fallback for a
//     document form (`extractOfficeText`'s flat dialect, reached via
//     `mode=full allowFull:true` or the `search_files action=office` compat
//     redirect — never handle-backed): `path`/`handle`/`sha` are OPTIONAL
//     below (`isArtifactTextOnly`). Re-tighten to REQUIRED once this arm
//     gets its own resolution (whether folded into the R5-8 wave or a
//     sibling erratum).
//
// NOT ON THIS LIST — fixed PERMANENTLY below, not a stopgap:
//   - `read.batch`'s `file-downgraded` FIFTH class (`readCodeModes.ts`'s
//     mode=slice symbol-over-cap trimmed-head downgrade, re-served via
//     `handles=[]`) predates and is untouched by the R5-8 wave — that wave
//     converts only class (a); this is a different producer entirely.
//     `FILE_DOWNGRADED_SHAPES` below is its correct, final shape.
//   - `read.map` form `overview`'s `packages` key: a plain A.8.1 rule E-1
//     omit-when-empty gap (zero packages legitimately omits the key),
//     unrelated to R5-8.
// ---------------------------------------------------------------------------

import type { CreateTarget, FrontierEntry, Kind } from "@tokenlighten/types";

import { editFloorHolds } from "../decisionWire.js";

// ---------------------------------------------------------------------------
// The table's own vocabulary
// ---------------------------------------------------------------------------

/** A JSON object as it sits on the wire, before any type narrowing. */
export type WireBody = Readonly<Record<string, unknown>>;

/**
 * A named structural check, for the requirements a bare key-presence test
 * cannot express: "at least one", "each entry carries", "if A then B".
 *
 * The `id` is the violation's name and is what a failing verdict reports, so it
 * is written to be greppable and to survive re-ordering of this file.
 */
export type ShapePredicate = {
  readonly id: string;
  readonly holds: (scope: WireBody) => boolean;
};

/**
 * One of the 27 shapes.
 *
 * `keys` are resolved against the row's SCOPE: the response body for an
 * untagged kind, and the tagged BLOCK (`outline` / `receipt` / `matches`) for a
 * tagged one. `source` cites the line this row was transcribed from, so a
 * future reader can re-derive it rather than trusting it.
 */
export type RequiredSetRow = {
  readonly kind: Kind;
  readonly form?: string;
  readonly keys: readonly string[];
  readonly predicates: readonly ShapePredicate[];
  readonly source: string;
};

/**
 * A kind's entry: one row, or a block-tagged family of them.
 *
 * `block` is the top-level key holding the tagged object and `tag` is the
 * discriminator field INSIDE it — for `read.receipt` those are both spelled
 * `receipt`, which is A.4's shape and not a typo.
 */
export type ShapeEntry =
  | { readonly tagged: false; readonly row: RequiredSetRow }
  | {
      readonly tagged: true;
      readonly block: string;
      readonly tag: string;
      readonly rows: Readonly<Record<string, RequiredSetRow>>;
    };

// ---------------------------------------------------------------------------
// Small readers. Deliberately total: a malformed scope answers "no", never
// throws — a validator that can crash on a bad body is a second failure mode.
// ---------------------------------------------------------------------------

/** A plain JSON object (arrays and `null` are not). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own property whose value is not `undefined` — the `JSON.stringify` test. */
export function hasKey(scope: WireBody, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(scope, key) && scope[key] !== undefined;
}

function arrayAt(scope: WireBody, key: string): readonly unknown[] | undefined {
  const value = scope[key];
  return Array.isArray(value) ? value : undefined;
}

function recordAt(scope: WireBody, key: string): Record<string, unknown> | undefined {
  const value = scope[key];
  return isRecord(value) ? value : undefined;
}

function pred(id: string, holds: (scope: WireBody) => boolean): ShapePredicate {
  return { id, holds };
}

/** Every entry is an object carrying all of `fields` as present keys. */
function entriesCarry(items: readonly unknown[], fields: readonly string[]): boolean {
  return items.every((item) => isRecord(item) && fields.every((field) => hasKey(item, field)));
}

/** `key` holds a non-empty array whose every entry carries `fields`. */
function nonEmptyEntries(key: string, fields: readonly string[]): (scope: WireBody) => boolean {
  return (scope) => {
    const items = arrayAt(scope, key);
    return items !== undefined && items.length > 0 && entriesCarry(items, fields);
  };
}

/** `key` holds an array (possibly empty) whose every entry carries `fields`. */
function everyEntry(key: string, fields: readonly string[]): (scope: WireBody) => boolean {
  return (scope) => {
    const items = arrayAt(scope, key);
    return items !== undefined && entriesCarry(items, fields);
  };
}

// ---------------------------------------------------------------------------
// Sub-vocabularies the rows share
// ---------------------------------------------------------------------------

/**
 * `read.batch`'s PER-ENTRY required sets (`BatchEntry`,
 * `read-result.ts:312-388`). Keyed by the entry's own `form`, which is why they
 * live here and not in the (kind, form) table.
 *
 * `file` requires only `path`+`content`+`truncated` even though the type also
 * declares `handle` and `sha`: `batchEntry()`'s `file` arm keeps those two
 * CONDITIONALLY, so the wire may omit them. The committed `read.batch` pin
 * happens to carry both on all three of its entries; the row is written to the
 * producer's guarantee, not to the pin's good luck.
 */
const BATCH_ENTRY_KEYS: Readonly<Record<string, readonly string[]>> = {
  range: ["path", "range", "content", "truncated"],
  handle: ["handle", "path", "range", "content", "truncated", "sha"],
  file: ["path", "content", "truncated"],
};

/**
 * `file-downgraded`'s required set, AS A DISJUNCTION — S2c calibration
 * (2026-08-14), same discipline as `ARTIFACT_CONTENT_SHAPES` below.
 *
 * `readFamily.ts`'s `DOWNGRADE_FIELDS` doc comment enumerates FOUR classes,
 * all `resolveFullReadForPath` lineage (`server.ts:2598`) and all reachable
 * from `mode=full`: (a) the office redirect, (b) `code_unchanged` repeat,
 * (c) per-task-cap skeleton, (d) W1 head serve. DESIGN A.13 ruling 9
 * ([R5-8]) surveyed exactly those four: (b)/(c)/(d) always carry `reason`;
 * (a) carries it too (`reason:"artifact-full-downgraded"`) but never
 * `downgraded_from`/`handle`/`sha`, which is why ruling 9 converts (a) to a
 * `refusal` in a post-P3a wave (see the re-tighten list at the top of this
 * file) instead of writing this row around it.
 *
 * A FIFTH class exists that ruling 9's survey never counted, because it is
 * not `resolveFullReadForPath` lineage at all: `readCodeModes.ts`'s
 * mode=slice symbol-over-cap TRIMMED-HEAD downgrade
 * (`downgraded_from:"symbol"`, minted around :1005), re-served through the
 * `handles=[]` batch path. It never sets `reason` — same reasoning as its
 * `read.text` sibling (replayCorpus.spec.ts's scd2/scd3 note: the pre-v1
 * `reason:"symbol-cap-reached"` string was deliberately narrowed away, the
 * fact now rides `downgraded_from` alone). This is PERMANENT, not a
 * re-tighten stopgap: the R5-8 wave only converts class (a) and does not
 * touch this producer.
 */
const FILE_DOWNGRADED_SHAPES: readonly (readonly string[])[] = [
  ["path", "reason"],
  ["path", "downgraded_from"],
];

/**
 * `read.artifact`'s per-`content.form` requirement, as a DISJUNCTION of key
 * sets (`ArtifactContent`, `read-result.ts:435-528`).
 *
 * Four form values have two legitimate arms — the structured extraction and the
 * plain-`text` fallback the same union declares
 * (`{ form: "docx"|"xlsx"|"pptx"|"pdf"; text: string }`) — so the requirement
 * is "satisfies at least one of these key sets". `xlsx` appears with only the
 * text arm because the structured xlsx forms are tagged `xlsx.roster` and
 * `xlsx.table`.
 */
const ARTIFACT_CONTENT_SHAPES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  "xlsx.roster": [["sheets"]],
  "xlsx.table": [["sheet", "range", "columns", "rows"]],
  docx: [["sections"], ["text"]],
  pptx: [["slides"], ["text"]],
  pdf: [["pages"], ["text"]],
  xlsx: [["text"]],
  csv: [["range", "columns", "rows", "total_rows", "total_columns", "dialect"]],
  archive: [["format", "entries", "total_entries", "total_uncompressed_bytes", "read_only"]],
};

/**
 * `read.artifact` TEXT-ONLY content — S2c calibration (2026-08-14). Which
 * `ARTIFACT_CONTENT_SHAPES` alternative a body resolved to also decides
 * whether `path`/`handle`/`sha` are required (see the `read.artifact` row
 * below): a document form's structured key (`sections`/`slides`/`pages`) and
 * its `text` fallback are mutually exclusive by construction
 * (`readFamily.ts`'s `artifactContent()` returns on the first matching
 * branch), so checking the structured key's ABSENCE alongside `text`'s
 * presence is sufficient. Bare `xlsx` has no structured alternative at all —
 * `xlsx.roster`/`xlsx.table` are different `form` strings — so it is
 * text-only whenever it appears at all.
 */
const ARTIFACT_STRUCTURED_KEY: Readonly<Record<string, string>> = {
  docx: "sections",
  pptx: "slides",
  pdf: "pages",
};

function isArtifactTextOnly(content: Record<string, unknown> | undefined): boolean {
  if (content === undefined || !hasKey(content, "text")) return false;
  const form = String(content["form"]);
  if (form === "xlsx") return true;
  const structuredKey = ARTIFACT_STRUCTURED_KEY[form];
  return structuredKey !== undefined && !hasKey(content, structuredKey);
}

/** §2.6 `RetryTransition`, `protocol.ts:498-504`. Closed at five. */
const RETRY_TRANSITIONS: ReadonlySet<string> = new Set([
  "call",
  "challenge",
  "new-task",
  "user-input",
  "none",
]);

/** A.3 `TaskDecision`, `decision.ts:235`. Closed at five arms. */
const DECISION_KINDS: ReadonlySet<string> = new Set([
  "discover",
  "await_input",
  "act.answer",
  "act.edit",
  "done",
]);

/**
 * §4.2.1(3)'s minimal core — REQUIRED for the three side-effect members
 * (wave-11 B4; formerly checked only when present).
 *
 * §4.2.1 frames `core` as never shed, and `EditApplied`/`EditRolledBack`/
 * `EditStateUnknown` all declare it non-optional. Historically the shipped
 * producer could omit it (`buildCore()` returns `undefined` when the operation
 * resolved no path, and the projectors then omitted the key), so this
 * predicate once tolerated absence. B4 closes that: an absent core would hide
 * the write outcome, so it is a violation — and `enforceRequiredSet` (emit.ts)
 * converts the violating side-effect body into a state-unknown REFUSAL at the
 * emit boundary rather than throwing, so the caller keeps protocol recovery
 * (`code`/`retry`/`detail`) while disk state is in doubt. Every real dispatch
 * path resolves at least one path; the pathless shapes live only in the
 * projector-level specs.
 */
const CORE_WHEN_PRESENT = pred("edit/core-complete-when-present", (scope) => {
  // Side-effect members must disclose their SideEffectCore; absence is not an
  // optional omission because it would hide the write outcome.
  const core = recordAt(scope, "core");
  if (core === undefined) return false;
  const paths = arrayAt(core, "paths");
  return (
    hasKey(core, "counts") &&
    hasKey(core, "workspace") &&
    paths !== undefined &&
    paths.length > 0
  );
});

// ---------------------------------------------------------------------------
// THE 27 ROWS
// ---------------------------------------------------------------------------

/**
 * The required set of every wire shape, keyed by `Kind` and — for the three
 * [R4-4] members — by form inside it.
 *
 * EXHAUSTIVE BY CONSTRUCTION. `Record<Kind, …>` is what makes a sixteenth
 * member a COMPILE error here rather than an unvalidated shape at runtime;
 * `validate.ts`'s switch is the second, independent fence.
 */
export const REQUIRED_SETS: Readonly<Record<Kind, ShapeEntry>> = {
  // -------------------------------------------------------------------------
  // read.*
  // -------------------------------------------------------------------------

  /**
   * DESIGN:1978 — `task`, `profile`, `decision`. `evidence` is deliberately NOT
   * required: the row's own "explicitly not required" column scopes it to
   * emptiness on a non-`act` decision, and the delivery floor that does demand
   * served evidence is §2.1.1's, which S5 owns and which is not expressible as
   * a key-presence test (it quantifies over certificate obligations).
   */
  "read.task_pack": {
    tagged: false,
    row: {
      kind: "read.task_pack",
      keys: ["task", "profile", "decision"],
      predicates: [
        pred("read.task_pack/task-addressed", (b) => {
          const task = recordAt(b, "task");
          return task !== undefined && typeof task["id"] === "string" && hasKey(task, "coverage");
        }),
        pred(
          "read.task_pack/profile-declared",
          (b) => b["profile"] === "answer" || b["profile"] === "generic",
        ),
        pred("read.task_pack/decision-tagged", (b) => {
          const decision = recordAt(b, "decision");
          return decision !== undefined && DECISION_KINDS.has(String(decision["kind"]));
        }),
        // §2.1.1's `act.edit` floor, AS AMENDED BY [R5-23] (ruling 6): the ONE
        // half of §2.1.1 that IS a property of a single body. FLOOR-ANSWER
        // quantifies over what the client received earlier in the session and
        // stays S5's `actFloor.ts` (see this file's header); FLOOR-EDIT reads
        // two keys of the body in front of it, so refusing to state it here
        // would leave the ladder's own gate unable to catch a breach it caused.
        // The predicate DELEGATES to `decisionWire.ts`'s `editFloorHolds` — a
        // second spelling of a floor is how a floor stops being one.
        pred("read.task_pack/act-edit-floor", (b) => {
          const decision = recordAt(b, "decision");
          if (decision === undefined || decision["kind"] !== "act.edit") return true;
          const frontier = arrayAt(decision, "frontier") ?? [];
          const createTarget = isRecord(decision["create_target"]) ? decision["create_target"] : undefined;
          return editFloorHolds(
            frontier as readonly FrontierEntry[],
            createTarget as CreateTarget | undefined,
          );
        }),
        // Presence is not required (above); shape is, when it is there.
        pred("read.task_pack/evidence-is-array", (b) =>
          !hasKey(b, "evidence") ? true : arrayAt(b, "evidence") !== undefined,
        ),
      ],
      source: "DESIGN §4.3:1978; read-result.ts:48 ReadTaskPackResult",
    },
  },

  /**
   * DESIGN:1979 — ">=1 `Evidence` with `handle` + `path` + `range` (§3.3)",
   * typed as a non-empty `FreshEvidence` tuple (`read-result.ts:81`). Non-empty
   * is one of the four floors DESIGN actually states: a `read.text` with no
   * evidence has served nothing and is not a text serve.
   *
   * `path` IS NOT REQUIRED HERE, AND THAT IS THE PRODUCER'S DELIBERATE CHOICE
   * — not a weakening this table invented. `readFamily.ts`'s `textEvidence()`
   * (:729-745, the C2-9 "ABSENT, NOT EMPTY" note) OMITS `path` when the source
   * body names none, having weighed exactly this rule:
   *
   *   "This used to be `str(body["path"]) ?? ""`, which turned 'the source body
   *    names no path' into `path: ""` on the wire. §3.3 makes `path` part of
   *    the addressing triple, so an empty string is not a degraded address — it
   *    is a FALSE one, and worse than absence, because a client branches on a
   *    present key."
   *
   * That note names the very corpus responses this table is checked against
   * (mdh1, sln1, scw1), and `decisionWire.ts`'s `projectEvidence` spreads
   * `path` conditionally for the same reason — two projectors agreeing. Five of
   * the 242 replayed responses are `read.text` bodies with `handle`+`range` and
   * no `path`. Requiring `path` would fail them; requiring `path: ""` instead
   * is the falsehood C2-9 removed.
   *
   * So the check splits in two. `handle`+`range` is the addressing actually
   * guaranteed, and is required on every entry. `path` is required to be
   * HONEST rather than present: when it is emitted it must be a real path, and
   * `""` is a violation. That second predicate is strictly stronger than
   * §6.1(d)'s "no fresh Evidence without path + range", which passed on `""`
   * and is precisely why the defect survived until it was measured.
   */
  "read.text": {
    tagged: false,
    row: {
      kind: "read.text",
      keys: ["evidence"],
      predicates: [
        pred(
          "read.text/evidence-fresh-addressed",
          nonEmptyEntries("evidence", ["handle", "range"]),
        ),
        pred("read.text/evidence-path-not-falsified", (b) => {
          const items = arrayAt(b, "evidence");
          if (items === undefined) return false;
          return items.every(
            (item) => !isRecord(item) || !hasKey(item, "path") || item["path"] !== "",
          );
        }),
      ],
      source:
        "DESIGN §4.3:1979 + §3.3; read-result.ts:81 ReadTextResult; " +
        "readFamily.ts:729-745 (C2-9) narrows `path` to absent-not-empty",
    },
  },

  /**
   * DESIGN:1980, per form ([R4-4]). Six forms — see this file's header for why
   * `markdown` is here and not in DESIGN's five.
   *
   * The envelope requires only `outline` + its `form` tag; each row below is
   * keyed INSIDE `outline`.
   */
  "read.map": {
    tagged: true,
    block: "outline",
    tag: "form",
    rows: {
      /**
       * DESIGN:1980 says `signatures` requires `handle` + `path`, and
       * `StructuralOutline`'s arm declares `path: string`. THE WIRE DOES NOT
       * CARRY IT: the committed `read.map.json` pin is a `signatures` body with
       * `handle`, `language` and `signatures` and no `path`, because
       * `structuralOutline()`'s fallback arm keeps `path` only when the raw
       * body had one. `handle` is the addressing that is actually guaranteed,
       * so this row requires that and states the gap rather than failing a
       * shipping shape.
       */
      signatures: {
        kind: "read.map",
        form: "signatures",
        keys: ["handle", "language", "signatures"],
        predicates: [],
        source: "DESIGN §4.3:1980; read-result.ts:127 StructuralOutline; pin read.map.json (no `path`)",
      },
      /** DESIGN:1980 — `surfaces[].{role,handle,path}` + `coverage`. */
      surfaces: {
        kind: "read.map",
        form: "surfaces",
        keys: ["surfaces", "coverage"],
        predicates: [
          pred("read.map.surfaces/entries-addressed", everyEntry("surfaces", ["role", "handle", "path"])),
        ],
        source: "DESIGN §4.3:1980; read-result.ts StructuralOutline arm `surfaces`",
      },
      /** DESIGN:1980 — `files[].{path,handle}`. */
      files: {
        kind: "read.map",
        form: "files",
        keys: ["files"],
        predicates: [pred("read.map.files/entries-addressed", everyEntry("files", ["path", "handle"]))],
        source: "DESIGN §4.3:1980; read-result.ts StructuralOutline arm `files`",
      },
      /** DESIGN:1980 — `digest` requires `handle` + `path`; the type adds `sha` + `digest`. */
      digest: {
        kind: "read.map",
        form: "digest",
        keys: ["handle", "path", "sha", "digest"],
        predicates: [],
        source: "DESIGN §4.3:1980; read-result.ts StructuralOutline arm `digest`",
      },
      /** read-result.ts:193-224, the sixth form. Same addressing as `digest`, plus its sections. */
      markdown: {
        kind: "read.map",
        form: "markdown",
        keys: ["handle", "path", "sha", "sections"],
        predicates: [],
        source: "read-result.ts:193-224 StructuralOutline arm `markdown` (post-dates DESIGN §4.3:1980)",
      },
      /**
       * DESIGN:1980 — repo-scoped: `repo:{name,handle}` + `recommended_reading_order`.
       *
       * `packages` is NOT required (S2c calibration, 2026-08-14): A.8.1 rule
       * E-1 ("`[]` is never emitted in place of absence") means a workspace
       * with zero packages OMITS the key entirely rather than emitting `[]`
       * — `structuralOutline()`'s overview-form keep-list only copies it when
       * non-empty. Unrelated to R5-8; not on the re-tighten list, this is the
       * table's permanent shape.
       */
      overview: {
        kind: "read.map",
        form: "overview",
        keys: ["repo", "recommended_reading_order"],
        predicates: [
          pred("read.map.overview/repo-addressed", (o) => {
            const repo = recordAt(o, "repo");
            return repo !== undefined && hasKey(repo, "name") && hasKey(repo, "handle");
          }),
          pred("read.map.overview/packages-non-empty-when-present", (o) => {
            if (!hasKey(o, "packages")) return true;
            const packages = arrayAt(o, "packages");
            return packages !== undefined && packages.length > 0;
          }),
        ],
        source: "DESIGN §4.3:1980; read-result.ts StructuralOutline arm `overview`",
      },
    },
  },

  /**
   * DESIGN:1981 — "a per-entry rollup keyed by handle/path, with per-entry
   * completeness"; explicitly NOT a single top-level `path`/`range`, because
   * the response is about N sources. One row: the `form` tag is per ENTRY, so
   * the per-form sets are a predicate over the array (`BATCH_ENTRY_KEYS`), not
   * a (kind, form) key.
   */
  "read.batch": {
    tagged: false,
    row: {
      kind: "read.batch",
      keys: ["entries"],
      predicates: [
        pred("read.batch/entries-are-array", (b) => arrayAt(b, "entries") !== undefined),
        pred("read.batch/entry-form-satisfied", (b) => {
          const entries = arrayAt(b, "entries");
          if (entries === undefined) return false;
          return entries.every((entry) => {
            if (!isRecord(entry)) return false;
            const form = String(entry["form"]);
            // `file-downgraded` is a disjunction (FILE_DOWNGRADED_SHAPES), not a
            // flat key list — see its own doc comment (S2c calibration).
            if (form === "file-downgraded") {
              return FILE_DOWNGRADED_SHAPES.some((keys) => keys.every((key) => hasKey(entry, key)));
            }
            const required = BATCH_ENTRY_KEYS[form];
            // An unrecognized entry form is a violation: `BatchEntry` is a
            // closed four-member union and a fifth member reaching the wire
            // undeclared is exactly what this table exists to catch.
            return required !== undefined && required.every((key) => hasKey(entry, key));
          });
        }),
      ],
      source: "DESIGN §4.3:1981; read-result.ts:268 ReadBatchResult + :312 BatchEntry",
    },
  },

  /**
   * DESIGN:1982 — ">=1 content-bearing entry per source, with its sheet/slide/
   * page addressing"; explicitly NOT a line `range`, because a cell or slide
   * span is not a line span. DESIGN spells the carrier `artifact_sections`; the
   * shipped member is `content: ArtifactContent` (`read-result.ts:415`), and
   * the committed `read.artifact.json` pin is the `csv` arm of it.
   *
   * The per-form disjointness rides `ARTIFACT_CONTENT_SHAPES` inside this row —
   * see the header note on why this member is not broken out per form.
   *
   * `path`/`handle`/`sha` are NOT unconditional (S2c calibration, 2026-08-14).
   * `projectArtifact()` (`readFamily.ts:1119-1132`) copies all three with
   * `keep()` — present iff the raw body carries them — and the office-
   * extraction arm (`extractOfficeText`'s flat dialect via `mode=full
   * allowFull:true` or the `search_files action=office` compat redirect)
   * never mints a handle, so it never does. See `isArtifactTextOnly` above
   * and the re-tighten list at the top of this file (DESIGN A.13 ruling 9,
   * [R5-8] — same "redirect vs. extract" feature area, though ruling 9's own
   * text is scoped to A.5.4 and does not itself name this A.5.5 arm).
   */
  "read.artifact": {
    tagged: false,
    row: {
      kind: "read.artifact",
      keys: ["content", "warnings"],
      predicates: [
        pred("read.artifact/content-bearing", (b) => {
          const content = recordAt(b, "content");
          if (content === undefined) return false;
          const alternatives = ARTIFACT_CONTENT_SHAPES[String(content["form"])];
          if (alternatives === undefined) return false;
          return alternatives.some((keys) => keys.every((key) => hasKey(content, key)));
        }),
        pred("read.artifact/addressed-unless-text-extraction", (b) => {
          if (isArtifactTextOnly(recordAt(b, "content"))) return true;
          return hasKey(b, "path") && hasKey(b, "handle") && hasKey(b, "sha");
        }),
      ],
      source:
        "DESIGN §4.3:1982; read-result.ts:415 ReadArtifactResult + :435 ArtifactContent; " +
        "R5-8/ruling 9 (2026-08-14) text-extraction arm exempted pending its own erratum",
    },
  },

  /**
   * DESIGN:1983 + A.4 ([R4-4]) — the envelope requires only the `receipt` tag;
   * each form states what its own claim needs. Two forms make a RESIDENCY claim
   * and carry addressing for it; the other three assert nothing about bytes and
   * carry none — and `receipts.ts` notes that a non-residency form carrying
   * `prior` or `handle` is itself a bug.
   */
  "read.receipt": {
    tagged: true,
    block: "receipt",
    tag: "receipt",
    rows: {
      /** Residency. A.4 — `task` + >=1 `PriorEvidence`, each carrying `prior`. */
      "pack-unchanged": {
        kind: "read.receipt",
        form: "pack-unchanged",
        keys: ["task", "evidence"],
        predicates: [
          pred("read.receipt.pack-unchanged/prior-evidence", nonEmptyEntries("evidence", ["prior"])),
        ],
        source: "DESIGN §4.3:1983; receipts.ts Receipt arm `pack-unchanged`",
      },
      /** Residency. A.4 — `handle` + `sha`; `served_by` is provenance, not required. */
      "code-unchanged": {
        kind: "read.receipt",
        form: "code-unchanged",
        keys: ["handle", "sha"],
        predicates: [],
        source: "DESIGN §4.3:1983; receipts.ts Receipt arm `code-unchanged`",
      },
      /**
       * Non-residency. A.4 — `certificate`.
       *
       * `CertificateRef` (`decision.ts:84`) declares `{id, obligations,
       * workspace}` all required, but this path narrows it, deliberately and
       * disclosed ([R5-10a]): the execution fence carries a task fingerprint,
       * not a `WorkspaceMarker`, so on the wire this certificate is `{id}` or
       * `{id, obligations}` and never the full triple. `id` is what the
       * correlation actually needs, so that is what this row requires.
       */
      "decision-unchanged": {
        kind: "read.receipt",
        form: "decision-unchanged",
        keys: ["certificate"],
        predicates: [
          pred("read.receipt.decision-unchanged/certificate-identified", (r) => {
            const certificate = recordAt(r, "certificate");
            if (certificate === undefined || typeof certificate["id"] !== "string") return false;
            if (!hasKey(certificate, "obligations")) return true;
            const obligations = arrayAt(certificate, "obligations");
            return obligations !== undefined && obligations.length > 0;
          }),
        ],
        source: "DESIGN §4.3:1983 + [R5-10a]; receipts.ts Receipt arm `decision-unchanged`",
      },
      /** Non-residency. A.4 — `kit_ref`; the kit is addressed by ref, not by a file handle. */
      "kit-unchanged": {
        kind: "read.receipt",
        form: "kit-unchanged",
        keys: ["kit_ref"],
        predicates: [],
        source: "DESIGN §4.3:1983; receipts.ts Receipt arm `kit-unchanged`",
      },
      /** Non-residency. A.4 — `done` + `total`. There is no file this claim is about. */
      "closure-complete": {
        kind: "read.receipt",
        form: "closure-complete",
        keys: ["done", "total"],
        predicates: [
          pred(
            "read.receipt.closure-complete/counts-numeric",
            (r) => typeof r["done"] === "number" && typeof r["total"] === "number",
          ),
        ],
        source: "DESIGN §4.3:1983; receipts.ts Receipt arm `closure-complete`",
      },
    },
  },

  /**
   * DESIGN:1984 — "the obligation rollup", and explicitly NO HANDLE: this is
   * the member whose 364-byte measured body falsified Revision 1's per-tool
   * "always has a handle" rule (DESIGN:1965-1971). `open`/`done`/`total` are
   * the rollup; `summary` is the object form
   * (`ClosureSessionSummary`, `read-result.ts:641`) and is optional.
   */
  "read.closure": {
    tagged: false,
    row: {
      kind: "read.closure",
      keys: ["open", "done", "total"],
      predicates: [
        pred("read.closure/rollup-shaped", (b) => {
          return (
            arrayAt(b, "open") !== undefined &&
            typeof b["done"] === "number" &&
            typeof b["total"] === "number"
          );
        }),
      ],
      source: "DESIGN §4.3:1984; read-result.ts:612 ReadClosureResult",
    },
  },

  // -------------------------------------------------------------------------
  // search.*
  // -------------------------------------------------------------------------

  /**
   * DESIGN:1985, per form ([R4-4]). Note what is explicitly NOT required:
   * `query` on any form other than `find` — `symbols`, `locate` and `diff` emit
   * none, and `diff` takes no query argument at all. And zero hits is a VALID,
   * COMPLETE result, so `find`'s `files` may be `[]` with `total_*` at 0.
   */
  "search.matches": {
    tagged: true,
    block: "matches",
    tag: "form",
    rows: {
      find: {
        kind: "search.matches",
        form: "find",
        keys: ["query", "files", "total_files", "total_matches", "literal"],
        predicates: [
          // Zero-hit is complete, so this asserts shape, never population.
          pred("search.matches.find/files-are-array", (m) => arrayAt(m, "files") !== undefined),
        ],
        source: "DESIGN §4.3:1985; search-result.ts:66 SearchMatches arm `find`",
      },
      symbols: {
        kind: "search.matches",
        form: "symbols",
        keys: ["locations", "total"],
        predicates: [],
        source: "DESIGN §4.3:1985; search-result.ts SearchMatches arm `symbols`",
      },
      locate: {
        kind: "search.matches",
        form: "locate",
        keys: ["result"],
        predicates: [],
        source: "DESIGN §4.3:1985; search-result.ts SearchMatches arm `locate`",
      },
      diff: {
        kind: "search.matches",
        form: "diff",
        keys: ["files", "total_files"],
        predicates: [],
        source: "DESIGN §4.3:1985; search-result.ts SearchMatches arm `diff`",
      },
    },
  },

  /**
   * DESIGN:1986 — `symbol`, and `references[]` may be EMPTY (the census's 190 B
   * body is exactly that). The paging duty in the same row — "`limit` with
   * `cause:"records"` and `limit.next` iff more pages exist" — is an EMISSION
   * condition, not a required key: "iff more pages exist" quantifies over
   * server-side state this table cannot see. Its checkable half is universal
   * and lives in `validate.ts`'s A.8.1 E-5 arm: a `records` limit must carry
   * `next`, on every kind.
   */
  "search.references": {
    tagged: false,
    row: {
      kind: "search.references",
      keys: ["symbol", "references", "files", "total"],
      predicates: [
        pred("search.references/collections-are-arrays", (b) => {
          return arrayAt(b, "references") !== undefined && arrayAt(b, "files") !== undefined;
        }),
      ],
      source: "DESIGN §4.3:1986; search-result.ts:201 SearchReferencesResult",
    },
  },

  /** DESIGN:1987 — "the tree rollup", i.e. `root` + `tree`. `depth` is filesystem-scoped only. */
  "search.tree": {
    tagged: false,
    row: {
      kind: "search.tree",
      keys: ["root", "tree"],
      predicates: [],
      source: "DESIGN §4.3:1987; search-result.ts:251 SearchTreeResult",
    },
  },

  // -------------------------------------------------------------------------
  // edit.* — the three SE-STABLE kinds plus the no-write reclassification
  // -------------------------------------------------------------------------

  /**
   * DESIGN:1988 — `applied[]`, plus the §4.2.1 minimal core. `core` is checked
   * only when present; see `CORE_WHEN_PRESENT` for why that is the honest rule
   * at this HEAD rather than a weakening.
   */
  "edit.applied": {
    tagged: false,
    row: {
      kind: "edit.applied",
      keys: ["applied"],
      predicates: [
        pred("edit.applied/entries-addressed", everyEntry("applied", ["path", "range"])),
        CORE_WHEN_PRESENT,
      ],
      source: "DESIGN §4.3:1988 + §4.2.1(3); edit-result.ts:179 EditApplied",
    },
  },

  /** DESIGN:1989 — `action`, and nothing else: nothing was written, so no `core`. */
  "edit.reclassified": {
    tagged: false,
    row: {
      kind: "edit.reclassified",
      keys: ["action"],
      predicates: [],
      source: "DESIGN §4.3:1989; edit-result.ts:247 EditReclassified",
    },
  },

  /** DESIGN:1990 — `attempted[]`, plus the §4.2.1 minimal core. `recovery` optional. */
  "edit.rolled_back": {
    tagged: false,
    row: {
      kind: "edit.rolled_back",
      keys: ["attempted"],
      predicates: [
        pred("edit.rolled_back/attempted-are-array", (b) => arrayAt(b, "attempted") !== undefined),
        CORE_WHEN_PRESENT,
      ],
      source: "DESIGN §4.3:1990 + A.5.13; edit-result.ts:264 EditRolledBack",
    },
  },

  /**
   * DESIGN:1991 — `affected[]`, `recovery`, plus the §4.2.1 minimal core.
   * `recovery` is REQUIRED here and optional on `edit.rolled_back`: §2.4's
   * normative invariant, and the one asymmetry between the two ledger members.
   */
  "edit.state_unknown": {
    tagged: false,
    row: {
      kind: "edit.state_unknown",
      keys: ["affected", "recovery"],
      predicates: [
        pred("edit.state_unknown/affected-are-array", (b) => arrayAt(b, "affected") !== undefined),
        CORE_WHEN_PRESENT,
      ],
      source: "DESIGN §4.3:1991 + §2.4 + A.5.14; edit-result.ts:311 EditStateUnknown",
    },
  },

  // -------------------------------------------------------------------------
  // refusal
  // -------------------------------------------------------------------------

  /**
   * DESIGN:1992 — `for`, `code`, `retry`; `field` whenever the refusal names an
   * offending property (§1.3.1).
   *
   * `Refusal` (`protocol.ts:414`) is a two-armed union on `retry`, NOT a `form`
   * tag, so it stays one row and the conditional is a predicate:
   * `certificate_id` is required exactly on the `challenge` arm — it is the
   * correlation key back to the fence, and a challenge naming no certificate
   * cannot be checked against one. On the other four transitions it is
   * optional, not forbidden.
   *
   * `fields` implies `field`, with `field === fields[0]` (A.8.2): `fields` is
   * emitted iff MORE THAN ONE property offends, and it never replaces the
   * singular field a §1.3.1 consumer reads.
   */
  refusal: {
    tagged: false,
    row: {
      kind: "refusal",
      keys: ["for", "code", "retry"],
      predicates: [
        pred("refusal/retry-declared", (b) => RETRY_TRANSITIONS.has(String(b["retry"]))),
        pred(
          "refusal/challenge-names-certificate",
          (b) => b["retry"] !== "challenge" || typeof b["certificate_id"] === "string",
        ),
        pred("refusal/fields-implies-field", (b) => {
          if (!hasKey(b, "fields")) return true;
          const fields = arrayAt(b, "fields");
          return fields !== undefined && fields.length > 0 && b["field"] === fields[0];
        }),
      ],
      source: "DESIGN §4.3:1992 + §1.3.1 + A.8.2; protocol.ts:414 Refusal",
    },
  },
};

/** Runtime guard for the closed v1 discriminator vocabulary. */
export function isKnownProtocolKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REQUIRED_SETS, value);
}

/**
 * The row for a (kind, form), or `undefined` when the kind is form-tagged and
 * `form` names no declared member of its closed union.
 *
 * An unrecognized form is NOT silently accepted here — `validate.ts` turns the
 * `undefined` into a named violation. The three tagged unions are closed by
 * type, so a form outside them reaching the wire is a real defect, and the
 * opposite (fail-open) choice would leave the largest shapes unvalidated.
 * `budgetFor` fails OPEN on the same input for the opposite reason: over-
 * granting bytes is safe, under-checking structure is not.
 */
export function requiredSetFor(kind: Kind, form?: string): RequiredSetRow | undefined {
  const entry = REQUIRED_SETS[kind];
  if (!entry.tagged) return entry.row;
  if (form === undefined) return undefined;
  return entry.rows[form];
}

/** Every row in the table, for the exhaustiveness meta-test. 27 at this HEAD. */
export function allRequiredSetRows(): readonly RequiredSetRow[] {
  const rows: RequiredSetRow[] = [];
  for (const entry of Object.values(REQUIRED_SETS)) {
    if (entry.tagged) rows.push(...Object.values(entry.rows));
    else rows.push(entry.row);
  }
  return rows;
}
