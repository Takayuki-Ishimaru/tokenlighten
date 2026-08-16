// relatedLookups.ts — server-side steering toward the ONE targeted call an
// identifier's definition or call sites already resolve in, attached at the
// exact decision point where action=find just confirmed the identifier is
// real (a literal, non-regex, >=1-file hit on the exact query token).
//
// Evidence (2026-08-04 signal5-1 run): across one session, solvers issued
// search_files action=find 27 times against only 3 action=symbols and 2
// action=references calls — definitions and call sites were repeatedly
// re-discovered by re-running find (or escaping to native grep) instead of
// the ONE action=symbols / action=references call that already resolves
// each. This module attaches that call, ready to run, as an OPTIONAL
// (non-required) `related_lookups` field. Unlike `next_call` elsewhere in
// this server — which means "the single required continuation" (see e.g.
// findReferences.ts's cursor pagination or an execution_contract's
// discovery phase) — nothing here is a mandatory next step, so it rides a
// differently-named field on purpose. The guide is deliberately NOT updated
// to teach this field: the response's own content is the only steering
// signal this feature measures (no residency/priming assist).
//
// Scope, deliberately narrow (see AGENTS.md's "no bench overfitting"):
//   - ONLY buildFindResponse()'s single-query Pass 1 exact-literal-hit path.
//     A response reaches that path if and only if `literal === true` with
//     no `matched_variant`/`matched_terms` set (see findText.ts's Pass
//     1 / Pass 1.5 / Pass 2 fallback ladder) — Pass 1.5 (naming-variant
//     fallback) and Pass 2 (tokenized AND/OR decomposition) both explicitly
//     set `literal: false`, so a single `literal !== true` check excludes
//     them without re-deriving their own signals. Both are excluded because
//     by the time either runs, the ORIGINAL query string is no longer what
//     matched — a definition/callers lookup for that exact string would not
//     be the precise, targeted call this feature promises.
//   - queries[] (buildFindResponseForQueries, the OR-batch of up to 5
//     literal tokens) is out of scope: "one identifier" does not describe a
//     batch, and the primary/documented single-identifier call shape is
//     `query=`, not `queries=[...]`.
//   - The zero-match absence certificate is categorically excluded (see the
//     `response.absence` guard below) — that contract already certifies the
//     token is verifiably NOT present anywhere scanned; suggesting a
//     further lookup there would invite exactly the re-search the
//     certificate forecloses.
//
// No per-item suppression heuristic (e.g. "the hit already looks like the
// definition line, so drop the `definition` entry"): deliberately not
// implemented. It would trade a small, harmless redundancy (running
// action=symbols when the definition was already visible) for the risk of
// silently withholding a needed lookup on a misjudged case — exactly the
// escape this feature exists to close. Keep both entries whenever the gate
// passes; do not get clever here.
//
// No path/lang propagation from the originating find call either: a
// definition or caller may legitimately live outside whatever
// subtree/language the find call happened to be scoped to, so narrowing the
// follow-up calls risks a false miss more than it saves bytes.
//
// Byte budget: computed and checked AFTER buildFindResponse's own
// MAX_RESPONSE_BYTES-fitting trial has already run, then dropped (never
// re-triggering that trial) if attaching it would cross the SAME cap —
// mirrors maybeAttachMemberSweepToFindResponse exactly, and for the same
// reason: this feature must never be why a diet response bursts its budget.

import { isIdentifierToken } from "./memberSweep.js";
import { MAX_RESPONSE_BYTES as FIND_MAX_RESPONSE_BYTES, MAX_INVENTORY_RESPONSE_BYTES } from "./findText.js";
import type { FindResponse } from "./findText.js";

/** One ready-to-run search_files call: pass `.arguments` to the tool named `.tool` verbatim (cwd/lane etc. deferred to caller context, same convention as findReferences.ts's own continuationNextCall). */
export interface RelatedLookupCall {
  tool: "search_files";
  arguments: { action: "symbols" | "references"; query: string };
}

/**
 * Companion lookups for the identifier `related_lookups` was attached to:
 * its own definition (search_files action=symbols) and its call sites
 * (search_files action=references) — both entries share the SAME query the
 * find call just confirmed a real hit for.
 */
export interface RelatedLookups {
  /** This identifier's own definition. */
  definition: RelatedLookupCall;
  /** This identifier's call sites. */
  callers: RelatedLookupCall;
}

function buildRelatedLookups(query: string): RelatedLookups {
  return {
    definition: { tool: "search_files", arguments: { action: "symbols", query } },
    callers: { tool: "search_files", arguments: { action: "references", query } },
  };
}

export interface FindRelatedLookupsOptions {
  /** The exact query buildFindResponse was called with. */
  query: string;
  isRegex: boolean;
}

/**
 * Attach `related_lookups` to an already-built, already-capped find
 * response — purely additive, and a strict no-op (returns the SAME object)
 * whenever any gate below is not met:
 *   - regex queries (a pattern is not "one identifier", even if it happens
 *     to spell one — mirrors maybeAttachMemberSweepToFindResponse's own
 *     `isRegex` gate);
 *   - a zero-match absence response;
 *   - a response with no matched files;
 *   - anything other than Pass 1's exact-literal hit (`literal !== true`);
 *   - a query that is not a single bare identifier token.
 * When every gate passes but attaching would push the response over its own
 * byte cap, the attachment is dropped (not re-fitted) rather than
 * re-triggering buildFindResponse's own fitting trial.
 */
export function maybeAttachRelatedLookups(response: FindResponse, opts: FindRelatedLookupsOptions): FindResponse {
  if (opts.isRegex) return response;
  if (response.absence) return response;
  if (!response.files || response.files.length === 0) return response;
  if (response.literal !== true) return response;
  if (!isIdentifierToken(opts.query)) return response;

  const withLookups: FindResponse = { ...response, related_lookups: buildRelatedLookups(opts.query) };
  const cap = response.inventory ? MAX_INVENTORY_RESPONSE_BYTES : FIND_MAX_RESPONSE_BYTES;
  return Buffer.byteLength(JSON.stringify(withLookups), "utf8") <= cap ? withLookups : response;
}
