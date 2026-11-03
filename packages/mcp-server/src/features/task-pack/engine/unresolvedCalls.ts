// unresolvedCalls — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { ENUMERATED_ITEM_OBLIGATION_PREFIX } from "./changeAndReadinessEvidence2.js";
import { NEXT_CALL_SEARCH_ACTIONS } from "./epochEvidence2.js";
import { consultExecutedSearch } from "../../../util/packServeLog.js";
import { enumeratedItemFacetFromId } from "./changeAndReadinessEvidence2.js";
import { readLeadSpanWords } from "./epochEvidence2.js";
import { repairedNextCallTerms } from "./epochEvidence2.js";

/**
 * Validate and deterministically repair a discovery continuation before it is
 * exposed. This mirrors the advertised dispatcher shape closely enough to
 * reject calls that are guaranteed to fail without performing repo I/O.
 */
export function admitReadOnlyNextCall(call: ContinuationCall, originalQuery: string): ContinuationCall | undefined {
  if (call.tool === "tl_edit_file") return undefined;
  const args = { ...call.arguments };

  if (call.tool === "tl_read_file") {
    const hasBoundedTarget =
      (typeof args["handle"] === "string" && args["handle"].length > 0)
      || (Array.isArray(args["handles"]) && args["handles"].length > 0)
      || (typeof args["path"] === "string" && args["path"].length > 0)
      || (Array.isArray(args["paths"]) && args["paths"].length > 0)
      // TL142-01A: `targets` was missing from this list while being a shape
      // this very file's own producers already emit (`nextCallForUnresolved`'s
      // wiring-source branch: `{targets:[{path,symbol}]}`). Those reach the
      // wire directly, so the omission was invisible until an ALTERNATIVE-AXIS
      // candidate used the same carrier — Rule 1b's read of what an executed
      // search located — and this admission gate silently rejected the single
      // most specific call the pack could make, falling back to a re-read of an
      // already-served window.
      || (Array.isArray(args["targets"]) && args["targets"].length > 0)
      || (typeof args["symbol"] === "string" && args["symbol"].length > 0);
    if (hasBoundedTarget) return { ...call, arguments: args };
    const readQuery = typeof args["query"] === "string" ? args["query"] : "";
    return repairedNextCallTerms(readQuery).length > 0
      ? { ...call, arguments: args }
      : undefined;
  }

  const action = typeof args["action"] === "string" ? args["action"] : "";
  if (!NEXT_CALL_SEARCH_ACTIONS.has(action)) return undefined;
  if (action === "tree" || action === "diff") return { ...call, arguments: args };
  if (action === "locate") {
    // `locate` is the semantic action: nextCallForUnresolved hands it the FULL
    // query (with includeClosure) deliberately, because the locator ranks over
    // the whole request rather than one token. Collapsing it to terms[0] threw
    // that intent away — and on a CJK query it also picked a function word.
    // Keep the producer's query; only reject an empty one.
    const locateQuery = typeof args["query"] === "string" ? args["query"].trim() : "";
    return locateQuery.length > 0 ? { ...call, arguments: args } : undefined;
  }
  if (action === "references") {
    // A reference lookup is symbol-sensitive: splitting camelCase would turn
    // telemetrySender into a broader, semantically different telemetry query.
    const reference = typeof args["query"] === "string"
      ? args["query"].trim()
      : typeof args["symbol"] === "string"
        ? args["symbol"].trim()
        : "";
    return reference.length > 0 ? { ...call, arguments: args } : undefined;
  }
  if (action === "symbols") {
    // C2 (DESIGN-v0.15 §12 rows 82-84 wave B follow-up, 2026-09-05): the SAME
    // symbol-sensitive class of bug the `references` branch above already
    // guards against — splitting camelCase turns a resolved exact identifier
    // into a broader, different query. Live: `nextCallForUnresolved`'s
    // identifier-obligation branch built the exactly-correct
    // `{action:"symbols", query:"renderInvoice"}` (the caller-named,
    // uncovered `identifier:renderInvoice` obligation, verbatim), but the
    // generic tail below — reachable because `action !== "find"` skips its
    // OWN single-token exemption — reduced it to `repairedNextCallTerms`'
    // first tokenized/lower-cased/camelCase-split word ("render"), a stem
    // fragment that is not the gap's identifier and whose `search.matches`
    // reply has no continuation. `symbols` takes exactly ONE exact name
    // (never a `queries[]` array), so there is nothing here for tokenizing
    // into terms to usefully repair; keep the producer's query (or `symbol`)
    // verbatim, falling back to the whole original query only when the
    // candidate carried neither.
    const symbolQuery = typeof args["query"] === "string" && args["query"].trim() !== ""
      ? args["query"].trim()
      : typeof args["symbol"] === "string" && args["symbol"].trim() !== ""
        ? args["symbol"].trim()
        : originalQuery.trim();
    if (symbolQuery === "") return undefined;
    args["query"] = symbolQuery;
    return { ...call, arguments: args };
  }

  const suppliedQueries = Array.isArray(args["queries"])
    ? args["queries"].filter((item): item is string => typeof item === "string")
    : [];
  const seed = suppliedQueries.length > 0
    ? suppliedQueries.join(" ")
    : typeof args["query"] === "string"
      ? args["query"]
      : originalQuery;
  // R-B3 (2026-09-21, orchestrator ruling 6): a word of the request's own
  // generalised READ LEAD ("Walk me through", "Trace", "I want to
  // understand") is no search term — the same treatment `NEXT_CALL_GENERIC_
  // QUERY_TERMS` has always given the two classic leads "explain"/"describe",
  // with the span identified by `headIsWhAfterReadLead`'s own rule instead of
  // a word list (`maskReadLeadSpan`). Confirmed live: a pack that served
  // nothing prescribed `find "walk"` from "Walk me through how …". Dropping
  // the candidate leaves the chain's next producer, or an honest
  // `await_input`, exactly as a rejected "explain" always has.
  const leadWords = readLeadSpanWords(originalQuery);
  const terms = repairedNextCallTerms(seed).filter((term) => !leadWords.has(term.toLowerCase()));
  if (terms.length === 0) return undefined;

  delete args["queries"];
  // 2026-08-21 (W7 integration fix): a single ASCII-identifier-shaped seed —
  // no caller-supplied queries[] array, and the raw text is ONE bare
  // camelCase/snake_case/PascalCase token (e.g. "lunarBeacon") — must stay
  // ONE find query. repairedNextCallTerms splits on camelCase/script
  // boundaries for EPOCH-comparison purposes and would otherwise decompose
  // it into independent lowercase words ("lunar", "beacon"), discarding the
  // compound identifier the caller actually named in favor of two generic
  // words — worse recall, not better (see the `references` branch above,
  // which already protects the identical shape for the same reason:
  // "splitting camelCase would turn telemetrySender into a broader,
  // semantically different telemetry query"). Deliberately an ASCII
  // identifier-grammar test, not a bare "no whitespace" test: Japanese (and
  // other CJK) prose carries no space between words at all — a whitespace-
  // free JA sentence like "認証フローを確認してください" is many words, not
  // one identifier, and readinessSemantics.spec.ts pins its script-boundary
  // decomposition into queries:["認証","フロー","確認"] as intended recall
  // behavior, unaffected here. A genuinely multi-word original seed
  // ("payment gateway retry") is likewise unaffected and still becomes
  // queries[] below.
  const seedIsSingleToken = action === "find"
    && suppliedQueries.length === 0
    && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seed.trim());
  if (seedIsSingleToken) {
    args["query"] = seed.trim();
  } else if (action === "find" && terms.length > 1) {
    delete args["query"];
    args["queries"] = terms;
  } else {
    args["query"] = terms[0];
  }
  return { ...call, arguments: args };
}

/**
 * F-V13-6, THE TERMINATION RULE FOR ENUMERATED ITEMS.
 *
 * A stricter obligation must not buy itself an escape hatch: the only thing
 * this adds is ONE bounded `find` per item, and only while that find is still
 * unspent. Once the session has run it — whatever it returned — the item is
 * NOT promoted to proved (a search result the pack never served is not served
 * evidence) and it is NOT proposed again. The obligation then simply stays
 * uncovered and travels as an honest disclosure, which is the convergent state
 * for a requirement the repository cannot satisfy.
 *
 * `workspace` is optional so the readiness specs' synthetic, workspace-free
 * contracts keep their existing call shape; without it the first unproved item
 * is proposed exactly once per pack, as any other proof next would be.
 */
export function enumeratedItemFindCall(
  obligations: readonly TaskReadinessObligation[],
  workspace: string | undefined,
): ContinuationCall | undefined {
  for (const obligation of obligations) {
    if (obligation.status === "proved") continue;
    if (!obligation.id.startsWith(ENUMERATED_ITEM_OBLIGATION_PREFIX)) continue;
    const facet = enumeratedItemFacetFromId(obligation.id);
    if (facet === undefined) continue;
    if (workspace !== undefined && consultExecutedSearch(workspace, "find", facet) !== undefined) continue;
    return { tool: "tl_search_files", arguments: { action: "find", query: facet } };
  }
  return undefined;
}

/** FIX-G G3: literal matches examined when recovering an undeclared identifier. */
export const MAX_UNDECLARED_IDENTIFIER_MATCHES = 200;

/** FIX-G G3: one literal scan per (pack, identifier) — the contract builder runs several times per pack build. `null` = scanned, nothing qualifies. */
export const undeclaredIdentifierReadMemo = new WeakMap<TaskPackResult, Map<string, ContinuationCall | null>>();
