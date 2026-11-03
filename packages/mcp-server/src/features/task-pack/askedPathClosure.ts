// askedPathClosure.ts — answer-readiness closure for TWO shapes an external
// A/B evaluation of v0.16.4 (2026-11, Claude Code / Sonnet) showed the pack
// certifying too early or wandering (pure helpers; the fs-bound hooks live in
// readCodeTaskPack.ts beside the facet-closure hook, exactly like
// evidenceClosure.ts / callerExpansion.ts):
//
//  (a) THE ASKED PATH'S OWN SELF/THIS-METHOD. "Explain url_for and what
//      happens on BuildError" served `url_for`'s body — whose BuildError path
//      is one line, `return self.handle_url_build_error(error, endpoint,
//      values)` — and certified `act.answer` without `handle_url_build_error`,
//      a method the base class `App` (another module) defines. The agent had
//      to grep for it. `selfMethodCallsOnPath` finds, in a served callable
//      body, every `self.`/`this.`/`super.`/`cls.` method call that sits on a
//      path the question names: the call line, or the handler/guard block it
//      is in (`except BuildError:`, `catch (BuildError e)`, `if (...)`), names
//      a query identifier, or the method's own name spells the identifier.
//      The hook resolves the method in the same class, then up the base-class
//      chain (`baseClassNamesIn` / `classHeaderAbove`, any language with
//      self/this + inheritance TL can parse), serves it when it fits and
//      otherwise asks for it by exact range — the readiness obligation
//      `asked-path:<method>` keeps `act.answer` off the wire until that body
//      is served (DESIGN-v0.15 §3.3 「未配送の必須証拠が残る間はact.answerを出さない」).
//
//  (b) A QUOTED LITERAL THAT NO LONGER EXISTS IN SOURCE. "How does
//      res.redirect('back') handle the 'back' location?" over Express 5 (which
//      removed the magic string) matched `'back'` INSIDE `callback` by
//      substring, served three unrelated sibling methods as "facet evidence"
//      and certified. The quoted literal is matched as a whole token
//      (`wholeTokenOccursIn`), its absence from every source file is proved
//      and disclosed, and the one changelog/history line that mentions the
//      literal is surfaced instead of unrelated examples.
//
// Plans ride a small in-process memo keyed by workspace + query (the same
// discipline as facetGate.ts's plan memo: bounded, never on the wire), so the
// readiness stage — which runs after candidate selection, and again on a
// replay that re-runs no hook — judges against what the hook found.

import { maskNonCode } from "./callerExpansion.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Self-method calls on the asked path considered per focal body. */
export const MAX_ASKED_PATH_CALLS_PER_FOCAL = 3;
/** Lines a served asked-path callee window may carry; a longer method serves its head and its remainder stays `remaining`. */
export const MAX_ASKED_PATH_CALLEE_LINES = 80;
/** Base-class hops followed while resolving a self-method (class -> base -> base's base). */
export const MAX_BASE_CLASS_DEPTH = 3;
/** Distinct files opened while resolving one focal's asked-path callees. */
export const MAX_BASE_CLASS_FILES = 6;
/** Total bytes the asked-path hook may add to one pack. */
export const MAX_ASKED_PATH_BYTES_PER_PACK = 6 * 1024;
/** Lines above a call inspected for the handler/guard block opener it sits in. */
export const MAX_GUARD_LOOKBACK_LINES = 12;
/** Shortest query identifier a callee NAME may spell to count as the asked path (`handle_url_build_error` spells `BuildError`). */
export const MIN_NAME_SPELLED_TERM_CHARS = 5;
/** Doc lines surfaced for a source-absent quoted literal. */
export const MAX_LITERAL_DOC_MENTIONS = 2;
/** Files scanned for a quoted literal's source absence before the verdict is "not proven". */
export const MAX_LITERAL_ABSENCE_FILES = 4000;

// ---------------------------------------------------------------------------
// (a) self/this-method calls on the asked path
// ---------------------------------------------------------------------------

export interface SelfMethodCallOnPath {
  /** The called member (`handle_url_build_error`). */
  readonly name: string;
  /** 1-based file line of the call. */
  readonly line: number;
  /** `self` / `this` / `super` / `cls`. */
  readonly receiver: string;
  /** The query identifier that puts this call on the asked path. */
  readonly term: string;
  /** How: the handler/guard block opener names the term, the call line does, or the callee's name spells it. */
  readonly via: "handler" | "line" | "name";
}

const RECEIVER_CALL_RE = /(?<![\w$.])(self|this|super|cls)\s*(?:\?\.|\.|->|::)\s*([A-Za-z_$][\w$]*)\s*\(/g;
/** A block opener that selects a path (an exception handler, a branch, a case arm) — any language. */
const GUARD_OPENER_RE = /^\s*(?:\}?\s*)?(?:except\b|rescue\b|catch\b|elif\b|else\s+if\b|if\b|case\b|when\b|match\b|\}\s*catch\b|\}\s*else\s+if\b)/;
/** Members every object has or that never carry the asked behaviour. */
const IGNORED_MEMBERS: ReadonlySet<string> = new Set([
  "toString", "valueOf", "hasOwnProperty", "constructor", "super", "__init__", "__str__", "__repr__",
  "assertEqual", "assertTrue", "assertFalse", "assertRaises", "assertIn", "emit", "on", "off", "once",
  "log", "debug", "info", "warn", "warning", "error", "get", "set", "has", "add", "push", "pop", "keys",
  "values", "items", "append", "extend", "update", "format", "join", "split", "strip", "startswith", "endswith",
]);

/** Lowercase, separator-free spelling for "does this name spell that identifier" (`handle_url_build_error` -> `handleurlbuilderror`). */
export function normalizeIdentifierSpelling(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/** Whole-token occurrence of `token` in `text`, camelCase-segment aware (`shippingService` has `shipping`; `callback` has no `back`). */
export function wholeTokenOccursIn(text: string, token: string): boolean {
  if (token.length === 0) return false;
  const lowerText = text.toLowerCase();
  const lowerToken = token.toLowerCase();
  let from = 0;
  while (from < lowerText.length) {
    const index = lowerText.indexOf(lowerToken, from);
    if (index < 0) return false;
    const before = text[index - 1];
    const first = text[index];
    const last = text[index + token.length - 1] ?? "";
    const after = text[index + token.length];
    const beforeBoundary = before === undefined
      || !/[A-Za-z0-9]/.test(before)
      || (/[a-z0-9]/.test(before) && first !== undefined && /[A-Z]/.test(first));
    const afterBoundary = after === undefined
      || !/[A-Za-z0-9]/.test(after)
      || (/[a-z0-9]/.test(last) && /[A-Z]/.test(after));
    if (beforeBoundary && afterBoundary) return true;
    from = index + 1;
  }
  return false;
}

function indentationOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The handler/guard block opener `lineIndex` (0-based, in `bodyLines`) sits in:
 * the nearest opener above it with a smaller indentation (Python/Ruby) or, in
 * a brace language, the nearest opener above within `MAX_GUARD_LOOKBACK_LINES`
 * whose block has not been closed by a `}` at or below its own indentation
 * before the call. Bounded, line-shaped, never a parse.
 */
function guardOpenerAbove(bodyLines: readonly string[], lineIndex: number, hashComment: boolean, relPath?: string): string | undefined {
  const callIndent = indentationOf(bodyLines[lineIndex] ?? "");
  const floor = Math.max(0, lineIndex - MAX_GUARD_LOOKBACK_LINES);
  for (let at = lineIndex - 1; at >= floor; at--) {
    const raw = bodyLines[at] ?? "";
    const masked = maskNonCode(raw, hashComment, relPath);
    if (masked.trim().length === 0) continue;
    const indent = indentationOf(raw);
    if (GUARD_OPENER_RE.test(masked)) {
      // Python/Ruby: the opener must enclose the call (smaller indentation).
      // Brace languages: a `}`-led opener line (`} catch (e) {`) or an opener
      // at the call's own indentation or less also encloses it when its block
      // is still open — approximated as "no closing brace at <= its indent
      // between it and the call".
      if (indent < callIndent) return masked;
      if (indent <= callIndent && /\{\s*$/.test(masked)) {
        const closed = bodyLines.slice(at + 1, lineIndex).some((between) => {
          const b = maskNonCode(between, hashComment, relPath);
          return indentationOf(between) <= indent && /^\s*\}/.test(b);
        });
        if (!closed) return masked;
      }
    }
  }
  return undefined;
}

/**
 * Every `self.`/`this.`/`super.`/`cls.` method call of `bodyLines` (one
 * callable's lines, starting at file line `startLine`) that lies on a path the
 * question names: the enclosing handler/guard opener or the call line itself
 * names one of `terms` as a whole token, or the method's own name spells one
 * (`handle_url_build_error` for `BuildError`). Comments and string literals
 * are masked; the focal's own name is never a callee; at most
 * `MAX_ASKED_PATH_CALLS_PER_FOCAL`, in source order, deduplicated by name.
 */
export function selfMethodCallsOnPath(
  bodyLines: readonly string[],
  hashComment: boolean,
  terms: readonly string[],
  startLine: number,
  focalName: string,
  relPath?: string,
): SelfMethodCallOnPath[] {
  const usable = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 3))];
  if (usable.length === 0) return [];
  const spelledTerms = usable.filter((term) => term.length >= MIN_NAME_SPELLED_TERM_CHARS)
    .map((term) => ({ term, norm: normalizeIdentifierSpelling(term) }))
    .filter((entry) => entry.norm.length >= MIN_NAME_SPELLED_TERM_CHARS);
  const out: SelfMethodCallOnPath[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < bodyLines.length && out.length < MAX_ASKED_PATH_CALLS_PER_FOCAL; index++) {
    const masked = maskNonCode(bodyLines[index] ?? "", hashComment, relPath);
    RECEIVER_CALL_RE.lastIndex = 0;
    for (const match of masked.matchAll(RECEIVER_CALL_RE)) {
      const receiver = match[1]!;
      const name = match[2]!;
      if (name === focalName || IGNORED_MEMBERS.has(name) || seen.has(name)) continue;
      let via: SelfMethodCallOnPath["via"] | undefined;
      let term: string | undefined;
      const lineTerm = usable.find((candidate) => candidate !== name && wholeTokenOccursIn(masked, candidate));
      if (lineTerm !== undefined) { via = "line"; term = lineTerm; }
      if (via === undefined) {
        const opener = guardOpenerAbove(bodyLines, index, hashComment, relPath);
        const openerTerm = opener === undefined ? undefined : usable.find((candidate) => wholeTokenOccursIn(opener, candidate));
        if (openerTerm !== undefined) { via = "handler"; term = openerTerm; }
      }
      if (via === undefined) {
        const norm = normalizeIdentifierSpelling(name);
        const spelled = spelledTerms.find((entry) => norm !== entry.norm && norm.includes(entry.norm));
        if (spelled !== undefined) { via = "name"; term = spelled.term; }
      }
      if (via === undefined || term === undefined) continue;
      seen.add(name);
      out.push({ name, line: startLine + index, receiver, term, via });
      if (out.length >= MAX_ASKED_PATH_CALLS_PER_FOCAL) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Class headers and base classes (any language with self/this + inheritance)
// ---------------------------------------------------------------------------

export interface ClassHeader {
  /** 1-based file line of the header. */
  readonly line: number;
  readonly name: string;
  readonly bases: readonly string[];
}

const CLASS_HEADER_RE = /^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|sealed\s+|open\s+|data\s+|partial\s+|static\s+|declare\s+)*(?:class|struct|trait|object|interface)\s+([A-Za-z_$][\w$]*)/;

/**
 * Base-class names a class header names, in order, deduplicated, at most 4:
 * Python `class A(B, C, metaclass=M)`, TS/JS/Java/Kotlin/Scala/PHP/Dart
 * `class A extends B implements I`, C#/C++/Kotlin/Swift `class A : public B,
 * C`, Ruby `class A < B`. Generic arguments (`Base[T]`, `Base<T>`), call
 * arguments (`Base()`), keyword arguments and access specifiers are dropped;
 * a dotted base (`sansio.App`) keeps its last segment.
 */
export function baseClassNamesIn(headerText: string): string[] {
  const text = headerText.replace(/\s+/g, " ").trim();
  const bases: string[] = [];
  const push = (raw: string): void => {
    let name = raw.trim();
    if (name.length === 0) return;
    if (/^(?:metaclass|public|private|protected|virtual|abstract|final)\b/.test(name) && /[=\s]/.test(name)) {
      if (/^metaclass\s*=/.test(name)) return;
      name = name.replace(/^(?:public|private|protected|virtual)\s+/g, "");
    }
    if (name.includes("=")) return;
    name = name.replace(/[<\[(].*$/, "").trim();
    name = name.split(/[.:]/).filter(Boolean).pop() ?? name;
    name = name.replace(/\?$/, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    if (/^(?:object|Object|Any|Generic|Protocol|ABC|Enum|NamedTuple|TypedDict|dict|list|str|int|Exception|BaseException|Error)$/.test(name) && bases.length > 0) return;
    if (!bases.includes(name)) bases.push(name);
  };
  const pyMatch = /^(?:class)\s+[A-Za-z_$][\w$]*\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)\s*:?/.exec(text);
  if (pyMatch !== null) {
    for (const part of splitTopLevel(pyMatch[1] ?? "")) push(part);
    return bases.slice(0, 4);
  }
  const extendsMatch = /\bextends\s+([^{]+?)(?:\s+implements\b|\s+with\b|\s*\{|\s*$)/.exec(text);
  if (extendsMatch !== null) {
    for (const part of splitTopLevel(extendsMatch[1] ?? "")) push(part);
    return bases.slice(0, 4);
  }
  const rubyMatch = /^class\s+[A-Za-z_:$][\w:$]*\s*<\s*([A-Za-z_:$][\w:$]*)/.exec(text);
  if (rubyMatch !== null) {
    push(rubyMatch[1] ?? "");
    return bases.slice(0, 4);
  }
  const colonMatch = /^(?:[\w\s]*\b(?:class|struct|interface|object)\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?(?:\s*\([^)]*\))?)\s*:\s*([^{]+?)(?:\s*\{|\s*$|\s+where\b)/.exec(text);
  if (colonMatch !== null) {
    for (const part of splitTopLevel(colonMatch[1] ?? "")) push(part.replace(/^(?:public|private|protected|virtual)\s+/, ""));
    return bases.slice(0, 4);
  }
  return bases;
}

/** Split on top-level commas (not inside `()`, `[]`, `<>`). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * The class header enclosing file line `line` (1-based): the nearest header
 * above it with a smaller indentation (Python/Ruby) or the nearest header above
 * at all (brace languages), its header text joined over up to three lines when
 * the base list wraps. `undefined` when `line` is not inside a class.
 */
export function classHeaderAbove(fileLines: readonly string[], line: number, hashComment: boolean, relPath?: string): ClassHeader | undefined {
  const callIndent = indentationOf(fileLines[line - 1] ?? "");
  const pythonLike = relPath !== undefined && /\.(?:py|pyi|rb)$/i.test(relPath);
  for (let at = line - 2; at >= 0; at--) {
    const raw = fileLines[at] ?? "";
    const masked = maskNonCode(raw, hashComment, relPath);
    const match = CLASS_HEADER_RE.exec(masked);
    if (match === null) continue;
    if (pythonLike && indentationOf(raw) >= callIndent) continue;
    let header = masked;
    for (let extra = 1; extra <= 2 && !/[:{]\s*$/.test(header) && !/\{/.test(header); extra++) {
      header += " " + maskNonCode(fileLines[at + extra] ?? "", hashComment, relPath);
    }
    return { line: at + 1, name: match[1]!, bases: baseClassNamesIn(header) };
  }
  return undefined;
}

/** The header of the class named `name` in `fileLines` (first match), with its bases; `undefined` when the file declares no such class. */
export function classHeaderNamed(fileLines: readonly string[], name: string, hashComment: boolean, relPath?: string): ClassHeader | undefined {
  for (let at = 0; at < fileLines.length; at++) {
    const masked = maskNonCode(fileLines[at] ?? "", hashComment, relPath);
    const match = CLASS_HEADER_RE.exec(masked);
    if (match === null || match[1] !== name) continue;
    let header = masked;
    for (let extra = 1; extra <= 2 && !/[:{]\s*$/.test(header) && !/\{/.test(header); extra++) {
      header += " " + maskNonCode(fileLines[at + extra] ?? "", hashComment, relPath);
    }
    return { line: at + 1, name, bases: baseClassNamesIn(header) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// (b) quoted literals: whole-token matching, source absence, doc mentions
// ---------------------------------------------------------------------------

/** The explicitly quoted literal tokens of `query` (`'back'`, `"REDIRECT_BACK"`, `` `cache_ttl` ``), original spelling, deduplicated. */
export function quotedLiteralTokensIn(query: string): string[] {
  const out: string[] = [];
  for (const match of query.matchAll(/[`"']([A-Za-z_][A-Za-z0-9_.:-]{2,})[`"']/g)) {
    const token = match[1]!;
    if (!out.includes(token)) out.push(token);
  }
  for (const match of query.matchAll(/[「『]([A-Za-z_][A-Za-z0-9_.:-]{2,})[」』]/g)) {
    const token = match[1]!;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 4);
}

/** `'back'`, `"back"` or `` `back` `` anywhere in `text` (a comment counts: the literal is then still spelled in source). */
export function quotedFormOccursIn(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:'${escaped}'|"${escaped}"|\`${escaped}\`)`).test(text);
}

/**
 * Does a source file still spell `token`? True on its quoted form anywhere
 * (`'back'`), or on a whole-token occurrence in a CODE position (comments
 * masked, string literals kept — `maskNonCode` masks both, so the quoted-form
 * test above is what keeps a string literal visible). A whole word inside a
 * comment (`// save back to the db`) is prose, not the literal.
 */
export function sourceSpellsLiteral(lines: readonly string[], token: string, hashComment: boolean, relPath?: string): boolean {
  for (const line of lines) {
    if (quotedFormOccursIn(line, token)) return true;
    const masked = maskNonCode(line, hashComment, relPath);
    if (masked.trim().length === 0) continue;
    if (wholeTokenOccursIn(masked, token)) return true;
  }
  return false;
}

const DOC_EXTENSION_RE = /\.(?:md|markdown|mdx|rst|txt|adoc|asciidoc|textile|org)$/i;
const CHANGELOG_BASENAME_RE = /^(?:changelog|changes|history|news|releases?|release[-_]?notes|upgrading|upgrade|migration|migrating|breaking[-_]?changes|whats[-_]?new)(?:\.|$)/i;

/** A documentation file by extension, or a changelog/history file by basename (any extension). */
export function isDocLikePath(relPath: string): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  return DOC_EXTENSION_RE.test(basename) || CHANGELOG_BASENAME_RE.test(basename);
}

/** A changelog/history/release-notes file by basename (`History.md`, `CHANGES.rst`, `CHANGELOG`). */
export function isChangelogLikePath(relPath: string): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  return CHANGELOG_BASENAME_RE.test(basename);
}

export interface DocMentionLine {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
  readonly changelog: boolean;
}

/** The first lines of a doc that mention `token` — the quoted form first, then a whole-token mention — at most `max`. */
export function docMentionLinesIn(relPath: string, lines: readonly string[], token: string, max = MAX_LITERAL_DOC_MENTIONS): DocMentionLine[] {
  const changelog = isChangelogLikePath(relPath);
  const quoted: DocMentionLine[] = [];
  const plain: DocMentionLine[] = [];
  for (let index = 0; index < lines.length && quoted.length < max; index++) {
    const text = lines[index] ?? "";
    if (quotedFormOccursIn(text, token)) quoted.push({ path: relPath, line: index + 1, text, changelog });
    else if (plain.length < max && wholeTokenOccursIn(text, token)) plain.push({ path: relPath, line: index + 1, text, changelog });
  }
  return [...quoted, ...plain].slice(0, max);
}

// ---------------------------------------------------------------------------
// Plan memo (in-process, bounded FIFO, never on the wire)
// ---------------------------------------------------------------------------

export interface AskedPathWindow {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** The callee's name (`handle_url_build_error`). */
  readonly name: string;
  /** The served focal whose body calls it (`url_for`). */
  readonly focal: string;
  /** The query identifier that puts the call on the asked path. */
  readonly term: string;
  /** Where the method was found relative to the focal: its own class, or a base class (named). */
  readonly resolution: "same-class" | `base:${string}`;
}

export interface AskedPathUnresolved {
  readonly name: string;
  readonly focal: string;
  readonly term: string;
  readonly reason: string;
}

export interface QuotedLiteralAbsence {
  readonly term: string;
  readonly scopeComplete: boolean;
  readonly omittedCount: number;
  readonly scannedFiles: number;
  readonly docMentions: readonly DocMentionLine[];
}

export interface AskedPathPlan {
  readonly query: string;
  readonly windows: readonly AskedPathWindow[];
  readonly unresolved: readonly AskedPathUnresolved[];
  readonly literalAbsences: readonly QuotedLiteralAbsence[];
  /** sha of every file a window names at plan time — a mismatch invalidates the plan. */
  readonly fileShas: Readonly<Record<string, string>>;
}

export const MAX_ASKED_PATH_PLANS_PER_WORKSPACE = 32;
export const MAX_ASKED_PATH_PLAN_WORKSPACES = 16;

const plans = new Map<string, Map<string, AskedPathPlan>>();

export function recordAskedPathPlan(workspaceKey: string, plan: AskedPathPlan): void {
  let byQuery = plans.get(workspaceKey);
  if (byQuery === undefined) {
    if (plans.size >= MAX_ASKED_PATH_PLAN_WORKSPACES) {
      const oldest = plans.keys().next().value;
      if (oldest !== undefined) plans.delete(oldest);
    }
    byQuery = new Map();
    plans.set(workspaceKey, byQuery);
  }
  byQuery.delete(plan.query);
  if (byQuery.size >= MAX_ASKED_PATH_PLANS_PER_WORKSPACE) {
    const oldest = byQuery.keys().next().value;
    if (oldest !== undefined) byQuery.delete(oldest);
  }
  byQuery.set(plan.query, plan);
}

/** The plan recorded for `query`, or `undefined` when none was or a file it names changed since. */
export function askedPathPlanFor(
  workspaceKey: string,
  query: string,
  currentSha: (path: string) => string | undefined,
): AskedPathPlan | undefined {
  const plan = plans.get(workspaceKey)?.get(query);
  if (plan === undefined) return undefined;
  for (const [path, sha] of Object.entries(plan.fileShas)) {
    if (currentSha(path) !== sha) return undefined;
  }
  return plan;
}

export function resetAskedPathPlansForTest(): void {
  plans.clear();
}

/** The obligation id prefix the readiness stage mints per asked-path window. */
export const ASKED_PATH_OBLIGATION_PREFIX = "asked-path:";
