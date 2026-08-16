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
          // A.9.2 snake_case, renamed 2026-08-14: the refusal allowlist's own
          // "Why each rides" entry names `current_sha` as the hash-mismatch
          // carrier, `tools/applyEditsMulti.ts:812` already emits that
          // spelling, and this producer's camelCase copy was simply never
          // migrated — so the one hash a `precondition:"expected-hash"` retry
          // needs was dropped by the funnel while the allowlist said it rode.
          ...(currentShort ? { current_sha: currentShort, next: `retry with expectedSha=${currentShort}` } : {}),
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
          // A.9.2 snake_case, renamed 2026-08-14: the refusal allowlist's own
          // "Why each rides" entry names `current_sha` as the hash-mismatch
          // carrier, `tools/applyEditsMulti.ts:812` already emits that
          // spelling, and this producer's camelCase copy was simply never
          // migrated — so the one hash a `precondition:"expected-hash"` retry
          // needs was dropped by the funnel while the allowlist said it rode.
          ...(currentShort ? { current_sha: currentShort, next: `retry with expectedSha=${currentShort}` } : {}),
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // "scope-handle": the target path must be inside the scope handle's paths[].
  // -------------------------------------------------------------------------
  if (pre === "scope-handle") {
    const scopeId = String(args["scopeHandle"] ?? "");
    const entry = scopeId ? handleTable.get(scopeId) : undefined;
    if (!entry || entry.kind !== "scope") {
      // S1: name the offending param so a bare scope-violation is actionable —
      // the caller either forgot scopeHandle or passed a non-scope handle id.
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "scope-violation",
          next: scopeId
            ? `scopeHandle=${scopeId} is not a scope handle; pass a handle minted as kind=scope`
            : "precondition=scope-handle requires scopeHandle=<scope handle id>",
        },
      };
    }
    const paths = entry.paths ?? (entry.path ? [entry.path] : []);
    const inScope = paths.some(
      (p) => effectivePath === p || effectivePath.startsWith(p + "/"),
    );
    if (!inScope) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "out-of-scope",
          next: `${effectivePath} is outside scopeHandle=${scopeId}'s paths; edit a path within the scope or use a wider scope handle`,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // "unique-match": enforced at the call site for single-file exact edits
  // (see server.ts edit_file branch).  Nothing further to check here.
  // "references-reviewed": advisory flag for rename operations — no fail-closed.
  // -------------------------------------------------------------------------

  return { ok: true };
}
