// salientWordMatch.ts — whole-word, variant-aware matching for a salient
// word (Agent H narrow fix, 2026-09-19; supersedes the Phase 2 substring
// matcher this file previously held).
//
// Root cause this exists for (D1, see the wave report): the request-item
// proof pipeline's absence/coverage checks (readCodeTaskPack.ts's
// `distinctiveSalientAbsence` and `proveUnbindableRequestItem`) scanned only
// the query's own EXACT literal spelling. A corpus that spells the same
// concept "validate"/"validateCouponCode" never credited the query's
// "validated"; "retry"/"retryFailedNotifications" never credited "retried"
// — so a clause whose real implementation existed under a different
// inflection was certified "verified absent", which is false.
//
// This file's PRIOR version fixed that with a substring matcher
// (`hay.includes(variant)`), which introduced a DIFFERENT, forbidden false
// positive: the variant "const" is a literal prefix-substring of the
// unrelated English word "constant", so a query asking about a "constant"
// was wrongly "evidenced" by the bare keyword `const` appearing anywhere in
// a file. `textHasWordVariant` below fixes this by decomposing the haystack
// into whole identifier-shaped words FIRST and testing SET MEMBERSHIP —
// never `string.includes`.
//
// Deliberately narrow: safe, reversible, bidirectional suffix rules only, no
// dictionary, no dependency. Does NOT touch `readCodeTaskPack.ts`'s own
// `lightStem`/`surfaceEvidencesSalientWord` (other pins depend on their
// exact behavior) — this is a new, independent, additive helper.

/**
 * A BACKWARD rule strips one known suffix from `word` and returns zero or
 * more candidate ROOT forms (never adds anything). Returning an implausible
 * extra root is harmless — see `inflectionVariants`'s own doc comment for
 * why noise costs nothing here.
 */
type BackwardRule = (word: string) => string[];

const VOWELS = "aeiou";

/** True when `base`'s last two letters are an identical, non-vowel pair (stopp -> stop, runn -> run). */
function endsInDoubledConsonant(base: string): boolean {
  const last = base[base.length - 1];
  const secondLast = base[base.length - 2];
  return base.length > 2 && last !== undefined && last === secondLast && !VOWELS.includes(last);
}

/** True when a single trailing consonant, preceded by a single vowel (a true CVC tail — stop, run, plan), doubles before -ed/-ing in standard English spelling. w/x/y never double (fix, play). */
function needsDoubledConsonantBeforeSuffix(word: string): boolean {
  if (word.length < 3) return false;
  const last = word[word.length - 1]!;
  const secondLast = word[word.length - 2]!;
  const thirdLast = word[word.length - 3]!;
  if (VOWELS.includes(last) || "wxy".includes(last)) return false;
  if (!VOWELS.includes(secondLast) || VOWELS.includes(thirdLast)) return false;
  return true;
}

// Backward rules — plural/3rd-singular, past tense, gerund, nominalisation.
// Each strips ONE suffix pattern and returns candidate root(s); chaining
// happens via `inflectionVariants`'s own fixed-point loop over these alone
// (never the forward direction — see that function's doc comment for why
// keeping backward/forward separate is what keeps this noise-free).
const BACKWARD_RULES: readonly BackwardRule[] = [
  // plural / 3rd-person singular: boxes->box, invoices->invoice, companies->company.
  (w) => {
    const out: string[] = [];
    if (w.length > 4 && w.endsWith("ies")) out.push(`${w.slice(0, -3)}y`);
    if (w.length > 4 && w.endsWith("es")) out.push(w.slice(0, -2));
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) out.push(w.slice(0, -1));
    return out;
  },
  // past tense / -ed: validated->validate, retried->retry, stopped->stop
  // (doubled-consonant restore).
  (w) => {
    const out: string[] = [];
    if (w.length > 4 && w.endsWith("ied")) out.push(`${w.slice(0, -3)}y`);
    if (w.length > 4 && w.endsWith("ed")) {
      const base = w.slice(0, -2);
      out.push(base, `${base}e`);
      if (endsInDoubledConsonant(base)) out.push(base.slice(0, -1));
    }
    return out;
  },
  // gerund / -ing: validating->validate, running->run (doubled-consonant restore).
  (w) => {
    const out: string[] = [];
    if (w.length > 5 && w.endsWith("ing")) {
      const base = w.slice(0, -3);
      out.push(base, `${base}e`);
      if (endsInDoubledConsonant(base)) out.push(base.slice(0, -1));
    }
    return out;
  },
  // nominalisation -ion/-ation and -ication: validation->validate,
  // authentication->authenticate, notification->notify, verification->verify.
  (w) => {
    const out: string[] = [];
    if (w.length > 8 && w.endsWith("ication")) out.push(`${w.slice(0, -7)}y`);
    if (w.length > 6 && w.endsWith("ation")) out.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
    else if (w.length > 5 && w.endsWith("ion")) out.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
    return out;
  },
];

/**
 * From ONE root, generates its standard forward inflections (plural/
 * 3rd-singular, past tense, gerund, nominalisation) — applied ONCE per
 * root, never recursively to its own output, which is what keeps this
 * bounded: a naive fixed point over BOTH directions at once compounds an
 * intermediate form's own noise every round (e.g. "notifyings" re-pluralised
 * on top of itself) and floods a small variant cap before a legitimate
 * derived form is ever reached.
 */
function forwardForms(root: string): string[] {
  const out: string[] = [root];
  const endsConsonantY = /[^aeiou]y$/u.test(root);
  // plural / 3rd-person singular
  if (endsConsonantY) out.push(`${root.slice(0, -1)}ies`);
  else if (/(?:s|x|z|ch|sh)$/u.test(root)) out.push(`${root}es`);
  else out.push(`${root}s`);
  // past tense
  if (endsConsonantY) out.push(`${root.slice(0, -1)}ied`);
  else if (root.endsWith("e") && root.length > 3) out.push(`${root.slice(0, -1)}ed`);
  else if (needsDoubledConsonantBeforeSuffix(root)) out.push(`${root}${root[root.length - 1]}ed`);
  else out.push(`${root}ed`);
  // gerund (y stays y: notifying, never "notiing" — `needsDoubled...`
  // itself always excludes a y-ending root, so the plain fallback below is
  // the one that correctly fires for it).
  if (root.endsWith("e") && root.length > 3 && !root.endsWith("ee")) out.push(`${root.slice(0, -1)}ing`);
  else if (needsDoubledConsonantBeforeSuffix(root)) out.push(`${root}${root[root.length - 1]}ing`);
  else out.push(`${root}ing`);
  // nominalisation -ion/-ication
  if (endsConsonantY) out.push(`${root.slice(0, -1)}ication`);
  else if (root.endsWith("ate")) out.push(`${root.slice(0, -1)}ion`);
  return out;
}

/** Bound on the backward-chase fixed-point rounds — enough to chain e.g. "notifying" -> "notify", never unbounded. */
const MAX_ROOT_CHASE_ROUNDS = 3;
/** A DERIVED candidate below this length is discarded as noise (the original word always passes through regardless of length). */
const MIN_DERIVED_VARIANT_LENGTH = 3;
/** Hard cap on the returned set, so a pathological input can never make a caller's per-variant scan loop unboundedly. */
const MAX_VARIANTS = 40;

/**
 * Returns `word` lowercased, plus every form reachable from it: chase ROOT
 * candidates backward to a fixed point (Phase 1), generate each root's
 * standard forward inflections once (Phase 2), then let a nominalised
 * (-ion) form from Phase 2 take its own plural (Phase 3 — "notification" ->
 * "notifications"). The result is the SAME family whichever inflected
 * member you start from: `inflectionVariants("validated")`,
 * `inflectionVariants("validate")` and `inflectionVariants("validation")`
 * all contain each other. A word with no applicable rule, a non-ASCII-letter
 * word (CJK/katakana passes through untouched), or one shorter than 3
 * letters returns just itself.
 *
 * Deliberately generous: an implausible extra candidate (e.g. "invoic" while
 * deriving "invoice") is harmless — the caller only ever tests SET
 * MEMBERSHIP of a whole word against the result, so a candidate that is not
 * a real English word simply never matches anything and costs nothing.
 * Never asserts a SINGLE canonical form, only tests membership.
 */
export function inflectionVariants(word: string): string[] {
  const w0 = word.toLowerCase();
  if (!/^[a-z]+$/u.test(w0) || w0.length < 3) return [w0];

  // Phase 1: chase root candidates backward, fixed-point over a bounded
  // number of rounds.
  const roots = new Set<string>([w0]);
  let frontier = new Set<string>([w0]);
  for (let round = 0; round < MAX_ROOT_CHASE_ROUNDS; round++) {
    const next = new Set<string>();
    for (const w of frontier) {
      for (const rule of BACKWARD_RULES) {
        for (const candidate of rule(w)) {
          if (candidate.length < MIN_DERIVED_VARIANT_LENGTH || roots.has(candidate)) continue;
          roots.add(candidate);
          next.add(candidate);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  // Phase 2: from EVERY root, generate its forward forms exactly once.
  const all = new Set<string>([w0]);
  for (const root of roots) {
    all.add(root);
    for (const form of forwardForms(root)) {
      if (form.length >= MIN_DERIVED_VARIANT_LENGTH) all.add(form);
    }
  }

  // Phase 3: a nominalised (-ion) form is itself a noun and takes a plural
  // — one more non-compounding, plural-only pass ("notification" ->
  // "notifications").
  for (const w of [...all]) {
    if (w.length > 5 && w.endsWith("ion")) {
      all.add(/(?:s|x|z|ch|sh)$/u.test(w) ? `${w}es` : `${w}s`);
    }
  }

  return all.size > MAX_VARIANTS ? [w0, ...[...all].filter((v) => v !== w0).slice(0, MAX_VARIANTS - 1)] : [...all];
}

// ---------------------------------------------------------------------------
// Whole-word text matching
// ---------------------------------------------------------------------------

/** Identifier-shaped runs: ASCII letters, digits, underscore, hyphen (a bare digit run never starts one — `startsWith` a letter). */
const IDENTIFIER_RUN_RE = /[A-Za-z][A-Za-z0-9_-]*/gu;
/** camelCase / PascalCase / digit-boundary split points inside one already `_`/`-`-segmented piece. */
const SUBWORD_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/u;

/** Splits one `_`/`-`-free run on camelCase/digit boundaries: "validateCouponCode" -> ["validate","Coupon","Code"], "retry2x" -> ["retry","2x"]... "retryFailed" -> ["retry","Failed"]. */
function splitSubwords(run: string): string[] {
  return run.split(SUBWORD_BOUNDARY_RE).filter((s) => s.length > 0);
}

/**
 * Decomposes every identifier-like token of `text` into lowercase words, at
 * THREE granularities, so a `word` query can match whichever one it itself
 * is shaped like: the whole run as written ("retryFailedNotifications"),
 * each `_`/`-`-delimited segment of it (relevant for snake_case/kebab-case:
 * "MAX_RETRIES" -> "max_retries"), and each camelCase/PascalCase/digit
 * sub-word of that segment ("retry"/"failed"/"notifications"). A plain
 * prose word passes through as one token at all three (identical)
 * granularities. Non-ASCII runs (CJK/katakana) are not identifier-shaped by
 * `IDENTIFIER_RUN_RE` and are skipped — this matcher is EN-only (see the
 * module doc comment).
 *
 * The whole-run/whole-segment levels exist because `word` itself is
 * sometimes a COMPOUND identifier a caller wants matched as a unit (e.g. a
 * query's own salient word "calculateShippingCost", "getDisplayLanguage" —
 * `salientWords()`, this matcher's usual word source, extracts a camelCase
 * identifier as ONE token, never split) — without them, the haystack would
 * only ever offer split PIECES ("calculate"/"shipping"/"cost"), which a
 * whole compound needle could never equal.
 */
function identifierWords(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(IDENTIFIER_RUN_RE) ?? []) {
    out.push(run.toLowerCase());
    for (const segment of run.split(/[_-]+/u)) {
      out.push(segment.toLowerCase());
      for (const piece of splitSubwords(segment)) out.push(piece.toLowerCase());
    }
  }
  return out;
}

/**
 * True when some whole word of `text` — after camelCase/snake/kebab/digit
 * decomposition — is a member of `inflectionVariants(word)`. NEVER a
 * substring test (that is the exact bug this file exists to fix: "const"
 * must never evidence "constant"). Pure; no workspace access.
 */
export function textHasWordVariant(text: string, word: string): boolean {
  const variants = new Set(inflectionVariants(word));
  for (const token of identifierWords(text)) {
    if (variants.has(token)) return true;
  }
  return false;
}
