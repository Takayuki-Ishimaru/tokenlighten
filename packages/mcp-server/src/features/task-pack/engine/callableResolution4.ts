// callableResolution — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImportSpecifier } from "../evidenceClosure.js";
import { FileReadCache } from "./packBasics2.js";
import { IDENTIFIER_DEFINITION_KEYWORD_RE } from "./answerCandidates2.js";
import { declarationHeadShape } from "../callerExpansion.js";
import { definitionSegment } from "../callerExpansion.js";
import { explicitIdentifierAbsences } from "./identifierAbsence2.js";
import { freshAbsenceUniverse } from "./identifierAbsence2.js";
import { hasDeclarationHeadWord } from "../callerExpansion.js";
import { opensMultilineDeclarationParams } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { rightHandOpensDeclarationBody } from "../callerExpansion.js";
import { withoutClosedParenGroups } from "./callerExpansion3.js";

/**
 * FIX-FAB item 2: cheap, no-parse declaration-shape test over a
 * `scanLiteral` match's own trimmed line text (findText.ts's
 * `trimMatchText`, <=80 chars, left-anchored on `identifier`'s occurrence
 * unless it sits deep in an unusually long line) -- does `identifier` look
 * DECLARED on this line, not merely called/mentioned? Reuses the shared
 * governing-keyword test (`IDENTIFIER_DEFINITION_KEYWORD_RE` via
 * `definitionSegment`) the caller-expansion call-site filter already applies
 * for the SAME question, so `function`/`def`/`func`/`fn`/a modifier keyword
 * is recognized identically everywhere in this file.
 *
 * FIX (eval-0927 review-r2 #2, methodManyCallers): a keyword-only test could
 * never recognize a NON-keyword declaration -- TS/JS method shorthand
 * (`fetchJson(pathname: string): Promise<unknown> {`), a Java/C#/C++ typed
 * member head (`ClientOptions loadOptions(Foo x) {`) -- so `src/zclient.ts`,
 * sorting past the 40-file cap behind 45 ordinary call sites, had its
 * `fetchJson` declaration skipped entirely and the mention fallback handed
 * back the WRONG focal under the WRONG name. Now also applies
 * `opensBlockDeclaration`'s own left/right head rule directly (not
 * `opensBlockDeclaration` itself, which additionally wants a `masked` line —
 * this bounded, unmasked match text has no such guarantee, only the two
 * pieces that rule is built from). `text` is a single, possibly TRUNCATED
 * match line with no next line to look ahead to, so only a same-line
 * declaration is recognized here; a false negative still only costs the
 * reordering opportunity this function exists for -- `resolveFacetFocal`'s
 * own P0-2 safety net (never present a name-mismatched mention as the
 * clause's subject) is the backstop for whatever this heuristic still
 * misses, so a false positive here costs nothing either (the resolved
 * symbol is independently re-checked against `target`, as before).
 *
 * R4-A2 (eval-0927 review-r3, callSiteClassificationMatrix): now also
 * recognizes a BODY-LESS declaration (a `;`-terminated prototype / interface
 * member / overload signature — `rightHandOpensDeclarationBody`'s own doc
 * has the exact rule, including why a bare `;` is only safe proof when
 * `hasDeclarationHeadWord(before)` says the LEFT head already earns it) and
 * a generic argument list directly after the name (`fetchJson<T>(` —
 * `rightHandOpensDeclarationBody` skips it before paren-matching).
 *
 * FIX (R4-A2, eval-0927 review-r3 P0-3/shape(2), multilineSigManyCallers):
 * `rightHandOpensDeclarationBody` itself still only PROVES a same-line (or
 * same-line-plus-one) closure — this bounded, single, possibly TRUNCATED
 * match line has no further lines to hand it at all. Left there, a real
 * declaration whose OWN parameter list spans several lines
 * (`async fetchJson(\n  pathname: string,\n  init?: RequestInit,\n):
 * Promise<unknown> {`) never registered as declaration-shaped, so with 45
 * ordinary call sites sorting ahead of it in workspace-walk order, the
 * declaring file never even reached the 40-file cap
 * `findEnclosingCallableForLiteral` bounds its expensive per-file parse to
 * — nothing ever marked it worth reading first. `opensMultilineDeclarationParams`
 * (callerExpansion.ts, own doc has the full reasoning) is the weaker
 * one-line signal for exactly this: X's own argument list is still open at
 * EOL, with no argument's own `{` seen — gated additionally by
 * `hasDeclarationHeadWord` so a bare multi-line CALL (`schedule(x, () => {`
 * truncated the same way) is never caught by it (an ordinary call is never
 * preceded by a stray, unattached modifier/type keyword). A false positive
 * here still costs nothing (this function's own header above) — ranking
 * only; `findEnclosingCallableForLiteral` re-checks the resolved symbol's
 * real name by real parsing once the file is actually read.
 *
 * Exported for `callSiteClassificationMatrix.spec.ts` (R4-A2).
 */
export function isDeclarationShapedMatchText(text: string | undefined, identifier: string): boolean {
  if (text === undefined) return false;
  const at = text.indexOf(identifier);
  if (at < 0) return false;
  const before = text.slice(0, at);
  // The same cast / `export default` exclusions as `callSiteOccurrenceIsDeclaration`.
  const segment = withoutClosedParenGroups(definitionSegment(before));
  if (/\bexport\s+default\s*$/.test(segment)) return false;
  if (IDENTIFIER_DEFINITION_KEYWORD_RE.test(segment)) return true;
  if (!declarationHeadShape(before)) return false;
  if (rightHandOpensDeclarationBody(text, at, undefined, hasDeclarationHeadWord(before))) return true;
  return hasDeclarationHeadWord(before) && opensMultilineDeclarationParams(text, at);
}

/**
 * WP-C4 (2026-09-29, eval-0929 §8 item 2, completionHonesty (6)): the
 * `CollectedSymbolKind`s (collectSymbols.ts) a module-level VALUE holds --
 * a constant/enum, never a callable or a type. Mirrors
 * `ENUM_MEMBER_HOLDER_KINDS`' own "const"/"enum" pairing
 * (locateTaskContext.ts) plus "let"/"var" for a plain mutable module
 * binding in a language with no `const` keyword. Used only by
 * `bestConceptAnchoredInFile`'s `includeValueKinds` branch below -- the
 * ordinary identifier tier (`findDeclaredCallableAmong`,
 * `collectDeclaredCallablesNamedInFile`) already matches ANY kind by name
 * alone and needs no such list.
 */
export const VALUE_DECLARATION_KINDS: ReadonlySet<string> = new Set(["const", "let", "var", "enum"]);

/**
 * A facet-only clause (`inheritedFromLead`): the already-selected candidate
 * whose own callable NAME or a bounded peek of its BODY anchors the most
 * `subjectTerms` -- never proof, only the best available focus for a
 * bounded closure scan. Tier 3.
 *
 * FIX-FAB item 9 (eval-0927 review #12, jaKanjiOnly): when `selected` is
 * NOT empty, this is byte-for-byte the original behavior (same loop, same
 * scoring, same preference for an already-focused symbol) -- ranking against
 * the pack's own evidence always comes first. Only when the ordinary
 * lexical locate found NOTHING AT ALL (a kanji-only JA query has no literal
 * overlap with an English-named codebase, so `selected` is empty) does this
 * fall back to a bounded, workspace-wide scan for a symbol whose name or
 * body anchors the query's own BRIDGED concept terms (jaGlossary.ts) --
 * without it, a zero-length `selected` was a hard dead end: concept-anchoring
 * had nothing to rank, `resolveFacetFocal` returned nothing, and the pack
 * could only end in `await_input` with no candidates and no `next` at all.
 */
/**
 * eval-0929 integration fix (replayCorpus "focus retained" regression): the
 * symbol a selected candidate was focused on before FIX-C1's `tryAddWindow`
 * widened it in place. The widening must clear `.symbol` (serving would snap
 * back to the symbol's narrower span), but the candidate's focus is still
 * that symbol: a LATER requirement of the same closure pass (a callers
 * clause after a value clause widened the same file for a constant) used to
 * see no focus at all and fall back to the file's FIRST callable -- an
 * arbitrary declaration then certified as "0 call sites". Keyed by the
 * candidate object the pass mutates; never serialized.
 */
export const widenedCandidateFocus = new WeakMap<ImpactCandidate, string>();

/** Original caller-selected window, before a value facet widens the candidate.
 * This is focus metadata only: never set candidate.symbol, which would change
 * the exact range the caller requested to be served. */
export const explicitFacetSelectionRange = new WeakMap<ImpactCandidate, { start: number; end: number }>();

/**
 * WP-N (eval-0929 §8): whole-identifier absence verdicts per pack build (one
 * FileReadCache per build), so several facet clauses naming the same
 * identifier scan once.
 */
export const facetIdentifierAbsenceMemo = new WeakMap<FileReadCache, Map<string, boolean>>();

/**
 * Does the clause name at least one identifier (qualified owners excluded, as
 * in every identifier tier) and is EVERY such identifier absent as a whole
 * identifier (`explicitIdentifierAbsence`)? Then its value/condition has no
 * subject in this workspace — see the value/condition branch of
 * `resolveFacetFocal`.
 */
export function facetSubjectIdentifiersAbsent(
  requirement: FacetRequirement,
  qualifiedOwners: ReadonlySet<string>,
  workspace: string,
  cache: FileReadCache,
): boolean {
  const named = requirement.subjectIdentifiers.filter((identifier) => !qualifiedOwners.has(identifier));
  if (named.length === 0) return false;
  let memo = facetIdentifierAbsenceMemo.get(cache);
  if (memo === undefined) {
    memo = new Map();
    facetIdentifierAbsenceMemo.set(cache, memo);
  }
  const unknown = named.filter((identifier) => !memo!.has(identifier));
  if (unknown.length > 0) {
    const absences = explicitIdentifierAbsences(workspace, unknown, () => freshAbsenceUniverse(workspace), cache);
    for (const identifier of unknown) memo.set(identifier, absences.has(identifier));
  }
  return named.every((identifier) => memo!.get(identifier) === true);
}

/**
 * FIX-FAB item 4 (eval-0927 review #5, python): Python's relative-import dot
 * notation: N leading dots with NO slash mean "go up N-1 package levels from
 * the importing file's own directory" (one dot = the SAME package, `from
 * .config import X`; two = the parent package, `from ..pkg.mod import X`),
 * and the dots are followed by a DOTTED MODULE PATH, not a filesystem path
 * (`pkg.mod` -> `pkg/mod`). Distinguished from a TS/JS relative specifier
 * (always slash-delimited: "./x", "../x") by the absence of a "/" right
 * after the leading dots -- a bare "." (`from . import config`) is Python's
 * own "just this package" spelling with no TS/JS equivalent at all; it
 * names no module path of its own (the module name is the IMPORTED
 * BINDING, `config`, which this function -- given only the specifier --
 * cannot see), so it resolves to no candidate here (out of scope: a
 * qualified `config.X` reference is this module's own stated limitation,
 * see evidenceClosure.ts's header).
 */
export const PYTHON_DOTTED_RELATIVE_RE = /^(\.+)([\w.]*)$/;

/**
 * P1-4 (eval-0927 review r2 finding 4, esmJsImport): a TypeScript NodeNext/
 * Bundler-resolution ESM specifier names its OWN COMPILED OUTPUT extension
 * (`import { X } from "./config.js"`) even though the source file on disk is
 * `.ts`/`.tsx` (or `.mts`/`.cts` for a `.mjs`/`.cjs` specifier) — TypeScript's
 * own resolution rule, not a project-specific convention. Appending FURTHER
 * extensions to a base that ALREADY ends in one of these (the general loop
 * below) only ever produces a nonsense path (`config.js.ts`); the specifier's
 * own written extension must first be STRIPPED and replaced. Order mirrors
 * the TS compiler's own preference (`.js` tries `.ts` before the less common
 * `.tsx`); a literal `.js`/`.jsx`/`.mjs`/`.cjs` file (a plain JS project) is
 * still tried too, via the unchanged general loop below — this only ADDS
 * candidates, never removes the literal one.
 */
export const ESM_COMPILED_EXTENSION_SOURCE_MAP: ReadonlyArray<readonly [string, readonly string[]]> = [
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
  [".jsx", [".tsx"]],
  [".js", [".ts", ".tsx"]],
];

export function esmCompiledExtensionSourceCandidates(base: string): string[] {
  for (const [suffix, sourceExts] of ESM_COMPILED_EXTENSION_SOURCE_MAP) {
    if (base.endsWith(suffix)) return sourceExts.map((ext) => `${base.slice(0, -suffix.length)}${ext}`);
  }
  return [];
}

/** Candidate relative paths (with common extensions/index files tried) an import `spec` might resolve to, relative to `focalPath`'s own directory (relative specifiers) or the workspace root / focal directory (a dotted absolute specifier -- Python/Java/C#). Existence is decided by the caller simply trying `readCached` on each -- no separate fs check duplicated here. */
export function candidateRelativePaths(focalPath: string, spec: ImportSpecifier): string[] {
  const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".cs", ".h", ".hpp", ".hh", ".c", ".cc", ".cpp"];
  const baseDir = path.posix.dirname(focalPath.replace(/\\/g, "/"));
  const pythonDotted = spec.relative ? PYTHON_DOTTED_RELATIVE_RE.exec(spec.specifier) : null;
  let bases: string[];
  let includeInitPy = false;
  if (pythonDotted) {
    const dots = pythonDotted[1]!.length;
    const rest = pythonDotted[2]!; // "" for a bare "."/".." (see doc comment: no candidate to offer)
    if (rest.length === 0) {
      bases = [];
    } else {
      let dir = baseDir;
      for (let level = 1; level < dots; level++) dir = path.posix.dirname(dir);
      bases = [path.posix.normalize(path.posix.join(dir, rest.replace(/\./g, "/")))];
      includeInitPy = true;
    }
  } else {
    bases = spec.relative
      ? [path.posix.normalize(path.posix.join(baseDir, spec.specifier))]
      : [spec.specifier.replace(/\./g, "/"), path.posix.normalize(path.posix.join(baseDir, spec.specifier.replace(/\./g, "/")))];
  }
  const out: string[] = [];
  for (const base of bases) {
    // P1-4: the compiled-output-extension source candidates go FIRST — this
    // is the one TypeScript itself would actually resolve, and the general
    // loop below (unchanged) would otherwise reach the coincidentally-real
    // `${base}${ext}`/`index` candidates further down the list, or miss the
    // real source file entirely.
    for (const sourceCandidate of esmCompiledExtensionSourceCandidates(base)) {
      out.push(sourceCandidate.replace(/^\.\//, ""));
    }
    for (const ext of EXTENSIONS) {
      out.push(`${base}${ext}`.replace(/^\.\//, ""));
      out.push(`${base}/index${ext}`.replace(/^\.\//, ""));
    }
    // Python's own package-directory convention (`mod.py` OR `mod/__init__.py`)
    // -- item 4's explicit acceptance shape, absent from the TS/JS-oriented
    // "/index<ext>" loop above.
    if (includeInitPy) out.push(`${base}/__init__.py`.replace(/^\.\//, ""));
  }
  return out;
}

export async function resolveImportSpecifierFile(
  focalPath: string,
  spec: ImportSpecifier,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; content: string } | undefined> {
  for (const relPath of candidateRelativePaths(focalPath, spec)) {
    const content = readCached(workspace, relPath, cache);
    if (content !== undefined) return { path: relPath, content };
  }
  return undefined;
}

/**
 * `value`/`condition` closure for `focal`: module-level constants its OWN
 * body reads (same file), then -- for a candidate not declared in the same
 * file -- one import-resolved file; then every direct in-workspace callee (up
 * to MAX_SCANNED_CALLEE_NAMES names), one hop, each searched the SAME way
 * (fetchWithRetry -> loadOptions -> DEFAULT_OPTIONS; fetchWithRetry ->
 * shouldRetry -> RETRYABLE_STATUSES).
 *
 * FIX-G (2026-09-27, documented interface fix): the SAME walk now continues
 * past the serving bound, up to MAX_PLANNED_CONSTANT_WINDOWS, and reports what
 * it could NOT resolve — the gate (`buildFacetReadiness`) must know every
 * constant the answer needs, not only the ones this pack had room to serve.
 * Copilot retest (2026-10-02): the hook now serves and requires every window
 * (the focal's own constants, then the callees'), within
 * MAX_CLOSURE_BYTES_PER_PACK; FIX-C1's first-four serving bound is gone.
 */
/**
 * How many constant windows one requirement's closure may name; the hook serves and requires every one of them.
 * Copilot retest review (2026-10-02): 12 -> 24 now that the constants of every required callee count (a hub with
 * six callees reading two constants each already filled 12); a walk cut by it reports `complete:false`.
 */
export const MAX_PLANNED_CONSTANT_WINDOWS = 24;

/** FIX-FAB item 5 (eval-0927 review #8, twoConstants): how many levels deep a resolved constant's OWN initializer is scanned for further constant-like references (`TOTAL_BUDGET_MS = BASE_TIMEOUT_MS * MAX_ATTEMPTS` is depth 1 from `deadlineFor`'s own depth-0 read of `TOTAL_BUDGET_MS`). */
export const MAX_CONSTANT_INITIALIZER_DEPTH = 2;

/**
 * P1-4 (round-4/5 fable finding, arrowChainDepth3): a chain of PASS-THROUGH
 * CALLABLE bindings (`fetchWithRetry` -> `shouldRetry` -> `isRetryable` ->
 * `classify` -> `RETRYABLE_STATUSES`) never pushes a window for any hop
 * that is itself callable (`chaseConstant`'s own `isCallableBinding` skip),
 * so counting those hops against the SAME depth budget as a genuine VALUE's
 * own nested-reference scan (MAX_CONSTANT_INITIALIZER_DEPTH, deliberately
 * small — a value rarely nests more than one arithmetic level deep) cut the
 * chase before it ever reached a real value at all. Callable hops cost
 * nothing toward MAX_PLANNED_CONSTANT_WINDOWS (nothing is pushed for them),
 * so a materially larger, still-bounded budget is safe; `visitedConstantNames`
 * independently guards against a cycle regardless of either cap.
 */
export const MAX_CALLABLE_CHASE_DEPTH = 4;

/** FIX-FAB item 4 (eval-0927 review #7, barrel): how many files a re-export chase visits beyond the starting one before giving up (P2: undetermined, not a silent miss). */
export const MAX_REEXPORT_HOPS = 3;

/** P1-5 (eval-0927 review r2 finding 5, barrelStar2): total files a re-export chase may VISIT across every hop combined — a ceiling on the breadth-first search below, independent of `MAX_IMPORT_RESOLVED_FILES_PER_FOCAL` (which bounds how many specifiers ONE file contributes to the next hop's frontier). */
export const MAX_REEXPORT_FILES_TOTAL = 8;

/**
 * WP-A2 (eval-0929 §4/§8, defect (c) -- WP-A's deferred item): a
 * PURE-REFERENCE hop -- a resolved window whose own value side is nothing
 * but a name/qualified name, or an object/array whose members' values are
 * all names (`isPureReferenceInitializer`) -- has served no literal at all,
 * unlike an ordinary value hop `MAX_CONSTANT_INITIALIZER_DEPTH` bounds. It
 * must keep being chased (`export const BASE = RAW; export const RAW =
 * INNER; ...`) past that smaller cap, under this larger, still-bounded hop
 * count of its own -- independent of `MAX_CALLABLE_CHASE_DEPTH` (a different
 * hop kind entirely).
 */
export const MAX_PURE_REFERENCE_CHASE_DEPTH = 8;

/** Same shape as `MAX_REEXPORT_FILES_TOTAL`: total DISTINCT files a pure-reference chase (above) may visit across the WHOLE closure before giving up -- a same-file hop (`const A = B; const B = C;` in one file) costs nothing against this cap, only `MAX_PURE_REFERENCE_CHASE_DEPTH`. */
export const MAX_PURE_REFERENCE_FILES_TOTAL = 8;
