// anchorFlag.ts — the rollback switch of the anchor-first first hop
// (2026-10-29; anchorFirst.ts, requestAnchors.ts). DEFAULT ON; `TL_ANCHOR_FIRST=0`
// makes every anchor the request names invisible to the pack builder, the
// locator and the facet planner at once (they all read anchors through here),
// which restores the pre-change first hop exactly.
import { extractRequestAnchors, type RequestAnchors } from "./requestAnchors.js";

const NO_ANCHORS: RequestAnchors = { chains: [], literals: [], identifiers: [] };

export function anchorFirstEnabled(): boolean {
  return process.env["TL_ANCHOR_FIRST"] !== "0";
}

/** `extractRequestAnchors(query)`, or no anchors at all when the rollback switch is set. */
export function anchorsIfEnabled(query: string): RequestAnchors {
  return anchorFirstEnabled() ? extractRequestAnchors(query) : NO_ANCHORS;
}

const FILE_PATH_MENTION_RE = /[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|cs|php|c|h|cc|cpp|hpp|swift|scala|sh|md|json|ya?ml|toml)\b/;

/**
 * The literals a request names AS ITS SUBJECT — text to find. A literal beside a
 * file path or a code identifier is, more often than not, the CONTENT the request
 * writes ("add the comment 「retry policy always wins」 above initializePaymentRetryPolicy
 * in paymentGateway.ts"): the path and the identifier locate, the literal does not.
 */
export function subjectLiteralsIfEnabled(query: string): string[] {
  const anchors = anchorsIfEnabled(query);
  if (anchors.literals.length === 0) return [];
  if (anchors.identifiers.length > 0 || FILE_PATH_MENTION_RE.test(query)) return [];
  return anchors.literals;
}
