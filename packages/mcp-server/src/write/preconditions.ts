/**
 * preconditions.ts — edit_file precondition enforcement for v0.6.
 *
 * Exported function: enforcePreconditions
 *
 * Checks are deterministic and pure (no side effects beyond reading a file).
 * No Date.now() / Math.random() / argless new Date() used here.
 * All paths are workspace-relative POSIX paths.
 */

import { handleTable, shaOfText, shortSha, SHORT_SHA_MIN_HEX } from "../util/handles.js";
import type { EditFailure } from "@tokenlighten/types";

/**
 * DESIGN-v0.8 C10.1: responses now emit a SHORT sha prefix (>=12 hex,
 * `util/handles.ts` shortSha) instead of the full 71-char `sha256:`+64-hex
 * digest, so a caller that copies `expectedSha` straight out of a prior
 * response is now passing a PREFIX, not the full string. Exact full-sha
 * equality (the pre-C10 behavior) still works unchanged; this adds prefix
 * matching as an additional acceptance path — never a stricter one.
 *
 * Accepts:
 *   - `want === have` (exact match, unchanged pre-C10 behavior), OR
 *   - `want` is a `sha256:`-prefixed hex string of at least SHORT_SHA_MIN_HEX
 *     (12) hex digits that is itself a prefix of `have`'s hex digits.
 * A `want` shorter than SHORT_SHA_MIN_HEX hex digits is rejected even if it
 * technically prefixes `have` — short prefixes below the floor are more
 * likely to collide and were never emitted by shortSha, so accepting them
 * would only widen the attack/typo surface without matching real caller
 * behavior.
 */
function shaMatches(want: string, have: string): boolean {
  if (want === have) return true;
  const wantMatch = /^sha256:([0-9a-f]+)$/.exec(want);
  const haveMatch = /^sha256:([0-9a-f]+)$/.exec(have);
  if (!wantMatch || !haveMatch) return false;
  const wantHex = wantMatch[1]!;
  const haveHex = haveMatch[1]!;
  if (wantHex.length < SHORT_SHA_MIN_HEX) return false;
  if (wantHex.length >= haveHex.length) return false; // not a proper prefix; exact case already handled above.
  return haveHex.startsWith(wantHex);
}

/**
 * Parse a 1-based inclusive "start-end" line range (the same convention
 * `HandleEntry.range` and the `edits[]`/top-level `range` argument both
 * already use elsewhere in this codebase). Returns null for anything that
 * does not cleanly parse as two positive integers with start<=end, rather
 * than throwing — a malformed range here must degrade to "span unknown",
 * never crash a precondition check.
 */
function parseInclusiveRange(spec: string): { start: number; end: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(spec.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
  return { start, end };
}

/** 1-based line number containing character offset `offset` of `text`. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * The inclusive 1-based line span covering every occurrence of `search` in
 * `content` — the min start line and max end line across all matches — or
 * null when `search` is empty or never occurs. Deliberately spans ALL
 * occurrences rather than just the first: a scope-handle check must not
 * pass by looking at only one match while a later one (e.g. under
 * `target:"all"`) lands outside the handle's range.
 */
function occurrenceLineSpan(content: string, search: string): { start: number; end: number } | null {
  if (search === "") return null;
  let minLine = Number.POSITIVE_INFINITY;
  let maxLine = Number.NEGATIVE_INFINITY;
  let found = false;
  let fromIndex = 0;
  while (fromIndex <= content.length) {
    const idx = content.indexOf(search, fromIndex);
    if (idx === -1) break;
    found = true;
    const startLine = lineOfOffset(content, idx);
    const endLine = lineOfOffset(content, idx + search.length);
    if (startLine < minLine) minLine = startLine;
    if (endLine > maxLine) maxLine = endLine;
    fromIndex = idx + Math.max(search.length, 1);
  }
  return found ? { start: minLine, end: maxLine } : null;
}

/**
 * Best-effort resolution of an edit's own target line span, most-precise
 * signal first, used only when the named scope handle is itself
 * range-restricted (a repo/file/directory/path-only scope handle never
 * needs this — path containment alone is the whole check). Returns null
 * when no signal determines a span (e.g. a whole-file `content` replace or
 * a `create`, or a `search` with zero occurrences) — the caller treats null
 * as "cannot vouch for this edit", never as "assume it's fine".
 *
 *   1. An explicit `range` argument (the `edits[]`/top-level anchor-edit
 *      field, `CANONICAL_EDIT_ITEM.range` — "a caller range takes
 *      precedence over the handle's own stored range", server.ts's own
 *      comment on that field).
 *   2. The PRIMARY `handle` this edit addresses its target through (not the
 *      scope handle) — its own stored `range`, when it has one (a
 *      range/symbol handle content-replace).
 *   3. The line span of every occurrence of `search` in the current file
 *      content, when `search` is a non-empty string.
 */
async function resolveEditTargetRange(
  args: Record<string, unknown>,
  effectivePath: string,
  workspace: string,
  readFileSafe: (rel: string, root?: string) => Promise<string | null>,
): Promise<{ start: number; end: number } | null> {
  const explicitRangeArg = typeof args["range"] === "string" ? args["range"] : undefined;
  if (explicitRangeArg !== undefined) {
    return parseInclusiveRange(explicitRangeArg);
  }
  const primaryHandleId = typeof args["handle"] === "string" ? args["handle"] : undefined;
  const primaryEntry = primaryHandleId ? handleTable.get(primaryHandleId) : undefined;
  if (primaryEntry?.range) {
    return parseInclusiveRange(primaryEntry.range);
  }
  const search = typeof args["search"] === "string" ? args["search"] : "";
  if (search !== "") {
    const content = await readFileSafe(effectivePath, workspace);
    if (content !== null) return occurrenceLineSpan(content, search);
  }
  return null;
}

/**
 * Enforce preconditions for an edit_file operation.
 *
 * @param args           - The raw args from the MCP call.
 * @param effectivePath  - The workspace-relative path that will be edited.
 * @param workspace      - The absolute workspace root.
 * @param readFileSafe   - Async helper to read a file; returns null when absent/outside workspace.
 *
 * @returns { ok: true } when all preconditions pass, or
 *          { ok: false, failure: EditFailure } when any precondition fails.
 */
export async function enforcePreconditions(
  args: Record<string, unknown>,
  effectivePath: string,
  workspace: string,
  readFileSafe: (rel: string, root?: string) => Promise<string | null>,
): Promise<{ ok: true } | { ok: false; failure: EditFailure }> {
  const pre = args["precondition"];

  // -------------------------------------------------------------------------
  // "expected-hash": the current file sha256 must match expectedSha before
  // the edit is applied.
  // -------------------------------------------------------------------------
  if (pre === "expected-hash") {
    const want = String(args["expectedSha"] ?? "");
    // S1: even the missing-param case reads the live content so it can hand
    // back the current sha + a concrete retry — a bare {reason:"hash-mismatch"}
    // gave the caller nothing to act on. currentSha is shortened (C10.1) — a
    // DISPLAY value the caller can round-trip straight back as expectedSha.
    const content = await readFileSafe(effectivePath, workspace);
    const have = content === null ? "" : shaOfText(content);
    const currentShort = have ? shortSha(have) : have;
    if (!want) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "hash-mismatch",
          // R29-FIX (2026-09-05, D1): a named `field` is the classification
          // signal attachSupply.ts's isGenuinelyBareRefusal actually checks --
          // without it this `reason`-only failure (no `code`) was misread as
          // genuinely bare and got the nuclear retry:"new-task" + full
          // task-pack-abandonment `remaining` prose forced onto it, even
          // though `detail` already names the one-field fix. Measured: 5x in
          // a single paid smoke (r9, SF05 control).
          field: "expectedSha",
          // A.9.2 snake_case, renamed 2026-08-14: the refusal allowlist's own
          // "Why each rides" entry names `current_sha` as the hash-mismatch
          // carrier, `tools/applyEditsMulti.ts:812` already emits that
          // spelling, and this producer's camelCase copy was simply never
          // migrated — so the one hash a `precondition:"expected-hash"` retry
          // needs was dropped by the funnel while the allowlist said it rode.
          ...(currentShort ? { current_sha: currentShort, detail: `retry with expectedSha=${currentShort}` } : {}),
        },
      };
    }
    // C10.1: prefix-tolerant — a caller may have copied a shortSha-truncated
    // sha out of a prior response. shaMatches also accepts an exact full-sha
    // match, so nothing that worked before regresses.
    if (!shaMatches(want, have)) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "hash-mismatch",
          field: "expectedSha",
          // A.9.2 snake_case, renamed 2026-08-14: the refusal allowlist's own
          // "Why each rides" entry names `current_sha` as the hash-mismatch
          // carrier, `tools/applyEditsMulti.ts:812` already emits that
          // spelling, and this producer's camelCase copy was simply never
          // migrated — so the one hash a `precondition:"expected-hash"` retry
          // needs was dropped by the funnel while the allowlist said it rode.
          ...(currentShort ? { current_sha: currentShort, detail: `retry with expectedSha=${currentShort}` } : {}),
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // "scope-handle" (INV-I-4 / FX-P2 fix): the target path — and, when the
  // named handle is itself range-restricted, the edit's own target line
  // span — must lie within the handle named by `scopeHandle`.
  //
  // Pre-fix this precondition required `entry.kind === "scope"`, but no
  // production code path ever mints a `kind:"scope"` handle (INV-I's
  // exhaustive grep over every `handleTable.upsert(...)` call site and every
  // literal `"scope"` outside tests/cache), so every real handle a caller
  // could pass hit this branch and refused unconditionally — the advertised
  // capability (`server.ts`'s `CANONICAL_EDIT_ITEM.precondition` enum) was
  // permanently dead. The fix: accept ANY handle kind this session holds —
  // file/range/symbol/text/reference-set/scope/directory/repo alike, exactly
  // the plain vocabulary `HandleEntry` already uses to describe what a
  // handle addresses (`path`/`paths`/`range`) — and check real containment
  // instead of a kind tag nothing produces. The request schema is unchanged:
  // `scopeHandle` still names one handle id.
  // -------------------------------------------------------------------------
  if (pre === "scope-handle") {
    const scopeId = String(args["scopeHandle"] ?? "");
    const entry = scopeId ? handleTable.get(scopeId) : undefined;
    // Unknown, never-minted, or minted for a different worktree: none of
    // these are a handle THIS session can point at, so the historical
    // "scope-violation" bucket (not "out-of-scope", which is reserved for a
    // real handle whose addressed span the edit falls outside) still
    // applies unchanged.
    if (!entry || entry.workspaceRoot !== workspace) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "scope-violation",
          detail: scopeId
            ? `scopeHandle=${scopeId} is unknown or was not minted for this workspace this session; re-read/re-search to mint a fresh handle over the intended scope`
            : "precondition=scope-handle requires scopeHandle=<a handle id this session already holds>",
        },
      };
    }
    const paths = entry.paths ?? (entry.path ? [entry.path] : []);
    // round-18A finding 5: a path-less handle degraded to "no restriction at
    // all", regardless of `kind` — the ONLY legitimate reason a handle names
    // no path is a whole-repo `kind:"repo"` mint (`readCodeOverview.ts`'s
    // `handleTable.upsert({kind:"repo", workspaceRoot, ...})` with no scope),
    // where "every path is in scope" is the handle's actual, documented
    // meaning. Any OTHER path-less handle (a hand-built `kind:"scope"` test
    // fixture, a malformed/rehydrated entry) is not a scope at all — a scope
    // must NAME a path — and treating it as unrestricted would make
    // `precondition:"scope-handle"` a no-op for exactly the entries the
    // caller most needs it to constrain. Refuse `scope-violation`, the same
    // bucket the unknown-handle branch above already uses for "this is not a
    // real, path-bearing scope".
    if (paths.length === 0 && entry.kind !== "repo") {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "scope-violation",
          detail: `scopeHandle=${scopeId} names no path (kind=${entry.kind}); a scope must name a path — `
            + "re-read/re-search to mint a path-bearing handle over the intended scope",
        },
      };
    }
    // A path-less `kind:"repo"` handle restricts nothing at the path level —
    // every path in the workspace is in scope, same as it always implicitly
    // was for a repo-wide handle.
    const inScope = paths.length === 0 || paths.some(
      (p) => effectivePath === p || effectivePath.startsWith(p + "/"),
    );
    if (!inScope) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "out-of-scope",
          detail: `${effectivePath} is outside scopeHandle=${scopeId}'s paths; edit a path within the scope or use a wider scope handle`,
        },
      };
    }
    const scopeRange = typeof entry.range === "string" ? parseInclusiveRange(entry.range) : null;
    if (scopeRange) {
      const targetRange = await resolveEditTargetRange(args, effectivePath, workspace, readFileSafe);
      if (targetRange === null) {
        // The handle IS range-restricted, but this edit's own extent could
        // not be determined from an explicit `range`, the primary `handle`'s
        // own stored range, or a `search` occurrence — most commonly a
        // whole-file `content` replace or a `create`. A range-restricted
        // scope handle cannot vouch for an edit whose span it cannot see;
        // fail closed rather than silently letting it through.
        return {
          ok: false,
          failure: {
            ok: false,
            reason: "out-of-scope",
            detail: `scopeHandle=${scopeId} is restricted to ${effectivePath}:${entry.range}, and this edit's own target span could not be determined (no range, no range-bearing handle, and no search match) — pass an explicit range, address the edit through a range/symbol handle inside that span, or use a scope handle without a range restriction`,
          },
        };
      }
      if (targetRange.start < scopeRange.start || targetRange.end > scopeRange.end) {
        return {
          ok: false,
          failure: {
            ok: false,
            reason: "out-of-scope",
            detail: `edit target ${effectivePath}:${targetRange.start}-${targetRange.end} falls outside scopeHandle=${scopeId}'s range ${entry.range}; edit within that range or use a wider/unranged scope handle`,
          },
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // "unique-match": enforced at the call site for single-file exact edits
  // (see server.ts edit_file branch).  Nothing further to check here.
  // "references-reviewed": advisory flag for rename operations — no fail-closed.
  // -------------------------------------------------------------------------

  return { ok: true };
}
