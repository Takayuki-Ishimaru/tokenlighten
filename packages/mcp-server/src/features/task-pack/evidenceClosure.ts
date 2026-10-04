// evidenceClosure.ts — FIX-C1 (eval-0927 P0-1, 2026-09-27): bounded evidence
// closure for a FACET requirement (requestFacets.ts), mirroring
// callerExpansion.ts's own contract exactly: PURE / INJECTED I/O ONLY. Every
// function here takes plain data — a file's lines, a name, a body's lines —
// and never touches the filesystem, a flag, env var or task state. The hook
// (readCodeTaskPack.ts, beside the caller-expansion hook) turns a real
// workspace read/parse into these inputs, exactly as it already does for
// callerExpansion.ts.
//
// PROBLEM (brief-fix-c1.md Deliverable 2): `loadOptions` reads
// `DEFAULT_OPTIONS`; `shouldRetry` reads `RETRYABLE_STATUSES`. Neither name is
// necessarily in the query, and neither declaration is necessarily in the
// window an ordinary locator already served (a "sliced" file variant windows
// the served body down to just the reading function). This module finds
// that declaration — same file, or one file away through an import line —
// and, for the `callers`/`flow` facets, the DIRECT in-workspace callees a
// focal body calls (their own definitions live elsewhere; callerExpansion.ts
// already owns finding CALL SITES of a member, reused directly by the hook —
// see brief-fix-c1.md Deliverable 3 point 2 — so this module never
// duplicates that).
//
// GENERALITY: every declaration shape below is named for the LANGUAGE FAMILY
// it covers (TS/JS, Python, Go, Java, C#, C/C++), never for a fixture or
// project. `findModuleConstantWindow`'s own spec (`evidenceClosure.spec.ts`)
// exercises at least one constant + one import + one caller case in EACH of
// those six.
//
// KNOWN LIMITATION (stated, not hidden — see this module's own report): a
// QUALIFIED reference (`pkg.MaxRetries`, `config.DEFAULT_TIMEOUT`) is not
// resolved by this module. `constantLikeReferencesIn` deliberately skips an
// identifier immediately after `.` (a property/member name, per brief's own
// "skip locals/params/properties (.name)"), so a qualified constant's own
// NAME is skipped and its (ordinarily lower-case) qualifier does not pass the
// constant-shape filter either. The primary scenario this wave fixes —
// `RETRYABLE_STATUSES.has(status)`, `DEFAULT_OPTIONS.timeoutMs` — is an
// UNQUALIFIED reference to a same-package/imported name, which this module
// resolves; a namespaced reference is future work.

import { declarationHeadShape, maskNonCode } from "./callerExpansion.js";
import { isProseAcronym } from "./concernRecovery.js";

// ---------------------------------------------------------------------------
// Tunables (named, per brief-fix-c1.md Deliverable 2's own bound list)
// ---------------------------------------------------------------------------

/**
 * How many of a focal's direct callees get the deeper, costlier walks: their
 * own callees (readCodeTaskPack.ts MAX_FLOW_CALLEE_DEPTH) and, for the value
 * closure, the self-properties it chases. Copilot retest (2026-10-02): it no
 * longer decides WHICH direct callees are required -- every one is, up to
 * MAX_SCANNED_CALLEE_NAMES / MAX_REQUIRED_CALLEE_WINDOWS below. Cutting the
 * required list at three names with nothing recording the cut certified a
 * hub function (`quote()`) from two of its six callees.
 */
export const MAX_CALLEES_PER_REQUIREMENT = 3;
/** Copilot retest (2026-10-02): how many call names in a focal's body are considered as direct callees at all (built-ins included). A body naming more reports its callee list cut (`calleesComplete:false`), which the facet gate discloses as undetermined. */
export const MAX_SCANNED_CALLEE_NAMES = 64;
/** Copilot retest (2026-10-02): how many RESOLVED direct callees become required windows; past it the callee list is reported cut, never silently covered. */
export const MAX_REQUIRED_CALLEE_WINDOWS = 16;
/**
 * How many files reached through the focal file's own import lines are opened
 * to tell WHICH declaration a same-named subject means (readCodeTaskPack.ts,
 * `importedDeclarationFile` -- a miss there is an ambiguity the pack discloses).
 * R2-T3 (eval-0929 final review, P0-4): it no longer bounds a CONSTANT or CALLEE
 * search -- the re-export/include chase, the callee lookup and the Go
 * same-package scan each carry their own file/byte budget and report a miss
 * that hit it (`onBounded`), because a two-file cap that ends a search
 * without a word becomes a silent `request-item-empty`.
 */
export const MAX_IMPORT_RESOLVED_FILES_PER_FOCAL = 2;
/** A single constant/declaration window's own line cap; a larger declaration serves its head and reports the rest as remaining (mirrors callerExpansion.ts's own CALLER_WINDOW_MARGIN_LINES-style honesty, never a silent truncation). */
export const MAX_CONSTANT_WINDOW_LINES = 40;
/** P1-6: the sane ceiling `declarationRealExtent` re-measures a truncated declaration's REAL close against — far larger than the 40-line serving cap (so an 80-200-line real-world table/config object is captured whole), but still bounded, so a pathological unterminated brace can never turn a continuation ask into a literal-EOF read. */
export const MAX_CONSTANT_REAL_EXTENT_LINES = 2000;
/**
 * Total embedded bytes this module's OWN windows may contribute to one pack — the hook enforces this across every requirement, mirroring callerExpansion.ts's MAX_CALLER_EXPANSION_BYTES.
 * Copilot retest (2026-10-02): 4096 -> 8192. The value/condition closure now serves a focal's callee bodies and every constant they read; a required window past this budget is still asked for by a ranged `next`, and that extra round trip costs far more than the bytes.
 */
export const MAX_CLOSURE_BYTES_PER_PACK = 8192;

// ---------------------------------------------------------------------------
// Module-level constant / enum declaration lookup
// ---------------------------------------------------------------------------

export interface ConstantWindow {
  readonly start: number;
  readonly end: number;
  /** True when the declaration's own extent exceeds MAX_CONSTANT_WINDOW_LINES and `end` is a cap, not the declaration's real close. */
  readonly truncated: boolean;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Per-file lookup indexes (perf, 2026-09-28). `findModuleConstantWindow` and
// `importSpecifiersNaming` are asked once per candidate NAME, and the facet
// closure asks for every identifier a focal reads: on a 46k-line focal file
// that re-masked and regex-tested every line per name (~2 s of one pack).
// Both prefilters below are exact, and are cached per `lines` ARRAY (a
// WeakMap, so an index lives exactly as long as the caller's split of that
// file):
//  - every declaration shape (and a Go grouped member) bounds the name with
//    `\b`, a separator or `\s*[:=]`, so it can only match a line holding the
//    name as a maximal [A-Za-z0-9_] run — and masking only turns characters
//    into spaces, so it never creates a run the raw line lacks;
//  - every import shape is anchored at `^\s*(import|export|from|using|
//    #include)` or a destructuring `const|let|var {`.
// Candidate lines are still visited in ascending order with the original
// per-line tests, so the first match — the result — is unchanged.
// ---------------------------------------------------------------------------

interface FileLineIndex {
  /** Maximal [A-Za-z0-9_] run -> ascending 0-based indexes of the lines holding it. */
  readonly tokens: Map<string, number[]>;
  /** `maskNonCode` results, per hashComment flag (index 1 = true). */
  readonly masked: readonly [Map<number, string>, Map<number, string>];
  /** 0-based indexes of lines that can carry an import / re-export / include shape. */
  importLines?: number[];
  /** Parallel to `importLines`: each statement's text, the raw line itself unless a brace/paren-wrapped import spans several lines (`joinedImportStatement`). */
  importTexts?: string[];
  /** Go grouped `const (`/`var (` openers per hashComment flag (index 1 = true). */
  groupOpeners: [number[] | undefined, number[] | undefined];
  /** Parallel to `groupOpeners`: the 0-based line index where each grouped block ends (exclusive), see `goGroupedBlockWindow`. */
  groupEnds: [number[] | undefined, number[] | undefined];
}

const fileLineIndexes = new WeakMap<readonly string[], FileLineIndex>();
const WORD_RUN_RE = /[A-Za-z0-9_]+/g;
const WORD_ONLY_RE = /^[A-Za-z0-9_]+$/;
// R2-T3: `const|let|var NAME = require(` joins the destructuring opener — the
// member form `const B = require("./x").A` binds a name exactly like
// `const { A: B } = require("./x")` (see `importSpecifiersNaming`).
const IMPORT_SHAPED_LINE_RE = /^\s*(?:import\b|export\b|from\b|using\b|#include\b|(?:const|let|var)\s*\{|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\b)/;

function fileLineIndex(lines: readonly string[]): FileLineIndex {
  let index = fileLineIndexes.get(lines);
  if (index === undefined) {
    const tokens = new Map<string, number[]>();
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i]!.matchAll(WORD_RUN_RE)) {
        const list = tokens.get(match[0]);
        if (list === undefined) tokens.set(match[0], [i]);
        else if (list[list.length - 1] !== i) list.push(i);
      }
    }
    index = { tokens, masked: [new Map(), new Map()], groupOpeners: [undefined, undefined], groupEnds: [undefined, undefined] };
    fileLineIndexes.set(lines, index);
  }
  return index;
}

function maskedLineAt(lines: readonly string[], index: FileLineIndex, at: number, hashComment: boolean): string {
  const cache = index.masked[hashComment ? 1 : 0];
  let masked = cache.get(at);
  if (masked === undefined) {
    masked = maskNonCode(lines[at]!, hashComment);
    cache.set(at, masked);
  }
  return masked;
}

/**
 * Declaration-HEAD shapes, tried in order against one MASKED line (comments/
 * strings already blanked by the caller — see `maskNonCode`). The first
 * match wins; a real source file is one language, so at most one family
 * ever legitimately matches — trying all of them is simpler and more robust
 * than threading a language classifier through this pure module, and costs
 * nothing extra (one line, a handful of cheap regex tests).
 *
 *  - TS/JS: `const|let|var` (exported or not, `declare` tolerated), at
 *    column 0 (this file's own convention for "top level" — mirrors
 *    `topLevelDeclaredNames`, readCodeTaskPack.ts, which anchors the same way
 *    for the same reason: a real top-level statement is never indented).
 *    B2 (round-8 fable finding, own reproduction — a Kotlin top-level `val`
 *    was previously NEVER found by this function at all, even same-file:
 *    `namesDeclaredWithin`'s local-scope keyword set and
 *    `findQualifiedConstantWindow`'s own `memberRe` both already treat `val`
 *    as an ordinary binding keyword alongside const/let/var; this shape now
 *    does too): `val` (Kotlin/Swift top-level property) joins the same slot.
 *  - TS/JS/Java/C#: `enum NAME` — TS at column 0 (`(const )?enum`); Java/C#
 *    tolerated at any indentation (a class-nested enum is still "the"
 *    declaration a class-scoped focal reads).
 *  - Python: module-level `NAME = …` / `NAME: Type = …`, column 0 (Python
 *    has no separate "top level" keyword — no indentation IS module level).
 *  - Go: a single `const NAME …` / `var NAME …`, column 0. A GROUPED
 *    `const (…)`/`var (…)` block is handled separately below (grouped
 *    members are not, by themselves, column-0 declarations).
 *  - C/C++: `#define NAME …`, column 0; file-scope
 *    `(static )?(const|constexpr) … NAME =`, column 0.
 *  - Java/C#: a `static` field carrying `final`/`readonly`/`const` (either
 *    modifier order) — NOT column-0 (a class member is indented one level;
 *    Java/C# have no true module-level constant the way TS/Python/Go do).
 */
function declarationShapes(escapedName: string): ReadonlyArray<{ re: RegExp; columnZero: boolean }> {
  return [
    // "pub" (Rust visibility) sits in the SAME optional slot as "export" --
    // `pub const TIMEOUT_MS: u64 = 6500;` is otherwise the identical shape
    // TS/JS's own `const NAME = ...` already matches (round-7 orchestrator
    // follow-up, oRustModuleConst: a bare `const` line, no "pub", already
    // matched; only the visibility keyword was unhandled). B2 (round-9 fable
    // finding, P2-11 residual): Kotlin/Scala allow a VISIBILITY modifier
    // (`private`/`internal`/`public`/`protected`) before a top-level
    // declaration, and `const val` is two keywords, not one -- `private
    // const val TIMEOUT_MS = 100` and `internal val retryLimit = 3` are both
    // ordinary top-level Kotlin constants a same-file bare read must resolve
    // with no import at all, exactly like the already-supported bare `val
    // NAME = ...`.
    { re: new RegExp(`^(?:export\\s+|pub\\s+|private\\s+|internal\\s+|public\\s+|protected\\s+)?(?:declare\\s+)?(?:const\\s+)?(?:const|let|var|val)\\s+${escapedName}\\b`), columnZero: true },
    { re: new RegExp(`^(?:export\\s+)?(?:const\\s+)?enum\\s+${escapedName}\\b`), columnZero: true },
    { re: new RegExp(`^.*\\benum\\s+${escapedName}\\b`), columnZero: false },
    { re: new RegExp(`^${escapedName}\\s*(?::[^=]*)?=(?!=)`), columnZero: true },
    { re: new RegExp(`^(?:const|var)\\s+${escapedName}\\b`), columnZero: true },
    { re: new RegExp(`^#define\\s+${escapedName}\\b`), columnZero: true },
    { re: new RegExp(`^(?:static\\s+)?(?:const|constexpr)\\s+[\\w:<>*&\\s]+?\\b${escapedName}\\s*=`), columnZero: true },
    { re: new RegExp(`^.*\\bstatic\\b.*\\b(?:final|readonly|const)\\b.*\\b${escapedName}\\s*=`), columnZero: false },
    { re: new RegExp(`^.*\\b(?:final|readonly|const)\\b.*\\bstatic\\b.*\\b${escapedName}\\s*=`), columnZero: false },
  ];
}

/**
 * Bracket/paren/brace-depth extent of the declaration starting at
 * `startLine` (1-based), scanning no further than `limit` (inclusive,
 * 1-based): the window ends at the first line (>= startLine) after which
 * depth returns to 0 — correct for both a one-line declaration (`const X =
 * 5;`, depth never leaves 0) and a multi-line literal (`const X = {\n
 * ...\n};`, depth goes 1 then back to 0 on the closing line), with no
 * separate "did we see an opener" tracking needed. Shared by
 * `declarationExtent` (the SERVED window, capped at MAX_CONSTANT_WINDOW_LINES
 * — a larger declaration is reported truncated, its HEAD still served, never
 * a silent drop — brief-fix-c1.md Deliverable 2) and `declarationRealExtent`
 * (P1-6, eval-0927 review r2 finding 6: the declaration's REAL close, for a
 * continuation ceiling that is never literal EOF).
 */
function depthExtentUpTo(lines: readonly string[], startLine: number, hashComment: boolean, limit: number): ConstantWindow {
  let depth = 0;
  for (let line = startLine; line <= limit; line++) {
    const masked = maskNonCode(lines[line - 1] ?? "", hashComment);
    for (const ch of masked) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return { start: startLine, end: line, truncated: false };
  }
  return { start: startLine, end: limit, truncated: limit < lines.length };
}

export function declarationExtent(lines: readonly string[], startLine: number, hashComment: boolean): ConstantWindow {
  return depthExtentUpTo(lines, startLine, hashComment, Math.min(lines.length, startLine + MAX_CONSTANT_WINDOW_LINES - 1));
}

/**
 * P1-6 (eval-0927 review r2 finding 6, bigConstantsLongTail): the
 * declaration's REAL close — the SAME depth scan `declarationExtent` runs,
 * bounded by the much larger MAX_CONSTANT_REAL_EXTENT_LINES ceiling instead
 * of the 40-line SERVING cap. `facetGate.ts`'s truncated-window continuation
 * calls this to learn where a big constant's declaration actually ends, so a
 * continuation ask stops there instead of walking on to literal EOF (a 1000-
 * line padding tail after an 82-line table is not part of the declaration).
 * Still bounded (never a literal `lines.length`-only scan): a declaration
 * bigger than the ceiling reports `truncated:true` exactly like
 * `declarationExtent` does at its own smaller cap — an even-larger
 * declaration degrades to "served up to the sane ceiling", never to
 * unbounded reading.
 */
export function declarationRealExtent(lines: readonly string[], startLine: number, hashComment: boolean): ConstantWindow {
  return depthExtentUpTo(lines, startLine, hashComment, Math.min(lines.length, startLine + MAX_CONSTANT_REAL_EXTENT_LINES - 1));
}

/**
 * A GROUPED Go `const (…)` / `var (…)` block: a member line naming `name` at
 * the head of its trimmed text, inside a column-0 `const (` / `var (` opener
 * and before that block's own column-0 closing `)`.
 *
 * R2-T3 (eval-0929 final review, P0-4 class -- "a cap never becomes a silent
 * empty"): the scan used to be bounded to MAX_CONSTANT_WINDOW_LINES (40)
 * lines FROM THE OPENER, so a member sitting 41+ lines into a big enum-style
 * block (HTTP codes, error codes, an iota table -- ordinary Go) was never
 * found, and the caller certified a false `request-item-empty`. The block is
 * now searched to its real end through the per-file token index (only the
 * lines that contain the NAME are tested, so a 2000-line block costs the same
 * as a 5-line one). The block's end is its column-0 `)` -- or, for a block
 * that never closes, the next column-0 top-level declaration -- never an
 * INDENTED `)`, which is the tail of a member's own multi-line call
 * (`x = f(\n\t\t1,\n\t)`) and used to end the scan early. The SERVED window is
 * still capped (`declarationExtent`): only the search is unbounded.
 */
function goGroupedBlockWindow(lines: readonly string[], name: string, hashComment: boolean): ConstantWindow | undefined {
  const memberRe = new RegExp(`^\\s*${escapeForRegex(name)}\\b`);
  const index = fileLineIndex(lines);
  const slot = hashComment ? 1 : 0;
  let openers = index.groupOpeners[slot];
  let ends = index.groupEnds[slot];
  if (openers === undefined || ends === undefined) {
    // A masked line can only open a block where the raw line already starts
    // with the keyword (masking never touches column-0 code characters).
    openers = [];
    ends = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^(?:const|var)/.test(lines[i]!)) continue;
      // `(` ends the opener line (gofmt's own shape) -- a C# top-level tuple
      // deconstruction `var (a, b) = pair;` is one statement, not a block.
      if (!/^(?:const|var)\s*\(\s*$/.test(maskedLineAt(lines, index, i, hashComment))) continue;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^(?:\)|(?:func|type|const|var|import|package)\b)/.test(lines[j]!)) { end = j; break; }
      }
      openers.push(i);
      ends.push(end);
    }
    index.groupOpeners[slot] = openers;
    index.groupEnds[slot] = ends;
  }
  const candidateLines = WORD_ONLY_RE.test(name) ? (index.tokens.get(name) ?? []) : undefined;
  for (const [k, i] of openers.entries()) {
    const end = ends[k]!;
    if (candidateLines !== undefined) {
      for (const j of candidateLines) {
        if (j <= i) continue;
        if (j >= end) break;
        if (memberRe.test(maskedLineAt(lines, index, j, hashComment))) return declarationExtent(lines, j + 1, hashComment);
      }
      continue;
    }
    for (let j = i + 1; j < end; j++) {
      if (memberRe.test(maskedLineAt(lines, index, j, hashComment))) return declarationExtent(lines, j + 1, hashComment);
    }
  }
  return undefined;
}

/**
 * The declaration window of a module-level constant/enum named `name` in
 * `lines` (one file's content, already split — 1-based line numbers match
 * the file). Tries every `declarationShapes` family in order, then a Go
 * grouped block as a fallback. `undefined` when no declaration of `name` is
 * found in THIS file (the hook then tries an import-resolved file — see
 * `importSpecifiersNaming` below).
 */
export function findModuleConstantWindow(
  lines: readonly string[],
  name: string,
  hashComment: boolean,
): ConstantWindow | undefined {
  if (name.length === 0) return undefined;
  const escaped = escapeForRegex(name);
  const shapes = declarationShapes(escaped);
  const index = fileLineIndex(lines);
  const candidateLines = WORD_ONLY_RE.test(name) ? (index.tokens.get(name) ?? []) : undefined;
  const visit = (at: number): ConstantWindow | undefined => {
    const masked = maskedLineAt(lines, index, at, hashComment);
    for (const shape of shapes) {
      if (shape.columnZero && /^\s/.test(masked)) continue;
      if (shape.re.test(masked)) return declarationExtent(lines, at + 1, hashComment);
    }
    return undefined;
  };
  if (candidateLines !== undefined) {
    for (const at of candidateLines) {
      const window = visit(at);
      if (window) return window;
    }
  } else {
    for (let at = 0; at < lines.length; at++) {
      const window = visit(at);
      if (window) return window;
    }
  }
  return goGroupedBlockWindow(lines, name, hashComment);
}

/**
 * B3 (round-8 fable finding, cjsRequireModuleConst/cjsDestructureConst/
 * tsDefaultImportObjectConst): `name`'s declaration as a CommonJS/ES-default
 * EXPORT member — `exports.name = …` / `module.exports.name = …` (a direct
 * property assignment, matched at any indentation, mirroring how a
 * `declarationShapes` field shape is not column-anchored either), or a
 * DEPTH-1 key of a `module.exports = { … }` / `export default { … }` object
 * literal (`TIMEOUT_MS: 6500,`, one brace inside the assignment — the key
 * may share the opener's own line too, `module.exports = { TIMEOUT_MS: 1 }`).
 * A NESTED member two levels deep is deliberately not matched — the same
 * "one member, one hop" scope every other owner-body search in this module
 * keeps. `undefined` when this file has no such export shape, or the object
 * literal does not carry this key at depth 1.
 */
export function findModuleExportsMemberWindow(lines: readonly string[], name: string, hashComment: boolean): ConstantWindow | undefined {
  if (name.length === 0) return undefined;
  const escaped = escapeForRegex(name);
  const directRe = new RegExp(`^\\s*(?:module\\.)?exports\\.${escaped}\\s*=(?!=)`);
  for (let i = 0; i < lines.length; i++) {
    if (directRe.test(maskNonCode(lines[i] ?? "", hashComment))) return declarationExtent(lines, i + 1, hashComment);
  }
  const openerRe = /^\s*(?:module\.exports\s*=|export\s+default)\s*\{/;
  const keyRe = new RegExp(`^(?:['"]${escaped}['"]|${escaped})\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    const rawOpener = lines[i] ?? "";
    if (!openerRe.test(rawOpener)) continue;
    const maskedOpener = maskNonCode(rawOpener, hashComment);
    const braceAt = maskedOpener.indexOf("{");
    if (braceAt === -1) continue;
    // The opener's own line may carry the FIRST key too (`module.exports =
    // { TIMEOUT_MS: 6500, … }`) -- tested against the text right after the
    // opening brace, same depth-1 rule as every following line.
    if (keyRe.test(maskedOpener.slice(braceAt + 1).trimStart())) return declarationExtent(lines, i + 1, hashComment);
    let depth = 0;
    for (const ch of maskedOpener.slice(braceAt)) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    const limit = Math.min(lines.length, i + MAX_CONSTANT_WINDOW_LINES);
    for (let j = i + 1; j < limit && depth > 0; j++) {
      const masked = maskNonCode(lines[j] ?? "", hashComment);
      if (depth === 1 && keyRe.test(masked.trimStart())) return declarationExtent(lines, j + 1, hashComment);
      for (const ch of masked) {
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      }
    }
  }
  return undefined;
}

/**
 * Round-9 orchestrator check (o9TsLiteralField/o9KtLiteralField/
 * o9JavaLiteralField/o9PyLiteralSelfAttr): true when a property window's
 * value side names nothing that would need resolving elsewhere — a literal
 * (`2000`, `2000L`, `6.5`, `"x"`, `true`), or a construction/call built only
 * from literals (`new Set([502, 503])`, `listOf(1000L, 2000L)`,
 * `Duration.ofSeconds(2)`). Such a declaration IS the value. A bare or
 * qualified name read on the value side (`timeoutMs` from a constructor
 * parameter, `config.timeoutMs`, `Config.TIMEOUT`) is not self-contained, and
 * any identifier this cannot classify (a cast, a type argument) keeps the
 * conservative answer. The value side is what follows the property name's
 * own `=` (field, assignment, parameter default) up to the next top-level
 * `,`/`;`/closer, or what follows `return` in a getter.
 */
export function propertyInitializerIsSelfContained(windowLines: readonly string[], propName: string, hashComment: boolean): boolean {
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const nameAt = new RegExp(`(?<![\\w$])${escapeForRegex(propName)}(?![\\w$])`).exec(text);
  if (nameAt === null) return false;
  const afterName = text.slice(nameAt.index + propName.length);
  const eq = /^[^=;{}]*?(?<![=!<>])=(?![=>])/.exec(afterName);
  const ret = /\breturn\b/.exec(afterName);
  let from: number;
  if (eq !== null) from = nameAt.index + propName.length + eq[0].length;
  else if (ret !== null) from = nameAt.index + propName.length + ret.index + ret[0].length;
  else return false;
  let depth = 0;
  let end = text.length;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) { end = i; break; }
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) { end = i; break; }
  }
  // Masking keeps columns, so the raw slice is the same span: a string
  // literal is blanked in `text` but still a value.
  if (windowLines.join("\n").slice(from, end).trim().length === 0) return false;
  const value = text
    .slice(from, end)
    .replace(/\b0[xXbBoO][0-9a-fA-F_]+[A-Za-z]*\b/g, " ")
    .replace(/(?<![\w$.])\.?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[A-Za-z]*/g, " ");
  const literalWords = /^(?:true|false|null|undefined|None|True|False|nil|NaN|Infinity|new)$/;
  for (const match of value.matchAll(IDENTIFIER_RE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (literalWords.test(token)) continue;
    if (at > 0 && value[at - 1] === ".") continue; // a member of a call chain
    if (/\bnew\s+$/.test(value.slice(0, at))) continue; // the constructed type
    const after = value.slice(at + token.length);
    if (/^\s*(?:<[^>]*>)?\s*\(/.test(after)) continue; // a callee
    if (/^(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\(/.test(after)) continue; // `Duration.ofSeconds(`
    return false;
  }
  return true;
}

/**
 * Round-9 review P0-1 (cjsExplicitSelfKey): true when the exports member
 * `name` declared in `window` (`exports.name = …`, `module.exports.name = …`,
 * or a `name: …` key of `module.exports = { … }` / `export default { … }`)
 * reads a binding of the SAME name on its value side (`{ TIMEOUT_MS:
 * TIMEOUT_MS }`, `exports.TIMEOUT_MS = TIMEOUT_MS * 2`). Such a key holds no
 * value of its own — the answer is the module's own binding — and a scan
 * that skips the key's own name never reaches it. Only the value side on the
 * key's own line is read (up to the next top-level `,`, `;` or closer).
 */
export function exportsMemberValueReadsOwnName(
  lines: readonly string[],
  window: { start: number; end: number },
  name: string,
  hashComment: boolean,
): boolean {
  const escaped = escapeForRegex(name);
  const keyRe = new RegExp(`(?:(?:^|[{,])\\s*${escaped}\\s*:(?!:)|^\\s*(?:module\\.)?exports\\.${escaped}\\s*=(?![=>]))`);
  const readRe = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`);
  for (let line = window.start; line <= window.end; line++) {
    const masked = maskNonCode(lines[line - 1] ?? "", hashComment);
    const key = keyRe.exec(masked);
    if (!key) continue;
    const from = key.index + key[0].length;
    let depth = 0;
    let end = masked.length;
    for (let i = from; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if ((ch === "," || ch === ";") && depth === 0) { end = i; break; }
    }
    return readRe.test(masked.slice(from, end));
  }
  return false;
}

/**
 * P0-4 (round-4 fable finding, 2026-09-28) — REPLACES the old, narrower
 * "literal-like" filter (R3-A2's P2-11(b) ruling, now superseded: it treated
 * ANY call in the initializer as disqualifying unless the callee's name sat
 * on a small constructor allowlist, so `parseInt(env ?? "3")`,
 * `defineConfig({...})`, `float(os.environ.get(...))` and
 * `time.Duration(4500) * time.Millisecond` were all wrongly excluded from
 * VALUE windows — the exact class of evidence a "default timeout" / "which
 * statuses" question needs). The new rule: a module binding is excluded from
 * VALUE windows ONLY when it is itself CALLABLE — a function declaration/
 * expression, an arrow function (or Python `lambda`, or a Go function
 * literal `func(...) {...}` assigned to a `var`), or a class (declaration or
 * expression) — i.e. `NAME(...)` invokes it directly, or `NAME` is a type.
 * `export const shouldRetry = (status) => RETRYABLE_STATUSES.has(status)` is
 * exactly this shape: `shouldRetry` itself is not "a value", so
 * `chaseConstant` (readCodeTaskPack.ts) does not serve ITS window as the
 * answer, but it DOES keep walking into the callable's own body — the
 * ordinary constant-reference recursion already there — which is how
 * `RETRYABLE_STATUSES` is reached one hop further (the "callee path").
 *
 * EVERY OTHER shape is a required value window, however it was built:
 * number/string/boolean/null and array/object/tuple/template literals
 * (with or without a nested call — an object literal with a function-VALUED
 * MEMBER, `{ timeoutMs: 7200, delayMs: (n) => 100 * n }`, is still a value:
 * only the binding's OWN top-level shape is tested, never what a member deep
 * inside it happens to be), a computed constant built by an arbitrary call
 * (`parseInt(...)`, `float(...)`, a `time.Duration(...) * time.Millisecond`
 * arithmetic expression), an object built by a call (`defineConfig({...})`,
 * `buildSet(...)`), `new X(...)`, `require(...)`, and an enum's own members.
 * Deliberately permissive on ambiguous input (a window this cannot classify
 * — e.g. a macro body this module never parses closely — is never callable):
 * a false negative here would silently drop evidence a real value question
 * needed, while the caller's own byte budget already guards against a giant
 * window some other way.
 *
 * The companion OVER-SERVING guard (a binding the focal uses ONLY as a call
 * RECEIVER, `logger.info(...)`, is not a value window) lives in
 * `constantLikeReferencesIn` below, at the USAGE site — never here: this
 * function only ever sees the declaration's OWN text, never how the focal's
 * body refers to it.
 */
const CALLABLE_HEAD_FUNCTION_RE = /^(?:async\s+)?function\b/u;
const CALLABLE_HEAD_CLASS_RE = /^class\b/u;
const CALLABLE_HEAD_LAMBDA_RE = /^lambda\b/u;
const CALLABLE_HEAD_GO_FUNC_RE = /^func\b/u;
const CALLABLE_HEAD_BARE_ARROW_RE = /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/u;

/**
 * Depth-0 (bracket-aware) index of a declaration's own assignment `=`, or -1
 * when none exists before the first bracket opens at depth 0 (an `enum
 * NAME {`, an interface, or any other bracket-first head with no initializer
 * to test — never callable, since there is nothing assigned to call).
 * Excludes `==`/`!=`/`<=`/`>=`/`=>` (an arrow inside a TYPE ANNOTATION, e.g.
 * `const handler: (x: number) => void = ...`, must not be mistaken for the
 * real assignment).
 */
function topLevelAssignmentIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "{" || ch === "(" || ch === "[") {
      if (depth === 0) return -1;
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === "=") {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev === "!" || prev === "<" || prev === ">" || prev === "=") continue;
      if (next === "=" || next === ">") continue;
      return i;
    }
  }
  return -1;
}

/**
 * True when the initializer text (already stripped of the assignment `=`)
 * opens with an arrow function's own parameter list: an optional `async`,
 * then a paren-matched `(...)`, then — after an optional `: ReturnType`
 * (itself bracket-balanced, so a generic/object return type's own brackets
 * never confuse the scan) — `=>`. `false` when the matching `)` is not
 * followed by `=>` at all (an ordinary parenthesized value/tuple, never a
 * function).
 */
function initializerOpensWithArrowParams(text: string): boolean {
  let i = 0;
  const asyncMatch = /^async\s+/u.exec(text);
  if (asyncMatch) i = asyncMatch[0].length;
  if (text[i] !== "(") return false;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        let innerDepth = 0;
        for (; j < text.length; j++) {
          const c = text[j]!;
          if (c === "(" || c === "{" || c === "[" || c === "<") innerDepth++;
          else if (c === ")" || c === "}" || c === "]" || c === ">") innerDepth = Math.max(0, innerDepth - 1);
          else if (innerDepth === 0 && c === "=" && text[j + 1] === ">") return true;
          else if (innerDepth === 0 && (c === ";" || c === ",")) return false;
        }
        return false;
      }
    }
  }
  return false;
}

/**
 * True when `windowLines` (a module-level binding's OWN declaration text,
 * already resolved by `findModuleConstantWindow`/`resolveConstantWindow`) is
 * itself a CALLABLE binding — see this section's own header comment for the
 * full rule and the languages it covers (TS/JS, Python, Go; Java/C#'s static
 * fields are never callable-shaped by `declarationShapes` in the first
 * place, so this predicate is not reached for them).
 */
export function declarationIsCallable(windowLines: readonly string[], hashComment: boolean): boolean {
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const eq = topLevelAssignmentIndex(text);
  if (eq === -1) return false;
  const initializer = text.slice(eq + 1).replace(/^\s+/, "");
  if (CALLABLE_HEAD_FUNCTION_RE.test(initializer)) return true;
  if (CALLABLE_HEAD_CLASS_RE.test(initializer)) return true;
  if (CALLABLE_HEAD_LAMBDA_RE.test(initializer)) return true;
  if (CALLABLE_HEAD_GO_FUNC_RE.test(initializer)) return true;
  if (CALLABLE_HEAD_BARE_ARROW_RE.test(initializer)) return true;
  return initializerOpensWithArrowParams(initializer);
}

/** The first type-declaring keyword of a declaration head. */
const TYPE_DECLARATION_KEYWORD_RE = /\b(class|interface|enum|struct|trait|protocol|object|record|union)\b/u;

/**
 * Copilot standard-setup evaluation (2026-10-02) and its review: true when a
 * top-level declaration (`kind` as the symbol parser reports it, the window
 * starting at its first line) carries no constant VALUE a value question
 * could be missing — a function or method, a const bound to one (an arrow,
 * a lambda), a type alias, an interface, a trait or a protocol. The parser
 * files enums, interfaces, structs and traits under "class", so the head's
 * first type keyword tells them apart. A class, enum, struct, object or
 * record may carry the value itself (`Status.PAID`, `Limits.MAX`, a Rust
 * associated const), so it is never exempt.
 */
export function declarationCarriesNoConstantValue(kind: string, windowLines: readonly string[], hashComment: boolean): boolean {
  if (kind === "function" || kind === "method" || kind === "type") return true;
  if (kind === "const") return declarationIsCallable(windowLines, hashComment);
  if (kind !== "class") return false;
  const head = windowLines.slice(0, 6).map((line) => maskNonCode(line, hashComment)).join("\n");
  const keyword = TYPE_DECLARATION_KEYWORD_RE.exec(head)?.[1];
  return keyword === "interface" || keyword === "trait" || keyword === "protocol";
}

/**
 * A numeric or quoted literal on `line` once a trailing `//`/`#` comment is
 * dropped -- mirrors facetGate.ts's own `lineHasLiteral` (kept as a small
 * local duplicate: evidenceClosure.ts must stay fs/task-state-free and
 * importing FROM facetGate.ts, which already imports from here, would be
 * circular). Decides only whether a resolved window is "empty of any
 * concrete value", never a status.
 *
 * eval-0929 §4/§8 fix: a digit run is a literal only when it OPENS the
 * token it sits in -- `64`, `0x40`, `1_000`, `1e3` and `64u64` (a literal
 * with a language type/unit suffix) all open on a digit, because no
 * mainstream language lets an identifier start with one. A digit run that
 * instead sits inside a digit-SUFFIXED type/const name (`u64`, `i32`,
 * `int8_t`, `Float64`, `uint16` in Rust/C/C++/Go/Julia/Kotlin/…) never
 * opens its token, so stripping every `IDENTIFIER_RE` match first (each
 * runs from its own leading letter/`_`/`$` through every trailing digit)
 * removes such a name whole while always leaving a real literal's leading
 * digit behind. The prior one-character lookbehind/lookahead only ever
 * inspected the digit run's immediate neighbour, so a 2+ digit suffix could
 * retry-match on its OWN trailing digit (preceded by another digit, not a
 * letter) and be misread as carrying a literal.
 */
function lineHasLiteralText(line: string): boolean {
  const code = line.replace(/\s(?:\/\/|#).*$/u, "").replace(/^\s*(?:\/\/|#|\*|\/\*).*$/u, "");
  return /\d/u.test(code.replace(IDENTIFIER_RE, "")) || /["'`]/u.test(code);
}

/**
 * V4 (round-7 fable finding, valueBehindConfigAccessor): true (and the exact
 * expression text) when `windowLines`' own initializer (after its top-level
 * `=`) is NOTHING BUT a single construction/call expression -- `new
 * Settings()`, `createConfig()`, `load()` -- AND no line of the window holds
 * a literal anywhere. Such a window resolves SYNTACTICALLY (a real
 * declaration was found) but answers nothing a value/condition question
 * needs: whatever number/string the question wants lives inside whatever
 * `Settings`/`createConfig`/`load` itself returns, not on this line.
 * `undefined` for an ordinary value (a literal, an object/array, or a call
 * MIXED with literal content, e.g. `parseInt(x, 10)` or
 * `time.Duration(4500) * time.Millisecond` -- P0-4's "computed constant"
 * shape, deliberately kept a served value exactly as before this addition:
 * the "no literal anywhere" gate is a STRICT subset of P0-4's cases).
 */
export function constructionOnlyInitializer(windowLines: readonly string[], hashComment: boolean): string | undefined {
  if (windowLines.some((line) => lineHasLiteralText(line))) return undefined;
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const eq = topLevelAssignmentIndex(text);
  if (eq === -1) return undefined;
  let initializer = text.slice(eq + 1).trim();
  if (initializer.endsWith(";")) initializer = initializer.slice(0, -1).trim();
  const callHead = /^(?:new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.exec(initializer);
  if (callHead === null) return undefined;
  let depth = 0;
  for (let i = callHead[0].length - 1; i < initializer.length; i++) {
    const ch = initializer[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i === initializer.length - 1 ? initializer : undefined;
    }
  }
  return undefined;
}

/**
 * B3 (round-8 fable finding, cjsRequireModuleConst): true when `windowLines`'
 * own top-level initializer is NOTHING BUT a bare `require("...")` call (a
 * `const config = require("./config");` window, or a TS `import config =
 * require("./config");` one) — a MODULE binding, never a value: its
 * specifier string answers no value/condition question, and pushing this
 * line as though it did is exactly the P3 violation this closure exists to
 * prevent. Deliberately narrower than, and checked BEFORE,
 * `constructionOnlyInitializer` — B3's own rule is that a require() is
 * NEVER even disclosed as a "construction this pack did not follow" (V4)
 * either: it is a plain module alias, resolved instead through
 * `importedModuleAliasesIn`/`resolveModuleNamespaceFile`'s own alias branch.
 * `maskNonCode` blanks a string literal's own quote marks to spaces (by
 * design, for call-shape column arithmetic elsewhere), so the specifier
 * itself is invisible here by the time this runs — `require(   )` is
 * exactly what a real `require("./config")` masks to, which is what this
 * regex matches; anything past a bare call (`require("./x").default`, a
 * second argument) is deliberately NOT matched — MAY still be a genuine
 * value this scan should try to serve, so it is left to the ordinary path.
 */
export function isRequireModuleInitializer(windowLines: readonly string[], hashComment: boolean): boolean {
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const eq = topLevelAssignmentIndex(text);
  if (eq === -1) return false;
  let initializer = text.slice(eq + 1).trim();
  if (initializer.endsWith(";")) initializer = initializer.slice(0, -1).trim();
  return /^require\(\s*\)$/.test(initializer);
}

/**
 * R2-T3 (eval-0929 final review, P1-4): true when `windowLines`' own
 * top-level initializer is NOTHING BUT a member read off a `require()` --
 * `const TTL_MS = require("./consts").RAW_TTL;` -- an IMPORT BINDING exactly
 * like `const { RAW_TTL: TTL_MS } = require("./consts")`: the value lives in
 * the required module, never on this line. `importSpecifiersNaming` reads the
 * same statement as a named spec (`exportedName: "RAW_TTL"`); a declaration
 * lookup that returned this line as the constant's own window would serve a
 * line that holds no literal and certify the facet `covered` (the
 * `isRequireModuleInitializer` P3 violation, one property access later).
 * Same masked-text convention as `isRequireModuleInitializer` above.
 */
export function isRequireMemberInitializer(windowLines: readonly string[], hashComment: boolean): boolean {
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const eq = topLevelAssignmentIndex(text);
  if (eq === -1) return false;
  let initializer = text.slice(eq + 1).trim();
  if (initializer.endsWith(";")) initializer = initializer.slice(0, -1).trim();
  return /^require\(\s*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)+$/.test(initializer);
}

/** A bare name, or a dotted/`::`-qualified reference chain (`RAW_TIMEOUT`, `Config.Base.timeout`, `crate::limits::RAW`) -- no call, no operator, no literal. Shared by `isPureReferenceExpression`'s two branches (a bare value, or one aggregate member's value). */
const PURE_REFERENCE_NAME_RE = /^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/u;

/**
 * True when `expr` (already trimmed, and stripped of any trailing `;`) is
 * NOTHING BUT a single name/qualified-name reference, or an object/array
 * aggregate whose EVERY member's value is -- recursively -- the same: no
 * literal anywhere, no call/construction. An aggregate with even ONE
 * literal-or-call member (`{ a: NAME, b: 4 }`) does NOT qualify -- some
 * value already reached this window, so it is the ORDINARY served-value
 * case (`chaseConstant`'s pre-existing depth-limited nested scan), never
 * the pure-reference one this predicate exists to flag.
 */
function isPureReferenceExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed === "") return false;
  if (PURE_REFERENCE_NAME_RE.test(trimmed)) return true;
  const isObject = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isArray = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (!isObject && !isArray) return false;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return false; // an empty aggregate carries no reference to chase -- never "pure reference"
  const members = topLevelSplit(inner, ",").map((m) => m.trim()).filter((m) => m !== "");
  if (members.length === 0) return false;
  return members.every((member) => {
    if (!isObject) return isPureReferenceExpression(member);
    if (member.startsWith("...")) return isPureReferenceExpression(member.slice(3));
    const colon = topLevelIndexOf(member, ":");
    return isPureReferenceExpression(colon === -1 ? member : member.slice(colon + 1));
  });
}

/**
 * WP-A2 (eval-0929 §4/§8, defect (c) -- WP-A's own deferred item): true when
 * `windowLines`' own top-level initializer is a PURE reference (see
 * `isPureReferenceExpression`'s own doc) -- no literal anywhere in the
 * window, no call/construction. `chaseConstant`'s long-standing comment
 * ("the value itself is already served, so leaving its own sub-references
 * unchased is a bounded, honest depth choice") is true ONLY when the pushed
 * window's own text already carries a value; a pure-reference window like
 * `export const BASE_TIMEOUT = RAW_TIMEOUT;` or `const CONFIG = { t:
 * DEFAULTS.t };` serves NOTHING concrete on its own, so `chaseConstant` must
 * keep chasing the name(s) it points at past the ordinary
 * `MAX_CONSTANT_INITIALIZER_DEPTH` bound (under its own separate,
 * still-bounded hop/file budget), or disclose them -- never silently stop
 * as though the value had already been served. Mutually exclusive with
 * `constructionOnlyInitializer`/`declarationIsCallable` by construction: a
 * call or construction always contains a `(`, which no shape this predicate
 * accepts can ever have. Purely syntactic -- a bare/qualified name, or an
 * aggregate of only such names -- so it applies uniformly to every language
 * `resolveConstantWindow` resolves a window for (TS/JS, Python, Go, Java,
 * Kotlin, C#, Rust, C/C++, …), never keyed to any one language's own
 * declaration syntax.
 */
export function isPureReferenceInitializer(windowLines: readonly string[], hashComment: boolean): boolean {
  if (windowLines.some((line) => lineHasLiteralText(line))) return false;
  const text = windowLines.map((line) => maskNonCode(line, hashComment)).join("\n");
  const eq = topLevelAssignmentIndex(text);
  if (eq === -1) return false;
  let initializer = text.slice(eq + 1).trim();
  if (initializer.endsWith(";")) initializer = initializer.slice(0, -1).trim();
  return isPureReferenceExpression(initializer);
}

// ---------------------------------------------------------------------------
// Candidate identifiers a body reads that MIGHT be module-level constants
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * FIX-FAB item 3 (eval-0927 review #4/#6, lowerCamelConst/golang): reserved
 * words across TS/JS/Python/Go/Java/C#/C/C++ that `IDENTIFIER_RE` matches as
 * ordinary tokens but that can never be a constant/binding REFERENCE —
 * declaration/control keywords, boolean/null-ish literals, and the soft
 * keywords (`async`, `from`, `as`, `of`) this file's own import/declaration
 * shapes already key on. Needed only because `looksLikeConstantReference`
 * below is widened past the Capitalized/UPPER_SNAKE naming convention that
 * used to exclude an ordinary lowercase keyword BY ACCIDENT of case; case is
 * no longer the filter, so the exclusion has to be explicit. General
 * language vocabulary, not tied to any fixture.
 */
const RESERVED_WORD_RE = new RegExp(
  "^(?:" + [
    "const", "let", "var", "val", "def", "function", "func", "fn", "class", "struct", "enum", "interface", "type",
    "trait", "impl", "module", "namespace", "package", "import", "export", "from", "as", "default", "declare",
    "public", "private", "protected", "internal", "static", "final", "readonly", "abstract", "override", "virtual",
    "async", "await", "synchronized", "native", "inline", "sealed", "open", "suspend", "mut", "extern", "register",
    "volatile",
    "if", "else", "elif", "for", "foreach", "while", "do", "switch", "case", "when", "match", "select", "break",
    "continue", "return", "yield", "throw", "try", "catch", "finally", "new", "delete", "typeof", "instanceof",
    "in", "of", "is", "and", "or", "not", "pass", "lambda", "global", "nonlocal", "with", "assert", "raise",
    "except", "goto", "sizeof", "defer", "chan", "range", "go", "map",
    "true", "false", "null", "nil", "none", "None", "True", "False", "undefined", "void",
    "int", "bool", "float", "double", "char", "byte", "short", "long", "string",
    "self", "this", "super", "base", "cls",
  ].join("|") + ")$",
);

/**
 * True when `value` is shaped like a MODULE/PACKAGE-LEVEL binding reference
 * — UPPER_SNAKE (>=2 chars), a Capitalized identifier with at least one
 * lowercase letter (`Status`, `AbortController`), OR (item 3, eval-0927
 * review #4/#6) any other identifier of >=2 chars that is not a reserved
 * word. `export const
 * defaultOptions = {...}` and Python's `default_timeout_s = 5.5` are exactly
 * as real a module constant as `DEFAULT_OPTIONS` — naming CASE never told a
 * real module-level binding apart from an ordinary local, its SCOPE did, and
 * scope is what `constantLikeReferencesIn`'s own property-access skip and
 * `namesDeclaredWithin` exclusion (below) police; a name that turns out not
 * to have a matching declaration simply finds nothing downstream — bounded
 * and harmless, per this module's own no-guessing contract, and never
 * reported as a disclosed gap unless it is ALSO CONST_CASE-shaped (see
 * `isUnresolvableConstantName`, readCodeTaskPack.ts — an ordinary local that
 * slips through stays silent exactly as it already did before this widening).
 *
 * Deliberately MORE PERMISSIVE than requestFacets.ts's `isPascalCaseHump`
 * (which requires an INTERNAL case boundary, e.g. "AuthMiddleware", to tell
 * a real code identifier apart from an ordinary English word starting a
 * QUESTION -- "Explain..."). A source-code BODY has no such
 * sentence-initial-capitalization problem.
 *
 * R2-T3 (eval-0929 final review, P1-4's cjsRename* repros): a bare ALL-CAPS
 * word that is ordinary PROSE vocabulary in a QUESTION (`TTL`, `URL`, `API`,
 * `SQL`, `CPU` -- `concernRecovery.ts`'s `isProseAcronym`) used to be
 * dropped here for EVERY occurrence. That list answers "is this token a code
 * name or an English word in the user's sentence?" -- a question a SOURCE
 * body never asks: `return TTL;` inside a function body reads a binding named
 * `TTL`, and dropping the candidate meant a module constant named like an
 * acronym (`export const TTL = 9314`, `const { RAW_TTL: TTL } = require(...)`,
 * `import { RAW_TTL as TTL }`) was never looked up at all -- a false
 * `request-item-empty` (or `covered` with the literal never served) in the
 * commonest shape there is, whatever the import syntax. The acronym rule
 * survives only where it is right about the SOURCE: the operand of `new`
 * (`new HTTP.Request(url)`, `new URL(u)`) is a TYPE, never a constant
 * (`constantLikeReferencesIn`'s `constructedOnly`). Anywhere else the token
 * is a LOOKUP attempt (a miss is silent, see above); the disclosure rule for
 * an unresolved one keeps treating those acronyms conservatively
 * (readCodeTaskPack.ts, `disclosableNamedSpecs`), so a platform global such
 * as `URL` imported from a package never becomes a noisy gap.
 */
function looksLikeConstantReference(value: string): boolean {
  if (RESERVED_WORD_RE.test(value)) return false;
  return value.length >= 2;
}

/**
 * FIX-FAB item 3: names BOUND within `bodyLines` itself — a local
 * `const`/`let`/`var`/`val` declaration (TS/JS/Kotlin/Swift-ish), a Go short
 * variable declaration (`name := ...`), or a Python/Go simple assignment
 * (`name = ...` / `name: Type = ...`, always LOCAL here since `bodyLines`
 * is already sliced to one function's own body, never module level). Never
 * a module-level binding however it is spelled, so the widened, case-blind
 * `looksLikeConstantReference` net above must exclude these the same way it
 * already excludes a property/member access (`.name`) and the focal's own
 * name: scope, not spelling, is what tells a real module constant apart
 * from an ordinary local (brief: "excluding the focal's params/locals/
 * properties"). Parameter NAMES are deliberately not extracted here — a
 * parameter that slips through as a candidate simply fails to resolve
 * (harmless: a failed resolution never consumes the served-window budget,
 * see `constantClosureForFocal`), and a cross-language parameter-list
 * grammar (TS `name: Type`, Go `name Type`, Python bare `name`) is far
 * easier to get wrong than the declaration shapes this module already
 * commits to.
 */
function namesDeclaredWithin(
  bodyLines: readonly string[],
  hashComment: boolean,
  continuation: readonly boolean[] = argumentContinuationLines(bodyLines, hashComment),
): ReadonlySet<string> {
  const out = new Set<string>();
  const jsDeclRe = /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)/g;
  const goShortRe = /\b([A-Za-z_]\w*)\s*:=/g;
  // B1 follow-up (round-9 fable finding, own reproduction — rustMatchArmConstCondition/
  // csSwitchExpressionConstCondition): `=(?!=)` alone also matched the FIRST
  // character of a match-arm/switch-expression arrow `NAME => …`/`NAME -> …`
  // is not reachable here (Kotlin uses a literal `->`, never `=`), but Rust
  // `match`/C# switch-expression arms use `=>` — "RETRY_LIMIT => return
  // None," was wrongly read as a "simple assignment" declaring a LOCAL
  // named RETRY_LIMIT, which then silently excluded the genuine module
  // constant of the identical name from `constantLikeReferencesIn`'s
  // candidate set (the SAME false-exclusion class B1 removed from
  // `transientBindingNamesIn`, found in this SEPARATE function instead —
  // `topLevelAssignmentIndex` above already excludes both `==` and `=>` for
  // exactly this reason; this regex excluded only `==`). `(?![=>])` now
  // excludes both.
  const simpleAssignRe = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?![=>])/;
  for (const [index, rawLine] of bodyLines.entries()) {
    const masked = maskNonCode(rawLine, hashComment);
    for (const m of masked.matchAll(jsDeclRe)) out.add(m[1]!);
    for (const m of masked.matchAll(goShortRe)) out.add(m[1]!);
    // A `name=` line inside an open argument list is a keyword argument or a
    // parameter default (black-style `fetch(\n    url,\n    timeout=timeout,\n)`),
    // never an assignment statement: treating it as one excluded the imported
    // `timeout` from the whole body.
    if (continuation[index] === true) continue;
    const simple = simpleAssignRe.exec(masked.trimStart());
    if (simple) out.add(simple[1]!);
  }
  return out;
}

/**
 * Per body line: true when the line begins inside an argument or parameter
 * list, i.e. the innermost open bracket is a `(` or `[`. A `{` opened inside
 * one (a lambda or callback body) holds statements again, and a Go grouped
 * `var (` / `const (` / `import (` list holds declarations. A `name=value` at
 * the start of such a line is a keyword argument, a parameter default, an
 * annotation or attribute element, or a JSX attribute: a binding site of the
 * callee, never an assignment statement of this body and never a read.
 * Brackets are counted on masked text; an open frame is dropped when a later
 * line that does not start with a closer is indented no deeper than the
 * line that opened it, so an unbalanced bracket inside a multi-line string
 * cannot turn the rest of the body into "arguments" — unless the previous
 * code line ends with `(`, `[` or `,`, which only a continuation follows
 * (`fetch(url,\n    timeout=timeout)` written at the opener's own indent).
 */
export function argumentContinuationLines(bodyLines: readonly string[], hashComment: boolean, relPath?: string): boolean[] {
  const stack: { kind: "argument" | "declaration" | "block"; indent: number }[] = [];
  const out: boolean[] = [];
  let previousCodeEnd = "";
  for (const rawLine of bodyLines) {
    const masked = maskNonCode(rawLine, hashComment, relPath);
    const trimmed = masked.trim();
    const indent = masked.length - masked.trimStart().length;
    if (trimmed.length > 0 && !/^[)\]}]/.test(trimmed) && !/[(\[,]/.test(previousCodeEnd)) {
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    }
    if (trimmed.length > 0) previousCodeEnd = trimmed[trimmed.length - 1]!;
    out.push(trimmed.length > 0 && stack[stack.length - 1]?.kind === "argument");
    const groupOpen = /^(?:var|const|import)\s*\($/.test(trimmed) ? masked.lastIndexOf("(") : -1;
    for (let i = 0; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(" || ch === "[") stack.push({ kind: i === groupOpen ? "declaration" : "argument", indent });
      else if (ch === "{") stack.push({ kind: "block", indent });
      else if (ch === ")" || ch === "]" || ch === "}") stack.pop();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// B1 (round-8 fable finding, pyStarImportLowerConst/csUsingStaticPascalConst/
// cppScopedConst): every OTHER local-binding shape the two functions above
// do not cover. `namesDeclaredWithin`'s own doc called a bare parameter
// "harmless" to miss because a failed resolution simply consumed no served-
// window budget — true before round-7's V1 widening. V1 disclose*s* an
// imported-and-unresolved name, and (pre-B1) a WILDCARD import (`from x
// import *`, `using static X`, a quoted #include) was a candidate for EVERY
// queried name — B1's own `ImportSpecifier.wildcard` fix already narrows
// that, but a parameter/loop variable/kwarg name can in principle also
// collide with a NAMED (non-wildcard) import in the same file, so this is a
// second, independent guard: every shape below is POSITIVELY explained (a
// name genuinely bound at its own use site), the same class of drop
// `namesDeclaredWithin`'s locals already are — never a blanket noise filter.
// ---------------------------------------------------------------------------

/** A comma-split of `text` that keeps a bracket/paren/brace/angle-nested comma (a generic type argument, a default value's own call) from splitting one parameter/argument in two. */
function topLevelSplit(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/** The first bracket-depth-0 occurrence of `ch0` in `text`, or -1 — used to cut a parameter segment's own default-value tail off before reading its name. */
function topLevelIndexOf(text: string, ch0: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ch0) return i;
  }
  return -1;
}

/**
 * One parameter-list segment's own NAME: a leading `...`/`*`/`**` (JS rest,
 * Python args/kwargs) stripped, any default value past a top-level `=` cut
 * off, then `name: Type` (TS/Kotlin/Swift/Rust/Python-hint style, name
 * FIRST) whenever a top-level colon is present; otherwise the single bare
 * token (TS/JS/Python untyped), or — several space-separated tokens with no
 * colon — `nameFirst` picks Go's `name Type` order (name FIRST) vs Java/C#/
 * C++/Dart's `Type name` order (name LAST). Never guessed past what this can
 * parse with confidence: an empty/unparsable segment yields `undefined`.
 */
function parseParamSegmentName(rawSeg: string, nameFirst: boolean): string | undefined {
  let seg = rawSeg.trim();
  if (seg === "") return undefined;
  seg = seg.replace(/^\.\.\./, "").replace(/^\*{1,2}/, "").trim();
  const eqIdx = topLevelIndexOf(seg, "=");
  if (eqIdx !== -1) seg = seg.slice(0, eqIdx);
  seg = seg.trim();
  if (seg === "") return undefined;
  const colonMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(seg);
  if (colonMatch) return colonMatch[1];
  const tokens = seg.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const raw = (nameFirst ? tokens[0] : tokens[tokens.length - 1])!;
  const cleaned = raw.replace(/^[*&]+/, "").replace(/[[\]?!*&]+$/, "");
  return /^[A-Za-z_$][\w$]*$/.test(cleaned) ? cleaned : undefined;
}

/**
 * B1 (round-8 fable finding): the focal's OWN parameter names, read from its
 * own declaration signature — a value-position mention of a parameter is
 * fully explained by the signature itself, never an unresolved import.
 * Finds the focal's own name followed by a balanced parameter list (a
 * bounded scan over the first 20 lines of `bodyLines` — the signature is
 * always near the top, whatever else — a doc comment, a decorator — may sit
 * above it), splits it on top-level commas, then reads each segment's name
 * per this file's own extension: Go's `name Type` (name first, no colon) is
 * the one family here with an untyped-looking name BEFORE its type; every
 * other extension with a bare multi-token segment is Java/C#/C++/Dart-style
 * `Type name` (name last). A signature this cannot confidently locate (no
 * name+balanced-parens found within the bound) yields an empty set — never
 * guessed, and harmless exactly as `namesDeclaredWithin`'s own miss already is.
 */
export function focalParameterNames(bodyLines: readonly string[], hashComment: boolean, focalName: string, relPath: string): ReadonlySet<string> {
  const out = new Set<string>();
  if (focalName.length === 0) return out;
  const headRe = new RegExp(`\\b${escapeForRegex(focalName)}\\s*\\(`);
  const limit = Math.min(bodyLines.length, 20);
  let combined = "";
  let openIndex = -1;
  for (let i = 0; i < limit; i++) {
    const masked = maskNonCode(bodyLines[i] ?? "", hashComment);
    combined += (i > 0 ? "\n" : "") + masked;
    const m = headRe.exec(combined);
    if (m) { openIndex = m.index + m[0].length - 1; break; }
  }
  if (openIndex === -1) return out;
  let depth = 0;
  let end = -1;
  for (let i = openIndex; i < combined.length; i++) {
    const ch = combined[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return out;
  const paramText = combined.slice(openIndex + 1, end);
  const nameFirst = /\.go$/.test(relPath);
  for (const rawSeg of topLevelSplit(paramText, ",")) {
    const name = parseParamSegmentName(rawSeg, nameFirst);
    if (name !== undefined) out.add(name);
  }
  return out;
}

/**
 * B1 (round-8 fable finding): loop/comprehension variables (`for`/`foreach`,
 * every language's own "in"/"of" shape, a Java/C++/C#-style typed range-for
 * `for (Type x : xs)`, a C-style `for (Type x = 0; …)` init — Go's own
 * `x := …` short form is already `namesDeclaredWithin`'s own `goShortRe`),
 * `catch`/`except` variables, Python/JS lambda and arrow-function
 * parameters (reused verbatim by any callback bound inline in the body, not
 * only the focal's own signature), and a `name=value` KEYWORD-ARGUMENT name
 * in a call (Python/Ruby-style — the character immediately before `name`,
 * after whitespace, must be `(` or `,`, so an ordinary top-level
 * reassignment statement is never matched). Every shape is scanned across
 * the WHOLE body, not only the signature — a callback's own parameter list
 * is exactly as positively-explained as the focal's.
 */
export function transientBindingNamesIn(bodyLines: readonly string[], hashComment: boolean): ReadonlySet<string> {
  const out = new Set<string>();
  const forInOfRe = /\bfor\s*\(?\s*(?:const|let|var|val|mut)?\s*([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*)\s*)?(?:in|of)\b/g;
  const forColonRe = /\bfor\s*\(\s*[^:()]*?([A-Za-z_]\w*)\s*:\s*[^)]*\)/g;
  const forCStyleRe = /\bfor\s*\(\s*([^;()]*);/g;
  const catchColonRe = /\bcatch\s*\(\s*([A-Za-z_]\w*)\s*:/g;
  const catchTrailingRe = /\bcatch\s*\(\s*(?:[\w.<>[\],\s]*\s)?([A-Za-z_]\w*)\s*\)/g;
  const exceptAsRe = /\bexcept\b[^:]*\bas\s+([A-Za-z_]\w*)\s*:/g;
  const lambdaPyRe = /\blambda\b([^:]*):/g;
  const arrowParenRe = /\(([^()]*)\)\s*=>/g;
  const arrowBareRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  const kotlinLambdaRe = /\{\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*->/g;
  const kwargRe = /[(,]\s*([A-Za-z_]\w*)\s*=(?!=)/g;
  const addParamList = (text: string): void => {
    for (const rawSeg of text.split(",")) {
      const name = parseParamSegmentName(rawSeg, true);
      if (name !== undefined) out.add(name);
    }
  };
  for (const rawLine of bodyLines) {
    const masked = maskNonCode(rawLine, hashComment);
    for (const m of masked.matchAll(forInOfRe)) { out.add(m[1]!); if (m[2]) out.add(m[2]); }
    for (const m of masked.matchAll(forColonRe)) out.add(m[1]!);
    for (const m of masked.matchAll(forCStyleRe)) {
      const init = m[1]!.trim();
      if (init === "") continue;
      const eqIdx = init.indexOf("=");
      const decl = (eqIdx === -1 ? init : init.slice(0, eqIdx)).trim();
      const tokens = decl.split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1]?.replace(/^[*&]+/, "");
      if (last && /^[A-Za-z_]\w*$/.test(last)) out.add(last);
    }
    for (const m of masked.matchAll(catchColonRe)) out.add(m[1]!);
    for (const m of masked.matchAll(catchTrailingRe)) out.add(m[1]!);
    for (const m of masked.matchAll(exceptAsRe)) out.add(m[1]!);
    for (const m of masked.matchAll(lambdaPyRe)) addParamList(m[1]!);
    for (const m of masked.matchAll(arrowParenRe)) addParamList(m[1]!);
    for (const m of masked.matchAll(arrowBareRe)) out.add(m[1]!);
    for (const m of masked.matchAll(kotlinLambdaRe)) addParamList(m[1]!);
    for (const m of masked.matchAll(kwargRe)) out.add(m[1]!);
  }
  return out;
}

/**
 * P0-4's OVER-SERVING GUARD: true when the call-shaped occurrence of `token`
 * at `masked[at..]` (already confirmed `token.identifier(` by the caller) is
 * a BARE STATEMENT — its own return value used for nothing
 * (`logger.info("charge");`, `await logger.flush();`) — as opposed to a call
 * whose result feeds a larger expression (`RETRYABLE_STATUSES.has(status) &&
 * attempt < max`, `return X.has(y);`, `if (X.has(y)) {`), which DOES read the
 * receiver's own data and must never be excluded (evidenceClosure.spec.ts's
 * own existing case: `RETRYABLE_STATUSES.has(status) || Status.Active ===
 * status` — `RETRYABLE_STATUSES` is exactly this shape). Deliberately keyed
 * on the concrete call syntax (what comes immediately before the receiver
 * and immediately after the call's own matching `)` on this same line),
 * never on a method-name allow/deny list — a query-shaped name out of an
 * unbounded real-world vocabulary (`.get`, `.has`, `.find`, ...) is not a
 * closed set, and `logger.info` / `RETRYABLE_STATUSES.has` cannot be told
 * apart by name alone.
 */
function isBareReceiverStatement(masked: string, at: number): boolean {
  const before = masked.slice(0, at);
  const boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"));
  const prefix = before.slice(boundary + 1).trim();
  if (prefix !== "" && !/^(?:await|void)$/.test(prefix)) return false;
  const openParen = masked.indexOf("(", at);
  if (openParen === -1) return false;
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { closeParen = i; break; }
    }
  }
  if (closeParen === -1) return false; // unbalanced on this line -- never wrongly excluded
  const suffix = masked.slice(closeParen + 1).trim();
  return suffix === "" || suffix === ";";
}

const RECEIVER_CALL_RE = /^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/u;

/** A `::` path rooted at a primitive type or the standard library, ending right before a member. */
const BUILTIN_SCOPE_PATH_RE = /(?<![\w$:])(?:std|core|alloc|u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64|char|bool|str)(?:::[A-Za-z_]\w*)*::$/;

/** Extensions whose call syntax uses `name=value` keyword/named arguments (Python, Kotlin, Scala). */
const KEYWORD_ARG_LANG_RE = /\.(?:py|kt|kts|scala|sc)$/;

/**
 * B1 (round-9 fable finding, pyKwargSameNameImportedConst/rustMatchArmConstCondition
 * — THE ROUND-9 LESSON): true when the occurrence of `token` at `masked[at..]`
 * is the NAME half of a keyword/named argument DIRECTLY inside a call's own
 * argument list — `name=` (never `==`) immediately preceded, after
 * whitespace, by `(` or `,`. That one TOKEN is a binding site, not a read: the
 * caller is telling the callee which parameter to fill, not reading a value
 * named `token`. Positional only, exactly as the round-9 lesson requires — the
 * SAME name at its call's own VALUE side (`timeout=timeout`), or anywhere else
 * in the body, is scanned normally by every other occurrence of the identical
 * token; this test looks at nothing but the text immediately around THIS one
 * occurrence, never the name globally (the bug this replaces —
 * `transientBindingNamesIn`'s `kwargRe` feeding a NAME-level `excludeNames` —
 * dropped `timeout=timeout`'s VALUE side too, hiding the imported constant
 * `pyKwargSameNameImportedConst` needed). Callers gate this to Python/Kotlin/
 * Scala files only (`KEYWORD_ARG_LANG_RE`) — the one family of languages
 * `name=value` inside a call means a named argument; elsewhere (`foo(x = 5)`
 * in JS, a rare assignment-as-argument-expression) this test is never applied.
 */
function isKeywordArgumentNamePosition(masked: string, at: number, token: string): boolean {
  const before = masked.slice(0, at).trimEnd();
  const prevCh = before[before.length - 1];
  if (prevCh !== "(" && prevCh !== ",") return false;
  const after = masked.slice(at + token.length);
  const eqMatch = /^\s*=/.exec(after);
  if (!eqMatch) return false;
  return after[eqMatch[0].length] !== "=";
}

/**
 * Constant-shaped identifiers `bodyLines` references, in first-appearance
 * order, deduplicated, excluding: an identifier immediately preceded by `.`
 * (a property/member name — "skip locals/params/properties (.name)", brief
 * Deliverable 2), the focal's own name (never its own definition), a name
 * `namesDeclaredWithin` finds LOCALLY bound in this same body (item 3),
 * anything in `excludeNames` (e.g. a callee's own name when scanning ITS
 * body, when the hook can supply it — optional, an empty set is always safe),
 * and (P0-4's over-serving guard) a name whose EVERY occurrence in this body
 * is a bare-statement call through it as a receiver (`logger.info(...)`,
 * never used as a value) — `isBareReceiverStatement` above — and the member
 * of a `::` path rooted at a primitive type or the standard library
 * (`u32::MAX`, `std::f64::consts::PI`), a language constant.
 */
export function constantLikeReferencesIn(
  bodyLines: readonly string[],
  hashComment: boolean,
  ownName: string,
  excludeNames: ReadonlySet<string> = new Set(),
  /**
   * OPTIONAL, purely additive (R6-C, eval-0927 review-r5 P1-3): the focal's
   * own workspace-relative path, forwarded to `maskNonCode` so a value
   * hidden inside a C#/Kotlin/Swift/Ruby interpolated string or past a
   * JS/TS regex literal (csInterpolatedConst/ktTemplateConst/
   * tsRegexQuoteConst) is not silently masked away. Omitted, this function's
   * behaviour is byte-for-byte what it was before this parameter existed.
   */
  relPath?: string,
  /**
   * OPTIONAL (Copilot standard-setup evaluation, 2026-10-02): the path that
   * decides whether an unquoted object-literal KEY is skipped
   * (`isObjectLiteralKeyPosition`, TS/JS only). Defaults to `relPath`; a
   * caller scanning a resolved window's own initializer passes that
   * window's path here WITHOUT `relPath`, so the scan's masking and
   * continuation handling stay exactly what they were.
   */
  objectKeyLangPath: string | undefined = relPath,
): string[] {
  const skipObjectKeys = objectKeyLangPath !== undefined && OBJECT_KEY_LANG_RE.test(objectKeyLangPath);
  const continuation = argumentContinuationLines(bodyLines, hashComment, relPath);
  const locallyBound = namesDeclaredWithin(bodyLines, hashComment, continuation);
  const order: string[] = [];
  const seenOrder = new Set<string>();
  // Running AND, per token: does EVERY occurrence seen so far look like a
  // discardable `token.method(...)` statement? A single occurrence that is
  // either a bare value use or a call whose result is used flips this false
  // for good (short-circuits the very next update via `(prior ?? true) &&
  // isBareUse`, never re-set true afterward).
  const bareReceiverOnly = new Map<string, boolean>();
  // R2-T3: the same running AND for "EVERY occurrence is the operand of
  // `new`" -- only ever consulted for a prose acronym (see the return below).
  const constructedOnly = new Map<string, boolean>();
  let prevTail = "";
  for (const [index, rawLine] of bodyLines.entries()) {
    const masked = maskNonCode(rawLine, hashComment, relPath);
    const lineTail = prevTail;
    prevTail = lastCodeChar(masked) ?? prevTail;
    for (const match of masked.matchAll(IDENTIFIER_RE)) {
      const token = match[0];
      const at = match.index ?? -1;
      // A `::`-qualified member (`config::TIMEOUT_MS`, PHP `self::MAX`, C++
      // `Client::MAX` inside `Client`, `crate::config::MAX`) stays a
      // candidate: it is the only way an owner that is neither a type nor a
      // known module alias is chased at all. A disclosure it leaves next to
      // a resolved `Owner.member` window is reconciled away afterwards
      // (readCodeTaskPack.ts, `reconcileQualifiedMemberDisclosures`).
      if (at > 0 && masked[at - 1] === ".") continue;
      if (at > 1 && masked[at - 1] === ":" && masked[at - 2] === ":" && BUILTIN_SCOPE_PATH_RE.test(masked.slice(0, at))) continue;
      // B1 (round-9 fable finding): a POSITIONAL skip, not a name-level one —
      // only THIS occurrence (the kwarg NAME token) is excluded; the same
      // token's value-side occurrence elsewhere on this same line, or on any
      // other line, is still scanned normally.
      if (relPath !== undefined && KEYWORD_ARG_LANG_RE.test(relPath) && isKeywordArgumentNamePosition(masked, at, token)) continue;
      // The same binding site on its own line inside an open argument list
      // (black-style calls, hanging indents, multi-line parameter defaults,
      // annotation elements, JSX attributes): the first token followed by
      // `=` (never `==`/`=>`) names the callee's parameter, it is not a read.
      if (continuation[index] === true && masked.slice(0, at).trim() === "" && /^\s*=(?![=>])/.test(masked.slice(at + token.length))) continue;
      // A POSITIONAL skip too: an object-literal key names a property, never
      // the same-named binding (see isObjectLiteralKeyPosition).
      if (skipObjectKeys && isObjectLiteralKeyPosition(masked, at, token, lineTail)) continue;
      if (token === ownName || excludeNames.has(token) || locallyBound.has(token)) continue;
      if (!seenOrder.has(token)) { seenOrder.add(token); order.push(token); }
      const after = masked.slice(at + token.length);
      const isBareUse = RECEIVER_CALL_RE.test(after) && isBareReceiverStatement(masked, at);
      bareReceiverOnly.set(token, (bareReceiverOnly.get(token) ?? true) && isBareUse);
      constructedOnly.set(token, (constructedOnly.get(token) ?? true) && /\bnew\s+$/.test(masked.slice(0, at)));
    }
  }
  // A prose acronym (`API`, `HTTP`, `URL`, `TTL`...) is a candidate like any
  // other name EXCEPT as the operand of `new` (`new HTTP.Request(url)`,
  // `new URL(u)`): there it names a type, never a constant. Everywhere else
  // it is a binding a body may read (`return TTL;`) -- see
  // `looksLikeConstantReference`'s own R2-T3 note.
  return order.filter((token) =>
    !bareReceiverOnly.get(token)
    && !(constructedOnly.get(token) === true && isProseAcronym(token))
    && looksLikeConstantReference(token));
}

/**
 * TS/JS-family sources (Copilot standard-setup evaluation, 2026-10-02): an
 * unquoted object-literal key there names a property and never reads a
 * binding. Python dicts, Go map literals and Swift dictionaries key by VALUE
 * (`{KEY: v}` reads `KEY`), so they are deliberately absent.
 */
const OBJECT_KEY_LANG_RE = /\.[cm]?[jt]sx?$/i;

/** The last non-whitespace character of a masked line; undefined for a blank (or comment-only) line. */
function lastCodeChar(masked: string): string | undefined {
  const trimmed = masked.trimEnd();
  return trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined;
}

/**
 * Copilot standard-setup evaluation (2026-10-02): true when the occurrence
 * of `token` at `at` in `masked` is an unquoted object-literal KEY -- callers
 * gate this on OBJECT_KEY_LANG_RE (TS/JS) -- i.e. followed by a single `:`
 * (or the `?:` of an optional property) and preceded by `{` or `,`, on this
 * line or, for a key that opens its own line, as the last code character of
 * the lines before it (`prevTail`). Such a key names a property and never
 * reads the same-named binding. Measured: `return {subtotal, ...,
 * shipping:delivery}` in a `quote` that also imports the function
 * `shipping` was read as a VALUE read of that import, and its failed
 * constant resolution became the false "shipping is read by quote but its
 * declaration could not be resolved"; `return { MAX_RETRIES: 3 }` and an
 * `export const LIMITS = { MAX_RETRIES: 3 }` initializer were disclosed the
 * same way. A ternary's middle (`cond ? NAME : other`, preceded by `?`), a
 * `case NAME:` label and a computed key (`[NAME]:`) are reads and stay
 * reads.
 */
export function isObjectLiteralKeyPosition(masked: string, at: number, token: string, prevTail: string): boolean {
  if (!/^\??\s*:(?!:)/.test(masked.slice(at + token.length))) return false;
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i]!)) i--;
  const before = i >= 0 ? masked[i]! : prevTail;
  return before === "{" || before === ",";
}

/**
 * V1 (round-7 fable finding, orchestrator generalization): true when `at`
 * (an occurrence's start index in `masked`) sits inside a TYPE ANNOTATION
 * (`: Type`) rather than a value expression -- scanned backward from `at`
 * for the nearest `:`/statement boundary; a `:` reached first, with only
 * type-shaped punctuation and identifiers in between, means `at` is a type
 * reference, never a value read (TS/Kotlin/Swift/C#-style `name: Type =
 * init`, Python type hints `name: Type = init`). `::` (Rust/C++ scope) and a
 * ternary's `?:` are excluded from counting as that boundary.
 */
function isTypeAnnotationPosition(masked: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0) {
    const ch = masked[i]!;
    if (ch === ":") return masked[i - 1] !== ":" && masked[i - 1] !== "?";
    if (/[A-Za-z0-9_$<>[\]|&.,?\s]/.test(ch)) { i--; continue; }
    return false;
  }
  return false;
}

/**
 * V1 (round-7 fable finding): true when at least one occurrence of `name` in
 * `bodyLines` reads it in a VALUE position -- not immediately invoked
 * (`name(`, `new name(`), not used only as a discarded call receiver
 * (`name.method(...)`, the SAME bare-statement guard `isBareReceiverStatement`
 * already applies above), and not a type annotation. A name every occurrence
 * of which is call-only is a CALLEE this scan may still chase THROUGH when it
 * resolves (P0-4), but failing to resolve it is never disclosed as missing
 * VALUE evidence: the facet never needed the name's own "value", only
 * whatever it returns or does.
 */
export function hasValuePositionOccurrence(
  bodyLines: readonly string[],
  hashComment: boolean,
  name: string,
  /**
   * OPTIONAL (Copilot standard-setup evaluation, 2026-10-02): the path that
   * decides whether an unquoted object-literal KEY is skipped -- see
   * `isObjectLiteralKeyPosition`. Omitted, no key is skipped (the
   * pre-existing behaviour).
   */
  objectKeyLangPath?: string,
): boolean {
  if (name.length === 0) return false;
  const skipObjectKeys = objectKeyLangPath !== undefined && OBJECT_KEY_LANG_RE.test(objectKeyLangPath);
  const occurrenceRe = new RegExp(`(?<![\\w$.])${escapeForRegex(name)}(?![\\w$])`, "g");
  let prevTail = "";
  for (const rawLine of bodyLines) {
    const masked = maskNonCode(rawLine, hashComment);
    const lineTail = prevTail;
    prevTail = lastCodeChar(masked) ?? prevTail;
    for (const match of masked.matchAll(occurrenceRe)) {
      const at = match.index ?? -1;
      if (at < 0) continue;
      if (skipObjectKeys && isObjectLiteralKeyPosition(masked, at, name, lineTail)) continue;
      if (isTypeAnnotationPosition(masked, at)) continue;
      const after = masked.slice(at + name.length);
      if (/^\s*\(/.test(after)) continue; // name( / new name( -- invoked, not read
      if (RECEIVER_CALL_RE.test(after) && isBareReceiverStatement(masked, at)) continue; // name.method(...) discarded
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Callee names a body calls (for the "one hop of in-workspace callees" rule
// and the `flow` facet's "definitions of direct callees")
// ---------------------------------------------------------------------------

/** Bare call-shaped keywords that are never a real callee (control flow / declarations), mirroring the small, closed guard lists this codebase already uses at this granularity (e.g. `inferCallableSymbol`'s own `if|for|while|switch|catch` list). */
const CALL_SHAPE_EXCLUDED_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "function", "def", "class", "return", "new", "typeof", "instanceof",
  "await", "yield", "async", "case", "in", "of", "delete", "void", "throw", "super", "this",
]);

/**
 * Runtime/standard-library globals: NEVER an in-workspace callee by
 * definition (no import line, no local declaration, could ever name one),
 * so excluding them here spends `calleeNamesIn`'s caller's bounded
 * MAX_CALLEES_PER_REQUIREMENT budget only on candidates that could possibly
 * resolve. Confirmed root cause (FIX-C1, 2026-09-27, live V01/§4/V05
 * reproduction): `fetchWithRetry`'s body calls `AbortController`,
 * `setTimeout`, `fetch`, `clearTimeout` and `Promise` BEFORE it calls
 * `shouldRetry` (first-appearance order); with a bound of 3 and these five
 * unresolvable globals ahead of it, `shouldRetry` -- the one callee that
 * actually leads to `RETRYABLE_STATUSES` -- was never reached at all.
 * TS/JS + Python + Go, the language families this module's own per-language
 * spec cases cover; Java/C#'s standard library is overwhelmingly reached
 * through a qualified `Class.method(` shape this function already returns
 * (`method`, not `Class`), so it has little unqualified-global surface to
 * list here. A workspace that happens to declare its OWN function under one
 * of these exact names is the one (rare, and functionally harmless -- that
 * name just never becomes a resolved callee) trade-off this makes.
 */
export const COMMON_BUILTIN_CALLEES: ReadonlySet<string> = new Set([
  // JS/TS
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "clearImmediate", "fetch",
  "Promise", "AbortController", "Array", "Object", "Map", "Set", "JSON", "Math", "Date", "Error", "TypeError",
  "RangeError", "console", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "encodeURI",
  "decodeURI", "RegExp", "Symbol", "WeakMap", "WeakSet", "Proxy", "Reflect", "Buffer", "require", "structuredClone",
  "isNaN", "isFinite", "Number", "String", "Boolean", "Function",
  // Python
  "print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple", "open", "isinstance", "type",
  "super", "enumerate", "zip", "map", "filter", "sorted", "sum", "min", "max", "abs", "round", "input", "format",
  "repr", "hasattr", "getattr", "setattr", "iter", "next",
  // Go
  "cap", "make", "append", "panic", "recover", "println", "copy", "close", "complex", "imag", "real",
]);

/**
 * FIX-FAB2 (eval-0927 orchestrator repro, afx, 2026-09-28): true when a
 * call-shaped occurrence of a name at `masked[afterNameIndex..]` (already
 * confirmed call-shaped by the caller — `afterNameIndex` is right where the
 * name's own `(` begins, mod whitespace) is actually a DECLARATION opening a
 * body on this SAME line: its own parameter list's matching `)` is found on
 * this line and the very next non-whitespace character is `{` — a one-line
 * method shorthand (`place() { payment(); }`, an entire Java/C# member on
 * one line) or an ordinary multi-line-body declaration whose own header
 * still closes and opens its brace on one line (`cancel(id) {`). The
 * parameter list's own nested parens are balanced, so a default value that
 * itself calls something (`loadOptions(env = foo())`) does not stop the
 * scan early. `false` when the matching `)` is not found on this line (a
 * signature split across lines) — `calleeNamesIn` then falls back to
 * treating the occurrence as an ordinary call, the same recall-over-
 * precision default `declarationHeadShape`'s own empty-head case relies on
 * `opensBlockDeclaration`'s right-hand check to resolve.
 */
function opensBlockOnSameLine(masked: string, afterNameIndex: number): boolean {
  let i = afterNameIndex;
  while (i < masked.length && /\s/.test(masked[i]!)) i++;
  if (masked[i] !== "(") return false; // not call-shaped after all (caller already checked; defensive)
  let depth = 0;
  for (; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < masked.length && /\s/.test(masked[j]!)) j++;
        return masked[j] === "{";
      }
    }
  }
  return false; // matching ) not found on this line
}

/**
 * Identifiers `bodyLines` calls directly (a call-shaped occurrence: the name
 * immediately followed by `(`, not one of the control-flow/declaration
 * keywords above, not immediately preceded by `.` unless the caller wants
 * qualified calls too — kept SIMPLE and INCLUSIVE here: a `.method(` call's
 * `method` is still returned, since a same-file/imported free FUNCTION and a
 * qualified `obj.method(` both name something the hook may want to resolve
 * as a callee one hop deep). First-appearance order, deduplicated, excludes
 * `ownName` (never its own recursive call) and anything in `excludeNames`.
 *
 * FIX-FAB2 (eval-0927 orchestrator repro, afx): a call-shaped occurrence
 * that is itself the NAME's OWN declaration — a class/interface member
 * header, whether its body opens on this same line or a later one — is
 * never a callee: scanning a TYPE's whole body (the flow facet's
 * non-callable-focal path, readCodeTaskPack.ts's
 * `flowStepWindowsForNonCallableFocal`) previously counted every one of the
 * type's OWN member declarations (`place() { ... }`, `helperN() { ... }`) as
 * if they were things the type "called". Reuses callerExpansion.ts's
 * `declarationHeadShape` (FIX-FAB item 1's left-hand test, shared so the two
 * modules stay consistent) plus the same-line right-hand proof above. A
 * declaration is skipped WITHOUT being marked `seen`, so a genuine call to
 * the same name found LATER in `bodyLines` (e.g. a sibling method that
 * really does call it) still registers.
 */
export function calleeNamesIn(
  bodyLines: readonly string[],
  hashComment: boolean,
  ownName: string,
  excludeNames: ReadonlySet<string> = new Set(),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of bodyLines) {
    const masked = maskNonCode(rawLine, hashComment);
    for (const match of masked.matchAll(IDENTIFIER_RE)) {
      const token = match[0];
      const at = match.index ?? -1;
      const after = masked.slice(at + token.length);
      if (!/^\s*\(/.test(after)) continue; // not call-shaped
      if (token === ownName || excludeNames.has(token) || seen.has(token)) continue;
      if (declarationHeadShape(masked.slice(0, at)) && opensBlockOnSameLine(masked, at + token.length)) continue;
      seen.add(token);
      if (CALL_SHAPE_EXCLUDED_KEYWORDS.has(token) || COMMON_BUILTIN_CALLEES.has(token)) continue;
      out.push(token);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import-line resolution — the specifier a name plausibly arrives through
// ---------------------------------------------------------------------------

export interface ImportSpecifier {
  /** Verbatim specifier as written: a relative path ("./config", ".config"), a header ("x.h"), or a dotted package/class path (Python absolute import, Java `import static`, C# `using static`). */
  readonly specifier: string;
  /** True when `specifier` is written as a relative FILE reference (TS/JS "./x"/"../x", Python ".x", C/C++ "x.h" — a `#include "..."` is always treated as workspace-relative). False for a bare package/module/class path the hook must still try to resolve inside the workspace (Python absolute "pkg.x", Java "pkg.Class", C# "Namespace.Class"). */
  readonly relative: boolean;
  /**
   * B1 (round-8 fable finding, pyStarImportLowerConst/csUsingStaticPascalConst/
   * cppScopedConst): true when this specifier does NOT name any particular
   * binding — Python `from x import *`, C# `using static X`, a quoted C/C++
   * `#include` (every local header is a candidate for EVERY name, by this
   * module's own long-standing design), a TS/JS `export * from`, Java/Kotlin
   * `import a.b.C.*` / `import a.b.*`. `resolveConstantWindow`'s own
   * barrel/wildcard-owner chase may still resolve a name THROUGH a wildcard
   * spec (it is a real candidate FILE to try), but a wildcard never proves
   * the file "imports" the exact queried name the way a plain/aliased/
   * default/namespace entry does — V1's disclosure rule ("a name the file
   * imports, read in a value position, is disclosed") and the package-
   * wording gate both require `!wildcard` (readCodeTaskPack.ts,
   * `chaseConstant`). OPTIONAL (absent === `false`, an ordinary NAMED spec):
   * `importSpecifiersNaming`'s own `push` always sets it explicitly; the few
   * ad-hoc `ImportSpecifier`-shaped literals built elsewhere for a single
   * resolved-file lookup (never returned to a `chaseConstant` disclosure
   * decision) are unaffected.
   */
  readonly wildcard?: boolean;
  /**
   * B1: true only for a TS/JS module specifier or a Python import (any
   * shape) — the two families the eval's own package wording ("X is
   * imported from package P") was written for. A Java `import static`, a C#
   * `using static`, or a quoted C/C++ `#include` is a NAMESPACE/TYPE/HEADER
   * path, never a "package", even though it is also non-relative — false
   * here regardless of what `relative` says, so the package-wording gate
   * (`packageSpec = namedSpecs.find((s) => !s.relative && s.packageEligible)`)
   * never fires for one. OPTIONAL (absent === `false`), same reasoning as
   * `wildcard` above.
   */
  readonly packageEligible?: boolean;
  /**
   * FIX-ALIAS (eval-0929 §4, aliasTransitive/aliasSingle/aliasPathNamed):
   * the name this specifier's SOURCE module declares — set ONLY when it
   * differs from the LOCAL bound name the caller queried (`name`), i.e. only
   * for a rename: TS/JS `import { A as B }` / `export { A as B } from` /
   * `import { default as B }` (here `exportedName` is the literal string
   * `"default"` — the caller resolves the target's default export, or
   * discloses when it cannot), CJS/ESM destructure `const { A: B } =
   * require(...)`, Python `from m import A as B`, Kotlin/Scala member import
   * `import a.b.A as B`. OPTIONAL, purely additive: every NON-aliased spec
   * (the overwhelming majority) leaves this `undefined`, meaning "the same
   * name queried" — a caller that never reads this field resolves EXACTLY as
   * it always did. A caller that chases an import hop MUST look up
   * `spec.exportedName ?? name` in the resolved target file, never the bare
   * `name` alone — resolving under the LOCAL alias instead of the name the
   * target module actually declares is the confirmed root cause of a served
   * value window whose own text is nothing but an unresolved reference
   * (`timeoutMs: DEFAULT_MS`) being certified `covered` while the literal
   * behind the alias (`7231`) never reaches the client.
   */
  readonly exportedName?: string;
}

/**
 * A whole-line comment (never a block-comment CONTINUATION across lines —
 * same deliberate single-line abstention `maskNonCode` itself documents: a
 * multi-line block comment with no opener of its own on THIS line cannot be
 * classified without real parsing). `hashComment` distinguishes Python's `#`
 * comment marker from C/C++'s `#include`/`#define`, which must never be
 * treated as a comment here.
 */
function isCommentLine(rawLine: string, hashComment: boolean): boolean {
  const trimmed = rawLine.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || (hashComment && trimmed.startsWith("#"));
}

/** R2-T3: how many physical lines one wrapped import/require statement may span before the join gives up and leaves the opener line as it was (a runaway brace never swallows the file). */
const MAX_IMPORT_STATEMENT_LINES = 64;

/** The opener of a JS/TS statement whose `{ ... }` list may wrap over several lines: `import {`, `import D, {`, `import type {`, `export {`, `export type {`, and a CJS destructure `const|let|var {`. `export default {`/`export const x = {` are object LITERALS, not import lists, and deliberately do not match. */
const JS_WRAPPED_LIST_HEAD_RE = /^\s*(?:import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?|export\s+(?:type\s+)?|(?:const|let|var)\s*)\{/;
/** The opener of a Python `from m import (` ... `)` list (isort/black wrap every long import this way). */
const PY_WRAPPED_LIST_HEAD_RE = /^\s*from\s+[.\w]+\s+import\s*\(/;

/** `text` without a trailing `//` line comment (outside quotes) and without inline block comments. */
function withoutJsComments(text: string): string {
  const noBlock = text.replace(/\/\*.*?\*\//g, " ");
  let quote = "";
  for (let i = 0; i < noBlock.length; i++) {
    const ch = noBlock[i]!;
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "/" && noBlock[i + 1] === "/") return noBlock.slice(0, i);
  }
  return noBlock;
}

/**
 * R2-T3 (eval-0929 final review, P1-4 -- and the ESM twin it exposed): the
 * statement that starts at `lines[at]`, on ONE line. A named-import list,
 * CJS destructure or Python parenthesised import that prettier/black wrapped
 *
 *     const {
 *       RAW_TTL: TTL_MS,
 *       OTHER,
 *     } = require("./consts");
 *
 * was matched by no shape below (every regex is single-line), so its names
 * were bound to NOTHING -- and an unbound camelCase/PascalCase name is never
 * disclosed either (`isUnresolvableConstantName` needs CONST_CASE, the V1
 * import rule needs a NAMED spec), i.e. a false `request-item-empty` for the
 * commonest way real code spells a multi-name import. The wrapped list is
 * joined (comments stripped, bounded to MAX_IMPORT_STATEMENT_LINES, and only
 * when its closer is actually found) so every shape reads it exactly like the
 * single-line spelling. Anything else -- including a statement that already
 * fits on its line -- is returned unchanged.
 */
function joinedImportStatement(lines: readonly string[], at: number): string {
  const first = lines[at]!;
  const brace = JS_WRAPPED_LIST_HEAD_RE.test(first);
  const paren = !brace && PY_WRAPPED_LIST_HEAD_RE.test(first);
  if (!brace && !paren) return first;
  const open = brace ? "{" : "(";
  const close = brace ? "}" : ")";
  const strip = brace ? withoutJsComments : (text: string): string => text.replace(/(^|\s)#.*$/, "$1");
  const count = (text: string, ch: string): number => { let n = 0; for (const c of text) if (c === ch) n++; return n; };
  let statement = first;
  let depth = count(first, open) - count(first, close);
  if (depth > 0) {
    const parts = [strip(first)];
    for (let j = at + 1; j < lines.length && j <= at + MAX_IMPORT_STATEMENT_LINES && depth > 0; j++) {
      const piece = strip(lines[j]!);
      depth += count(piece, open) - count(piece, close);
      parts.push(piece);
    }
    // Never closed within the bound: leave the opener line alone.
    if (depth > 0) return first;
    statement = parts.join(" ");
  } else if (paren) {
    statement = strip(first);
  }
  // `from m import ( A, B, )` -> `from m import A, B,` (the one-line parser reads a bare list).
  return paren ? statement.replace(/^(\s*from\s+[.\w]+\s+import\s*)\(\s*/, "$1").replace(/\s*\)\s*$/, "") : statement;
}

/**
 * R2-T3: the LOCAL names a JS/TS object-destructuring pattern binds, each with
 * the top-level KEY it reads from the destructured value -- `pattern` is the
 * text BETWEEN the outer braces. `A` -> (A, A); `A: B` -> (A, B); a default
 * (`A = 1`, `A: B = 1`) is irrelevant to which export is read and is cut
 * off; `...rest` binds the remaining exports as one object (no single key,
 * skipped); a nested pattern (`A: { B, C: D }`) binds each inner local to the
 * OUTER key `A` -- the export that carries them -- so the chase serves that
 * export's own declaration. A computed/quoted non-identifier key can never
 * name a declared binding and is skipped.
 */
function destructuredBindings(pattern: string): Array<{ key: string; local: string }> {
  const out: Array<{ key: string; local: string }> = [];
  for (const rawMember of topLevelSplit(pattern, ",")) {
    const member = rawMember.trim();
    if (member === "" || member.startsWith("...")) continue;
    const colon = topLevelIndexOf(member, ":");
    const keyEnd = colon !== -1 ? colon : topLevelIndexOf(member, "=");
    const key = (keyEnd === -1 ? member : member.slice(0, keyEnd)).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    if (colon === -1) { out.push({ key, local: key }); continue; }
    let target = member.slice(colon + 1).trim();
    const eq = topLevelIndexOf(target, "=");
    if (eq !== -1) target = target.slice(0, eq).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(target)) out.push({ key, local: target });
    else if (target.startsWith("{") && target.endsWith("}")) {
      for (const inner of destructuredBindings(target.slice(1, -1))) out.push({ key, local: inner.local });
    }
  }
  return out;
}

/**
 * Import (and TS/JS re-export) lines in `fileLines` that plausibly bring
 * `name` into scope, across TS/JS (named/default/namespace import, `require`
 * destructuring, a named `export { X } from`/`export { Y as X } from`
 * barrel re-export, or an unnamed `export * from` wildcard re-export — item
 * 4, eval-0927 review #7), Python (`from x import name` / `from .x import
 * name`, `import pkg.mod[.name]`), Java (`import static pkg.Class.name`),
 * C# (`using static Namespace.Class` — names everything in the class, so any
 * such line is a candidate carrier), and C/C++ (`#include "x.h"` — a macro/
 * enum/const has no per-name import trace, so every local header include is
 * a candidate the hook tries, bounded by the re-export search's own file
 * budget -- readCodeTaskPack.ts, MAX_REEXPORT_FILES_TOTAL).
 * Go is deliberately absent — a Go package import never names an individual
 * constant (`pkg.Name` is a QUALIFIED reference, this module's own stated
 * limitation); the hook resolves Go's same-PACKAGE (same-directory)
 * visibility itself, since that needs a directory listing this pure module
 * cannot perform.
 *
 * B2 (round-9 fable finding, ktImportedTopLevelConst/ktImportedObjectMemberConst):
 * `filePath`, OPTIONAL and purely additive (omitted, every shape below
 * matches exactly as it always has — no existing caller/spec is affected),
 * gates the Python bare-`import a.b[.c] [as x]` shape to `.py` files only.
 * That shape is syntactically IDENTICAL to a semicolon-less Kotlin/Scala
 * member import (`import cfg.TIMEOUT_MS`) — without the gate, a Kotlin file
 * imports a WORKSPACE-DECLARED constant and this function wrongly reported
 * it as "imported from package cfg.TIMEOUT_MS" (own reproduction: neither a
 * package nor found there — cfg is a workspace package, TIMEOUT_MS its own
 * top-level declaration). The JVM shape itself is resolved separately, in
 * readCodeTaskPack.ts's `findJvmImportedConstantWindow` — never by treating
 * it as though it were Python.
 */
export function importSpecifiersNaming(
  fileLines: readonly string[],
  name: string,
  hashComment: boolean,
  filePath?: string,
): ImportSpecifier[] {
  const out: ImportSpecifier[] = [];
  const seen = new Set<string>();
  // B1 (round-8 fable finding): every push site states its own `wildcard`/
  // `packageEligible` facts explicitly (no implicit default) -- see
  // `ImportSpecifier`'s own doc for what each means and why a wildcard
  // spec's disclosure/package-wording eligibility differs from an ordinary
  // named one even when both resolve the identical FILE.
  const push = (specifier: string, opts: { forceRelative?: boolean; wildcard: boolean; packageEligible: boolean; exportedName?: string }): void => {
    const key = `${specifier}\u0000${opts.wildcard ? "w" : "n"}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      specifier,
      relative: opts.forceRelative ?? (specifier.startsWith(".") || specifier.startsWith("/")),
      wildcard: opts.wildcard,
      packageEligible: opts.packageEligible,
      ...(opts.exportedName !== undefined ? { exportedName: opts.exportedName } : {}),
    });
  };
  const boundName = (binding: string): string => {
    const asMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding);
    return asMatch ? asMatch[2]! : binding.replace(/^type\s+/, "");
  };
  // FIX-ALIAS: the SOURCE-side half of the same "A as B" shape `boundName`
  // already parses for the LOCAL half -- `undefined` (no "as") means "same
  // name queried", so every existing `boundName(binding) === name` match
  // site stays byte-for-byte correct when it does not also read this.
  const exportedNameOf = (binding: string): string | undefined => {
    const asMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding);
    return asMatch ? asMatch[1] : undefined;
  };
  const index = fileLineIndex(fileLines);
  if (index.importLines === undefined || index.importTexts === undefined) {
    index.importLines = [];
    index.importTexts = [];
    for (let at = 0; at < fileLines.length; at++) {
      if (!IMPORT_SHAPED_LINE_RE.test(fileLines[at]!)) continue;
      index.importLines.push(at);
      index.importTexts.push(joinedImportStatement(fileLines, at));
    }
  }
  for (const [statementIndex, at] of index.importLines.entries()) {
    const rawLine = fileLines[at]!;
    // NOT `maskNonCode`: that helper blanks the quote MARKS themselves (by
    // design, for call-shape column arithmetic elsewhere), which would
    // destroy the very quoted specifier this function exists to read. Every
    // shape below is anchored at `^\s*<keyword>`, so a `//`/`#`-commented-out
    // import line already fails to match on its own -- `isCommentLine` is
    // only needed for the (rarer) `/* ... */`/`*`-continuation shapes that
    // anchor differently.
    if (isCommentLine(rawLine, hashComment)) continue;
    // R2-T3: the whole statement -- the raw line itself unless a wrapped
    // `{ ... }` / `( ... )` import list spans several lines
    // (`joinedImportStatement`).
    const line = index.importTexts[statementIndex]!;

    const namedOpts = { wildcard: false, packageEligible: true };
    // R2-T3: `import D, { A as B } from "./m"` (a default binding beside the
    // named list) carries the same named list as `import { A as B } from`.
    const named = /^\s*import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(line);
    if (named) {
      for (const binding of named[1]!.split(",").map((b) => b.trim()).filter(Boolean)) {
        // FIX-ALIAS: `import { A as B }` binds `B` LOCALLY but the source
        // module declares `A` — `exportedName` carries `A` (undefined when
        // there is no "as", i.e. this spec names the same thing it always
        // did). `import { default as B }` matches this same shape with
        // `A === "default"`: the caller resolves the target's own default
        // export under that literal name, or discloses when it cannot.
        if (boundName(binding) === name) push(named[2]!, { ...namedOpts, exportedName: exportedNameOf(binding) });
      }
    }
    // FIX-ALIAS scope note: a PLAIN default import (`import B from "./m"`) is
    // left WITHOUT `exportedName` here, on purpose — every existing caller
    // already resolves it as a MODULE ALIAS (`importedModuleAliasesIn`'s own
    // `tsDefaultImportAlias`), never through this bare-name chase, and a bare
    // bodyWide bare bareName that DOES fail this bare lookup is already, and
    // correctly, reconciled once its qualified member access resolves
    // (`resolveQualifiedReferencesIn`'s own `MUST` un-disclose). Only the
    // NAMED `{ default as B }` spec above (which the brief's own scope names)
    // carries `exportedName: "default"`.
    const dflt = /^\s*import\s+([A-Za-z_$][\w$]*)\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']([^"']+)["']/.exec(line);
    if (dflt && dflt[1] === name) push(dflt[2]!, namedOpts);
    const ns = /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/.exec(line);
    if (ns && ns[1] === name) push(ns[2]!, namedOpts);
    // R2-T3 (eval-0929 final review, P1-4): the `{ ... }` list is parsed as a
    // real destructuring pattern (`destructuredBindings`), not split on
    // commas -- so a rename with a default (`{ A: B = 1 }`), a plain default
    // (`{ A = 1 }`), a mixed list (`{ A: B, C }`), a nested pattern and a
    // multi-line list (`joinedImportStatement`) all bind exactly like the ES
    // `import { A as B }` above.
    const req = /^\s*(?:const|let|var)\s*\{([\s\S]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/.exec(line);
    if (req) {
      for (const binding of destructuredBindings(req[1]!)) {
        // FIX-ALIAS: `const { A: B } = require(...)` binds `B` LOCALLY to
        // the required module's OWN key `A` — same rename shape as the ES
        // `as` import above, spelled with a colon instead.
        if (binding.local === name) push(req[2]!, { ...namedOpts, exportedName: binding.key !== name ? binding.key : undefined });
      }
    }
    // R2-T3: the MEMBER form `const B = require("./x").A` binds `B` to the
    // required module's own export `A` -- the same fact as
    // `const { A: B } = require("./x")`, spelled as a property read. (The bare
    // `const M = require("./x")` MODULE alias names no export and is resolved
    // through `importedModuleAliasesIn`, never here.) `.default` reads the
    // module's default export exactly like `import { default as B }`.
    // A longer chain (`require("./x").limits.ttl`) still binds through the
    // FIRST member: the module export that carries the rest.
    const reqMember = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*;?\s*$/.exec(line);
    if (reqMember && reqMember[1] === name) {
      push(reqMember[2]!, { ...namedOpts, exportedName: reqMember[3] !== name ? reqMember[3] : undefined });
    }
    // FIX-FAB item 4 (eval-0927 review #7, barrel): a TS/JS barrel re-export
    // (`export { DEFAULT_OPTIONS } from "./defaults"`, `export { Y as
    // DEFAULT_OPTIONS } from "./defaults"`) states exactly the same "this
    // name comes from that file" fact an import line does — the hook chases
    // it through `resolveImportSpecifierFile` the identical way, and it is
    // THAT hop-following loop (readCodeTaskPack.ts's `constantClosureForFocal`)
    // that turns a single one-hop resolution into barrel-following up to its
    // own hop cap; this module stays single-line/single-hop.
    const namedReexport = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(line);
    if (namedReexport) {
      for (const binding of namedReexport[1]!.split(",").map((b) => b.trim()).filter(Boolean)) {
        // FIX-ALIAS: `export { A as B } from "./mod"` re-exports THIS file's
        // "./mod" under the LOCAL name B -- a caller chasing B must look up
        // `A` (the SOURCE's own name) in "./mod", never B itself.
        if (boundName(binding) === name) push(namedReexport[2]!, { ...namedOpts, exportedName: exportedNameOf(binding) });
      }
    }
    // A wildcard re-export (`export * from "./defaults"`) names nothing, so
    // it cannot be gated on `name` at all — it is a candidate for EVERY
    // lookup in this file, exactly as uncertain (and exactly as bounded by
    // MAX_REEXPORT_FILES_TOTAL downstream) as a C/C++ local
    // #include already is below. B1: still a TS/JS module specifier
    // (`packageEligible`), but `wildcard` so it never itself "names" a
    // queried identifier (V1) — `resolveConstantWindow`'s own barrel chase
    // is what may still resolve THROUGH it.
    const starReexport = /^\s*export\s+\*\s*from\s*["']([^"']+)["']/.exec(line);
    if (starReexport) push(starReexport[1]!, { wildcard: true, packageEligible: true });

    const pyFrom = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
    if (pyFrom) {
      for (const binding of pyFrom[2]!.split(",").map((b) => b.trim()).filter(Boolean)) {
        const asMatch = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(binding);
        // FIX-ALIAS: `from m import A as B` binds `B` LOCALLY -- module `m`
        // declares `A`, never `B`.
        if ((asMatch ? asMatch[2]! : binding) === name) {
          push(pyFrom[1]!, { wildcard: false, packageEligible: true, exportedName: asMatch ? asMatch[1] : undefined });
        }
      }
    }
    // V3 follow-up (round-7 orchestrator probe, oPyStarReexport): a Python
    // star re-export (`from .defaults import *`) names NOTHING specific --
    // mirroring the TS/JS wildcard re-export just below, it is a candidate
    // for EVERY lookup in this file (bounded downstream the identical way:
    // MAX_REEXPORT_FILES_TOTAL). B1
    // (round-8, pyStarImportLowerConst): `wildcard:true` -- it names nothing
    // specific, so it must never make an unrelated body name (a parameter, a
    // loop variable, a keyword-argument name) look "imported".
    const pyStarReexport = /^\s*from\s+([.\w]+)\s+import\s+\*\s*$/.exec(line);
    if (pyStarReexport) push(pyStarReexport[1]!, { wildcard: true, packageEligible: true });
    // B2 (round-9 fable finding): this bare shape is Python-only -- a
    // semicolon-less Kotlin/Scala `import a.b.NAME` matches the identical
    // regex but names a WORKSPACE member/package, never a Python module;
    // `filePath` known and non-`.py` skips it entirely (see this function's
    // own doc). `filePath === undefined` keeps every existing caller/spec
    // byte-for-byte unchanged.
    const pyImport = (filePath === undefined || /\.py$/.test(filePath))
      ? /^\s*import\s+([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(line)
      : null;
    if (pyImport) {
      const alias = pyImport[2];
      const tail = pyImport[1]!.split(".").pop();
      if (alias === name || (alias === undefined && tail === name)) push(pyImport[1]!, { wildcard: false, packageEligible: true });
    }
    // Round-9 orchestrator follow-up: a Kotlin member import of a top-level
    // property (`import org.acme.net.defaultTimeout [as t]`) names that value
    // exactly like Java's `import static a.b.C.NAME;` below, so a read of it
    // that cannot be resolved (a library outside the workspace) is disclosed
    // instead of silently certified. camelCase members only: a capitalised
    // member is a type (not a value read), and SCREAMING_SNAKE constants are
    // already disclosed by name. Kotlin only (Scala imports whole packages).
    const ktMember = filePath !== undefined && /\.kts?$/.test(filePath)
      ? /^\s*import\s+([\w.]+)\.([a-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*;?\s*$/.exec(line)
      : null;
    // FIX-ALIAS: `import a.b.A as B` binds `B` LOCALLY -- the member `A`
    // (ktMember[2]) is the real name to look up, never `B` itself.
    if (ktMember && (ktMember[3] ?? ktMember[2]) === name) {
      push(ktMember[1]!, { wildcard: false, packageEligible: false, exportedName: ktMember[3] !== undefined ? ktMember[2] : undefined });
    }

    // B1 (round-8, csUsingStaticPascalConst): `import static`/`using static`
    // name a JVM/CLR NAMESPACE or TYPE, never a "package" (`packageEligible:
    // false`, unconditionally, regardless of `relative`). `javaStatic` names
    // its member explicitly (`name` already gates the match) so it is not a
    // wildcard; `csUsingStatic` names NOTHING (every member of the class is
    // reachable bare) so it is, exactly like the Python/TS star shapes above.
    const javaStatic = /^\s*import\s+static\s+([\w.]+)\.([A-Za-z_$][\w$]*)\s*;/.exec(line);
    if (javaStatic && javaStatic[2] === name) push(javaStatic[1]!, { wildcard: false, packageEligible: false });
    const csUsingStatic = /^\s*using\s+static\s+([\w.]+)\s*;/.exec(line);
    if (csUsingStatic) push(csUsingStatic[1]!, { wildcard: true, packageEligible: false });

    // B1/B2 (round-8, ktStarImportLowerConst/javaStaticStarImportConst): a
    // Java/Kotlin TYPE wildcard (`import a.b.C.*`, `import static a.b.C.*`)
    // or PACKAGE wildcard (`import a.b.*`) — captured whether or not
    // "static" is present (Kotlin never writes it; Java's own per-member
    // `import static a.b.C.NAME;` shape above already handles the non-
    // wildcard case). `name` cannot gate this match at all (a wildcard names
    // every member of C, or every top-level declaration of package a.b), so
    // — like every other wildcard here — it is pushed unconditionally and
    // left for the caller (`findWildcardImportedConstantWindow`, B2) to
    // classify TYPE vs PACKAGE by the specifier's own last-segment casing.
    const javaKotlinWildcard = /^\s*import\s+(?:static\s+)?([\w.]+)\.\*\s*;?\s*$/.exec(line);
    if (javaKotlinWildcard) push(javaKotlinWildcard[1]!, { wildcard: true, packageEligible: false });

    // A quoted #include is always workspace-local by C/C++ convention (an
    // angle-bracket #include <x.h> is a SYSTEM header, deliberately not
    // matched here); force `relative:true` regardless of whether the
    // written path itself starts with "./" (a bare "config.h" sibling
    // include is exactly as workspace-relative as "./config.h"). B1
    // (round-8, cppScopedConst): every local include is a candidate for
    // EVERY name (this function's own long-standing design, see this
    // function's own doc) — `wildcard:true` so it never single-handedly
    // makes an unrelated bare name (a parameter, a loop counter, the
    // focal's own type) look "imported" (`packageEligible:false` too: a
    // relative `#include` was never package-eligible in the first place,
    // stated here for clarity).
    const include = /^\s*#include\s+"([^"]+)"/.exec(line);
    if (include) push(include[1]!, { forceRelative: true, wildcard: true, packageEligible: false });
  }
  return out;
}

/**
 * V3 (round-7 fable finding, goCrossPackageConst / pure `config::TIMEOUT_MS`
 * rows): lowercase names this FILE imports as a MODULE/PACKAGE/NAMESPACE
 * (not an individual binding) -- Go `import "pkg/config"` (alias = last
 * path segment) or `import cfg "pkg/config"` (explicit alias, single-line or
 * inside a parenthesized `import (...)` block), Python `import config` /
 * `import pkg.config as cfg` (unaliased dotted form binds the FIRST
 * segment, matching real Python semantics), Rust `use a::b::config;` /
 * `use a::b::config as cfg;`, C/C++ `using namespace ns;`.
 * `qualifiedConstantReferencesIn` accepts a LOWERCASE owner ONLY when it is
 * in this set -- otherwise a lowercase `Owner.member` shape is an ordinary
 * property read (`response.status`), never a constant reference.
 */
export function importedModuleAliasesIn(fileLines: readonly string[], hashComment: boolean): ReadonlySet<string> {
  const out = new Set<string>();
  const addGoImportSpec = (specText: string): void => {
    const aliased = /^([A-Za-z_]\w*)\s+"([^"]+)"$/.exec(specText);
    // FIX-GOALIAS (eval-0929 §4/§8, WP-K): a blank import (`_ "path"`) binds
    // no NAME a value read could ever qualify through -- Go forbids reading
    // the blank identifier, so "_" is never a real owner, only ever a
    // structurally-matched alias token this regex happens to also accept.
    if (aliased) { if (aliased[1] !== "_") out.add(aliased[1]!); return; }
    const plain = /^"([^"]+)"$/.exec(specText);
    if (plain) { const seg = plain[1]!.split("/").pop(); if (seg) out.add(seg); }
  };
  let inGoImportBlock = false;
  for (const rawLine of fileLines) {
    const trimmed = rawLine.trim();
    if (inGoImportBlock) {
      if (trimmed === ")") { inGoImportBlock = false; continue; }
      addGoImportSpec(trimmed);
      continue;
    }
    if (isCommentLine(rawLine, hashComment)) continue;
    if (trimmed === "import (") { inGoImportBlock = true; continue; }
    const goSingle = /^import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"\s*$/.exec(trimmed);
    if (goSingle) {
      const goAlias = goSingle[1] ?? goSingle[2]!.split("/").pop()!;
      if (goAlias !== "_") out.add(goAlias);
      continue;
    }
    // V3 follow-up (round-7 orchestrator probe, oTsNamespaceImport): a TS/JS
    // namespace import binds a MODULE NAMESPACE object, not one member --
    // `ns.MEMBER` reads that module's own top level, exactly like the other
    // module aliases below.
    const tsNamespaceImport = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["']/.exec(trimmed);
    if (tsNamespaceImport) { out.add(tsNamespaceImport[1]!); continue; }
    // B3 (round-8 fable finding, cjsRequireModuleConst/tsDefaultImportObjectConst):
    // a CJS `require()` assignment, a TS `import x = require(...)`, and a
    // TS/JS DEFAULT import all bind a MODULE alias here -- `x.member` reads
    // that module's own exports, the same qualified-alias branch every other
    // module/package/namespace alias in this set already gets. A name that
    // turns out not to be a plain object (an ordinary default-exported
    // FUNCTION, say) simply fails to resolve any member downstream --
    // `resolveModuleNamespaceFile`'s own no-guessing contract, same as the
    // Python opportunistic binding just below.
    const cjsRequireAlias = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'][^"']+["']\s*\)/.exec(trimmed);
    if (cjsRequireAlias) { out.add(cjsRequireAlias[1]!); continue; }
    const tsImportEqualsRequire = /^import\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'][^"']+["']\s*\)/.exec(trimmed);
    if (tsImportEqualsRequire) { out.add(tsImportEqualsRequire[1]!); continue; }
    const tsDefaultImportAlias = /^import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'][^"']+["']/.exec(trimmed);
    if (tsDefaultImportAlias) { out.add(tsDefaultImportAlias[1]!); continue; }
    const pyImport = /^import\s+([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(trimmed);
    if (pyImport) { out.add(pyImport[2] ?? pyImport[1]!.split(".")[0]!); continue; }
    // V3 follow-up (oPyModuleAlias/oPyStarReexport): `from pkg import mod`
    // (any item, aliased or not, star excluded -- a star import introduces
    // no name of its own) binds `mod` to the SUBMODULE object itself just
    // as often as to a plain value/function -- opportunistic: a name that
    // turns out not to be a module simply fails to resolve downstream
    // (`resolveModuleNamespaceFile`'s own no-guessing contract), so this
    // never needs to tell the two apart here.
    const pyFromImport = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(trimmed);
    if (pyFromImport) {
      for (const item of pyFromImport[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (item === "*") continue;
        const asMatch = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(item);
        out.add(asMatch ? asMatch[2]! : item);
      }
      continue;
    }
    const cppUsingNs = /^using\s+namespace\s+([A-Za-z_]\w*)\s*;/.exec(trimmed);
    if (cppUsingNs) { out.add(cppUsingNs[1]!); continue; }
  }
  // Rust `use` trees (grouped, multi-line, `as`, `self`) and `mod name;`
  // declarations bind module names too.
  for (const name of rustUseBindings(fileLines, hashComment).keys()) out.add(name);
  return out;
}

/**
 * FIX-GOALIAS (eval-0929 §4/§8, WP-K -- "a Go package-qualified constant
 * read is never verified empty"): Go import bindings in `fileLines` -- alias
 * (an explicit `import lim "example.com/app/limits"`, or the unaliased
 * convention's own last path segment, `import "example.com/app/limits"` ->
 * "limits") -> the import PATH TEXT it names, across a single-line
 * `import [alias] "path"` and a parenthesized `import (…)` block (one entry
 * per line, alias or bare). `importedModuleAliasesIn` above already proves
 * `owner` is a Go package alias (its own, independently-parsed Go branch);
 * this is the SAME shapes, kept as its own small duplicate rather than a
 * shared refactor of that widely-used, already-hardened function (round-7/
 * 8/9 fable findings), so this addition carries none of that function's own
 * regression risk. Used only by `findGoQualifiedPackageConstantWindow`
 * (readCodeTaskPack.ts), which needs the PATH TEXT (not just the alias) to
 * resolve a go.mod module path to a workspace directory -- a plain
 * package-name text scan (this fix's own root cause) silently mismatches
 * the moment the alias differs from the real declared package name. A dot
 * import (`. "path"`) binds no alias a qualified read could ever use (every
 * name it introduces is read UNQUALIFIED) and a blank import (`_ "path"`)
 * binds no readable name at all (Go forbids reading the blank identifier)
 * -- both excluded, never returned as a key.
 */
export function goImportPathAliasesIn(fileLines: readonly string[], hashComment: boolean): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const addGoImportSpec = (specText: string): void => {
    const aliased = /^([A-Za-z_]\w*)\s+"([^"]+)"$/.exec(specText);
    if (aliased) { if (aliased[1] !== "_") out.set(aliased[1]!, aliased[2]!); return; }
    const plain = /^"([^"]+)"$/.exec(specText);
    if (plain) { const seg = plain[1]!.split("/").pop(); if (seg) out.set(seg, plain[1]!); }
  };
  let inGoImportBlock = false;
  for (const rawLine of fileLines) {
    const trimmed = rawLine.trim();
    if (inGoImportBlock) {
      if (trimmed === ")") { inGoImportBlock = false; continue; }
      addGoImportSpec(trimmed);
      continue;
    }
    if (isCommentLine(rawLine, hashComment)) continue;
    if (trimmed === "import (") { inGoImportBlock = true; continue; }
    const goSingle = /^import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"\s*$/.exec(trimmed);
    if (goSingle) {
      const alias = goSingle[1] ?? goSingle[2]!.split("/").pop()!;
      if (alias !== "_") out.set(alias, goSingle[2]!);
      continue;
    }
  }
  return out;
}

const RUST_USE_START_RE = /^(?:pub(?:\([^)]*\))?\s+)?use\s+(?=[A-Za-z_{]|::)/;
const RUST_MOD_DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/;
const MAX_RUST_USE_STATEMENT_LINES = 32;

/**
 * Rust names bound by `use` statements and `mod name;` declarations in
 * `fileLines`: bound name -> the full path it names (`use crate::net::{config,
 * util as u};` binds `config` -> [crate, net, config] and `u` -> [crate, net,
 * util]; `mod limits;` binds `limits` -> [self, limits]; `{self}` binds the
 * group's own prefix). Glob (`*`) and `as _` entries bind nothing; a
 * statement with a `\` (PHP `use App\Config;`) or that does not parse is
 * skipped whole.
 */
export function rustUseBindings(fileLines: readonly string[], hashComment: boolean): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (let i = 0; i < fileLines.length; i++) {
    const raw = fileLines[i] ?? "";
    if (isCommentLine(raw, hashComment)) continue;
    const trimmed = raw.trim();
    const modDecl = RUST_MOD_DECL_RE.exec(trimmed);
    if (modDecl) { out.set(modDecl[1]!, ["self", modDecl[1]!]); continue; }
    const start = RUST_USE_START_RE.exec(trimmed);
    if (!start) continue;
    let statement = trimmed.slice(start[0].length);
    let j = i;
    while (!statement.includes(";") && j + 1 < fileLines.length && j - i < MAX_RUST_USE_STATEMENT_LINES) {
      j++;
      statement += ` ${(fileLines[j] ?? "").trim()}`;
    }
    const semi = statement.indexOf(";");
    if (semi === -1 || statement.includes("\\")) continue;
    i = j;
    const tokens = statement.slice(0, semi).match(/[A-Za-z_]\w*|::|[{},*]/g) ?? [];
    parseRustUseTree(tokens, { at: 0 }, [], out);
  }
  return out;
}

function parseRustUseTree(tokens: readonly string[], cursor: { at: number }, prefix: readonly string[], out: Map<string, readonly string[]>): boolean {
  const segments = [...prefix];
  if (tokens[cursor.at] === "::") cursor.at++;
  for (;;) {
    const token = tokens[cursor.at];
    if (token === "{") {
      cursor.at++;
      while (tokens[cursor.at] !== "}") {
        if (cursor.at >= tokens.length) return false;
        if (!parseRustUseTree(tokens, cursor, segments, out)) return false;
        if (tokens[cursor.at] === ",") cursor.at++;
      }
      cursor.at++;
      return true;
    }
    if (token === "*") { cursor.at++; return true; }
    if (token === undefined || !/^[A-Za-z_]\w*$/.test(token)) return false;
    cursor.at++;
    if (tokens[cursor.at] === "::") { segments.push(token); cursor.at++; continue; }
    const full = token === "self" ? segments : [...segments, token];
    let bound = token === "self" ? segments[segments.length - 1] : token;
    if (tokens[cursor.at] === "as") {
      bound = tokens[cursor.at + 1];
      cursor.at += 2;
    }
    if (bound !== undefined && bound !== "_" && full.length > 0) out.set(bound, full);
    return true;
  }
}

// ---------------------------------------------------------------------------
// P0-3 (round-4/5 fable finding, classMethod/classMethodCtorDefault/
// classMethodField/classMethodAssign/classMethodPy): a member focal's body
// commonly reads its OWN INSTANCE STATE (`this.options.timeoutMs`,
// `self.timeout`) rather than a module constant directly --
// `constantLikeReferencesIn`'s property-access skip (an identifier
// immediately preceded by `.`) is exactly right for an ordinary property
// READ (never treat `.timeoutMs` as if it were a bare module name), but it
// means `this.p`/`self.p` never even becomes a CANDIDATE, so nothing ever
// followed it to the constant its OWNER assigned. This section adds that
// one hop: the property NAME (`selfPropertyReferencesIn`), then that
// property's OWN declaration site within the class (`findOwnerPropertyWindow`
// -- field initializer, constructor parameter property with a default, or a
// constructor-body assignment, chasing a bare-name assignment to the
// constructor's OWN same-named parameter default one hop further, e.g.
// Python's `def __init__(self, timeout=DEFAULT_TIMEOUT_S): self.timeout =
// timeout`). TS/JS, Java/C#-ish (field initializer only -- neither language
// has TS's parameter-property sugar) and Python.
// ---------------------------------------------------------------------------

/** V2 (round-7 fable finding): every qualifier a self-property read may carry with NO language gate -- `this`/`self` (the ORIGINAL shapes) plus `super` (reserved in every OOP language this scan reaches, so `super.p` is unambiguous everywhere). `cls` (Python classmethods) is deliberately NOT here: it is an ordinary identifier in most other languages, so it is added only when the caller proves the file is Python (`selfPropertyReferencesIn`'s own `relPath` gate). */
const SELF_PROPERTY_DOT_QUALIFIER = "this|self|super";

/** V2 (round-7 fable finding): Ruby instance-variable syntax `@p` -- no `self.`/`this.` prefix at all; the `@` sigil itself is the self-property marker. Gated to `.rb` files by the caller (a bare `@name` is a decorator/annotation in Python/Java/TS/Scala, never an ivar read). */
const RUBY_IVAR_RE = /@([A-Za-z_]\w*)/g;

/**
 * Instance-property names `bodyLines` reads via `this.p` / `self.p` / `super.p`
 * (also `this.p.q` -- only the FIRST component, `p`, is returned: that is the
 * property whose OWNER declaration this module can locate; a further `.q`
 * is a plain property read on WHATEVER `p` resolves to, already visible once
 * `p`'s own declaration window is served). First-appearance order,
 * deduplicated. Never itself decides whether `p` is real -- same
 * no-guessing contract as `constantLikeReferencesIn`: a name that fails to
 * resolve to any owner declaration is simply dropped downstream.
 *
 * P0-2 (round-6 fable finding, classMethodStaticProp): `ownerTypeName`, when
 * supplied, ALSO matches a bare qualified reference `Owner.p` (e.g.
 * `HttpClient.DEFAULTS.timeoutMs`) -- a static member read is exactly as much
 * "this callable's own type's state" as `this.p` is, just spelled without an
 * instance.
 *
 * V2 (round-7 fable finding, classMethodPyClassmethodCls / P2-11b
 * classMethodBracketThis): `relPath`, when it ends `.py`, ALSO recognizes
 * `cls.p` (a Python `@classmethod`'s own self-reference); when it ends
 * `.rb`, ALSO recognizes Ruby's `@p` ivar syntax. Every qualifier ALSO
 * matches bracket notation, `this["p"]` / `self['p']` -- the same read,
 * spelled for a computed/reserved-word member name.
 *
 * P0-2's OVER-SERVING GUARD (brief-round6, "never turn every method that
 * reads an unrelated this.logger into undetermined"): mirrors
 * `constantLikeReferencesIn`'s own P0-4 guard exactly -- a property name
 * whose EVERY occurrence in `bodyLines` is a bare-statement call THROUGH it
 * (`this.logger.info(...)`, result discarded) is excluded. A property read
 * as a VALUE anywhere (a bare use, or a call whose result feeds a larger
 * expression) is kept, same as the module-constant guard already proves.
 */
export function selfPropertyReferencesIn(
  bodyLines: readonly string[],
  hashComment: boolean,
  ownerTypeName?: string,
  relPath?: string,
): string[] {
  const isPython = relPath !== undefined && /\.py$/.test(relPath);
  const isRuby = relPath !== undefined && /\.rb$/.test(relPath);
  let qualifierAlt = SELF_PROPERTY_DOT_QUALIFIER;
  if (isPython) qualifierAlt += "|cls";
  if (ownerTypeName) qualifierAlt += `|${escapeForRegex(ownerTypeName)}`;
  const dotRe = new RegExp(`\\b(?:${qualifierAlt})\\.([A-Za-z_$][\\w$]*)`, "g");
  const bracketRe = new RegExp(`\\b(?:${qualifierAlt})\\[\\s*["']([A-Za-z_$][\\w$]*)["']\\s*\\]`, "g");
  const seen = new Set<string>();
  const order: string[] = [];
  const bareReceiverOnly = new Map<string, boolean>();
  const record = (name: string, masked: string, at: number, matchLen: number): void => {
    if (!seen.has(name)) { seen.add(name); order.push(name); }
    const after = masked.slice(at + matchLen);
    const isBareUse = RECEIVER_CALL_RE.test(after) && isBareReceiverStatement(masked, at);
    bareReceiverOnly.set(name, (bareReceiverOnly.get(name) ?? true) && isBareUse);
  };
  for (const rawLine of bodyLines) {
    const masked = maskNonCode(rawLine, hashComment);
    for (const m of masked.matchAll(dotRe)) {
      const at = m.index ?? -1;
      if (at < 0) continue;
      record(m[1]!, masked, at, m[0].length);
    }
    // NOT `masked` for the bracket form: `maskNonCode` blanks the quoted
    // member NAME itself (it is a string literal), which would destroy the
    // very text this regex exists to read -- same reasoning
    // `importSpecifiersNaming` already documents for import specifiers.
    // Guarded by `isCommentLine` instead (whole-line comments only, the
    // same scope that guard already covers elsewhere); `maskNonCode`'s
    // column-preserving blanking means the RAW match's indices still line
    // up with `masked` for the bare-receiver check below.
    if (!isCommentLine(rawLine, hashComment)) {
      for (const m of rawLine.matchAll(bracketRe)) {
        const at = m.index ?? -1;
        if (at < 0) continue;
        record(m[1]!, masked, at, m[0].length);
      }
    }
    if (isRuby) {
      for (const m of masked.matchAll(RUBY_IVAR_RE)) {
        const at = m.index ?? -1;
        if (at < 0) continue;
        record(m[1]!, masked, at, m[0].length);
      }
    }
  }
  return order.filter((name) => !bareReceiverOnly.get(name));
}

/** V2 (round-7 fable finding): modifier keywords that may precede an IMPLICIT-`this` field declaration's own type token (mirrors `findOwnerPropertyWindow`'s `typedFieldRe`, generalized to capture ANY name rather than testing one). */
const IMPLICIT_FIELD_UNTYPED_RE = /^\s*(?:(?:public|private|protected|readonly|static|val|var)\s+)*([A-Za-z_$][\w$]*)[?!]?\s*(?::[^=]*)?=(?!=)/;
const IMPLICIT_FIELD_TYPED_RE = /^\s*(?:(?:public|private|protected|internal|static|readonly|final|const|volatile)\s+)*[A-Za-z_$][\w$.<>[\]]*\s+([A-Za-z_$][\w$]*)[?!]?\s*(?::[^=]*)?=(?!=)/;

/**
 * V2 (round-7 fable finding, classMethodJavaBareField/ktBareFieldConst): the
 * NAMES `findOwnerPropertyWindow`'s own field shapes would resolve for SOME
 * name -- every field `lines[classStart-1..classEnd-1]` declares at its own
 * top level, outside every method body. A BARE identifier read (Java/
 * Kotlin/C#/C++/Swift/Scala/Dart's own IMPLICIT `this` member access) can
 * only be told apart from an ordinary unrelated bare name by first knowing
 * the owner's OWN declared fields -- unlike `this.p`, the bare syntax alone
 * proves nothing (the caller gates this to those languages; TS/JS/Python
 * require an explicit `this.`/`self.` and must never call this).
 */
export function ownerFieldNames(
  lines: readonly string[],
  classStart: number,
  classEnd: number,
  methodSpans: readonly OwnerMemberSpan[],
  hashComment: boolean,
): ReadonlySet<string> {
  const names = new Set<string>();
  const insideAnyMethod = (lineNo: number): boolean => methodSpans.some((m) => lineNo >= m.start && lineNo <= m.end);
  for (let lineNo = classStart; lineNo <= classEnd; lineNo++) {
    if (insideAnyMethod(lineNo)) continue;
    const masked = maskNonCode(lines[lineNo - 1] ?? "", hashComment);
    const untyped = IMPLICIT_FIELD_UNTYPED_RE.exec(masked);
    if (untyped) { names.add(untyped[1]!); continue; }
    const typed = IMPLICIT_FIELD_TYPED_RE.exec(masked);
    if (typed) names.add(typed[1]!);
  }
  return names;
}

/** TS/JS read-accessor header: `[modifiers] get NAME(` -- proves a `methodSpans` entry matched by NAME is a GETTER for the property, never an ordinary method that merely happens to share its name (`findOwnerPropertyWindow`'s own (d)). */
const GETTER_HEAD_RE = /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*get\s+[A-Za-z_$][\w$]*\s*\(/u;

/** One class-body member's own line span, as far as this module needs to know it (mirrors the caller's own parsed-symbol shape, kept minimal and pure here). */
export interface OwnerMemberSpan {
  readonly start: number;
  readonly end: number;
  /** Unqualified name (`unqualifiedSymbolTail`'d by the caller) -- used only to recognize the constructor (`constructor` / `__init__`). */
  readonly name: string;
}

/**
 * The declaration site of instance property `name` within a class/struct's
 * OWN body (`lines[classStart-1 .. classEnd-1]`, numbered like `lines`
 * itself), tried in order:
 *  (a) a field initializer at the class's own top level -- a member line
 *      shaped `[modifiers] name[?!][: Type] = <init>`, OUTSIDE every method
 *      body (`methodSpans` bounds the exclusion, so an unrelated method-body
 *      reassignment of a same-named local can never be mistaken for a field
 *      declaration) -- TS/JS/Java/C#/Kotlin-ish;
 *  (b) inside the constructor (the `methodSpans` entry named `constructor`
 *      or `__init__`, if one exists): a parameter naming `name` directly
 *      WITH A DEFAULT in the signature -- TS's own parameter-property sugar
 *      (`constructor(private readonly name = DEFAULT) {}`) reads this way
 *      with no further indirection, and Python's `def __init__(self,
 *      name=DEFAULT):` reads the SAME way when the property and parameter
 *      share a name (the common `self.name = name` convention);
 *  (c) inside the constructor: a body assignment `this.name = <rhs>` /
 *      `self.name = <rhs>`. When `<rhs>` is itself one bare identifier that
 *      is ALSO one of the constructor's own parameters with a default (a
 *      differently-named Python parameter, `self.timeout = timeout_s`), the
 *      constructor's own default wins (the assignment's RHS is a local
 *      parameter, not a value); otherwise the assignment line itself is the
 *      window (`this.options = DEFAULT_OPTIONS` -- DEFAULT_OPTIONS is
 *      directly in the assignment's own text, found by the caller's ordinary
 *      constant-reference scan over the returned window);
 *  (d) a TS/JS read ACCESSOR: a `methodSpans` entry named `name` whose own
 *      header line carries the `get` keyword (`private get timeoutMs():
 *      number { ... }`) is `name`'s own declaration -- the caller's ordinary
 *      constant-reference scan over the accessor's BODY (returned here
 *      exactly like a constructor assignment line is) reaches whatever
 *      module constant the getter itself returns, one hop further. Never
 *      mistaken for an ordinary same-named method lacking `get`.
 * (a) additionally matches a Java/C#-style TYPED field -- an access/static
 *     modifier set (now also `final`/`const`/`volatile`) followed by ONE
 *     bare type token before the name (`private final int timeoutMs = ...`)
 *     -- tried only when the untyped shape above does not match, so every
 *     TS/JS/Kotlin-ish field this function already resolved keeps resolving
 *     through the exact same window as before this widening.
 * `undefined` when none of the shapes names `name` at all -- a property with
 * no textual assignment this module can see (a property set by a non-getter
 * method, an inherited field, a constructor/method parameter with no
 * default) is left unresolved exactly like an ordinary failed constant
 * lookup: never reported as a gap BY THIS MODULE (the caller,
 * `constantClosureForFocal` in readCodeTaskPack.ts, is the one that turns a
 * whole-property miss into an honest `undetermined` disclosure -- P0-2,
 * round-6 fable finding -- this module itself does not widen
 * `isUnresolvableConstantName`'s own CONST_CASE-or-package-import
 * requirement for a lowercase property name).
 */
export function findOwnerPropertyWindow(
  lines: readonly string[],
  classStart: number,
  classEnd: number,
  methodSpans: readonly OwnerMemberSpan[],
  name: string,
  hashComment: boolean,
): ConstantWindow | undefined {
  const escaped = escapeForRegex(name);
  // V2 (round-7 fable finding, ktBareFieldConst): `val`/`var` added to the
  // modifier list -- Kotlin/Swift-family field declarations (`private val
  // timeoutMs = ...`) carry their OWN binding keyword where TS/JS class
  // fields carry none; a plain TS/JS field (no `val`/`var` present) matches
  // exactly as before, since the group is optional and repeatable.
  const fieldRe = new RegExp(`^\\s*(?:(?:public|private|protected|readonly|static|val|var)\\s+)*${escaped}[?!]?\\s*(?::[^=]*)?=(?!=)`);
  // P0-2 (round-6 fable finding, classMethodJavaField): tried only as a
  // FALLBACK (see the loop below) when `fieldRe` itself does not match --
  // Java/C# fields carry a bare TYPE token between their modifiers and the
  // name (`int`, `Duration`, a generic `List<String>`) that `fieldRe` has no
  // slot for; TS/JS class fields never do, so this never competes with the
  // original shape for the same line.
  const typedFieldRe = new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|readonly|final|const|volatile)\\s+)*[A-Za-z_$][\\w$.<>[\\]]*\\s+${escaped}[?!]?\\s*(?::[^=]*)?=(?!=)`);
  const insideAnyMethod = (lineNo: number): boolean => methodSpans.some((m) => lineNo >= m.start && lineNo <= m.end);
  for (let lineNo = classStart; lineNo <= classEnd; lineNo++) {
    if (insideAnyMethod(lineNo)) continue;
    const masked = maskNonCode(lines[lineNo - 1] ?? "", hashComment);
    if (fieldRe.test(masked) || typedFieldRe.test(masked)) return declarationExtent(lines, lineNo, hashComment);
  }
  // (d) TS/JS read accessor -- see this function's own doc. Checked before
  // the constructor lookup: a `get name()` member is unambiguous once
  // matched by NAME, and it can never accidentally overlap either
  // constructor shape below (their own `methodSpans` entry is named
  // "constructor"/"__init__", never the property's own name).
  const accessor = methodSpans.find((m) => m.name === name);
  if (accessor !== undefined && GETTER_HEAD_RE.test(maskNonCode(lines[accessor.start - 1] ?? "", hashComment))) {
    return declarationExtent(lines, accessor.start, hashComment);
  }
  const ctor = methodSpans.find((m) => m.name === "constructor" || m.name === "__init__");
  if (ctor === undefined) return undefined;
  const paramDefaultRe = (paramName: string): RegExp =>
    new RegExp(`(?:\\(|,)\\s*(?:(?:public|private|protected|readonly)\\s+)*${escapeForRegex(paramName)}[?!]?\\s*(?::[^,=()]*)?=`);
  // The constructor's own SIGNATURE text only -- stop accumulating lines the
  // first time a line closes the parameter list (`) {`/`):`), so a default
  // value's own object/array literal never bleeds body lines into this text.
  let signature = "";
  const sigLimit = Math.min(ctor.end, ctor.start + MAX_CONSTANT_WINDOW_LINES);
  for (let lineNo = ctor.start; lineNo <= sigLimit; lineNo++) {
    signature += `${maskNonCode(lines[lineNo - 1] ?? "", hashComment)}\n`;
    if (/\)\s*(?::[^{]*)?\s*[{:]/.test(signature)) break;
  }
  if (paramDefaultRe(name).test(signature)) return declarationExtent(lines, ctor.start, hashComment);
  const assignRe = new RegExp(`^\\s*(?:this|self)\\.${escaped}\\s*=(?!=)\\s*(.+?);?\\s*$`);
  for (let lineNo = ctor.start; lineNo <= ctor.end; lineNo++) {
    const masked = maskNonCode(lines[lineNo - 1] ?? "", hashComment);
    const assign = assignRe.exec(masked);
    if (assign === null) continue;
    const rhs = assign[1]!.trim();
    if (WORD_ONLY_RE.test(rhs) && paramDefaultRe(rhs).test(signature)) return declarationExtent(lines, ctor.start, hashComment);
    return declarationExtent(lines, lineNo, hashComment);
  }
  return undefined;
}
