// ---------------------------------------------------------------------------
// protocol v1 — the `search_files` response family (A.5.8–A.5.10).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13). Implements the A.9.1 `search-result.ts` row.
//
// §2.2 records the gap this file closes: `search_files` responses had NO
// contract type in `packages/types` at all — all five non-`tree` actions
// returned ad-hoc shapes. The element types below are the ones A.9.1 moves out
// of `packages/mcp-server`; each emitter keeps its own declaration until the P2
// emitter migration re-points it at this one.
//
// Rules T and K from the A.5.3–A.5.10 preamble govern these members too; see
// the header of `read-result.ts` for their statement.
// ---------------------------------------------------------------------------

import type { ProtocolVersion, Limit } from "./protocol.js";
import type { LocateOutput } from "./locate-impact.js";
import type { ArchiveFormat } from "./archive.js";

// ---------------------------------------------------------------------------
// A.5.8 `search.matches`
// ---------------------------------------------------------------------------

/** Today's `find`, `symbols`, `locate`, `diff` (§3.2). */
export type SearchMatchesResult = {
  v: ProtocolVersion;
  kind: "search.matches";
  matches: SearchMatches;
  limit?: Limit;
};

/**
 * [R4-4], adjudicated 2026-08-13 — `query` IS REQUIRED ONLY ON THE FORM THAT
 * HAS ONE. §4.3 required `query` on this member; only `find` emits one.
 * `symbols`, `diff` and `locate` carry no `query` field at all, `diff` accepts
 * no query ARGUMENT, and corpus id `sps1_action_symbols_path_only_no_query` is
 * a live `symbols` call with none. Per-form required sets:
 *
 *   | Form      | Required                                                  |
 *   |-----------|-----------------------------------------------------------|
 *   | `find`    | `query`, `files`, `total_files`, `total_matches`, `literal`|
 *   | `symbols` | `locations`, `total`                                      |
 *   | `locate`  | `result`                                                  |
 *   | `diff`    | `files`, `total_files`                                    |
 *
 * Requiring `query` on the member envelope would have forced three of four
 * forms to FABRICATE one — the class §2.1.1 and §4.4 both exist to remove.
 *
 * ZERO HITS IS A VALID, COMPLETE RESULT (§4.3): the census's 830 B `find` body
 * is a zero-hit `absence` shape, and `absence` is what makes the zero-hit claim
 * CERTIFIED rather than merely empty.
 *
 * Three shapes that are REFUSALS in v1 rather than members of this union:
 *  - the find escalation body (servedFindEscalation.ts:393-416), today
 *    `{ok:false, error, reason, required_action, terminal, terminal_reason,
 *    retry_same_call, …}` through `toolOk` — in v1
 *    `code:"repeated-all-served-find"`, `retry:"challenge"` or `"new-task"`
 *    (A.9.2 rows 5 and 20);
 *  - `GetCurrentDiffResult.error` (getCurrentDiff.ts:175), the field that
 *    produced §4.1's measured 7,576-byte failure of which ~7.4 KB was raw
 *    `git diff` usage text — in v1 a failed `git diff` is a `refusal`, not a
 *    success carrying an error string (A.9.2 row 9);
 *  - `{mode:"map", hit:false, reason}` — see `read-result.ts` (A.9.2 row 11).
 */
export type SearchMatches =
  /** today's action=find — `FindResponse`
   *  (features/search/find/findText.ts:636-746), plus the fields stamped
   *  downstream by `servedFindEscalation.ts` and `searchHopClosure.ts`, which
   *  are NOT on the declared interface. */
  | {
      form: "find";
      query: string;
      files: FindFileGroup[];
      total_files: number;
      total_matches: number;
      literal: boolean;
      /** Emitted iff >=1 match was found (findText.ts:710); absence means zero
       *  hits, and `absence` carries the certified claim instead. */
      inventory_complete?: true | "by-directory";
      /** Emitted iff the query was non-literal, or `queries[]` was used. */
      matched_terms?: string[];
      /** Emitted iff an identifier-variant fallback produced the hits. */
      matched_variant?: string;
      /** Emitted iff the tokenized fallback was also empty; absence means no
       *  suggestion qualified. */
      did_you_mean?: string[];
      /** Prose; A.8 rule E-7. */
      hint?: string;
      /** Prose; A.8 rule E-7. */
      note?: string;
      /** Emitted iff the response is truncated (findText.ts:700); absence means
       *  every match is in `files`. */
      inventory?: FindInventoryFileEntry[] | FindInventoryDirEntry[];
      /** Emitted iff zero matches AND the scan was complete enough to certify
       *  it. */
      absence?: FindAbsence;
      /** Emitted iff the corresponding attachment pass produced content. */
      member_sweep?: MemberSweepAttachment;
      /** As `member_sweep`. */
      related_lookups?: RelatedLookups;
      /** As `member_sweep`. */
      hop1?: Hop1Context[];
      /** As `member_sweep`. */
      hop1_omitted?: number;
      /** Emitted iff some matched lines lie outside what was served this
       *  session (servedFindEscalation.ts:287). */
      partially_served?: true;
      /** As `partially_served`. */
      partial_served_note?: string;
      /** Emitted iff every matched file AND line was already served this
       *  session (servedFindEscalation.ts:413, :324). */
      all_served?: true;
      /** As `all_served`. */
      all_served_occurrence?: number;
      /** As `all_served`. */
      served_note?: string;

      /**
       * DISCLOSED DEVIATION, C2-4 (Revision-5 row). Per-layer WALK-SKIP counts
       * (findText.ts:673). A.5.8 has no slot for it and §4.4 has no
       * carrier: these paths were never candidates, so folding them into
       * `Limit.omitted` would claim the server WITHHELD results it could have
       * sent. Kept under the emitter's own name. The collision with
       * `Limit.omitted` is structurally namespaced (`matches.omitted` vs
       * `limit.omitted`) and the two shapes are disjoint — a count map here, a
       * three-value enum array there.
       */
      omitted?: FindWalkOmissions;

      /**
       * DISCLOSED DEVIATION, C2-4 (Revision-5 row). The archive-scoped find
       * (`ArchiveFindResult.archive_scope`, tools/archive.ts:169-190) has NO
       * appendix home: A.5.8 is transcribed from the filesystem `FindResponse`
       * only. The accommodation MIRRORS A.5.10's `archive?` block so the two
       * archive-scoped members read the same way. `archive_scope.path` is
       * dropped because every `files[]` element already carries the outer path.
       */
      archive?: {
        format: ArchiveFormat;
        /** Entries in the container. */
        entries: number;
        /** Entries whose CONTENT was read and line-matched. */
        scanned_entries: number;
        /** Entries skipped (binary, oversize, unsupported). */
        omitted_entries: number;
      };

      /**
       * DISCLOSED DEVIATION, C2-4 (Revision-5 row). The archive reader's own
       * disclosure list. A.5.10 carries it INSIDE its `archive` block; this
       * form's accommodation above is specified at four fields, so it rides at
       * the form level. Emitted iff non-empty — dropping it would delete the
       * only statement that part of the container was not scanned.
       */
      warnings?: string[];
    }

  /** today's action=symbols — `SearchSymbolsResult` (tools/searchSymbols.ts:75-79) */
  | {
      form: "symbols";
      locations: SymbolLocation[];
      total: number;
      /** Emitted iff `query` was empty/omitted AND `path` was given
       *  (server.ts:9199); absence means the call was a normal symbol query. */
      note?: string;
    }

  /** today's action=locate — `LocateOutput` (locate-impact.ts:105). Already a
   *  declared discriminated union on `hit`; carried over unchanged. A `hit:false`
   *  locate is a VALID, COMPLETE result (§4.3), not a refusal. */
  | { form: "locate"; result: LocateOutput }

  /** today's action=diff — `GetCurrentDiffResult` (tools/getCurrentDiff.ts:32-49).
   *  `totalFiles` → `total_files`: §3.2's defect table names this exact
   *  inconsistency, and v1 has one spelling (A.9.2 row 8). */
  | { form: "diff"; files: DiffFile[]; total_files: number };

// ---------------------------------------------------------------------------
// A.5.9 `search.references`
// ---------------------------------------------------------------------------

/**
 * REQUIRED (§4.3): `symbol`; and `limit` with `cause:"records"` and
 * `limit.next` IFF more pages exist. `references[]` may be empty — the census's
 * 190 B body is exactly that.
 *
 * THERE IS NO STANDALONE `cursor` FIELD (§2.1.2, F5, and A.8 rule E-6), and
 * there is not one today either: the P0/C-3 pin
 * (`__tests__/fixtures/wire-baselines/search.references.paged.json`) measures
 * the opaque token living only inside `next_call.arguments.cursor`. In v1 that
 * `next_call` IS `limit.next`, and `limit.next.arguments.cursor` is the cursor.
 *
 * DELETED INTO `limit` per Rule T: `truncated`, `truncation_reason`,
 * `files_omitted`, `references_omitted`, `next_call`, `cursor_note`.
 * (A.9.2 row 19: `truncation_reason: "match-cap+bytes"` maps to no single
 * `Limit.cause`; P2 picks one when it writes the emitter.)
 *
 * NO top-level `query` today and none in v1 — the identifier is `symbol`.
 */
export type SearchReferencesResult = {
  v: ProtocolVersion;
  kind: "search.references";
  symbol: string;
  references: Reference[];
  files: ReferenceFileGroup[];
  total: number;
  /** Emitted iff zero references AND >=1 file was scanned. */
  absence?: ReferenceAbsence;
  /** Emitted iff the attachment pass produced content. */
  member_sweep?: MemberSweepAttachment;
  /** Emitted only alongside `member_sweep` (findReferences.ts:570). */
  hint?: string;
  /** Emitted iff the hop-1 closure pass produced content. */
  hop1?: Hop1Context[];
  /** As `hop1`. */
  hop1_omitted?: number;

  /**
   * DISCLOSED DEVIATION, C2-4 (Revision-5 row). A.5.9 lists `cursor_note` among
   * the fields "deleted into `limit` per Rule T", but it is NOT a truncation
   * dialect: it is the INVALID-CURSOR disclosure (findReferences.ts:362),
   * emitted when a caller's continuation token did not decode and the page was
   * therefore served FROM THE START. It can appear on a response that withheld
   * nothing — where there is no `limit` to carry it — and deleting it there
   * converts a caller error into a silent wrong answer: page 1 returned as if
   * it were page N. Kept until A.5.9 names a carrier for it.
   */
  cursor_note?: string;

  limit?: Limit;
};

// ---------------------------------------------------------------------------
// A.5.10 `search.tree`
// ---------------------------------------------------------------------------

/**
 * Transcribed from `CompactTree` (tools/exploreTree.ts:176-214) plus the
 * archive-scoped variant (server.ts:8999-9009, shape at tools/archive.ts:927),
 * which has no `depth`. Today's `mode:"tree"` stamp (server.ts:9260) is
 * deleted: `kind` is the discriminator (D4).
 *
 * `CompactTree`'s `ok:false` / `reason:"not-found"|"not-a-directory"` /
 * `did_you_mean` / `next` / `refused` fields are NOT part of this member. They
 * are a REFUSAL in v1 — `RefusalCode` carries `not-found` and `not-a-directory`,
 * and `did_you_mean` is already a `Refusal` field (§2.6). Emitting a failure
 * through `toolOk` with a body `ok:false` is exactly what D6 deletes
 * (A.9.2 row 10).
 */
export type SearchTreeResult = {
  v: ProtocolVersion;
  kind: "search.tree";
  root: string;
  /** newline-joined rendered text, NOT an array */
  tree: string;
  /** Emitted iff the tree is filesystem-scoped; absence means archive-scoped
   *  (tools/archive.ts:927 has no depth). */
  depth?: number;
  /** Emitted iff the tree is archive-scoped. */
  archive?: { format: ArchiveFormat; total_entries: number; warnings: string[] };
  /** Prose; A.8 rule E-7. */
  note?: string;
  limit?: Limit;
};

// ---------------------------------------------------------------------------
// Element types moved out of `packages/mcp-server` (A.9.1)
// ---------------------------------------------------------------------------

/** features/search/find/findText.ts:602-635. */
export type FindFileGroup = {
  path: string;
  lines: number[];
  /** Trimmed source text per line, same order as `lines` (<=80 chars each). */
  snippets?: string[];
  /** Count of this file's TRUE matched lines beyond what `lines`/`snippets`
   *  show. The true per-file total is always recoverable as
   *  `lines.length + more_lines`. Absent once `lines`/`snippets` show every one
   *  of this file's matches. */
  more_lines?: number;
  /** One-line "primary symbol + purpose" for this file (<=72 chars). Present
   *  only on the top ROLE_MAX_ANNOTATED_FILES files of a response, and only
   *  when cheaply derivable — never filler.
   *  NOT `SurfaceRole`: this is the same-name, different-vocabulary field
   *  A.2.7 refuses to unify. */
  role?: string;
  /** Full hit count before the byte cap trims this file's lines. */
  match_count?: number;
  /** Edit-grade range, present only for a uniquely dominant code cluster. */
  range?: string;
  /** Range handle paired with `context`. */
  handle?: string;
  /** Bounded exact source context around a uniquely dominant repeated hit. */
  context?: string;

  /**
   * DISCLOSED EXTENSIONS, C2-4 (Revision-5 row) — the residency annotations
   * `servedFindEscalation.ts` stamps onto `files[]` after `findText.ts` built
   * them. A.5.8's `FindFileGroup` transcription predates them. They are the
   * 2026-08-09 range-honesty fix: `served_this_session` says this file's bytes
   * are already in the caller's context (:220), `lines_held` says whether EVERY
   * matched line is (not merely the file), and `matched_lines_outside_served`
   * counts the ones that are not (:278). Dropping them would restore the
   * defect that fix removed — a whole path marked "read" on a sliver of it.
   */
  served_this_session?: true;
  /** As `served_this_session`. */
  lines_held?: boolean;
  /** As `served_this_session`. */
  matched_lines_outside_served?: number;

  /**
   * DISCLOSED EXTENSIONS, C2-4 — the archive-scoped find's per-entry
   * addressing (tools/archive.ts:170-179). `path` is the outer container and
   * `member` the entry inside it; the pair plus `handle`/`range` is the
   * §3.3 addressing triple for a VIRTUAL member, which is read-only and
   * immutable. Absent on every filesystem-scoped find.
   */
  member?: string;
};

/**
 * Per-layer walk-skip counts (features/search/find/walk `WalkOmissions`), each
 * present only when non-zero — a skipped path is never silent. NOT a delivery
 * limit: these paths were excluded from the SCAN, so they never were results.
 */
export type FindWalkOmissions = {
  ignored?: number;
  gitignored?: number;
  tokenlighten_ignored?: number;
  oversize?: number;
  symlinks?: number;
  non_text?: number;
  secrets?: number;
};

/** features/search/find/findText.ts:754-772. The zero-hit certificate. */
export type FindAbsence = {
  /** Files whose CONTENT was read and line-matched for this query — NOT the
   *  walk's candidate count and NOT `total_files` (which counts MATCHED files,
   *  i.e. 0 on every response carrying this object). */
  scanned_files: number;
  /** The exact token(s) whose absence is certified. */
  tokens: string[];
  /** Plain-language negative fact, scoped to what was actually scanned. */
  conclusion: string;
  /** Present only when some paths were NOT scanned (ignore layers, oversize,
   *  unfollowed symlinks, unreadable files) — so absence is never mistaken for
   *  a whole-repo claim. */
  caveat?: string;
};

/** One matched file's hit count in a truncated response's exhaustive inventory.
 *  features/search/find/findText.ts:775-779. */
export type FindInventoryFileEntry = {
  path: string;
  /** True total match count for this file — never capped. */
  matches: number;
};

/** Per-directory rollup entry, used instead of `FindInventoryFileEntry[]` when
 *  the per-file list would itself be large (`inventory_complete: "by-directory"`).
 *  features/search/find/findText.ts:782-788. */
export type FindInventoryDirEntry = {
  dir: string;
  /** Distinct matched files under this directory. */
  files: number;
  /** Total matches summed across every matched file under this directory. */
  matches: number;
};

/** One ready-to-run `search_files` call.
 *  features/search/find/relatedLookups.ts:65-68. */
export type RelatedLookupCall = {
  tool: "search_files";
  arguments: { action: "symbols" | "references"; query: string };
};

/** Companion lookups for the identifier `related_lookups` was attached to.
 *  features/search/find/relatedLookups.ts:76-81. */
export type RelatedLookups = {
  /** This identifier's own definition. */
  definition: RelatedLookupCall;
  /** This identifier's call sites. */
  callers: RelatedLookupCall;
};

/** features/search/find/memberSweep.ts:42-48. */
export type MemberSweepAttachment = {
  symbol: string;
  /** Up to 12 member names, public/exported-looking members first. */
  members: string[];
  /** Ready-to-run BATCHED find call for the first <=5 members. */
  next: string;
};

/** util/searchHopClosure.ts:11-18. */
export type Hop1Context = {
  path: string;
  line: number;
  range: string;
  relation: "definition" | "reference" | "match";
  handle: string;
  code: string;
};

/** tools/searchSymbols.ts:55. */
export type SymbolKind = "function" | "class" | "method" | "const" | "type";

/** tools/searchSymbols.ts:57-73. `score`/`reasons` only when `includeScores`. */
export type SymbolLocation = {
  path: string;
  line: number;
  symbol: string;
  kind: SymbolKind;
  score?: number;
  reasons?: string[];
  /** One-line "primary symbol + purpose" for this file — the same same-name,
   *  different-vocabulary field as `FindFileGroup.role`, NOT `SurfaceRole`
   *  (A.2.7). */
  role?: string;
};

/** tools/findReferences.ts:152-163. */
export type Reference = {
  path: string;
  line: number;
  in_comment: boolean;
  /** Trimmed source line (<=80 chars, match-centered). NOT populated on the
   *  flat `references[]` array the emitter builds — read `files[].snippets`. */
  text?: string;
};

/** One file's references, grouped so the path is not repeated per line.
 *  `lines`, `snippets` and `in_comment` stay index-aligned.
 *  tools/findReferences.ts:171-188. */
export type ReferenceFileGroup = {
  path: string;
  lines: number[];
  /** Trimmed source text per line, same order/length as `lines`. */
  snippets?: string[];
  /** Comment flag per line, same order/length as `lines`. */
  in_comment: boolean[];
  /** This path sits under a build-output directory segment. PROVENANCE ONLY —
   *  never a filter: the full-recall rule requires such hits still be returned,
   *  the caller just gets to weigh them. */
  generated?: boolean;
  /** Matched lines of THIS file not on this page. They are recoverable — the
   *  page's cursor (inside `limit.next.arguments`) resumes inside this file. */
  more_lines?: number;
};

/** Zero-match certificate for references — the same honesty contract as
 *  `FindAbsence` in a simpler shape. tools/findReferences.ts:204-212. */
export type ReferenceAbsence = {
  /** Files opened and scanned. Unreadable ones are NOT counted here. */
  scanned_files: number;
  symbol: string;
  conclusion: string;
  /** Present when some walked files could not be read — the certificate then
   *  covers only the scanned ones. */
  caveat?: string;
};

/** tools/getCurrentDiff.ts:32-37. */
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

/** tools/getCurrentDiff.ts:39-43. */
export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
};
