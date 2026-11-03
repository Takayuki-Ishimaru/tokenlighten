// concernProof — extracted implementation; imports point to the owning modules.


/**
 * Tier C generic-software vocabulary (DESIGN-v0.15 R1 §4.2 generalization,
 * 2026-09-08) — the EN counterpart of requestItems.ts's
 * `isGenericJapaneseAbsenceTerm`/its word list: words so common in ANY
 * codebase's own descriptive prose that their absence, by itself, would
 * never tell a reader something distinguishing about THIS workspace (same
 * test: "would an absence of this word ever tell the reader something about
 * the workspace?"). Deliberately does NOT include a word like
 * "invalidation" — specific enough that its absence CAN be a genuine,
 * distinguishing signal in the right query, so it stays a live candidate.
 * Kept short and hand-reviewed, unrelated to `OVERVIEW_GATE_VOCABULARY`
 * above (that list excludes a word from the DIFFERENT overview-redirect
 * gate's "named subject" signal; this one excludes a word from verified-
 * ABSENCE disclosure candidacy — "implementation" legitimately sits on
 * both, doing two unrelated jobs).
 */
/**
 * C3 (fix-c, 2026-09-21, plan §6.1/chip 1) — light/predicate verbs that
 * describe HOW a topic behaves rather than naming any distinguishing
 * subject of their own: "Explain how authentication works" is a question
 * ABOUT authentication, not about the word "works". Chip 1's exact
 * reproduction: `distinctiveSalientAbsence` skipped "authentication" as
 * already-evidenced (an incidental README mention), then fell through to
 * "works" — zero literal occurrences anywhere — and certified THAT absent,
 * which reads as "authentication itself is broken" rather than the true,
 * unrelated fact that the word "works" never appears in source.
 *
 * Folded into `GENERIC_SOFTWARE_ABSENCE_WORDS` below (excludes these from
 * Tier C candidacy — the REPRESENTATIVE-term selection `distinctiveSalient
 * Absence` uses) and separately consulted by `proveUnbindableRequestItem`'s
 * own word sample (excludes these from the search/concentration bag).
 * Deliberately narrow and kept as its own set — unlike
 * `GENERIC_SOFTWARE_ABSENCE_WORDS` (which also excludes ordinary nouns like
 * "cache"/"module" from Tier C candidacy, safe there ONLY because that list
 * never gates a SEARCH), a light verb is semantically empty regardless of
 * which mechanism consults it, so it is safe to exclude from both.
 *
 * R-B3 (2026-09-21, orchestrator ruling 2) — THE ONE CLOSED CLASS of
 * predicates that is not a topic term. FIX-C's C3 had additionally excluded
 * EVERY participle after an auxiliary (`PREDICATE_AUXILIARY_RE`, Tier C
 * only), which made content verbs non-evidential: "how inventory is
 * replenished" asked about replenishment, yet only "inventory" could ever be
 * reported absent, so a workspace whose real code merely NAMES inventory
 * certified the point without a word. A predicate is excluded only when it is
 * semantically LIGHT or GENERIC — it says that something happens to the
 * topic, never WHAT happens — and every member below is here for exactly that
 * reason (all inflections listed, because the three consumers compare whole
 * lowercase words):
 *  - light verbs: be, do, have, get, make, go, take — the auxiliary/support
 *    verbs of English ("how is it done", "what does it take"); work, happen,
 *    run, occur, behave — "how X works/happens/runs/occurs/behaves" asks about
 *    X, never about the verb (C3's original chip-1 reproduction).
 *  - generic process verbs: execute, handle, perform, process, implement,
 *    use, apply, manage, call, invoke, trigger, and configure (the
 *    multi-syllable synonym of "set") — "how X is executed/handled/
 *    processed/implemented/applied/…" names no mechanism of its own; any code
 *    that does anything at all "processes"/"handles"/"uses" something, so the
 *    word neither locates nor distinguishes the concern (and "handling"/
 *    "implementation"/"manager" were already Tier C generic nouns).
 *  - generic participles: done, made (set is below the salient length).
 * Every OTHER predicate ("replenished", "renewed", "resolved", "validated",
 * "invalidated", "enqueued", "computed", …) is a topic term with its
 * derivational variants (`concernTermVariants`), exactly like a noun.
 */
/**
 * R-B3 (ruling 2): the generic PROCESS verbs of the closed class, kept as their
 * own list because one reader needs them apart: `concernCoveredByServedEvidence`'s
 * sliver guard. Non-evidential for coverage and absence like every member of
 * the class, but "how refunds are processed" still says the answer is a
 * PROCESSING body — so when the served lines of the anchoring file lack it and
 * its unserved part spells it at a code position (`processRefund` below a
 * served `RefundRequest` interface), the point is not covered off the sliver.
 */
export const GENERIC_PROCESS_VERB_WORDS: ReadonlySet<string> = new Set([
  "execute", "executes", "executed", "executing",
  "handle", "handles", "handled", "handling",
  "perform", "performs", "performed", "performing",
  "process", "processes", "processed", "processing",
  "implement", "implements", "implemented", "implementing",
  "use", "uses", "used", "using",
  "apply", "applies", "applied", "applying",
  "manage", "manages", "managed", "managing",
  "call", "calls", "called", "calling",
  "invoke", "invokes", "invoked", "invoking",
  "trigger", "triggers", "triggered", "triggering",
  // "set" is below the salient length; "configure" is its multi-syllable
  // synonym — it says the subject HAS a setting, never which one.
  "configure", "configures", "configured", "configuring",
  // WP-C (2026-09-29, eval-0929 §6/§8, orchestrator chip adopted from WP-B):
  // "decide(s)/decided/deciding" — "how mayRetry decides whether to retry"
  // says the answer is a DECISION, never that the literal word "decide"
  // appears anywhere; any function with a conditional at all could be said
  // to "decide" something, so on its own it names no mechanism, same class
  // as "handle"/"process"/"manage" above. Measured false absence: a query
  // whose only OTHER salient word was already generic left "decides" as
  // Tier C's sole candidate, certified absent even though the function's
  // actual condition was served in full.
  "decide", "decides", "decided", "deciding",
]);

export const LIGHT_VERB_WORDS: ReadonlySet<string> = new Set([
  // light verbs
  "be", "been", "being",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "get", "gets", "got", "gotten", "getting",
  "make", "makes", "made", "making",
  "go", "goes", "went", "gone", "going",
  "take", "takes", "took", "taken", "taking",
  "work", "works", "worked", "working",
  "happen", "happens", "happened", "happening",
  "run", "runs", "ran", "running",
  "occur", "occurs", "occurred", "occurring",
  "behave", "behaves", "behaved", "behaving",
  // generic process verbs
  ...GENERIC_PROCESS_VERB_WORDS,
]);

// Adversarial review 2 finding 5 (2026-09-08): the original 36-word list
// below missed a large swath of ordinary software/English vocabulary — a
// composite request naming any of them (in a workspace that happens to
// spell the same concept differently) certified a purely lexical "no
// occurrence of <word>" scan as a "verified absent" point on an act.answer,
// which reads to a caller as "this workspace has no timeout handling" even
// though the string is only true in the narrow "no literal substring" sense.
// Expanded with the reviewer's own five words (timeout/logging/cleanup/
// boundary/handling) plus the broader common-vocabulary sweep below — same
// test as always: "would an absence of this word, on its own, ever tell a
// reader something DISTINGUISHING about this particular workspace?".
export const GENERIC_SOFTWARE_ABSENCE_WORDS: ReadonlySet<string> = new Set([
  // Original 36-word list.
  "cache", "implementation", "service", "module", "function", "class",
  "config", "configuration", "method", "logic", "handler", "request",
  "response", "server", "client", "error", "value", "type", "test", "tests",
  "file", "code", "data", "feature", "behavior", "behaviour", "support",
  "change", "update", "version", "option", "default", "current", "existing",
  "related", "relevant",
  // Review finding 5's own five reproduced words.
  "timeout", "logging", "cleanup", "boundary", "handling",
  // Process/mechanism vocabulary.
  "check", "checks", "validation", "parsing", "parser", "loader", "loading",
  "startup", "shutdown", "initialization", "retry", "retries", "fallback",
  "defaults", "helper", "helpers", "utility", "utilities", "wrapper",
  "adapter", "factory", "manager", "controller", "provider", "listener",
  "callback", "event", "events", "status", "state", "result", "results",
  "output", "input", "setting", "settings", "message", "messages", "signal",
  "command",
  // Generic data-shape/parameter vocabulary.
  "argument", "arguments", "param", "params", "parameter", "parameters",
  "string", "number", "boolean", "object", "array", "list", "entry",
  "entries", "item", "items", "field", "fields", "record", "records",
  "table", "tables", "index", "key", "keys", "path", "paths", "directory",
  "folder", "name", "names", "count", "counter", "limit", "limits", "size",
  "length", "format", "formats", "mode", "modes", "flag", "flags", "options",
  // Copilot retest r5 review (2026-10-03): the words that only shape the
  // ANSWER and can never name a feature of a workspace. (The citation words r4
  // listed here — source, lines, evidence, citations, locations, ... — moved to
  // CITATION_CLAUSE_WORDS, read only inside a recognized citation clause: here
  // they also hid a real "how citations are formatted" or "how evidence is
  // stored" question in a workspace without that feature.)
  "brief", "briefly", "concise", "concisely", "verbatim", "bulleted",
  // WP-C (2026-09-29) listed the facet-DESCRIPTOR nouns here by hand
  // (condition(s)/caller(s)/codes/statuses/values/flow(s) — eval-0929 §6's
  // `request-item-absent:conditions`/`:callers`/`:codes`). WP-C3 (orchestrator
  // ruling rule 2(a): ONE shared source, no second hand-maintained list)
  // moved them out: the literal-absence gate (`disclosableAbsenceTerm` below,
  // via requestItems.ts `isLiteralEligibleTerm`) reads requestFacets.ts's
  // exported `isFacetDescriptorTerm` — the facet detectors' own nouns —
  // instead, which covers these words and every other one those detectors
  // spell.
  // C3 (fix-c, 2026-09-21): light/predicate verbs — see LIGHT_VERB_WORDS'
  // own doc comment just above for why these can never be Tier C's
  // reported term.
  ...LIGHT_VERB_WORDS,
]);
