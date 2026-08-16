// ---------------------------------------------------------------------------
// protocol v1 — the `read_file` response family (A.5.1–A.5.7).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13). Implements the A.9.1 `read-result.ts` row. §2.2: this file is
// the successor of `read-edit.ts` + `task-pack.ts`'s output types; the legacy
// declarations stay importable until the P2 emitter migration deletes their
// last use.
//
// TWO RULES FROM THE A.5.3–A.5.10 PREAMBLE GOVERN EVERY MEMBER BELOW.
//
// RULE T (truncation). §4.4 absorbs the `truncated`/`note`/`byte_budget`/
// `map_cap_bytes`/`truncation_reason`/`*_omitted`/`surface_drops`/`continued`/
// `served_range_ledger`/`content_completeness` dialects into `Limit`:
//  - RESPONSE-LEVEL truncation is `limit` and appears in no other form.
//    Absence of `limit` IS completeness (§3.1, §4.4).
//  - PER-SOURCE truncation survives only where the design keeps a per-source
//    axis: `Evidence.remaining` (§4.4(3)) and the per-entry `truncated` §4.3
//    requires on `read.batch`.
//  - Today's per-item `omitted[] {path|handle, reason}` arrays are DELETED:
//    §4.4 adjudicates `omitted` as a coarse enum, so the content is
//    `limit.omitted: OmittedClass[]`.
//
// RULE K (`kind` is reserved at the top level). Under D4 the top-level `kind`
// is the sole discrimination contract. The three shapes that ship a top-level
// `kind` carrying a DIFFERENT vocabulary are all inside `read.artifact`; the
// two that collide with the discriminator (`mode=artifact`'s
// xlsx|docx|pptx|pdf|csv and `ReadFileArchiveOutput.kind: "archive"`) are
// renamed to `content.form` (A.9.2 row 7).
// ---------------------------------------------------------------------------

import type { ProtocolVersion, Evidence, FreshEvidence, Limit } from "./protocol.js";
import type { TaskRef, TaskDecision } from "./decision.js";
import type { Receipt } from "./receipts.js";
import type { ImpactSurface } from "./locate-impact.js";
import type { ProfilePlan } from "./task-pack.js";
import type { ArchiveFormat, ReadFileArchiveEntry } from "./archive.js";
import type { ReadCodePackOutput } from "./read-edit.js";

// ---------------------------------------------------------------------------
// A.5.1 `read.task_pack`
// ---------------------------------------------------------------------------

/**
 * Required set (§4.3): `task`, `profile`, `decision`, plus the acting member's
 * §2.1.1 delivery floor. `evidence` MAY be empty ONLY on a non-`act` decision.
 */
export type ReadTaskPackResult = {
  v: ProtocolVersion;
  kind: "read.task_pack";
  task: TaskRef;
  profile: "answer" | "generic";
  evidence: Evidence[];
  decision: TaskDecision;
  /** Optional, non-binding task lifecycle notice. */
  advisory?: string;
  /** Emitted iff >=1 rare extension carries information (§3.1). Absence means
   *  no evidence model, wiring, change contract, kit or artifact section
   *  applies. */
  plan?: ProfilePlan;
  limit?: Limit;
};

// ---------------------------------------------------------------------------
// A.5.2 `read.text`
// ---------------------------------------------------------------------------

/**
 * Today's `slice`, `full`, `symbol`, `small_file`, and `sections` serves (§3.2).
 *
 * Required set (§4.3): >=1 `Evidence` with `handle` + `path` + `range` —
 * expressed as a non-empty tuple of `FreshEvidence`, which is §3.3's addressing
 * triple made unrepresentable-otherwise.
 *
 * Today's `truncated` + `next` chain on `mode=full`, `continued` on
 * `mode=slice`, and `served_range_ledger` all re-express as
 * `evidence[].remaining` plus `limit` (§4.3 shed step 4, §4.4). The E3
 * duplicate the census measured on the 455-byte re-serve receipt — `summary`
 * AND `served_range_ledger` carrying the same served-range fact, plus a `note`
 * restating `code_unchanged` in prose — has NO v1 representation: `remaining`
 * is the single carrier.
 */
export type ReadTextResult = {
  v: ProtocolVersion;
  kind: "read.text";
  evidence: [FreshEvidence, ...FreshEvidence[]];
  limit?: Limit;
};

// ---------------------------------------------------------------------------
// A.5.3 `read.map`
// ---------------------------------------------------------------------------

/** tools/getFileSkeleton.ts:81. */
export type SkeletonProfile = "class-map" | "symbol-map" | "doc-map" | "full-skeleton";

/**
 * Today's `skeleton`, `map`, `digest`, `overview` (§3.2). NO `range` — a
 * projection is not a window into a file (F3).
 */
export type ReadMapResult = {
  v: ProtocolVersion;
  kind: "read.map";
  outline: StructuralOutline;
  limit?: Limit;
};

/**
 * [R4-4], adjudicated 2026-08-13 — ADDRESSING IS PER FORM. §4.3 required
 * `handle` + `path` on `read.map`; three of the five forms have no single file
 * to name, so the disposition keeps the addressing where each form has it:
 *
 *   | Form         | Required addressing                                    |
 *   |--------------|--------------------------------------------------------|
 *   | `signatures` | `handle` + `path`                                      |
 *   | `digest`     | `handle` + `path` (+ `sha`)                            |
 *   | `surfaces`   | `surfaces[].{role, handle, path}` + `coverage`         |
 *   | `files`      | `files[].{path, handle}`                               |
 *   | `overview`   | `repo: {name, handle}` + `recommended_reading_order`   |
 *
 * `overview` is REPO-SCOPED: there is no file, and inventing one would be the
 * false-addressing class §3.3 exists to prevent. `range` remains forbidden on
 * every form (F3).
 *
 * The third runtime shape behind `mode=map`, `{mode:"map", hit:false, reason}`
 * (server.ts:4781), is a REFUSAL in v1, not a map — `RefusalCode` carries the
 * reason (A.9.2 row 11).
 */
export type StructuralOutline =
  /** today's mode=skeleton — tools/getFileSkeleton.ts:399-407, server.ts:7027 */
  | {
      form: "signatures";
      handle: string;
      path: string;
      language: string;
      /**
       * TWO REAL EMITTED SHAPES, same as the `files` form's note below.
       *
       * `getFileSkeleton`'s rendered text blob is the one the A.5.3 census
       * recorded. `buildFullDowngradePayload`'s per-task-cap arm
       * (`server.ts:2338/2348`, the B2c conversion) emits the SAME projection
       * STRUCTURED — `extractSymbolsFromFile`'s `{name, range, line}` rows —
       * and it is a live emitter the census missed, so v1 carries it rather
       * than pretending one of the two does not exist. Widened additively
       * (§1.4(a)); the string arm is unchanged and remains the dominant form.
       *
       * The rows are NOT flattened to text: `range` is what makes the outline
       * a zoom target rather than a picture, and that arm exists precisely to
       * replace a content head with an addressable structure.
       */
      signatures: string | Array<{ name: string; range: string; line?: number }>;
      /** Emitted iff the skeleton was truncated (getFileSkeleton.ts:404-408);
       *  absence means the full skeleton fit. */
      profile_used?: SkeletonProfile;
      /** As `profile_used`. */
      hint?: string;
    }

  /** today's mode=map, surface-locator form — `ReadCodeMapOutput`
   *  (read-edit.ts:233-244), emitted at server.ts:4783 */
  | {
      form: "surfaces";
      surfaces: Array<{ role: ImpactSurface; handle: string; path: string }>;
      coverage: "complete" | "partial";
      /** Emitted iff `coverage === "partial"`; absence means every requested
       *  surface role was covered. */
      missing?: ImpactSurface[];
    }

  /** today's mode=map, paths[] form — server.ts:4759-4772, entries built at
   *  server.ts:4738-4744. A SECOND, incompatible runtime shape behind the same
   *  `mode`, which the declared `ReadCodeMapOutput` does not cover; it is a real
   *  emitted shape, so v1 gives it its own form rather than pretending one of
   *  the two does not exist. */
  | {
      form: "files";
      files: Array<{ path: string; handle: string; language: string; signatures: string }>;
      /** Prose; A.8 rule E-7. */
      note?: string;
    }

  /** today's mode=digest — `ReadCodeDigestOutput` (read-edit.ts:282-293) */
  | {
      form: "digest";
      handle: string;
      path: string;
      sha: string;
      digest: {
        imports?: string[];
        symbols?: Array<{ name: string; range: string; line?: number }>;
        text_hits?: Array<{ line: number; text: string }>;
      };
    }

  /**
   * today's mode=overview ON A MARKDOWN PATH — server.ts:5150-5165.
   *
   * A SECOND REAL SHAPE BEHIND `mode=overview`, exactly like the `files` form
   * behind `mode=map`, and one the A.5.3 census missed. It shipped a top-level
   * `kind:"markdown"` — a value outside D4's fifteen-member vocabulary that
   * SHADOWED the envelope discriminator, so no family predicate recognised the
   * response and it reached the wire wholly unprojected. Rule K relocates that
   * vocabulary here, where a nested `form` cannot collide with `kind`.
   *
   * Repo-`overview` cannot hold it: there is no package, no
   * `recommended_reading_order`, and the unit is a HEADING TREE of one file.
   * `sections[].range` is what makes each row a `sections:[…]` / `mode=slice`
   * target, which is this form's reason to exist.
   */
  | {
      form: "markdown";
      handle: string;
      path: string;
      sha: string;
      /** The document's first heading. Absence means it has none. */
      title?: string;
      /** The lead prose, capped. Absence means the document opens with a heading. */
      summary?: string;
      sections: Array<{ heading: string; section: string; level: number; range: string }>;
      /**
       * The pre-cap heading count. Emitted iff the section list was capped;
       * absence means it is complete — the same A.8.2 condition the
       * `signatures` form applies to `profile_used`/`hint`. `limit` proves
       * THAT rows were dropped; only this says how many the document has, and
       * a caller cannot tell a 40-of-40 index from a 40-of-1501 one without it.
       */
      sections_total?: number;
    }

  /** today's mode=overview — `ReadCodeOverviewOutput` (read-edit.ts:386-412).
   *  The five §3.4 E1 empty-only arrays (5 of 9 top-level fields observed empty
   *  [M]) are OMIT-WHEN-EMPTY, not deleted: `recommended_reading_order` stays
   *  required because it is the member's reason to exist; the other four are
   *  optional and emitted iff non-empty (A.8 rule E-1). */
  | {
      form: "overview";
      repo: { name: string; handle: string };
      packages: Array<{
        path: string;
        name?: string;
        role: string;
        entrypoints?: string[];
        commands?: string[];
        bins?: string[];
      }>;
      tools?: string[];
      commands?: string[];
      cli_commands?: string[];
      flows?: string[];
      recommended_reading_order: Array<{
        path: string;
        handle: string;
        why: string;
        line?: number;
        range?: string;
        target: string;
      }>;
    };

// ---------------------------------------------------------------------------
// A.5.4 `read.batch`
// ---------------------------------------------------------------------------

/**
 * Today's `pack`, `handles`, and the `full` batch form (§3.2).
 *
 * The response-level `completeness: "complete"|"partial"|"empty"` rollup is
 * DELETED: absence of `limit` is completeness (§4.4).
 */
export type ReadBatchResult = {
  v: ProtocolVersion;
  kind: "read.batch";
  entries: BatchEntry[];
  /** Emitted iff this was a query-driven `pack` (read-edit.ts:45-52); absence
   *  means the batch was addressed by path or handle. */
  locate?: ReadCodePackOutput["locate"];
  limit?: Limit;
};

/**
 * PER-ENTRY `truncated` IS REQUIRED (§4.3) and is the per-source axis Rule T
 * preserves.
 *
 * This member is why §3.2 lists `ReadCodeFullBatchResponseItem` by name: that
 * type is `{path: string; [field: string]: unknown}` — "an index signature
 * standing in for a union … the shape a discriminated union exists to replace".
 * The two `file*` forms below are that replacement.
 *
 * P2 OBLIGATION, PRE-PUBLISH — DISCHARGED 2026-08-14 (C2-3, on C2-8's evidence).
 * The `file-downgraded` field list below is no longer transcribed from a doc
 * comment ending in "etc."; it is ENUMERATED FROM THE EMITTER. The emitter is
 * `resolveFullReadForPath` (server.ts:2598), shared by the batch and the
 * single-path `mode=full` path, and it produces FOUR payload classes:
 *
 *   (a) an office redirect — `{ok:false, reason:"artifact-full-downgraded",
 *       path, alternatives[], next}`;
 *   (b) `buildFullDowngradePayload`'s `code_unchanged` repeat read;
 *   (c) its per-task-cap skeleton serve;
 *   (d) its W1 head serve.
 *
 * `reason` is therefore a CLOSED nine-value union: the eight literals declared
 * at server.ts:2141-2153 plus (a)'s own `"artifact-full-downgraded"`.
 *
 * REVISION-5 CANDIDATE, RAISED NOT SILENTLY FIXED: class (a) is structurally
 * incompatible with A.5.4's five-field stub. It carries NO `downgraded_from`,
 * NO `handle` and NO `sha`, and it carries `alternatives[]` and an `ok:false`
 * of its own. As a SINGLE-PATH response it is a `refusal` in v1 (D6 —
 * `ok:false` leaves the success family), which is the honest member for "I will
 * not serve this as text, here is what to ask for instead". As a BATCH ENTRY it
 * has nowhere else to go: `read.batch` entries are not responses and cannot be
 * refusals, so it stays here with `handle`/`sha`/`downgraded_from` optional.
 * A.5.4 as written cannot express it; the corrected text is in C2-3's report.
 */
export type BatchEntry =
  /** today's mode=pack — `ReadCodePackResponseItem` (read-edit.ts:31-37) */
  | {
      form: "range";
      path: string;
      range: string;
      /** Emitted iff the caller supplied one in `paths[].purpose`. */
      purpose?: string;
      content: string;
      truncated: boolean;
    }

  /** today's mode=handles — `ReadCodeHandlesBatchResponseItem` (read-edit.ts:59-66) */
  | {
      form: "handle";
      handle: string;
      path: string;
      range: string;
      content: string;
      truncated: boolean;
      sha: string;
    }

  /** today's mode=full batch, SUCCESS arm — the fields a single-path
   *  `ReadCodeFullOutput` would return (read-edit.ts:338-349), minus `mode` */
  | {
      form: "file";
      path: string;
      handle: string;
      content: string;
      truncated: boolean;
      sha: string;
      /** Emitted iff the serve expanded to the whole file. */
      fullFileExpansion?: boolean;
    }

  /** today's mode=full batch, SERVED-DOWNGRADE arm — enumerated from
   *  `resolveFullReadForPath` (server.ts:2598) and `buildFullDowngradePayload`
   *  (server.ts:2133); see this type's doc comment for the four classes. */
  | {
      form: "file-downgraded";
      path: string;
      /** Absent on the office-redirect class, which mints no handle. */
      handle?: string;
      /** Absent on the office-redirect class. */
      downgraded_from?: string;
      reason: FullDowngradeReason;
      /** shortSha display prefix; absent on the office-redirect class. */
      sha?: string;
      /** Byte length of the file the governor declined to serve in full. */
      bytes?: number;
      /** The W1 head serve: a governed downgrade SERVES content, it does not
       *  hand back a breadcrumb. Absent on classes (a) and (c). */
      content?: string;
      /** Class (b): the caller already holds these exact bytes. */
      code_unchanged?: true;
      /** Class (b)'s coverage statement, from the served-range ledger. */
      summary?: { served: string[]; unserved?: string[]; complete: boolean };
      /** Prose; A.8 rule E-7. */
      note?: string;
      /** True iff re-issuing with `allowFull:true` would change the outcome. */
      allow_full_would_help?: boolean;
      total_lines?: number;
      /** Class (c): the per-task-cap projection, in place of raw content. */
      skeleton?: string;
      remaining_ranges?: string[];
      next?: string;
      /** Class (a) only: the modes that CAN read this source. */
      alternatives?: unknown[];
    };

/**
 * The closed `reason` set for `BatchEntry`'s `file-downgraded` arm — the eight
 * literals `buildFullDowngradePayload` declares (server.ts:2141-2153) plus the
 * office redirect's own value. Declaring it as a union rather than `string` is
 * free before v1 publishes and breaking after (§1.4).
 */
export type FullDowngradeReason =
  | "cap-exceeded"
  | "full-denied"
  | "per-path-cap-reached"
  | "per-task-cap-reached"
  | "tiny-task-cap-reached"
  | "allowfull-task-cap-reached"
  | "candidate-pack-full-repeat"
  | "full-downgraded"
  | "artifact-full-downgraded";

// ---------------------------------------------------------------------------
// A.5.5 `read.artifact`
// ---------------------------------------------------------------------------

/**
 * Today's `artifact` and `archive` (§3.2). Required: >=1 content-bearing
 * section per source, with its sheet/slide/page addressing. NOT a line `range`
 * — a cell or slide span is not a line span (F3).
 *
 * `artifact_sections` is NOT this member's field: it belongs to the task-pack
 * family and rides `plan` (A.6.1). §4.3's `read.artifact` row uses the phrase
 * "`artifact_sections` entry"; the flattened `content` here is what
 * `mode=artifact` actually emits, and the two are different responses carrying
 * the same underlying extraction.
 */
export type ReadArtifactResult = {
  v: ProtocolVersion;
  kind: "read.artifact";
  path: string;
  handle: string;
  /** shortSha display prefix (server.ts:5938-5944). */
  sha: string;
  content: ArtifactContent;
  /** Emitted iff the source is xlsx/docx/pptx AND carries >=1 chart or media
   *  (server.ts:5983-5986); absence means no embedded visuals, or the source is
   *  pdf/csv. */
  visuals?: OoxmlVisualInventory;
  warnings: string[];
  limit?: Limit;
};

/**
 * Per Rule K, today's top-level `kind` on both families becomes `content.form`.
 * Per Rule T, the six per-branch `truncated` booleans become `limit`.
 */
export type ArtifactContent =
  /** server.ts:6010-6084. `XlsxRosterEntry`: office/xlsx.ts:353-375. */
  | {
      form: "xlsx.roster";
      sheets: Array<{
        name: string;
        dimensions: string;
        hidden: boolean;
        rowCount: number;
        colCount: number;
        cellCount: number;
      }>;
      /** Emitted iff a sheet was auto-inlined; absence means the roster is a
       *  roster only. */
      inlined?: {
        sheet: string;
        range: string;
        columns: string[];
        rows: unknown[][];
        note: string;
      };
    }

  /** server.ts:6098-6111. `XlsxTableResult`: office/xlsx.ts:455-470. */
  | { form: "xlsx.table"; sheet: string; range: string; columns: string[]; rows: unknown[][] }

  /** server.ts:6120-6130. `DocxSection`: office/docx.ts:289-292. */
  | { form: "docx"; sections: Array<{ heading: string; text: string }> }

  /** server.ts:6139-6151. `PptxSlideSection`: office/pptx.ts:378-381. */
  | { form: "pptx"; slides: Array<{ heading: string; text: string }> }

  /** server.ts:6178-6187. `PdfPage`: office/pdf.ts:44-47. No `visuals`. */
  | { form: "pdf"; pages: Array<{ page: number; text: string }> }

  /** server.ts:1366-1386 (csvArtifactShape). `CsvTableResult`: office/csv.ts:74-102.
   *  `form` is "csv" for .tsv input too (server.ts:1372). */
  | {
      form: "csv";
      range: string;
      columns: string[];
      rows: unknown[][];
      total_rows: number;
      total_columns: number;
      dialect: { delimiter: string; header: boolean };
      /** Prose; A.8 rule E-7. */
      note?: string;
    }

  /**
   * `extractOfficeText`'s FLAT extraction — extractOfficeText.ts:317-324,
   * reached by `mode=full allowFull:true` on any of the four document kinds
   * (server.ts:2740) and by `mode=artifact` on a docx/pptx served whole.
   *
   * A REAL EMITTED SHAPE THE A.5.5 CENSUS MISSED, carried rather than dropped
   * (same disposition as `StructuralOutline`'s `files` form). It is not a
   * duplicate of the `docx`/`pptx`/`pdf` arms above: those are per-section /
   * per-slide / per-page SPLITS of the same document, and this arm is the case
   * where no split was computed — one markdown-ish blob with `## Page N` /
   * heading separators. `form` reuses the same four-value document vocabulary,
   * so a client branching on `form` alone must read `text` when the structured
   * array for that form is absent.
   */
  | { form: "docx" | "xlsx" | "pptx" | "pdf"; text: string }

  /** today's mode=archive — `ReadFileArchiveOutput` (archive.ts:70-82). Every
   *  field unconditional. `entries[].kind` is a NESTED vocabulary and does not
   *  collide with the discriminator (Rule K); note that `"binary"` is declared
   *  but never produced (archive.ts:676 emits only `"text"` or `"unknown"`) —
   *  under §1.4(d) an unemitted value is removable PRE-V1 ONLY, so P2 runs the
   *  E2 reader-zero check and either removes it or records why it stays. */
  | {
      form: "archive";
      format: ArchiveFormat;
      entries: ReadFileArchiveEntry[];
      total_entries: number;
      total_uncompressed_bytes: number;
      read_only: true;
    };

// ---------------------------------------------------------------------------
// The OOXML visual inventory, transcribed.
//
// A.5.5 types `ReadArtifactResult.visuals` as `OoxmlVisualInventory` and cites
// `packages/mcp-server/src/office/ooxmlVisuals.ts:53-56`. A.9.1 assigns the type
// NO ROW, and `packages/types` cannot import from `packages/mcp-server`, so
// A.0 rule 1 ("every type reachable from a wire response is defined here, or is
// an existing declared type in packages/types, or is transcribed in full") is
// not satisfied by the appendix for this branch. It is transcribed here in
// full, verbatim from the emitter, and the placement gap is reported as a
// Revision-5 candidate rather than silently re-shaped.
// ---------------------------------------------------------------------------

/** office/ooxmlVisuals.ts:53-56. */
export type OoxmlVisualLocation = {
  location: string;
  position?: string;
};

/** office/ooxmlVisuals.ts:42-51. */
export type OoxmlChartSeries = {
  name: string;
  nameFormula?: string;
  categoryFormula?: string;
  categories: Array<string | number>;
  categoryCount: number;
  valueFormula?: string;
  values: Array<string | number>;
  valueCount: number;
};

/** office/ooxmlVisuals.ts:58-65. */
export type OoxmlChartInfo = {
  path: string;
  type: string;
  title?: string;
  locations: OoxmlVisualLocation[];
  embeddedWorkbook?: string;
  series: OoxmlChartSeries[];
};

/** office/ooxmlVisuals.ts:67-72. */
export type OoxmlMediaUse = OoxmlVisualLocation & {
  name?: string;
  altText?: string;
  title?: string;
  caption?: string;
};

/** office/ooxmlVisuals.ts:74-80. */
export type OoxmlMediaInfo = {
  path: string;
  kind: "image" | "video";
  format: string;
  external?: boolean;
  uses: OoxmlMediaUse[];
};

/** office/ooxmlVisuals.ts:82-87. */
export type OoxmlVisualInventory = {
  charts: OoxmlChartInfo[];
  media: OoxmlMediaInfo[];
  truncated: boolean;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// A.5.6 `read.receipt`
// ---------------------------------------------------------------------------

/**
 * `isError` unset — the receipt family is a SUCCESS (§2.5), which
 * `preparedDiscoveryReceipt` already gets right (state/session.ts:2751).
 * No `limit`: a receipt withholds nothing, it re-asserts what the caller holds.
 */
export type ReadReceiptResult = {
  v: ProtocolVersion;
  kind: "read.receipt";
  receipt: Receipt;
};

// ---------------------------------------------------------------------------
// A.5.7 `read.closure`
// ---------------------------------------------------------------------------

/**
 * THE MEMBER THAT FALSIFIES THE PER-TOOL REQUIRED-FIELD RULE (§4.3): no handle.
 * The measured body is 364 bytes with no handle at all.
 *
 * `complete: false` is DELETED: it is exactly the universal completeness flag
 * §4.4 withdraws. Completeness here is `open.length === 0`, which is a stronger
 * claim and one the §6.1(d) tests can check.
 *
 * The `closure_complete: true` case is NOT this member — it is the
 * `closure-complete` receipt (A.4), which fires once, on the edit that closed
 * the last check.
 */
export type ReadClosureResult = {
  v: ProtocolVersion;
  kind: "read.closure";
  /** obligation ids still open */
  open: string[];
  done: number;
  total: number;
  /** Emitted iff no checks are registered; absence means checks are registered
   *  and `open`/`done`/`total` describe them. */
  applicability?: "no-registered-checks";
  /** Prose; A.8 rule E-7. */
  note?: string;
  /**
   * A.8 rule E-7.
   *
   * DISCLOSED DEVIATION, ADJUDICATED 2026-08-13 (Revision-5 row). A.5.7
   * transcribes `summary?: string`, while the live emitted shape
   * (`ReadCodeClosureOutput.summary`) is an OBJECT
   * `{edits, files, checks_closed, checks_open}`. The object form is KEPT under
   * the same key, because the two directions are not symmetric: flattening now
   * destroys four counts that nothing else on the wire carries, and flattening
   * LATER — if the user rules for the string — is free. A.0 rule 2 forbids
   * improving adjudicated text, so the appendix is not edited here; the
   * deviation is declared at the point of departure instead.
   */
  summary?: ClosureSessionSummary;
};

/** The measured `mode=closure` summary object (`util/closureTracking.ts`). */
export type ClosureSessionSummary = {
  edits: number;
  files: string[];
  checks_closed: number;
  checks_open: number;
};
