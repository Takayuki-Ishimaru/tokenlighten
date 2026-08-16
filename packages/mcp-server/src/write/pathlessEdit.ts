/**
 * pathlessEdit.ts — workspace-scoped and symbol-scoped pathless edit_file.
 *
 * Implements DESIGN-v0.4-one-shot-read-write.md §"Write: Pathless edit_code"
 * (lines 157–229, 326–375).
 *
 * Algorithm:
 *   pathlessExactEdit   — scan all code files for the literal search string;
 *                         apply iff total occurrences == 1 across the scope.
 *   pathlessSymbolEdit  — find candidate symbol declarations via searchSymbols;
 *                         restrict to symbol line range; apply iff exactly one
 *                         range contains exactly one match.
 *
 * Safety chain: delegates to searchReplaceEdit (single-file edit) which already
 * enforces allowWrite / secret / symlink / size-cap / atomic-write guards.
 * Additional pathless-only rules:
 *   - Symbol-scoped candidates are filtered through the shared walk-ignore
 *     rules (DEFAULT_IGNORE + workspace .tokenlightenignore) so exclusions
 *     stay configurable rather than hard-coded repo conventions.
 *   - Counts occurrences with literal indexOf (not regex), deterministic.
 *   - Candidates array is capped at 3 (spec §350–375, ambiguous ≤ 768 B).
 *
 * Output shapes (compact):
 *   success:  { ok: true,  path, lines, delta }
 *   not-found:{ ok: false, code: "not-found",  error }
 *   ambiguous:{ ok: false, code: "ambiguous",  error, candidates: [{path, line}]? }
 *   error:    { ok: false, code: <existing>,   error }
 */

import * as fs from "fs";
import * as path from "path";
import { walkCodeFiles, isWalkIgnoredPath } from "../tools/walkRepo.js";
import { searchSymbols } from "../tools/searchSymbols.js";
import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { nestedWorkspaceCrossing } from "./workspaceBoundary.js";
import type { GuardedWorkspaceRoot } from "./guardedWorkspace.js";
import type { LangKey } from "../tools/walkRepo.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max candidates returned in ambiguous response (spec §152). */
const MAX_CANDIDATES = 3;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PathlessEditResult =
  | { ok: true; path: string; lines: string; delta: string }
  | {
      ok: false;
      code: string;
      error: string;
      candidates?: Array<{ path: string; line: number }>;
      /**
       * workspace-boundary disclosure (2026-08-13 hardening, CWE-863). Present
       * only when code === "invalid-input" and reason === "workspace-boundary"
       * — see pathlessWorkspaceBoundaryRefusal below. Mirrors the field set
       * server.ts's dispatch-level workspaceRoutingRefusal returns for a
       * NAMED crossing, so a caller that already knows how to read that
       * refusal reads this one identically.
       */
      reason?: "workspace-boundary";
      applied?: false;
      terminal?: false;
      workspace?: string;
      nested_workspace?: string;
      paths?: string[];
      detail?: string;
      next?: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize to LF + NFC for matching (same as textEdit.ts). */
function toLfNfc(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
}

/** Count non-overlapping occurrences of needle in haystack (literal indexOf). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = toLfNfc(haystack);
  const n = toLfNfc(needle);
  let count = 0;
  let idx = h.indexOf(n);
  while (idx !== -1) {
    count++;
    idx = h.indexOf(n, idx + n.length);
  }
  return count;
}

/** Return the 1-based line number of the first occurrence of needle in text. */
function firstOccurrenceLine(text: string, needle: string): number {
  const h = toLfNfc(text);
  const n = toLfNfc(needle);
  const idx = h.indexOf(n);
  if (idx === -1) return 1;
  return h.slice(0, idx).split("\n").length;
}

// ---------------------------------------------------------------------------
// Workspace-boundary post-check (2026-08-13 hardening, CWE-863)
// ---------------------------------------------------------------------------

/**
 * A pathless edit's write target is DISCOVERED by scanning the workspace, not
 * NAMED by the caller — so the dispatch-level workspace-boundary refusal
 * (server.ts's workspaceRoutingRefusal, which inspects only writeTargetPaths
 * derived from the call's own arguments) never sees it: a pathless call names
 * no `path`, so that inspection always finds zero crossings and the guard
 * returns null before dispatch ever reaches pathlessExactEdit/
 * pathlessSymbolEdit. The single unique candidate resolved below can still
 * land inside a nested linked worktree — a different workspace on its own
 * branch (see write/workspaceBoundary.ts) — and without this check that
 * write would land there silently (the 2026-08-09 incident class).
 * tools/renameSymbol.ts:150-156 documents the identical reasoning for its own
 * discovered targets ("the dispatch-level workspace-boundary refusal ... cannot
 * see them"); this mirrors that post-selection pattern here, run against the
 * ONE candidate a pathless edit ever resolves to, before any write happens.
 *
 * Returns the established `workspace-boundary` refusal shape (the same field
 * set server.ts's workspaceRoutingRefusal returns for a NAMED crossing) when
 * `relPath` resolves into a nested workspace, else null.
 */
function pathlessWorkspaceBoundaryRefusal(
  relPath: string,
  workspace: GuardedWorkspaceRoot,
): PathlessEditResult | null {
  const resolvedWorkspace = path.resolve(workspace);
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  const absTarget = path.resolve(workspace, relPath);
  const foreign = nestedWorkspaceCrossing(absTarget, workspaceReal);
  if (foreign === undefined) return null;

  const detail = `the target lives in ${path.basename(foreign)}, a linked worktree nested inside ${path.basename(resolvedWorkspace)} — a different workspace on its own branch, not a subdirectory of this one`;
  return {
    ok: false,
    code: "invalid-input",
    error: detail,
    reason: "workspace-boundary",
    applied: false,
    terminal: false,
    workspace: resolvedWorkspace,
    nested_workspace: foreign,
    paths: [relPath],
    detail,
    next: `re-issue with cwd=${foreign} and a path relative to it`,
  };
}

// ---------------------------------------------------------------------------
// Workspace-scoped exact edit
// ---------------------------------------------------------------------------

export interface PathlessExactEditInput {
  search: string;
  replace: string;
  lang?: LangKey;
  /** Optional workspace-relative subdirectory/file to scope the scan. */
  path?: string;
}

/**
 * Apply search/replace edit when the search string appears exactly once
 * across all non-excluded code files in the workspace (or scoped subpath).
 */
export async function pathlessExactEdit(
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  _sessionId: string,
  input: PathlessExactEditInput,
): Promise<PathlessEditResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }

  if (!input.search) {
    return { ok: false, error: "search is required for pathless edit", code: "invalid-input" };
  }

  // Walk code files (honours shared ignore rules).
  const files = walkCodeFiles(workspace, {
    lang: input.lang,
    subPath: input.path,
  });

  // Collect matches: literal indexOf per file.
  type Match = { relPath: string; line: number; count: number };
  const matches: Match[] = [];

  for (const f of files) {
    // No exclusion check here: walkCodeFiles already applied the shared
    // walk-ignore rules (DEFAULT_IGNORE + workspace .tokenlightenignore), so
    // every f in `files` has already passed them.
    let text: string;
    try {
      text = fs.readFileSync(f.absPath, "utf8");
    } catch {
      continue;
    }

    const count = countOccurrences(text, input.search);
    if (count === 0) continue;

    const line = firstOccurrenceLine(text, input.search);
    matches.push({ relPath: f.relPath, line, count });
  }

  const totalOccurrences = matches.reduce((s, m) => s + m.count, 0);

  if (totalOccurrences === 0) {
    return { ok: false, code: "not-found", error: "search string not found in any code file" };
  }

  if (totalOccurrences > 1 || matches.length > 1) {
    // Flatten per-file matches to individual candidate locations.
    const candidates: Array<{ path: string; line: number }> = [];
    for (const m of matches) {
      if (candidates.length >= MAX_CANDIDATES) break;
      candidates.push({ path: m.relPath, line: m.line });
    }
    return {
      ok: false,
      code: "ambiguous",
      error: "search string matches multiple locations",
      candidates,
    };
  }

  // Exactly one match in one file.
  const target = matches[0]!;

  // Post-selection workspace-boundary check — see pathlessWorkspaceBoundaryRefusal.
  const boundaryRefusal = pathlessWorkspaceBoundaryRefusal(target.relPath, workspace);
  if (boundaryRefusal !== null) return boundaryRefusal;

  // Delegate to the full safety-chain edit (allowWrite check redundant but harmless).
  const result = await searchReplaceEdit(
    { path: target.relPath, search: input.search, replace: input.replace },
    workspace,
    allowWrite,
  );

  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }

  return { ok: true, path: result.path, lines: result.lines, delta: result.delta };
}

// ---------------------------------------------------------------------------
// Symbol-scoped exact edit
// ---------------------------------------------------------------------------

export interface PathlessSymbolEditInput {
  symbol: string;
  search: string;
  replace: string;
  lang?: LangKey;
}

/**
 * Find all declarations of `symbol` in the workspace; for each candidate,
 * check whether `search` appears exactly once within the symbol's line range.
 * Apply iff exactly one symbol range contains exactly one match.
 */
export async function pathlessSymbolEdit(
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  _sessionId: string,
  input: PathlessSymbolEditInput,
): Promise<PathlessEditResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }

  if (!input.symbol) {
    return { ok: false, error: "symbol is required for symbol-scoped pathless edit", code: "invalid-input" };
  }
  if (!input.search) {
    return { ok: false, error: "search is required for pathless edit", code: "invalid-input" };
  }

  // 1. Find all candidate symbol declarations.
  let symbolResult: Awaited<ReturnType<typeof searchSymbols>>;
  try {
    symbolResult = await searchSymbols(
      { query: input.symbol, lang: input.lang, limit: 50 },
      workspace,
    );
  } catch (err) {
    return {
      ok: false,
      error: `Symbol index error: ${(err as Error).message}`,
      code: "index-error",
    };
  }

  // Filter to exact name match (searchSymbols may return fuzzy results).
  const exactCandidates = symbolResult.locations.filter(
    (loc) => loc.symbol === input.symbol,
  );

  if (exactCandidates.length === 0) {
    return { ok: false, code: "not-found", error: `symbol '${input.symbol}' not found` };
  }

  // 2. For each candidate, read the file and check if search appears exactly
  //    once within the symbol's line range.
  type Hit = { relPath: string; line: number };
  const hits: Hit[] = [];

  for (const candidate of exactCandidates) {
    const relPath = candidate.path;
    // searchSymbols locations are not walkCodeFiles-sourced, so apply the
    // shared walk-ignore rules here explicitly.
    if (isWalkIgnoredPath(workspace, relPath)) continue;

    const absPath = path.resolve(workspace, relPath);
    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    // Determine the symbol's line range using findEndLine logic.
    const { startLine, endLine } = getSymbolRange(text, candidate.line, relPath);

    // Extract the symbol body text (lines startLine..endLine, 1-based inclusive).
    const bodyText = extractLines(text, startLine, endLine);

    const count = countOccurrences(bodyText, input.search);
    if (count === 0) continue;

    // Record a hit for each occurrence in this symbol range.
    if (count === 1) {
      const bodyLine = firstOccurrenceLine(bodyText, input.search);
      hits.push({ relPath, line: startLine + bodyLine - 1 });
    } else {
      // Multiple matches within one symbol range — count each as a candidate.
      const normalizedNeedle = toLfNfc(input.search);
      let searchFrom = 0;
      for (let i = 0; i < count && hits.length < MAX_CANDIDATES; i++) {
        const normalizedBody = toLfNfc(bodyText);
        const idx = normalizedBody.indexOf(normalizedNeedle, searchFrom);
        if (idx === -1) break;
        const lineNum = startLine + normalizedBody.slice(0, idx).split("\n").length - 1;
        hits.push({ relPath, line: lineNum });
        searchFrom = idx + normalizedNeedle.length;
      }
    }
  }

  if (hits.length === 0) {
    return {
      ok: false,
      code: "not-found",
      error: `search string not found within any '${input.symbol}' symbol range`,
    };
  }

  if (hits.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      error: "search string matches multiple symbol ranges",
      candidates: hits.slice(0, MAX_CANDIDATES).map((h) => ({ path: h.relPath, line: h.line })),
    };
  }

  // Exactly one hit — apply the edit.
  const target = hits[0]!;

  // Post-selection workspace-boundary check — see pathlessWorkspaceBoundaryRefusal.
  const boundaryRefusal = pathlessWorkspaceBoundaryRefusal(target.relPath, workspace);
  if (boundaryRefusal !== null) return boundaryRefusal;

  const result = await searchReplaceEdit(
    { path: target.relPath, search: input.search, replace: input.replace },
    workspace,
    allowWrite,
  );

  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }

  return { ok: true, path: result.path, lines: result.lines, delta: result.delta };
}

// ---------------------------------------------------------------------------
// Internal: symbol range helpers (reuse brace logic from getSymbolWithContext)
// ---------------------------------------------------------------------------

/** Extract lines startLine..endLine from text (1-based, inclusive). */
function extractLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Given a file's text and the symbol's declaration line (1-based),
 * return the start/end line range for the symbol body.
 * Uses the same brace-depth algorithm as getSymbolWithContext.ts:findEndLine.
 */
function getSymbolRange(
  text: string,
  declarationLine: number,
  relPath: string,
): { startLine: number; endLine: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const ext = path.extname(relPath).toLowerCase();
  const isPython = ext === ".py" || ext === ".pyi";
  const isRuby = ext === ".rb";

  const startLine = declarationLine;

  if (isPython) {
    const defLine = lines[startLine - 1] ?? "";
    const defIndent = (defLine.match(/^(\s*)/) ?? ["", ""])[1]!.length;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() === "") continue;
      const curIndent = (l.match(/^(\s*)/) ?? ["", ""])[1]!.length;
      if (curIndent <= defIndent) return { startLine, endLine: i };
    }
    return { startLine, endLine: lines.length };
  }

  if (isRuby) {
    let depth = 1;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!.trim();
      // Line-initial anchoring is correct for def/class/module/begin (always
      // statement-initial) and is the SAFE choice for if/unless/while/until/
      // for too (those keywords also appear as trailing one-line statement
      // modifiers — "return nil if x.nil?" — which must NOT increment depth,
      // and this anchor already excludes that case). `do`, though, is
      // virtually always attached to the END of a method-call expression
      // (`items.each do |item|`), almost never line-initial, so anchoring it
      // the same way missed the common case entirely and under-counted
      // depth — the scanner then closed the range at the block's OWN `end`
      // instead of the enclosing def's. Detect a trailing `do` block opener
      // (with or without `|params|`) as an additional, independent signal;
      // `\sdo` (not `\bdo`) requires an actual preceding space so this never
      // matches inside an identifier like "redo" or "undo".
      if (
        /^(def|class|module|do|begin|if|unless|case|while|until|for)\b/.test(l) ||
        /\sdo(\s*\|[^|]*\|)?\s*$/.test(l)
      ) depth++;
      if (l === "end" || l.startsWith("end ") || l.startsWith("end#")) depth--;
      if (depth === 0) return { startLine, endLine: i + 1 };
    }
    return { startLine, endLine: lines.length };
  }

  // Brace-based (JS/TS/Go/Rust/Java/C/C#/etc.)
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const l = lines[i]!;
    for (let c = 0; c < l.length; c++) {
      const ch = l[c]!;
      if (ch === "{") { depth++; started = true; }
      if (ch === "}" ) {
        depth--;
        if (started && depth === 0) return { startLine, endLine: i + 1 };
      }
    }
  }
  return { startLine, endLine: lines.length };
}
