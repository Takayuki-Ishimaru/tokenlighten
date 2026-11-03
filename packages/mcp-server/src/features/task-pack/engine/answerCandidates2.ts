// answerCandidates — extracted implementation; imports point to the owning modules.


/**
 * C-1 (2026-07-24 wave 4): literal self-recovery for explicit identifiers.
 *
 * An answer pack that fails to cover an identifier the caller literally named
 * manufactures a second call: the pack lands on candidate-list /
 * confirm_candidates and the model's next move is the exact literal search
 * (`tl_search_files action=find <identifier>`) the server could have run itself.
 * When no ranked candidate carries the identifier, scan the workspace for it,
 * prefer definition-shaped occurrences in implementation files, and inject the
 * enclosing symbol (or a centered window) as an exact-identifier candidate.
 * Identifiers with zero literal occurrences are returned as verified-absent so
 * the readiness obligation can report decision-grade absence instead of the
 * ambiguous "no served evidence".
 *
 * Cost: fires only on the miss path (no exact candidate), <=3 identifiers,
 * one literal scan each — the same order of work locate's own content scan
 * already performs for the query.
 */
// R4-A2 (eval-0927 review-r3 callSiteClassificationMatrix, Kotlin `fun`):
// `fn`/`func` never match the substring "fun" (no word boundary sits between
// "fn" and "un"), so Kotlin's OWN declaration keyword was silently absent —
// every Kotlin method declaration fell through to the shape heuristic, which
// `isAlwaysKeywordLedLanguage` deliberately short-circuits to `false` for
// Kotlin (no keyword-less declaration syntax there), so a Kotlin method's own
// declaration line was misclassified as a call site of itself whenever it
// was scanned as a caller candidate in another file (two same-named methods
// in different classes; see `callSiteOccurrenceIsDeclaration`'s doc). Purely
// additive: every other caller of this shared regex only gains a new
// declaration-keyword match, never loses one.
// R5-A2 (eval-0927 review-r4 P1-11, c-macro-define): `define` (C/C++
// preprocessor `#define NAME(...)`, a function-like macro's own definition)
// -- `\bdefine\b` matches inside `#define` too (`#` is a non-word character,
// so a word boundary sits right before `d`). Purely additive, same as the
// `fun`/`fn`/`func` note above; cross-boundary note (R5-A2 owns only
// `callSiteOccurrenceIsDeclaration`/`isDeclarationShapedMatchText` in this
// file, but this shared constant feeds both).
export const IDENTIFIER_DEFINITION_KEYWORD_RE =
  /\b(?:function|class|def|define|struct|enum|interface|type|trait|impl|fun|fn|func|module|const|let|var|val|public|private|protected|static|export|abstract|override|virtual|void|int|bool|double|float|auto)\b/;
