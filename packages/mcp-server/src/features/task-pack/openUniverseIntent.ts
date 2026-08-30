/**
 * openUniverseIntent.ts — the canonical open-universe / additive-enum
 * quantifier classifiers.
 *
 * P1-e (2026-08-28 review-fix wave): this used to be two `function`
 * declarations inline in readCodeTaskPack.ts, which meant every OTHER site
 * that needed the same judgment (taskContractStore.ts's absence-consumption
 * path, notably) either duplicated the vocabulary inline or hand-rolled a
 * broader, uncanonical regex. Extracted to its own leaf module (zero
 * dependents besides util/flags.ts) so readCodeTaskPack.ts and
 * taskContractStore.ts reference the exact same predicate without a circular
 * import between them. readCodeTaskPack.ts re-exports both names so every
 * existing `from "../features/task-pack/readCodeTaskPack.js"` import keeps
 * working unchanged.
 */

import { proofCompletionEnabled } from "../../util/flags.js";

// Propagation-profile hints (notably `contract`) are broader than an
// exhaustive request. Only an actual quantifier may mint an open-universe
// obligation; otherwise an ordinary "explain this contract" task can never
// close despite having served the complete implementation.
const OPEN_UNIVERSE_INTENT_EN_RE = /\b(?:exhaustive|everywhere|(?:every|each)\s+(?:direct\s+callees?|direct\s+dependency\s+definitions?|definitions?\s+directly\s+called|callers?|references?|consumers?|definitions?)|all\s+(?:callers|references|consumers|definitions|direct\s+callees?))\b/i;

// Fixed compound literals: "全"/"列挙" bound directly to a noun, a distinct
// word-formation from the "すべての"/"を...すべて" general forms below.
const OPEN_UNIVERSE_INTENT_JA: readonly string[] = ["列挙", "全参照", "全呼び出し元"];

// P1-e(ii) (2026-08-28): the field-eval original "...定義をすべて特定してください"
// and the review's own "呼び出し元をすべて" both failed the pre-wave classifier —
// neither is one of the fixed compound literals above. Japanese expresses the
// same universal quantifier two general ways the pre-wave list did not cover:
//   - PREFIX form: すべての/全ての + noun ("すべての呼び出し元", "全ての参照")
//   - SUFFIX form: noun + を + すべて/全て ("定義をすべて特定", "呼び出し元をすべて")
const JA_QUANTIFIER_NOUN_RE = /(?:すべて|全て)の|を(?:すべて|全て)/gu;

// Half-width and full-width digits. A quantifier occurrence preceded closely
// by a digit is governed by an EXPLICIT BOUNDED COUNT ("3 症状すべての...",
// "3件をすべて...") — the digit already closes the universe to a named,
// finite set, so すべて there emphasizes completeness OVER that finite set
// rather than requesting an open-ended repository search. This is not merely
// the synthetic "3 症状すべてを修正する" unit case: the real aeroctl T05c
// multi-concern fixture's own query is "3 症状すべての根本原因を特定して
// 全部修正を当てる" — a bounded 3-concern task that must never mint an
// open-universe evidence-expansion obligation.
const JA_BOUNDED_COUNT_RE = /[0-9０-９]/;
/** How far back to look for a governing bounded count before a quantifier occurrence. */
const JA_BOUNDED_COUNT_LOOKBACK_CHARS = 12;

function hasUnboundedJapaneseQuantifierNoun(query: string): boolean {
  JA_QUANTIFIER_NOUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JA_QUANTIFIER_NOUN_RE.exec(query)) !== null) {
    const windowStart = Math.max(0, match.index - JA_BOUNDED_COUNT_LOOKBACK_CHARS);
    const preceding = query.slice(windowStart, match.index);
    if (!JA_BOUNDED_COUNT_RE.test(preceding)) return true;
    if (match.index === JA_QUANTIFIER_NOUN_RE.lastIndex) JA_QUANTIFIER_NOUN_RE.lastIndex += 1;
  }
  return false;
}

/**
 * Quantifier intent is independent from the answer/change profile.
 *
 * A-F6 (2026-08-28): OFF PARITY IS ENFORCED HERE, at the single predicate every
 * open-universe mechanism consults — obligation minting, the exactLocatedAnswer
 * exhaustive gate, evidence-expansion, the additive-mutation retention and the
 * expansion-gap route restore. None of that exists in v0.12 (base 23a023e0
 * contains no open-universe concept at all), so with the compatibility switch
 * OFF the mechanism must not fire at all rather than fire and be ignored later.
 */
export function hasOpenUniverseIntent(query: string): boolean {
  if (!proofCompletionEnabled()) return false;
  return OPEN_UNIVERSE_INTENT_EN_RE.test(query)
    || OPEN_UNIVERSE_INTENT_JA.some((marker) => query.includes(marker))
    || hasUnboundedJapaneseQuantifierNoun(query);
}

/** Adding one new enum/union value is a bounded edit, not an exhaustive audit
 * of the values that already exist.  Keep that edit from acquiring a false
 * standing open-universe obligation while preserving `every`/`all` audits. */
export function isAdditiveEnumIntent(query: string): boolean {
  return /\b(?:add|insert|introduce|append)\b[^\n]{0,80}\b(?:enum|union|status)\b/i.test(query)
    || /(?:列挙|enum|union)[^\n]{0,40}(?:追加|加える|足す)/.test(query);
}
