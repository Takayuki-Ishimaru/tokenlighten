// callableResolution — extracted implementation; imports point to the owning modules.
import type { RequestFacet } from "../requestFacets.js";
import { FileReadCache } from "./packBasics2.js";
import { callerExpansionTypeNameFor } from "./callerExpansion2.js";
import { isGoLanguage } from "../callerExpansion.js";
import { languageForPath } from "../../../util/languages.js";
import { readCached } from "./packBasics2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";

/**
 * Chip 3 (2026-09-27, INT-A): the args-keyed `facetClosureOutcomesByArgs`
 * WeakMap and its `facetClosureOutcomesFor` reader were removed here — dead
 * code confirmed by reading: `buildTaskPackCore` replaces `args` with a fresh
 * object before the hook that populated the map runs, and
 * `buildTaskExecutionContract` never receives the original `args` at all, so
 * nothing could ever look this map up by the same key it was written under
 * (neither `facetClosureOutcomesFor` itself nor any test called it). The
 * completion gate instead reads the plan `recoverFacetClosureCandidates`
 * records via facetGate.ts's memo (`recordFacetPlan`, keyed by the resolved
 * query), which also serves every later hop of the same query — this
 * `FacetClosureOutcome` shape remains that function's own per-requirement
 * bookkeeping, still computed and returned, just no longer squirreled away in
 * an unreachable side channel.
 */
export interface FacetClosureOutcome {
  readonly facet: RequestFacet;
  readonly clause: string;
  readonly subject: string;
  readonly focal: readonly string[];
  readonly windows: ReadonlyArray<{ readonly path: string; readonly range: string; readonly served: boolean }>;
  readonly totalCallSites?: number;
  readonly emptyVerified?: boolean;
  readonly reason?: string;
}

export interface ResolvedFacetFocal {
  readonly path: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly typeName: string;
  /** False when this SYMBOL itself is not a genuine member of a type (see `symbolIsRealMember`) -- the plain-top-level-function case `plainFunctionCallerSites` exists for. P0-1 (eval-0927 review-r4 #1): this is a fact about the resolved symbol, never about whether its FILE happens to declare some type elsewhere. */
  readonly hasRealType: boolean;
  /** FIX-G: the resolved symbol's parser kind (function / method / class / interface / …), so the completion gate can tell a callable focal from a type focal. */
  readonly kind?: string;
  /**
   * WP-F (eval-0929 §7 bullet 3 / §8 row 4, same_name_distractor / readLimit
   * chip task_b5ca96e5): set ONLY on the placeholder `resolveSameNameSafeCallable`
   * returns when >= 2 declarations of the SAME name were visible among the
   * pack's own selected candidates and neither rule (a) (an explicit file
   * path the question named) nor rule (b) (an import relation from a file
   * this pack already anchors on) could tell which one the question means.
   * The OTHER fields above still carry the first candidate found (so a
   * caller that only reads `.path`/`.name` informally keeps working), but
   * every caller that could certify `covered`/`empty` MUST check this field
   * FIRST and treat the requirement as undetermined instead -- never
   * silently certify an arbitrary same-named declaration (P0-2's own
   * policy, eval-0927 review-r3 #2, applied here to value/condition).
   * Absent = an ordinary, unambiguous focal.
   */
  readonly ambiguousWith?: readonly ResolvedFacetFocal[];
}

export interface NamedWindow {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly name: string;
  /** Import/re-export evidence, not a callable body to scan for values. */
  readonly binding?: boolean;
  /** FIX-FAB item 6 (eval-0927 review #10, bigConstants): true when `findModuleConstantWindow` capped this declaration's own extent — `end` is NOT the declaration's real close, and the value facet this window backs is not covered until the rest is served too (see facetGate.ts's continuation handling). Absent/false for every other window kind. */
  readonly truncated?: boolean;
}

/**
 * True when `symbol` is a genuine member of a type: the parser attached a
 * real enclosing type (`enclosingSymbol`), or the language's own member
 * syntax proves it even without that link.
 *
 * P0-1 (eval-0927 review-r4 #1, tsFreeFunctionBesideClass/
 * goFreeFunctionBesideStruct/pyFreeFunctionBesideClass/
 * cStructFreeFunction/cIfaceProtoTypedef; control cNoStructFreeFunction).
 * The OLD test (`hasRealEnclosingType`, since removed) asked "does this
 * FILE declare any real top-level type ANYWHERE" -- so a free top-level
 * function sitting in the SAME file as an unrelated class/struct (or a
 * struct defined via a separate `typedef`) was wrongly treated as THAT
 * type's member, and its bare calls (which, exactly because it is not a
 * member, carry no receiver at all) then lost `callSitesForFocalMember`'s
 * receiver-strength gate outright -- a gate that exists only for a real
 * member's cross-type ambiguity, which a plain top-level name never has
 * (see this section's own header comment). The test must be about THIS
 * symbol, never about the file it happens to sit in.
 *
 * Go's own grammar is the one carve-out: a receiver method
 * (`func (m *T) Name(...)`) is a SIBLING of its receiver's `type T struct`
 * in the parse tree, never a child of it (Go has no nested member syntax at
 * all), so `collectSymbols.ts` can never attach a real `enclosingSymbol` to
 * ANY Go method -- but it does still tell a receiver method (parser kind
 * "method") apart from a receiver-less top-level func (kind "function"),
 * which is exactly the fact this test needs and Go's own grammar already
 * proves independently of nesting. TS/JS, Python, Java, C#, Kotlin, C++'s
 * in-class-body methods, and a Go/C free function's absent receiver clause
 * all already nest (or don't nest) a real member correctly via
 * `enclosingSymbol`, so the Go kind check only ADDS coverage for Go, never
 * substitutes for the ordinary test elsewhere.
 */
export function symbolIsRealMember(symbol: { readonly kind: string; readonly enclosingSymbol?: { readonly name: string } }, relPath: string): boolean {
  if (symbol.enclosingSymbol !== undefined) return true;
  return symbol.kind === "method" && isGoLanguage(relPath);
}

/** A targeted disambiguation among a FEW same-named declarations — never a general scan. */
export const MAX_SAME_NAME_CANDIDATES = 4;

/**
 * Every symbol named EXACTLY `identifier` inside `filePath`'s own already-
 * parsed symbols, appended to `out` (capped at MAX_SAME_NAME_CANDIDATES,
 * deduped by path+line so the same declaration reached via two different
 * routes is never counted twice). Shared by `findAllDeclaredCallablesNamed`
 * and its workspace-scan widening below.
 */
export async function collectDeclaredCallablesNamedInFile(
  filePath: string,
  identifier: string,
  workspace: string,
  cache: FileReadCache,
  out: ResolvedFacetFocal[],
  seenPaths: Set<string>,
  seenKeys: Set<string>,
  capped: { hit: boolean },
): Promise<void> {
  if (seenPaths.has(filePath)) return;
  seenPaths.add(filePath);
  const content = readCached(workspace, filePath, cache);
  if (content === undefined) return;
  const lang = languageForPath(filePath);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, filePath) : null) ?? [];
  for (const symbol of parsed) {
    if (unqualifiedSymbolTail(symbol.name) !== identifier) continue;
    // P1-7 (eval-0927 review-r4 #7, sixSameNameOneFile; control
    // sixSameNameSixFiles): a cap hit HERE must be visible to the caller,
    // never silently swallowed -- see `resolveCallerCandidateForName`'s own
    // doc for why presenting whichever MAX_SAME_NAME_CANDIDATES candidates
    // happened to be collected first as "every declaration" risks a false
    // empty for a real declaration this pass never even reached (this file
    // alone held 6 same-named methods; the cap of 4 silently dropped the
    // one that was actually called).
    if (out.length >= MAX_SAME_NAME_CANDIDATES) { capped.hit = true; break; }
    const key = `${filePath}#${symbol.startLine}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const typeName = callerExpansionTypeNameFor(parsed, filePath);
    out.push({
      path: filePath,
      name: unqualifiedSymbolTail(symbol.name),
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      typeName: unqualifiedSymbolTail(symbol.enclosingSymbol?.name ?? typeName),
      hasRealType: symbolIsRealMember(symbol, filePath),
      kind: symbol.kind,
    });
  }
}

/**
 * P0-2 (eval-0927 review-r3 #2, tsTwoClassesSameMethod/kotlinFun): EVERY
 * declared callable named EXACTLY `identifier` among the pack's OWN already-
 * selected candidates (cheap: no new file read beyond what the pack already
 * opened), up to MAX_SAME_NAME_CANDIDATES — not just the first, unlike
 * `findDeclaredCallableAmong`'s own single-match Tier 1. Declaration ORDER
 * carries no relationship to which candidate a real caller actually
 * targets: with two classes declaring the same method name ("FakeClient.
 * fetchJson" with zero callers of its own, "HttpClient.fetchJson" with a
 * real one), whichever sorted first used to win the facet's identity by
 * default and be certified "0 call sites" under that name — a real call
 * site for the OTHER declaration sitting in the very same response.
 * `resolveFacetFocal`'s own P0-2 branch calls this, then asks each candidate
 * `callerSitesForFocal` (unedited — this repo's own "call the exported
 * closure-scan function per candidate rather than editing it" contract)
 * whether it has ANY real call site at all, and prefers the first one that
 * does; only when EVERY candidate genuinely has zero (see
 * `widenDeclaredCallablesNamedByScan` below) does the facet count as
 * legitimately empty.
 */
/**
 * P1-7 (eval-0927 review-r4 #7): `candidates` from a same-name declaration
 * scan, plus whether MAX_SAME_NAME_CANDIDATES was hit anywhere while
 * collecting them. `capped: true` means `candidates` may be MISSING a real
 * declaration this pass never reached -- the caller must never treat it as
 * exhaustive proof that "every declaration of this name is empty".
 */
export interface DeclaredCallablesScan {
  readonly candidates: readonly ResolvedFacetFocal[];
  readonly capped: boolean;
}
