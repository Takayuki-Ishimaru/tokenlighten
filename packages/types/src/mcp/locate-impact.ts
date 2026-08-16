import type { McpLang } from "./languages.js";

// ---------------------------------------------------------------------------
// explore action=locate
// ---------------------------------------------------------------------------

export interface LocateInput {
  action: "locate";
  query: string;
  /** Optional exact or likely symbol name to narrow the search. */
  symbol?: string;
  /** Optional file or directory scope (workspace-relative). */
  path?: string;
  /** Optional language filter. */
  lang?: McpLang;
  /** Maximum number of candidates to generate (default 3, cap 10). */
  limit?: number;
  /** Cap on the returned snippet in tokens (default 800). */
  maxTokens?: number;
}

/** Returned when exactly one confident location was identified. */
export interface LocateHitData {
  hit: true;
  primary: ImpactCandidate[];
  related: ImpactCandidate[];
  confidence: number;
  completeness: "complete" | "partial" | "unknown";
  /** NEW (v0.6): covered surface roles, sorted alpha. Present when handles are issued. */
  coverage?: ImpactSurface[];
  /**
   * NEW (v0.8): the required surface role(s) the locator determined are
   * missing on a `completeness:"partial"` result (populated only when the
   * locate flow's own required-surface coverage found exactly one missing
   * role). Lets a downstream pack say WHICH role is absent
   * ("missing-roles") instead of a bare "partial", and drive a
   * `surfaceRoles=[...]` re-locate. Omitted when nothing role-specific is
   * missing (e.g. a same-name multi-file recall upgrade, where the gap is
   * confirmation, not a role).
   */
  missingSurfaces?: ImpactSurface[];
  /**
   * NEW (v0.8, general root model): a re-scope suggestion (workspace-relative
   * directory — a project root or a subproject subtree) emitted when the
   * query's strong identifier tokens matched ONLY out-of-root candidates, i.e.
   * the caller is very likely scoped to the wrong subtree (the classic
   * parent-cwd failure). A downstream pack surfaces it in route/next so the
   * agent re-scopes (cwd or paths) instead of editing the out-of-root junk.
   * Omitted whenever an in-root answer exists or the caller already scoped the
   * call via `path`.
   */
  rootSuggestion?: string;
}

/** Detail entry for a single ambiguous candidate, including a pre-minted handle. */
export interface LocateCandidateDetail {
  path: string;
  line: number;
  endLine?: number;
  symbol?: string;
  surface: ImpactSurface;
  range: string;
  why: string;
  confidence: number;
  handle: string;
}

/** Returned when the location is ambiguous or cannot be determined. */
export interface LocateAbstainData {
  hit: false;
  reason:
    | "ambiguous"
    | "not-found"
    | "snippet-too-large"
    | "ignored-path"
    | "broad-query"
    | "multi-surface"
    | "missing-surface"; // NEW (v0.6)
  /** Up to 3 candidate locations (omitted on not-found / broad-query). */
  candidates?: Array<{ path: string; line: number; handle?: string }>;
  /** NEW (v0.7): richer per-candidate detail for ambiguous/multi-surface/missing-surface abstains. */
  candidateDetails?: LocateCandidateDetail[];
  /** NEW (v0.6): surfaces missing for "missing-surface" reason. */
  missing?: ImpactSurface[];
  /** One-call recovery using the pre-minted handles on the top candidates. */
  next?: string;
  /**
   * NEW (2026-08-01, not-found dead end): the workspace root that was actually
   * searched, plus a one-line re-scope hint. Emitted ONLY on a candidate-less
   * not-found, where a bare `{hit,reason}` told the caller neither where the
   * search looked nor what to try next. `scope` is the searched root itself —
   * never a path outside it.
   */
  scope?: string;
  note?: string;
  /**
   * NEW (v0.8, general root model): re-scope suggestion (see
   * LocateHitData.rootSuggestion) — also surfaced on an abstain when the only
   * evidence found was out-of-root, so even a not-found/ambiguous result can
   * tell the pack layer WHERE the task actually lives.
   */
  rootSuggestion?: string;
}

export type LocateOutput = LocateHitData | LocateAbstainData;

// ---------------------------------------------------------------------------
// Impact surfaces (used by locate + edit_code review)
// ---------------------------------------------------------------------------

/**
 * protocol v1 (A.9.1, `locate-impact.ts` row): UNCHANGED, and referenced by
 * `search.matches` (the `locate` form) and `read.map` (the `surfaces` form).
 * A.2.7 aliases this union as `SurfaceRole` — the vocabulary `Evidence.role`
 * carries ([R4-2]). Ten values, kebab-free by construction.
 */
export type ImpactSurface =
  | "contract"
  | "api"
  | "domain"  // NEW (v0.6)
  | "data"
  | "ui"
  | "style"
  | "test"
  | "config"
  | "doc"     // NEW (v0.6)
  | "unknown";

export interface ImpactCandidate {
  path: string;
  line: number;
  range?: string;
  /** NEW (2026-07-30): `range` came verbatim from the caller — a hard zoom window; consumers must not widen it back to an enclosing symbol/section. */
  callerRange?: boolean;
  symbol?: string;
  surface: ImpactSurface;
  why: string;
  confidence: number;
  required?: boolean;
  /** NEW (v0.6): session-local handle id. */
  handle?: string;
  /** NEW (v0.6): optional content fingerprint ("sha256:<hex>"). */
  sha?: string;
}

// ---------------------------------------------------------------------------
// Generic discriminated-union result wrapper
// ---------------------------------------------------------------------------

/**
 * Thin discriminated-union wrapper for MCP tool responses.
 * On success `ok` is true and `data` carries the typed payload.
 * On failure `ok` is false, `error` is a human-readable message, and
 * `code` is a machine-readable error code (e.g. "stale-content",
 * "not-found", "pdf-encrypted", "pdf-no-text-layer", "pdf-parse-failed").
 */
export type McpToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };
