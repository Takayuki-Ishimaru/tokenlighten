import type { McpLang } from "./languages.js";
import type { ImpactSurface } from "./locate-impact.js";

// ---------------------------------------------------------------------------
// read_code mode=pack (path-pack v0.4 + query-pack v0.5)
// ---------------------------------------------------------------------------

export interface ReadCodePackRequestItem {
  path: string;
  range?: string;
  symbol?: string;
  purpose?: string;
}

export interface ReadCodePackInput {
  mode: "pack";
  /** Path-driven pack (v0.4 behavior). Mutually exclusive with query. */
  paths?: ReadCodePackRequestItem[];
  /** Query-driven pack (v0.5). Routes through explore action=locate then assembles slices. */
  query?: string;
  /** Optional file or directory scope for query-pack (workspace-relative). */
  path?: string;
  /** Optional likely symbol name for query-pack. */
  symbol?: string;
  /** Optional language filter for query-pack. */
  lang?: McpLang;
  /** Token cap. Default 4000 for path-pack (no ceiling), 1400 for query-pack (hard cap 2400). */
  maxTokens?: number;
}

export interface ReadCodePackResponseItem {
  path: string;
  range: string;
  purpose?: string;
  content: string;
  truncated: boolean;
}

export interface ReadCodePackOutput {
  mode: "pack";
  items: ReadCodePackResponseItem[];
  omitted: Array<{ path: string; range?: string; reason: "cap-exhausted" | "not-found" | "out-of-range" | "cap-exceeded" | "not-tiny" }>;
  completeness: "complete" | "partial" | "empty";
  /** Present only on query-driven pack — direct source status for assembly. */
  locate?: {
    hit: boolean;
    reason?: string;
    confidence?: number;
    completeness?: "complete" | "partial" | "unknown";
    candidates?: Array<{ path: string; line: number }>;
  };
}

// ---------------------------------------------------------------------------
// A7: read_code handles:[] batch read — resolves N handles to N slices in
// one grouped response (mode=slice previously took exactly one handle).
// ---------------------------------------------------------------------------

export interface ReadCodeHandlesBatchResponseItem {
  handle: string;
  path: string;
  range: string;
  content: string;
  truncated: boolean;
  sha: string;
}

export interface ReadCodeHandlesBatchOutput {
  mode: "handles";
  items: ReadCodeHandlesBatchResponseItem[];
  omitted: Array<{ handle: string; reason: "handle-unknown" | "handle-workspace-mismatch" | "not-found" | "cap-exceeded" }>;
  completeness: "complete" | "partial" | "empty";
}

// ---------------------------------------------------------------------------
// A7: edit_code edits[] item — extended to accept handle-based edits so a
// single batch call can apply a multi-surface change set.
// ---------------------------------------------------------------------------

/** Path-driven batch edit item (original v0.2 shape). */
export interface BatchEditPathItem {
  path: string;
  search: string;
  replace: string;
}

/** Handle-driven search/replace batch edit item. */
export interface BatchEditHandleSearchItem {
  handle: string;
  search: string;
  replace: string;
}

/** Handle-driven range-content batch edit item (whole-range replacement). */
export interface BatchEditHandleContentItem {
  handle: string;
  content: string;
}

export type BatchEditItem = BatchEditPathItem | BatchEditHandleSearchItem | BatchEditHandleContentItem;

// ---------------------------------------------------------------------------
// Structured binary artifact edits (edit_file artifact={...})
// ---------------------------------------------------------------------------

export interface XlsxCellEdit {
  sheet: string;
  cell: string;
  /**
   * A.9.4's second admitted instance, on the same terms as `artifact.form`:
   * `artifact.cells[].value` (server.ts:703) is an EMPTY schema node accepting
   * any JSON value, unvalidated for the same structural reason. The class is
   * closed — no member may be added to it without a Revision row.
   */
  value?: string | number | boolean | null;
  formula?: string;
}

export interface OoxmlTextReplacement {
  search: string;
  replace: string;
  all?: boolean;
}

export interface ZipMemberEdit {
  action: "add" | "replace" | "delete";
  member: string;
  content?: string;
  sourcePath?: string;
}

export type ArtifactEdit =
  | { kind: "xlsx"; cells: XlsxCellEdit[] }
  | { kind: "docx" | "pptx"; replacements: OoxmlTextReplacement[] }
  | {
      kind: "pdf";
      /**
       * A.9.4 — THE ONE DECLARED EXCEPTION to §1.3.1(2), and it stays an
       * exception. `artifact.form` (server.ts:1289) is advertised as
       * `{type:"object"}` with NO `properties` because its KEYS ARE CALLER
       * DATA, not protocol vocabulary: they are a PDF document's own field
       * names. Advertising them is impossible IN PRINCIPLE, not merely
       * unfinished, so the recursive validator short-circuits at this node
       * (validation/requestShape.ts:317-319).
       *
       * The exception is BOUNDED, and the bound is normative: such a map must
       * declare `{type:"object"}` with no `properties`, must be pinned as such
       * by the §6.1(a) schema snapshot so the hole cannot spread silently, and
       * must carry NO protocol-defined key of its own — mixing protocol keys
       * and caller keys in one map would make the exception unbounded. NO OTHER
       * property may join this class without a Revision row: "its keys are
       * data" is checkable, "we have not got round to declaring it" is the
       * defect §1.3.1(2) exists to close, and the two must not look alike.
       */
      form: Record<string, string | number | boolean | string[]>;
      flatten?: boolean;
    }
  | { kind: "zip"; members: ZipMemberEdit[] };

export interface ArtifactEditFileInput {
  path?: string;
  handle?: string;
  credentialRef?: string;
  outputCredentialRef?: string;
  artifact: ArtifactEdit;
}

export interface ArtifactEditSuccess {
  ok: true;
  path: string;
  kind: ArtifactEdit["kind"];
  changes: number;
  encrypted: boolean;
  sha: string;
}

// ---------------------------------------------------------------------------
// edit_code review:true opt-in
// ---------------------------------------------------------------------------

export interface EditReviewInfo {
  touched: Array<{ path: string; surface: ImpactSurface }>;
  possibleMissingSurfaces: ImpactSurface[];
  confidence: number;
  compactDiff: string;
}

// ---------------------------------------------------------------------------
// v0.6 handle types (wire-format projection of the internal HandleEntry)
// ---------------------------------------------------------------------------

/**
 * Public-facing handle reference returned in MCP responses.
 * The handle is short, session-local, and safe to expose in JSON.
 */
export interface HandleRef {
  /** Short session-local identifier ("h7"). */
  handle: string;
  /** Coarse kind of the underlying target. */
  kind:
    | "repo"
    | "file"
    | "symbol"
    | "range"
    | "text"
    | "reference-set"
    | "scope";
  /** Optional workspace-relative path (omit for scope handles). */
  path?: string;
  /** Inclusive 1-based "start-end" line range (omit for whole-file/scope). */
  range?: string;
  /** Optional symbol name when the handle targets a symbol. */
  symbol?: string;
  /** Content fingerprint ("sha256:<hex>") for hash-pinned reads/edits. */
  sha?: string;
}

/**
 * Failure shape returned by edit_code when a precondition is not met.
 */
export interface EditFailure {
  ok: false;
  reason:
    | "handle-unknown"
    | "handle-workspace-mismatch"
    | "hash-mismatch"
    | "search-not-unique"
    | "scope-violation"
    | "out-of-scope"
    | "write-not-enabled"
    | "archive-member-read-only"
    | "artifact-edit-required"
    | "artifact-edit-invalid"
    | "artifact-edit-incompatible-arguments"
    | "artifact-precondition-unsupported"
    | "not-found";
  /** When non-unique, a few candidate matches as handles. */
  matches?: Array<{ handle: string; path: string; line: number }>;
  /**
   * When hash-mismatch, the current sha so the client can refresh.
   *
   * A.9.2 snake_case (renamed 2026-08-14 from `currentSha`): the v1 refusal
   * allowlist carries `current_sha`, `tools/applyEditsMulti.ts` already emitted
   * that spelling, and the camelCase copy this producer used was silently
   * dropped by the funnel — the `expected-hash` retry the same failure
   * prescribes was unauthorable from the wire.
   */
  current_sha?: string;
  /**
   * S1: a one-line recovery instruction so a bare precondition failure is a
   * redirect, not a dead end — e.g. "retry with expectedSha=<current_sha>" for
   * a hash-mismatch, or a scopeHandle hint for a scope-violation.
   */
  next?: string;
}

// ---------------------------------------------------------------------------
// v0.6 read_code response shapes (R0–R3)
// ---------------------------------------------------------------------------

/**
 * R0: Surface map — coverage-oriented surface discovery.
 * No code body is returned.
 */
export interface ReadCodeMapOutput {
  mode: "map";
  /** One best surface, one handle each (coverage-oriented). */
  surfaces: Array<{
    role: ImpactSurface;
    handle: string;
    path: string;
  }>;
  coverage: "complete" | "partial";
  /** When partial: which surface roles were not covered. */
  missing?: ImpactSurface[];
}

/**
 * R1: File or symbol digest — enough structure for the model to choose
 * the next operation without full code bodies.
 */
export interface ReadCodeDigestOutput {
  mode: "digest";
  handle: string;
  path: string;
  digest: {
    imports?: string[];
    symbols?: Array<{ name: string; range: string; line?: number }>;
    /** Optional distinctive text hits inside the file. */
    text_hits?: Array<{ line: number; text: string }>;
  };
  sha: string;
}

/**
 * R2: Symbol or line slice — exact code only when reasoning requires it.
 * Response includes a handle and content hash.
 */
export interface ReadCodeSliceOutput {
  mode: "slice";
  handle: string;
  path: string;
  range: string;
  content: string;
  truncated: boolean;
  sha: string;
  /**
   * DESIGN-v0.9 §4.6a same-handle slice continuation: when a RANGE slice
   * truncated at the byte cap, the ONE next window over the SAME handle served
   * inline (up to the §4.8 must-fetch budget), so the deterministic follow-up
   * read is not a round trip. Present only when a window was inlined; `next`
   * is then advanced past it and `inlined` carries "slice-cont:<handle>".
   */
  continued?: { range: string; content: string };
  /**
   * DESIGN-v0.9 §4.6/§3.1: internal-execution manifest. On a slice this is
   * ["slice-cont:<handle>"] when `continued` is present. Each named handle is
   * verified content-bearing in the same response.
   */
  inlined?: string[];
  /** Content-hash-bound cumulative raw file-line coverage for this session. */
  served_range_ledger?: {
    sha: string;
    served: string[];
    unserved: string[];
    /** Raw lines in this request that were not covered by an earlier serve. */
    added_lines: number;
    requests: number;
    clusters: number;
    complete: boolean;
  };
}

/**
 * R3: Exact full file — escape hatch for tiny files or format-sensitive edits.
 * Not the default; callers must record this as a full-file expansion event.
 */
export interface ReadCodeFullOutput {
  mode: "full";
  handle: string;
  path: string;
  content: string;
  truncated: boolean;
  sha: string;
  /** Always true: callers must record this as a full-file expansion event. */
  fullFileExpansion: true;
  /** Full serve closes the content-hash-bound range ledger for this file. */
  served_range_ledger?: ReadCodeSliceOutput["served_range_ledger"];
}

/**
 * mode=full paths=[...] (2+ entries) — batch full-read, one result per path
 * in request order. Fixes a bench-observed gap: mode=full only ever accepted
 * a single `path`, so a caller that handed it paths=[a,b] got "path is
 * required" and re-issued one read_code call per file. Each item is
 * evaluated INDEPENDENTLY through the SAME full-read governor a single-path
 * call uses (byte cap, PER_PATH_FULL_CAP/PER_TASK_FULL_CAP, C5 auto-allow) —
 * batching does not weaken or bypass any cap. Modeled on
 * ReadCodeHandlesBatchOutput's items/omitted/completeness shape.
 */
export interface ReadCodeFullBatchResponseItem {
  path: string;
  /**
   * The remaining fields mirror what a single-path mode=full call would
   * return for this path: on success, ReadCodeFullOutput's own fields
   * (handle, content, truncated, sha, fullFileExpansion — `mode` omitted
   * here, it is redundant with the batch envelope's own `mode:"full"`); on a
   * served downgrade, the same downgraded-skeleton or artifact-redirect shape
   * a single-path call would return for that path (downgraded_from, reason,
   * skeleton, handle, next, etc.) instead of raw content.
   */
  [field: string]: unknown;
}

export interface ReadCodeFullBatchOutput {
  mode: "full";
  items: ReadCodeFullBatchResponseItem[];
  omitted: Array<{ path: string; reason: string }>;
  completeness: "complete" | "partial" | "empty";
}

/**
 * R0b: Repo overview — package/entrypoint map for broad understanding tasks.
 * No code body is returned; reading targets are handle-backed.
 */
export interface ReadCodeOverviewOutput {
  mode: "overview";
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
    /** First useful line for quick evidence linking. */
    line?: number;
    /** Whole-file line span, formatted as "1-N". */
    range?: string;
    target: string;
  }>;
  truncated: boolean;
}
