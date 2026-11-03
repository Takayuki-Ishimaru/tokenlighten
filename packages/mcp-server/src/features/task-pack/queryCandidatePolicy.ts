import type { Candidate, LocateOutput, TaskDecision, TaskProfileBinding } from "@tokenlighten/types";
import type { TaskPackArgs, TaskPackResult } from "./model.js";
import { requestAnchorsOf } from "./anchorFirst.js";

/** A location proposal is not a claim that its implementation answers the task. */
export const QUERY_CANDIDATE_LIMIT = 6;
export const QUERY_CANDIDATE_BYTES = 2048;
export const QUERY_CANDIDATE_GUIDANCE = "Select a relevant candidate with a targeted tl_read_file path/range, or refine with tl_search_files. These locations are unverified candidates. Ask the user only when the intended target is genuinely ambiguous.";

export interface QueryCandidateAnchors {
  /** A file the caller named, resolved using the ordinary workspace path rules. */
  readonly namedFile: boolean;
  /** An actual recognized artifact, never merely the word 'docs'. */
  readonly artifact: boolean;
}

/** Syntax only: no natural-language behavior classifier or project vocabulary. */
export function hasQueryCodeAnchor(query: string): boolean {
  const source = query.replace(/https?:\/\/\S+/g, "");
  const names = source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return requestAnchorsOf(query).literals.length > 0
    || names.some(name => /^[a-z_$]/.test(name) && /[a-z0-9][A-Z]/.test(name)
    || /[A-Za-z0-9]_[A-Za-z0-9]|^_[A-Za-z]/.test(name))
    || /\b[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)+(?![\w$.])/.test(source)
    || /\b[A-Za-z_$][\w$]*\(/.test(source)
    || /`[A-Za-z_$][\w$]*`|\([A-Z][A-Za-z0-9_$]*\)/.test(source);
}

export function needsQueryCandidateSelection(args: TaskPackArgs, anchors: QueryCandidateAnchors): boolean {
  return (args.query?.trim().length ?? 0) > 0
    && !args.symbol
    && !anchors.namedFile
    && !anchors.artifact
    && !hasQueryCodeAnchor(args.query!);
}

/** Confirm only request-spelled identities in bounded locator metadata files.
 * A match admits the ordinary builder; it grants no readiness or source residency.
 */
export async function hasConfirmedQueryCandidateAnchor(
  located: LocateOutput,
  names: readonly string[],
  declarationsForPath: (path: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (names.length === 0) return false;
  const named = new Set(names);
  const rows = located.hit
    ? [...located.primary, ...located.related]
    : [...(located.candidateDetails ?? []), ...(located.candidates ?? [])];
  const paths = [...new Set(rows.map(row => row.path))].slice(0, QUERY_CANDIDATE_LIMIT);
  for (const path of paths) {
    if ((await declarationsForPath(path)).some(name => named.has(name))) return true;
  }
  return false;
}

/** Only metadata crosses this boundary. Never copy a locator object wholesale. */
export function boundedQueryCandidates(located: LocateOutput, lineCountForPath?: (path: string) => number | undefined): Candidate[] {
  const rows = located.hit
    ? [...located.primary, ...located.related]
    : [...(located.candidateDetails ?? []), ...(located.candidates ?? [])];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.path || !Number.isSafeInteger(row.line) || row.line < 1) continue;
    let range = "range" in row && typeof row.range === "string" && /^\d+-\d+$/.test(row.range)
      ? row.range : `${row.line}-${row.line}`;
    const [start, end] = range.split("-").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 1 || end! < start!) continue;
    if (lineCountForPath) {
      const total = lineCountForPath(row.path);
      if (total === undefined || row.line > total || start! > total) continue;
      range = `${start}-${Math.min(end!, total)}`;
    }
    const key = `${row.path}:${range}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate: Candidate = {
      path: row.path,
      line: row.line,
      range,
      ...("symbol" in row && typeof row.symbol === "string" ? { symbol: row.symbol } : {}),
      ...("surface" in row && typeof row.surface === "string" ? { kind: row.surface } : {}),
    };
    if (Buffer.byteLength(JSON.stringify([...candidates, candidate]), "utf8") > QUERY_CANDIDATE_BYTES) continue;
    candidates.push(candidate);
    if (candidates.length >= QUERY_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

export function buildQueryCandidatePack(
  located: LocateOutput,
  binding: TaskProfileBinding,
  lineCountForPath?: (path: string) => number | undefined,
  requirements?: { required: string[]; missing: string[] },
): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "partial",
    surfaces: [],
    missing: requirements?.missing ?? [],
    ...(requirements?.required.length ? { required_surfaces: requirements.required } : {}),
    profile_binding: binding,
    query_candidate_selection: { candidates: boundedQueryCandidates(located, lineCountForPath) },
    advisory: QUERY_CANDIDATE_GUIDANCE,
    execution_contract: {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: "request-user-input",
      max_additional_discovery_calls: 0,
      reason: QUERY_CANDIDATE_GUIDANCE,
      await_input_code: "name-intended-target",
      typestate: {
        phase: "awaiting-input",
        allowed_actions: ["read", "search", "request-user-input"],
        challenge_required_for: [],
      },
    },
  };
}

/** Internal marker survives the normal shallow result copies, with no session state. */
export function queryCandidateSelectionOf(result: unknown): TaskPackResult["query_candidate_selection"] {
  if (result === null || typeof result !== "object") return undefined;
  const value = (result as Partial<TaskPackResult>).query_candidate_selection;
  return value !== undefined && Array.isArray(value.candidates) ? value : undefined;
}

export function queryCandidateDecision(result: unknown): TaskDecision | undefined {
  const selection = queryCandidateSelectionOf(result);
  if (selection === undefined) return undefined;
  return {
    kind: "await_input",
    code: "name-intended-target",
    ...(selection.candidates.length ? { candidates: selection.candidates } : {}),
  };
}
