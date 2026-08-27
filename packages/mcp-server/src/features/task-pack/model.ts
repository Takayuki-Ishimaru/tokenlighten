/**
 * Internal task-pack model.
 *
 * These types describe the builder's in-process draft/result. The external
 * MCP wire contracts remain canonical in @tokenlighten/types.
 */
import type {
  CreateTarget,
  McpLang,
  TaskChangeContract,
  TaskExecutionContract,
  TaskProfile,
  TaskProfileBinding,
  TaskProfileRequest,
  TaskWorkspaceState,
  TaskWiringProfile,
  TaskPackSingleSiteUniqueMatchFastPath,
} from "@tokenlighten/types";
import type { ContinuationPlan } from "../../util/continuation.js";
import type { OoxmlVisualInventory } from "../../office/ooxmlVisuals.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskPackSurface {
  role: string;
  handle: string;
  path: string;
  range: string;
  /**
   * Symbol name this surface anchors on, when the underlying candidate was a
   * symbol-kind match (as opposed to a text/line-range match). Used by A4's
   * concern-token route check (matches query tokens against path OR symbol,
   * never the embedded code) — surfaced here rather than kept internal-only
   * since it is otherwise-useful surface metadata already computed upstream.
   */
  symbol?: string;
  required?: boolean;
  why?: string;
  facts?: string[];
  /**
   * Canonical (single-copy) edit guidance — do NOT duplicate inside
   * likely_edits. DESIGN-v0.8 §C1 item 2: omitted when the value equals the
   * generic role fallback (editIntentForRole/doneCheckForRole) — a
   * role-specific string (enum-like queries) is always kept since it carries
   * task information the generic fallback does not.
   */
  edit_intent?: string;
  done_check?: string;
  /**
   * DESIGN-v0.8 §C1 item 1: present only on the PRIMARY surface (the first
   * surface in the pack, or any surface marked `required`) — secondary
   * surfaces omit it (fully derivable boilerplate; the agent already has the
   * primary surface's likely_edits shape to follow).
   */
  likely_edits?: Array<{ kind: string; handle?: string; target?: string; confidence?: number }>;
  /**
   * DESIGN-v0.8 §C1 item 3: `needs_exact_code`/`slice_wider` were dropped —
   * both are fully implied (code presence; the always-present `handle`,
   * respectively). Callers now check `code !== undefined` directly and
   * reconstruct a widen request as `read_code mode=slice handle=<handle>`.
   */
  code?: string;
  /**
   * DESIGN-v0.8 §C2 item 2: set instead of `code` when a CONSECUTIVE pack for
   * this workspace resolved this surface to the same handle+range with an
   * identical content hash as the immediately prior pack (or an earlier
   * surface within the SAME pack) — points at the surface that already
   * carries the identical block rather than re-sending it.
   */
  code_unchanged?: string;
  /**
   * turn-economy wave 3 (V2): content sha of the bytes this surface's file held
   * when it was served. Emitted ONLY on the compact `pack_unchanged` re-serve so
   * the caller can revalidate that the exact copy it already holds is still
   * current (the same sha this pack captured at serve time) without a re-serve of
   * the body. Absent on freshly-computed packs (the embedded `code`/handle is the
   * content there); a surface whose file was unreadable/oversized at capture omits
   * it. Never a substitute for the handle — purely a revalidation receipt.
   */
  sha?: string;
  /**
   * DESIGN-v0.8 §A5 deliverable 3: compact heading outline of a matched
   * contract doc (why="doc-contract-match"), one `"L<n>: <heading text>"`
   * entry per `#`/`##`/... line in the WHOLE document (not just the matched
   * section `code` already covers). Lets a multi-topic doc-heavy task do a
   * targeted `read_code mode=slice` over a known line range for a DIFFERENT
   * section instead of a native full-file read to discover what else the
   * doc covers.
   */
  outline?: string[];
  /**
   * DESIGN-v0.9 §4.1/§4.3/§4.4 content-completeness split (distinct from
   * `coverage`, which answers surface IDENTIFICATION — see TaskPackResult).
   * This answers "did we embed this surface's full range BODY?". CONVENTION
   * (chosen once, applied everywhere): the ONLY value ever emitted is
   * "partial"; a fully-embedded surface carries NO stamp (absence = complete).
   * Stamped "partial" when the body was match-centered-trimmed at the cliff
   * (centeredSliceForCap) or body-stripped under pack budget (trimToCap), so a
   * surface that carries this is always accompanied by `remaining_ranges`.
   */
  content_completeness?: "partial";
  /**
   * DESIGN-v0.9 §3.1/§4.1: the uncovered "<start>-<end>" line spans of THIS
   * surface's `range` whose bodies were not embedded (0, 1, or 2 spans; when
   * body-stripped entirely it is the whole range). Same-handle: the agent
   * re-slices `handle` over each span — never a re-locate. Present only
   * alongside content_completeness:"partial".
   */
  remaining_ranges?: string[];
  /**
   * Set when a partial body's DECISION-CRITICAL anchor lines (e.g. a wiring
   * hub's insertion/producer-entry sites) are all inside the served ranges —
   * the partialness is context, not missing evidence. Readiness risk treats
   * such a surface as anchor-complete instead of charging the
   * partial-surface-content factor (2026-07-25 honest-hub fix).
   */
  anchors_served?: boolean;
  /**
   * L1 (2026-08-08 doc-authority serve honesty): a DOC surface whose served
   * span is a sliver of its own file (see features/task-pack/docSliver.ts)
   * carries the same navigation index `mode=slice` already emits for that
   * file, plus one executable section-scoped zoom. Field names mirror the
   * slice path EXACTLY so callers meet one vocabulary, not two.
   */
  total_lines?: number;
  headings?: Array<{ level: number; text: string; range: string }>;
  headings_truncated?: boolean;
  headings_total?: number;
  headings_note?: string;
  sections_hint?: string;
  next_call?: { tool: string; arguments: Record<string, unknown> };
}

// csv covers both .csv and .tsv (tsv is normalized to the csv kind at mint —
// see mintArtifactSurface — so a single csv branch in extractArtifactBuildSection
// serves both; office/csv.ts forces the tab delimiter from the .tsv extension).
export type ArtifactKind = "docx" | "xlsx" | "pptx" | "pdf" | "csv";

/** Discovery-only pack surface. Runtime shape intentionally has no code/range/role. */
export interface ArtifactTaskPackSurface {
  path: string;
  basename: string;
  kind: "artifact";
  artifactKind: ArtifactKind;
  size: number;
  handle: string;
  extract: string;
}

export type TaskPackResultSurface = TaskPackSurface | ArtifactTaskPackSurface;

export type ConcernCoverage = import("@tokenlighten/types").ConcernCoverage;

/** One internally-executed artifact extraction, exposed at pack top level. */
export type ArtifactTaskPackSection = (
  | { sheet: string; range: string; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { kind: "docx"; sections: Array<{ heading: string; text: string }>; truncated: boolean }
  | { kind: "pptx"; slides: Array<{ heading: string; text: string }>; truncated: boolean }
  | { kind: "pdf"; pages: Array<{ page: number; text: string }>; truncated: boolean }
) & { visuals?: OoxmlVisualInventory };

/**
 * One artifact source's inlined extraction, carrying source identity.
 *
 * A1 (2026-07-30): the entry may also disclose that the per-artifact inline
 * budget served only a PREFIX of the extraction. Live defect (T14 two-deck
 * audit): a pack resolved both decks to size+handle+`extract` STUBS and served
 * zero slide text, so the caller paid two extra round trips to read content the
 * server had already located — while the distributed guide's own contract says
 * "artifact packs need content-bearing artifact_sections per source". The
 * honesty fields below are what let a bounded inline stay truthful instead of
 * falling back to that stub: what was cut, and the ONE call that fetches it.
 */
export interface ArtifactTaskPackSectionEntry {
  path: string;
  section: ArtifactTaskPackSection;
  /**
   * Stamped ONLY when the inline budget (or the extractor's own cap) served
   * less than this artifact's full extraction. Same convention as the
   * surface/rollup fields: the only value ever emitted is "partial"; absence
   * means the inlined section is the whole extraction.
   */
  content_completeness?: "partial";
  /**
   * The artifact's own file handle (the same id its `{kind:"artifact"}` surface
   * carries) — the address `next` resolves against, so a partial entry is
   * self-contained and does not require re-finding the surface.
   */
  handle?: string;
  /**
   * Ids of the extraction entries NOT inlined here — docx headings, "Slide N",
   * "page-N", or a "rows A-B" span for a sheet. Bounded; the tail collapses to
   * a "+N more" marker.
   */
  remaining_sections?: string[];
  /** Exact one-call fetch for `remaining_sections`, addressed by `handle`. */
  next?: string;
  /** One-line truthful disclosure of what the budget cut and why. */
  note?: string;
}

export interface TaskPackResult {
  /** Opaque replay reference attached by the task-pack dispatcher. */
  qref?: string;
  mode: "task_pack";
  /**
   * DESIGN-v0.8 coverage-honesty: three-way, replacing the old binary
   * complete|partial that conflated ≥5 distinct states and trained agents to
   * distrust every pack:
   *   - "complete": the locate flow was complete AND every required role is
   *     covered AND every query concern is addressed — trust it, edit directly.
   *   - "focused": exactly one confident site with no cross-surface fan-out
   *     (single-surface, high locator confidence) — also trustworthy; the pack
   *     covers the whole change.
   *   - "partial": genuinely incomplete — see `coverage_reason` for WHY.
   */
  coverage: "complete" | "focused" | "partial";
  /**
   * DESIGN-v0.8 coverage-honesty: WHY the pack is not "complete". These exact
   * strings are a cross-workstream telemetry contract (bench counts them) —
   * do NOT rename. Omitted on a "complete" pack (nothing to explain).
   *   - "single-site": one confident location, no fan-out (a "focused" pack).
   *   - "candidate-list": several plausible primaries need confirmation first.
   *   - "missing-roles": a required surface role is absent.
   *   - "concerns-uncovered": a query concern token is not addressed by any surface.
   *   - "diff-truncated": the working-tree diff had more changed files than fit.
   */
  coverage_reason?: "single-site" | "candidate-list" | "missing-roles" | "concerns-uncovered" | "diff-truncated";
  // Code consumers retain the historical type; artifact objects are appended
  // only at the shared wire-emission choke point via TaskPackResultSurface[].
  surfaces: TaskPackSurface[];
  missing: string[];
  /**
   * A4 item "stop reporting partial-by-budget": candidate paths that were
   * FOUND but trimmed purely because the candidate pool exceeded
   * MAX_SURFACES_DISTINCT — nothing required is missing on their account.
   * Reported here (non-alarming) instead of folded into `missing` (alarming,
   * and what previously branded 22/22 packs "partial" even when every
   * required role was covered). Only populated by the main locate flow's
   * budget trim; other flows (seeded paths[], partial-candidate abstain
   * fallback) do not produce this kind of drop.
   */
  trimmed?: string[];
  /**
   * turn-economy wave 2 (W2): set to true when capGuidanceMetadata dropped the
   * tail of one or more guidance lists (`trimmed` candidate paths, `missing`,
   * or the `create_note`) to hold their COMBINED size under
   * GUIDANCE_METADATA_CAP_BYTES. A single terse marker instead of an ever-
   * growing inventory of unserved files — the raised pack budget flows to code
   * bodies, not to more crawl targets. Omitted when nothing was dropped.
   */
  guidance_trimmed?: true;
  /**
   * 09e pollution honesty: the distinct non-workspace project roots the final
   * surfaces span, present ONLY when there are >= 2 (a single-root pack —
   * the overwhelmingly common case — carries no field). A multi-root pack is
   * either a genuine two-domain task or the pack-level symptom of
   * cross-project candidate pollution; naming the roots lets the caller
   * re-scope (paths=["<root>"] or a root-naming query token) instead of
   * silently trusting a mixed pack. Ordered by surface count, dominant first.
   */
  roots?: string[];
  ok?: false;
  reason?: "broad-overview-query";
  alternatives?: string[];
  required_surfaces?: string[];
  missing_required_surfaces?: string[];
  blocking_next_steps?: string[];
  route?: {
    action: "edit_from_handles" | "locate_missing_surfaces" | "fallback_native" | "confirm_candidates" | "inspect_handles" | "answer_from_handles";
    reason: string;
    max_additional_tl_calls: number;
  };
  checks?: string[];
  verify?: string[];
  /**
   * Item 4 (create-target note): set when a module-shaped query token
   * (snake_case/camelCase, length>=6, not a generic noise word) matches
   * neither a walked file's basename/stem anywhere in the workspace nor any
   * served surface's path/symbol/embedded code — the task may genuinely
   * require CREATING a new module rather than editing an existing one. At
   * most one note (the longest qualifying unmatched token); never invents a
   * path. See buildCreateTargetNote.
   */
  create_note?: string;
  /**
   * DESIGN-v0.8 §A7: on a PARTIAL pack only, a compact (≤PARTIAL_TREE_CAP_BYTES)
   * one-line-per-dir inventory of the surfaces' dominant root cluster, so an
   * agent that would otherwise resort to a native `find -type f` after a
   * partial pack can see what else the cluster contains without a full-file
   * dump. Omitted on complete packs (nothing more to discover) and dropped
   * early by trimToCap under budget pressure (navigation convenience, not
   * task-closing content).
   */
  tree?: string;
  next?: string;
  /** DESIGN-v0.9 §8: stable per-concern coverage for multi_concern packs. */
  concerns?: ConcernCoverage[];
  /** Repository-observed lexical ties that bounded search cannot resolve. */
  concern_ambiguities?: Array<{ id: string; candidates: string[] }>;
  /** Specialized route selected for this pack; generic is omitted. */
  task_profile?: Exclude<TaskProfile, "generic">;
  /** Selection provenance for explicit/inferred profile routing. */
  profile_binding?: TaskProfileBinding;
  /** Stable stop/continue signal consumed by agents and bench telemetry. */
  execution_contract?: TaskExecutionContract;
  /** Sparse receipt for safe read/search operations completed before returning. */
  internalized?: Array<{
    op: "find" | "read";
    status: "used";
    evidence: number;
    handle?: string;
  }>;
  /** Edit/review responsibilities derived from the final served surfaces. */
  change_contract?: TaskChangeContract;
  /** Producer-to-consumer endpoints and insertion handle for wiring work. */
  wiring?: TaskWiringProfile;
  /** DESIGN-v0.9 §5/§8: structured residual work authored by the builder. */
  continuation?: ContinuationPlan;
  /**
   * Behavior 3 (task_pack re-call dedup): true ONLY on the COMPACT response
   * returned when this call exactly re-issued the prior served pack and every
   * surface file is unchanged. Such a response omits all code/skeleton/facts/
   * likely_edits — its `surfaces` carry handle/path/range/role only — so the
   * agent re-uses the handles it already has instead of paying for a full
   * re-serialization. Absent (undefined) on every freshly-computed pack.
   */
  pack_unchanged?: true;
  /**
   * protocol v1 §2.3 / A.4 (C2-3): the RECEIPT TAG — v1's single discriminator
   * for the receipt family, replacing the four booleans a client used to have
   * to probe. Minted alongside `pack_unchanged` above (which stays as the
   * in-process signal this module's compaction guards, `attachSupply` and the
   * canonical-decision fence all read) and deleted from the wire by
   * `protocol/readFamily.ts`, which projects it into `Receipt`.
   */
  receipt?: "pack-unchanged";
  /**
   * turn-economy wave 3 (V2): the CURRENT workspace state (fingerprint + scope +
   * inventory counts) attached to a compact `pack_unchanged` re-serve. It is the
   * revalidation proof — the caller re-binds the cert it already holds to this
   * fingerprint ("workspace_state fingerprint binds cert; pack_unchanged
   * revalidates") without re-serializing the whole pack. Present ONLY on the
   * compact response (a freshly-computed pack carries its workspace_state inside
   * `execution_contract` instead); omitted when no workspace was resolvable.
   */
  workspace_state?: TaskWorkspaceState;
  /**
   * Behavior 3: on a `pack_unchanged` response, the still-OPEN completion
   * checks (session lastOpenIds ∩ the ids this pack recorded), ≤3 entries,
   * each ≤140 chars — a compact reminder of what remains before "done" without
   * re-sending the full `checks[]`. Omitted when nothing is open.
   */
  checks_open?: string[];
  /**
   * DESIGN-v0.9 §3.1/§4.4 response-level content-completeness ROLLUP, distinct
   * from `coverage` (surface identification). CONVENTION (same as the
   * per-surface field): the ONLY value ever emitted is "partial"; OMITTED when
   * every code-bearing surface embedded its full range and nothing was
   * body-stripped (absence = complete). Equivalent to "partial iff any surface
   * carries content_completeness:'partial'". Stamped by
   * stampRollupContentCompleteness at the shared dedupeTrimAndPersist exit, so
   * all four pack flows report it identically.
   */
  content_completeness?: "partial";
  /** Edit-readiness, independent of surface coverage. Omitted when sufficient. */
  content_sufficiency?: "needs-followup";
  /**
   * DESIGN-v0.9 §4.3: count of WHOLE surfaces trimToCap dropped purely for
   * size (the last-resort handle loss after every body was stripped). Omitted
   * when 0 (the overwhelmingly common case now the trim order is inverted).
   * The bench reads this to see size-triggered handle loss.
   */
  surface_drops?: number;
  /** DESIGN-v0.9 §8: content-bearing artifact extraction for artifact_build. */
  section?: ArtifactTaskPackSection;
  /** Multiple independently required artifact inputs, each with source identity. */
  artifact_sections?: ArtifactTaskPackSectionEntry[];
  /**
   * A1: artifact paths whose inlined body trimToCap removed ENTIRELY under
   * byte pressure — the last resort, reached only after every code body was
   * stripped. The artifact's stub surface (handle + `extract` call) always
   * survives, so nothing becomes unreachable; this field exists so the
   * disappearance is stated rather than silent. Omitted (the normal case) when
   * no artifact body was shed.
   */
  artifact_sections_trimmed?: string[];
  /**
   * Exact artifact source files whose content must be present before an
   * artifact_build pack can be certified prepared. Unlike artifact kind,
   * source identity preserves two independently required XLSX inputs.
   */
  artifact_requirements?: string[];
  /**
   * Explicit new-file frontier proved from a unique existing directory.
   *
   * ONE TYPE, TWO SITES ([R5-23], ruling 6): the shape is declared once in
   * `@tokenlighten/types` as `CreateTarget`, because since ruling 6 this same
   * object is projected onto `decision.act.edit.create_target`. A second
   * structural declaration here would let the builder's idea of a create
   * target drift from the wire's.
   */
  create_target?: CreateTarget;
  /** A stale/colloquial requested name resolved by multi-facet ownership. */
  answer_resolution?: {
    strategy: "semantic-responsibility";
    requested_identifier: string;
    resolved_handle: string;
    matched_facets: string[];
  };
  /**
   * DESIGN-v0.9 §4.6b: internal-execution manifest. When a complete/focused
   * pack would have emitted `read_file handles=[...]` as a next for >=2
   * code-less surfaces, the pack builder instead INLINES those surfaces'
   * bodies (up to the must-fetch budget, §4.8) and stamps one
   * "surface-body:<handle>" entry per body actually embedded. Present ONLY
   * when internal execution occurred; every named handle is verified
   * content-bearing in the same response by attachSupply (§4.7). Also the
   * signal capForResult reads to grant the §4.8 must-fetch budget expansion.
   */
  inlined?: string[];
  /**
   * IMPROVEMENT A (cumulative session-stateful coverage): set to "cumulative"
   * when this pack reports coverage:"complete" only because the UNION of the
   * current call's surfaces and still-valid surfaces PRIOR calls in this task
   * already served covers every required role. Absent on a single-call
   * complete pack. Its presence tells the model the pack is trustworthy
   * (edit/answer directly) even though THIS call did not re-serve every role.
   */
  coverage_basis?: "cumulative";
  /**
   * IMPROVEMENT A: the surfaces PRIOR packs in this task already served that a
   * cumulative-complete decision relied on — so the model knows it already
   * HOLDS them and does not re-fetch. Code-less by design (path/role/handle
   * only); the handle re-slices the already-served body when needed.
   */
  served_earlier?: Array<{ path: string; role: string; handle?: string }>;
  /**
   * IMPROVEMENT A: a complete, CODE-LESS inventory of the entire known working
   * set — every identified frontier/candidate file (current surfaces, prior
   * served surfaces, budget-trimmed candidates) plus resolvable depth-1 import
   * neighbours of served surfaces (role:"import-neighbor"). Emitted whenever
   * coverage is NOT single-call complete (or the working set overflowed byte
   * caps): the model zooms via these handles/paths instead of re-searching.
   * Capped (~200 entries / ~8 KiB) with a per-directory rollup beyond the cap.
   */
  frontier_index?: Array<{ path: string; role: string; handle?: string }>;
  /**
   * IMPROVEMENT D (honest verification-path signal): machine-readable verdict
   * on whether the served surfaces' own toolchain can actually RUN a
   * verification command in THIS checkout. `available:false` with
   * reason:"dependencies not installed" tells an agent NOT to burn turns
   * installing a toolchain the checkout was never set up to run; the
   * `command` is the exact runnable command when available:true. Additive to
   * the human-facing `verify[]` hints (which stay as-is).
   */
  verification?: {
    available: boolean;
    reason?: string;
    command?: string;
    suggestion?: string;
  };
  /**
   * iter-3 F5: a compact, best-effort RUNTIME hint for an artifact-sourced pack
   * whose create/edit target is a Python module (Office source + .py target). It
   * lists python3* interpreters discovered by filesystem stat only (PATH + common
   * Homebrew/System locations — never executed) and, per interpreter, whether its
   * site-packages appears to contain the module the artifact kind needs
   * (xlsx→openpyxl, docx→python-docx). It exists to spare a build cell the tail of
   * turns spent hunting an interpreter that can import the library. HINT ONLY —
   * fs presence is not proof the import succeeds; `note` says so. Bounded to
   * ~500B and omitted entirely on non-Python targets or when nothing is found.
   */
  runtime?: {
    kind: "python";
    note: string;
    module: string;
    interpreters: Array<{ path: string; has_module: boolean }>;
  };
  /** A conservative, server-proved shortcut for one exact existing-file replacement. */
  fast_path?: TaskPackSingleSiteUniqueMatchFastPath;
  /** Additive provenance for a successful pathless locator scope retry. */
  scope_inferred?: { path: string; reason: "pathless-locator-abstain" };
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** Valid language identifiers (mirrors LocateInput.lang). */
type ValidLang = McpLang;

export interface TaskPackArgs {
  query?: string;
  /** Server-derived trace join key. Internal only; never serialized or fingerprinted. */
  evidenceShadowQref?: string;
  /**
   * C2: this call resolved its query from a `qref`, i.e. it is a REPLAY over an
   * already-certified working set rather than a freshly-typed request. Server-
   * derived; internal only, never serialized or fingerprinted.
   */
  taskQueryRefReplay?: true;
  /**
   * PI-09 close-out: the caller sent `force_serve:true` — "my context was
   * compacted, send the bodies again". Suppresses every BODY-WITHHOLDING pack
   * receipt (exact-fingerprint dedup, semantic-duplicate dedup, subset
   * receipt) so the response carries surfaces, not an acknowledgement.
   *
   * Server-derived from the request argument; internal only, and deliberately
   * NOT part of `computePackFingerprint`/`computeExtraArgsKey` — a forced
   * serve must answer the SAME question as the unforced one, and the record it
   * captures must be reusable by the caller's next ordinary call.
   */
  forceServe?: boolean;
  /** Opaque reference safe to echo in follow-up call guidance. */
  credentialRef?: string;
  /** Resolved secret for in-process artifact extraction; never serialized. */
  credentialPassword?: string;
  /** Explicit task-shape hint. The server validates it and falls back safely. */
  taskProfile?: TaskProfileRequest;
  path?: string;
  symbol?: string;
  lang?: ValidLang;
  limit?: number;
  surfaceRoles?: string[];
  /**
   * T1 (2026-08-27 field-eval): explicit caller byte ceiling for this pack --
   * forwarded from read_file's advertised maxBytes argument. Effective
   * target = min(type-specific default, maxBytes, maxTokens*4), floored at
   * DEFAULT_RESPONSE_BYTE_FLOOR -- see readCodeTaskPack.ts's capForResult and
   * readCodeModes.ts's resolveCallerByteCeiling. Absent for ordinary calls,
   * which keeps their behavior byte-identical.
   */
  maxBytes?: number;
  /** Sibling of maxBytes, converted to bytes at 4 chars/token before the min(). */
  maxTokens?: number;
  /**
   * Server-derived, internal only: the env/client-profile-resolved default
   * byte ceiling, consulted ONLY when the caller supplies neither maxBytes
   * nor maxTokens above. Never serialized or fingerprinted.
   */
  clientDefaultByteCeilingHint?: number;
  /**
   * A1: caller-supplied exact file paths to seed as surfaces directly,
   * bypassing the pathless locator for those files. When present and
   * non-empty, buildTaskPack seeds a surface for every entry (never drops
   * one) and runs the locator only to fill missing REQUIRED roles, confined
   * to the supplied paths' common ancestor directory.
   *
   * FIX-B3 (2026-07-09d forensics): a bare path string is also accepted
   * (coerced to `{path}` internally via normalizePathEntry), matching the
   * coercion mode="full"'s batch paths[] branch already applies
   * (server.ts's `typeof p === "object" ? ... : String(p)`). task_pack's own
   * shape-map had not mirrored that, so a real agent's `mode="task_pack"` +
   * bare-string paths[] call hard-errored ("invalid paths[] entry: missing
   * path") on exactly the shape mode="full" already accepts.
   */
  paths?: Array<TaskPackPathEntry | string>;
}

/**
 * FIX-B3: the canonical, always-object shape of a paths[] entry. Module-level
 * (not nested in TaskPackArgs) so it can be reused as the element type of
 * every internal, already-normalized local (buildSeededTaskPack's `entries`/
 * `toRead`/`SeedInfo.entry`) without re-deriving it from the wider
 * `TaskPackArgs["paths"]` union each time.
 */
export type TaskPackPathEntry = { path: string; range?: string; symbol?: string; purpose?: string };
