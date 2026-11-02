// anchorFirst.ts — 2026-10-29 first-hop field report: the anchors a request
// NAMES (a dotted member such as `res.redirect`, a code identifier, a quoted or
// bracketed literal — `requestAnchors.ts`) are looked up FIRST, in the
// workspace, before any lexical ranking.
//
// WHY. `res.redirect` was split into `res` / `redirect` and never searched as
// one thing, so the first pack served `lib/express.js` (`var res = require(...)`)
// and certified `act.answer` over a Readme; `[default: (unlimited)]` was plain
// words. A request that names a definition owes the caller that definition:
//
//   - `resolveAnchorDefinitions` finds the DECLARATION of each named identifier
//     or chain (`res.redirect = function redirect(url) {…}`, `exports.send =`,
//     `Foo.prototype.bar =`, `def f(`, `const X =`), its span, and whether the
//     workspace defines the name at all. "Defines" is what lets the readiness
//     gate demand a definition row for a name that has one, while a name the
//     workspace does not define (stdlib `os.path.join`) keeps today's rule.
//   - `resolveAnchorLiterals` finds the exact-text occurrences of each literal.
//   - the resolution is remembered per (workspace, query) so the synchronous
//     readiness builder reads the SAME facts the pack builder minted its
//     candidates from (`recallAnchorResolution`).
//
// Everything here is read-only and bounded: one literal scan per anchor, one
// parse per file that holds a declaration-shaped hit.

import * as fs from "node:fs";
import * as path from "node:path";

import { scanLiteral } from "../search/find/findText.js";
import { languageForPath } from "../../util/languages.js";
import { declarationRealExtent } from "./evidenceClosure.js";
import { hasHashComments } from "./callerExpansion.js";
import { anchorsIfEnabled } from "./anchorFlag.js";
import type { RequestAnchors } from "./requestAnchors.js";

// ---------------------------------------------------------------------------
// Anchors of a query (memoized: the extractor runs on hot paths)
// ---------------------------------------------------------------------------

const anchorMemo = new Map<string, RequestAnchors>();
const ANCHOR_MEMO_MAX = 64;

export function requestAnchorsOf(query: string): RequestAnchors {
  const memoKey = process.env["TL_ANCHOR_FIRST"] === "0" ? `off\u0000${query}` : query;
  const hit = anchorMemo.get(memoKey);
  if (hit !== undefined) return hit;
  let anchors: RequestAnchors;
  try {
    anchors = anchorsIfEnabled(query);
  } catch {
    anchors = { chains: [], literals: [], identifiers: [] };
  }
  if (anchorMemo.size >= ANCHOR_MEMO_MAX) anchorMemo.delete(anchorMemo.keys().next().value as string);
  anchorMemo.set(memoKey, anchors);
  return anchors;
}

/** The dotted chains a request names, as written (`res.redirect`, `Foo.prototype.bar`). */
export function anchorChainsOf(query: string): string[] {
  return requestAnchorsOf(query).chains.map((chain) => chain.raw);
}

/** Identifiers AND chains the request names, in order of first appearance. */
export function anchorIdentifiersOf(query: string): string[] {
  return requestAnchorsOf(query).identifiers;
}

/** Anchor identifiers considered for definition lookup and the readiness gate. */
export const MAX_ANCHOR_IDENTIFIERS = 6;
/** Literals searched per request. */
export const MAX_ANCHOR_LITERALS = 3;
/** Definitions kept per anchor identifier. */
export const MAX_DEFINITIONS_PER_ANCHOR = 2;
/** Literal hits kept per literal. */
export const MAX_HITS_PER_LITERAL = 2;
/** A name declared only outside the implementation, in more files than this, names no single definition. */
const MAX_NON_IMPLEMENTATION_DECLARING_FILES = 3;
/** Raw scan matches examined per anchor. A chain such as `res.send` is mentioned on hundreds of lines. */
const MAX_SCAN_MATCHES = 3000;
/** Matches examined when a chain's member is searched by its own name. */
const MAX_MEMBER_SCAN_MATCHES = 3000;
/** Window a declaration without a parsed extent is served over. */
const FALLBACK_DEFINITION_LINES = 40;
/** Literal window radius when no enclosing symbol is known. */
const LITERAL_WINDOW_BEFORE = 8;
const LITERAL_WINDOW_AFTER = 16;
/** A literal found on more lines than this is not a location. */
const MAX_LITERAL_OCCURRENCES = 8;
/** Largest enclosing symbol a literal hit is served as. */
const LITERAL_SYMBOL_MAX_LINES = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnchorDefinition {
  /** The anchor as the request wrote it (`res.redirect`, `computeTotal`). */
  readonly id: string;
  readonly path: string;
  /** The line the declaration starts on (1-based). */
  readonly startLine: number;
  /** The last line of the declaration (1-based, inclusive). */
  readonly endLine: number;
  /** The symbol name to anchor the served row on. */
  readonly symbol: string;
  /** The declaration line's trimmed text — revalidated before a remembered resolution is trusted. */
  readonly lineText: string;
  /** False for a test, example, fixture, doc or bench path. */
  readonly implementation: boolean;
}

export interface AnchorLiteralHit {
  readonly literal: string;
  readonly path: string;
  readonly line: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly lineText: string;
  readonly implementation: boolean;
}

export interface AnchorResolution {
  readonly definitions: readonly AnchorDefinition[];
  readonly literalHits: readonly AnchorLiteralHit[];
  /** Anchor identifiers (as written) the workspace defines — each has at least one entry in `definitions`. */
  readonly definedIds: readonly string[];
}

export interface AnchorSymbol {
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly signatureStartLine?: number;
  readonly signatureEndLine?: number;
  /** The type or function this symbol is declared inside, when the parser knows it. */
  readonly enclosingSymbol?: { readonly name: string } | undefined;
}

/** What the resolver needs from its host (the pack builder's cache and predicates). */
export interface AnchorIO {
  readonly workspace: string;
  /** Narrow the scans to a sub-path (`args.path`). */
  readonly scopePath?: string;
  /**
   * The request text. A member of a type the request itself names (`updateGps`
   * of "the big EKF class …") is the type's business — the class focus and the
   * structure map serve it — not an anchor of its own.
   */
  readonly query?: string;
  read(relPath: string): string | undefined;
  /** Parsed symbols of a file; omitted for the synchronous resolver. */
  parsedSymbols?(text: string, lang: string, relPath: string): Promise<readonly AnchorSymbol[] | null>;
  /** `isDeclarationShapedMatchText`: does this line DECLARE `identifier`? */
  isDeclarationShaped(text: string, identifier: string): boolean;
}

// ---------------------------------------------------------------------------
// Path classes
// ---------------------------------------------------------------------------

const NON_DECLARING_LANGUAGES: ReadonlySet<string> = new Set([
  "markdown", "html", "css", "json", "jsonc", "yaml", "toml",
]);

/**
 * A path that carries a request subject's own code (not a test, example, doc or vendored
 * copy). `fixtures` / `samples` / `demos` / `benchmarks` count only as the file's own
 * directory or name — the same leaf-scoped reading `isNonImplementationAnswerCandidate`
 * gives them — because a repository can keep its real subject under `bench/fixtures/<app>/…`.
 */
export function isImplementationAnchorPath(relPath: string): boolean {
  const posix = relPath.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)(?:__tests__|tests?|specs?|decoys?|examples?|docs?|vendor|third_party|node_modules)(?:\/|$)/.test(posix)) return false;
  if (/\.(?:spec|test)\.[^./]+$/.test(posix) || /(?:^|\/)test_[^/]+$/.test(posix) || /_test\.[^./]+$/.test(posix)) return false;
  const segments = posix.split("/").filter((segment) => segment !== "");
  const leaf = segments[segments.length - 1] ?? "";
  const parent = segments.length >= 2 ? segments[segments.length - 2]! : "";
  const leafScoped = /(?:^|[^a-z])(?:fixtures?|samples?|demos?|benchmarks?)(?:[^a-z]|$)/;
  return !(leafScoped.test(leaf) || leafScoped.test(parent));
}

// ---------------------------------------------------------------------------
// Whole-chain occurrences
// ---------------------------------------------------------------------------

const ID_CHAR = /[A-Za-z0-9_$]/;

/** Start offsets of `id` in `line` where neither neighbour continues a name or a member chain. */
function chainOccurrences(line: string, id: string): number[] {
  const out: number[] = [];
  for (let at = line.indexOf(id); at >= 0; at = line.indexOf(id, at + 1)) {
    const before = at > 0 ? line[at - 1]! : "";
    const after = line[at + id.length] ?? "";
    if (before !== "" && (ID_CHAR.test(before) || before === ".")) continue;
    if (after !== "" && ID_CHAR.test(after)) continue;
    out.push(at);
  }
  return out;
}

const ASSIGNMENT_AFTER_RE = /^\s*(?::[^=]*)?=(?!=|>)/;

// ---------------------------------------------------------------------------
// Raw declaration hits (synchronous)
// ---------------------------------------------------------------------------

interface RawHit {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly lineText: string;
  /** The declaration starts in column 0 (a top-level statement, not a member). */
  readonly column0: boolean;
  /** The line itself is a declaration by shape (not merely a mention a parsed symbol might confirm). */
  readonly shaped: boolean;
  /** The symbol name to look for in the parse when it is not the anchor id (`prompt` for `click.prompt`). */
  readonly matchName?: string;
  /** A type-qualified chain's owner (`Context` of `Context.invoke`): the parsed symbol must be declared inside it. */
  readonly ownerType?: string;
}

function linesOf(io: AnchorIO, relPath: string, memo: Map<string, string[] | undefined>): string[] | undefined {
  if (memo.has(relPath)) return memo.get(relPath);
  const text = io.read(relPath);
  const lines = text === undefined ? undefined : text.split(/\r?\n/);
  memo.set(relPath, lines);
  return lines;
}

/** Declaration-shaped (or symbol-confirmable) occurrences of `id`, workspace-wide, scan order. */
function collectRawHits(io: AnchorIO, id: string, memo: Map<string, string[] | undefined>): RawHit[] {
  let matches: ReturnType<typeof scanLiteral>;
  try {
    matches = scanLiteral(id, io.workspace, { caseInsensitive: false, ...(io.scopePath ? { path: io.scopePath } : {}) });
  } catch {
    return [];
  }
  const isChain = id.includes(".");
  const out: RawHit[] = [];
  for (const match of matches.slice(0, MAX_SCAN_MATCHES)) {
    const language = languageForPath(match.path);
    if (language === undefined || NON_DECLARING_LANGUAGES.has(language)) continue;
    const lines = linesOf(io, match.path, memo);
    const full = lines?.[match.line - 1];
    if (full === undefined) continue;
    const offsets = chainOccurrences(full, id);
    if (offsets.length === 0) continue;
    const at = offsets[0]!;
    const before = full.slice(0, at);
    const after = full.slice(at + id.length);
    let shaped: boolean;
    if (isChain) {
      // `res.redirect = function redirect(url) {` — a chain is declared by being assigned.
      shaped = before.trim() === "" && ASSIGNMENT_AFTER_RE.test(after);
    } else {
      shaped = io.isDeclarationShaped(full, id)
        || (before === "" && ASSIGNMENT_AFTER_RE.test(after)); // column-0 module constant (`NAME = {`)
    }
    out.push({ id, path: match.path, line: match.line, lineText: full.trim(), column0: !/^\s/.test(full), shaped });
  }
  // A chain that is never written as `<chain> = …` is declared another way: see chainMemberHits.
  if (isChain && !out.some((hit) => hit.shaped)) out.push(...chainMemberHits(io, id, memo));
  return out;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A declaration keyword (and optional modifiers) right before the declared name. */
const DECLARATION_KEYWORD_BEFORE_RE = /(?:^|[\s;{}])(?:(?:export|public|private|protected|static|async|final|abstract|override|pub|default)\s+)*(?:def|function\*?|fn|func|class|interface|type|enum|struct|trait|const|let|var|val|object|module)\s+$/;

/** Does a directory of `relPath`, or its file stem, carry the name `owner` (a package, a module)? */
function pathCarriesOwner(relPath: string, owner: string): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/");
  const stem = (segments[segments.length - 1] ?? "").replace(/\.[^.]+$/, "");
  return segments.slice(0, -1).includes(owner) || stem === owner;
}

/**
 * The other ways a dotted chain `owner.member` is declared when no `owner.member = …` exists:
 *
 *  - an installer call that names the pair as arguments — `defineGetter(req, 'protocol', fn)`,
 *    `Object.defineProperty(req, 'protocol', {…})`: the text `req.protocol` never appears there
 *    (the parser names the symbol `req.protocol`, which `definitionFromHit` then finds);
 *  - a PACKAGE-qualified member — `click.prompt`, where `click` is the package (a directory or a
 *    module named so) and `prompt` a top-level declaration under it, possibly re-exported by the
 *    package's `__init__`: the member's own declaration under that package;
 *  - a TYPE-qualified member — `Context.invoke`: the method `invoke` declared inside the type
 *    `Context` (checked against the parsed owner).
 *
 * The chain keeps its own id; only the symbol looked up differs (`matchName`).
 */
function chainMemberHits(io: AnchorIO, id: string, memo: Map<string, string[] | undefined>): RawHit[] {
  const dot = id.lastIndexOf(".");
  if (dot <= 0 || dot === id.length - 1) return [];
  const owner = id.slice(0, dot);
  const member = id.slice(dot + 1);
  const out: RawHit[] = [];
  const scanOptions = { caseInsensitive: false, ...(io.scopePath ? { path: io.scopePath } : {}) };
  const installer = new RegExp(`[(,]\\s*${escapeForRegExp(owner)}\\s*,\\s*['"]${escapeForRegExp(member)}['"]`);
  for (const quote of ["'", "\""]) {
    let matches: ReturnType<typeof scanLiteral>;
    try {
      matches = scanLiteral(`${quote}${member}${quote}`, io.workspace, scanOptions);
    } catch {
      continue;
    }
    for (const match of matches.slice(0, MAX_SCAN_MATCHES)) {
      const language = languageForPath(match.path);
      if (language === undefined || NON_DECLARING_LANGUAGES.has(language)) continue;
      const full = linesOf(io, match.path, memo)?.[match.line - 1];
      if (full === undefined || !installer.test(full)) continue;
      out.push({ id, path: match.path, line: match.line, lineText: full.trim(), column0: !/^\s/.test(full), shaped: true });
    }
  }
  if (out.length > 0) return out;
  let matches: ReturnType<typeof scanLiteral>;
  try {
    matches = scanLiteral(member, io.workspace, scanOptions);
  } catch {
    return [];
  }
  const typeOwned = /^[A-Z]/.test(owner.split(".").pop() ?? "");
  for (const match of matches.slice(0, MAX_MEMBER_SCAN_MATCHES)) {
    const language = languageForPath(match.path);
    if (language === undefined || NON_DECLARING_LANGUAGES.has(language)) continue;
    if (!typeOwned && !pathCarriesOwner(match.path, owner)) continue;
    const full = linesOf(io, match.path, memo)?.[match.line - 1];
    if (full === undefined) continue;
    const at = chainOccurrences(full, member)[0];
    if (at === undefined) continue;
    const column0 = !/^\s/.test(full);
    // The WHOLE occurrence is what is declared: `def hidden_prompt_func(prompt: str)` names `prompt` as a
    // parameter, and the shape test alone would read the `prompt` inside the function's own name.
    const before = full.slice(0, at);
    const after = full.slice(at + member.length);
    const keywordDeclared = DECLARATION_KEYWORD_BEFORE_RE.test(before) && /^\s*[(<=:]/.test(after);
    // A type's method may be written without a keyword (`invoke(args) {`): only the parse can tell it from a call.
    const methodShaped = typeOwned && before.trim() === "" && /^\s*\(/.test(after);
    if (!keywordDeclared && !methodShaped) continue;
    // Package-qualified: a top-level declaration. Type-qualified: any declaration — the parsed owner decides.
    if (!typeOwned && !column0) continue;
    out.push({
      id, path: match.path, line: match.line, lineText: full.trim(), column0, shaped: keywordDeclared,
      matchName: member, ...(typeOwned ? { ownerType: owner.split(".").pop()! } : {}),
    });
  }
  return out;
}

/** Does the request name `word` as a whole word? */
function queryNamesWord(query: string | undefined, word: string): boolean {
  if (query === undefined || word === "") return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeForRegExp(word)}(?:[^A-Za-z0-9_$]|$)`).test(query);
}

/** `void f(int);` — a declaration with no body, which says where a name lives but is not its definition. */
function isPrototypeLike(lineText: string): boolean {
  const head = /^(.*\))\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:=\s*0\s*)?;\s*(?:\/\/.*)?$/.exec(lineText);
  return head !== null && !/[={]/.test(head[1]!);
}

function tailName(name: string): string {
  const match = /(?:::|[.#])([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(name);
  return match?.[1] ?? name;
}

function symbolNamesAnchor(symbolName: string, id: string): boolean {
  return symbolName === id
    || symbolName.replace(/::|#/g, ".") === id
    || (!id.includes(".") && tailName(symbolName) === id);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function extentFromLines(lines: readonly string[], relPath: string, startLine: number): { start: number; end: number } {
  const extent = declarationRealExtent(lines, startLine, hasHashComments(relPath));
  // A brace-less body (Python `def`) closes on its own line; serve a bounded window past it.
  if (extent.end <= startLine) {
    const language = languageForPath(relPath);
    if (language === "python" || language === "ruby") {
      const indentOf = (value: string): number => value.length - value.trimStart().length;
      const headIndent = indentOf(lines[startLine - 1] ?? "");
      let end = startLine;
      for (let next = startLine + 1; next <= lines.length && next <= startLine + 200; next++) {
        const text = lines[next - 1] ?? "";
        if (text.trim() === "") continue;
        if (indentOf(text) <= headIndent) break;
        end = next;
      }
      return { start: startLine, end };
    }
  }
  return { start: startLine, end: Math.max(startLine, extent.end) };
}

/**
 * A name that first appears INSIDE a parameter list (`long measure(const struct sched_s *s, long seed)`)
 * is used there, not declared — whatever name a parser gave the enclosing function. The declaration
 * of a name is where it comes before any `(` (a Go method's receiver is the one exception).
 */
function namedInsideParameterList(lineText: string, name: string): boolean {
  if (/^\s*func\s*\(/.test(lineText)) return false;
  const at = new RegExp(`(?<![A-Za-z0-9_$])${escapeForRegExp(name)}(?![A-Za-z0-9_$])`).exec(lineText)?.index;
  const paren = lineText.indexOf("(");
  return at !== undefined && paren >= 0 && at > paren;
}

async function definitionFromHit(
  io: AnchorIO,
  hit: RawHit,
  memo: Map<string, string[] | undefined>,
  symbolMemo: Map<string, readonly AnchorSymbol[] | null>,
): Promise<AnchorDefinition | undefined> {
  const lines = linesOf(io, hit.path, memo);
  if (lines === undefined) return undefined;
  if (!hit.id.includes(".") && hit.ownerType === undefined && namedInsideParameterList(lines[hit.line - 1] ?? hit.lineText, hit.matchName ?? hit.id)) return undefined;
  let symbols: readonly AnchorSymbol[] | null = null;
  if (io.parsedSymbols !== undefined) {
    if (symbolMemo.has(hit.path)) symbols = symbolMemo.get(hit.path) ?? null;
    else {
      const lang = languageForPath(hit.path);
      const text = io.read(hit.path);
      try {
        symbols = lang !== undefined && text !== undefined ? await io.parsedSymbols(text, lang, hit.path) : null;
      } catch {
        symbols = null;
      }
      symbolMemo.set(hit.path, symbols);
    }
  }
  const symbolOwner = (symbol: AnchorSymbol): string | undefined =>
    symbol.enclosingSymbol?.name ?? /^(.+?)(?:::|\.)[A-Za-z_$][A-Za-z0-9_$]*$/.exec(symbol.name)?.[1];
  const named = (symbols ?? [])
    .filter((symbol) =>
      symbolNamesAnchor(symbol.name, hit.matchName ?? hit.id)
      && (hit.ownerType === undefined || symbolOwner(symbol)?.split(/::|\./).pop() === hit.ownerType)
      && hit.line >= (symbol.signatureStartLine ?? symbol.startLine)
      && hit.line <= Math.max(symbol.startLine, symbol.signatureEndLine ?? symbol.startLine))
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  const implementation = isImplementationAnchorPath(hit.path);
  if (named !== undefined) {
    // A member of a type the request names belongs to that type's own focus.
    const owner = named.enclosingSymbol?.name ?? (/^(.+?)(?:::|\.)[A-Za-z_$][A-Za-z0-9_$]*$/.exec(named.name)?.[1]);
    if (!hit.id.includes(".") && owner !== undefined && queryNamesWord(io.query, owner)) return undefined;
    return {
      id: hit.id, path: hit.path, startLine: named.startLine, endLine: Math.max(named.startLine, named.endLine),
      symbol: named.name, lineText: (lines[named.startLine - 1] ?? hit.lineText).trim(), implementation,
    };
  }
  if (!hit.shaped) return undefined;
  // A type-qualified chain is a member OF THAT TYPE: a same-named method of another type is not it,
  // and shape alone cannot tell them apart.
  if (hit.ownerType !== undefined) return undefined;
  // A declaration by shape whose file the parser does not name it in (a Python
  // module constant, a JS chain the grammar does not model): its own extent.
  if (symbols !== null && symbols.length > 0 && !hit.id.includes(".") && /^\s/.test(lines[hit.line - 1] ?? "")) {
    // An INDENTED declaration-shaped line the parser did not name is a parameter,
    // a field or a local — not the definition of the name.
    return undefined;
  }
  const extent = extentFromLines(lines, hit.path, hit.line);
  const end = extent.end > extent.start ? extent.end : Math.min(lines.length, hit.line + FALLBACK_DEFINITION_LINES - 1);
  return {
    id: hit.id, path: hit.path, startLine: hit.line, endLine: Math.max(hit.line, end),
    symbol: hit.id, lineText: hit.lineText, implementation,
  };
}

function rankDefinitions(definitions: AnchorDefinition[]): AnchorDefinition[] {
  const withBody = definitions.filter((definition) => !isPrototypeLike(definition.lineText));
  // A prototype only says where the name lives: with a definition that has a body, it is not a rival.
  const kept = withBody.length > 0 ? withBody : definitions;
  return kept
    .map((definition, order) => ({ definition, order }))
    .sort((a, b) =>
      Number(b.definition.implementation) - Number(a.definition.implementation)
      || a.order - b.order)
    .map((entry) => entry.definition);
}

/**
 * The declarations kept for one anchor: those of the implementation (a test's or an
 * example's same-named helper is no rival), or every one there is when only such
 * files declare it. `undefined` when SEVERAL implementation files declare the name:
 * which of them the request means is the same-name logic's call (WP-O,
 * `recoverSameNameAnswerSubjects`), not this lookup's — and a name declared that
 * widely is no single definition's subject.
 */
function chooseDefinitions(found: AnchorDefinition[]): AnchorDefinition[] | undefined {
  // Overloads (`@overload def prompt(…) -> str: ...` twice, then the implementation) declare one name
  // several times in one file: the implementation is the longest of them.
  const longestPerFile = new Map<string, AnchorDefinition>();
  for (const definition of found) {
    const current = longestPerFile.get(definition.path);
    if (current === undefined || definition.endLine - definition.startLine > current.endLine - current.startLine) {
      longestPerFile.set(definition.path, definition);
    }
  }
  const ranked = rankDefinitions([...longestPerFile.values()]);
  const implementation = ranked.filter((definition) => definition.implementation);
  if (new Set(implementation.map((definition) => definition.path)).size > 1) return undefined;
  // Declared only in tests / examples / fixtures, and in many of them: a generic name, no one is the subject.
  if (implementation.length === 0 && new Set(ranked.map((definition) => definition.path)).size > MAX_NON_IMPLEMENTATION_DECLARING_FILES) return undefined;
  return (implementation.length > 0 ? implementation : ranked).slice(0, MAX_DEFINITIONS_PER_ANCHOR);
}

/**
 * The declarations of every identifier or chain the request names. A name
 * declared in several implementation files is left out (`definedIds` does not
 * list it): see `chooseDefinitions`.
 */
export async function resolveAnchorDefinitions(io: AnchorIO, ids: readonly string[]): Promise<AnchorResolution> {
  const memo = new Map<string, string[] | undefined>();
  const symbolMemo = new Map<string, readonly AnchorSymbol[] | null>();
  const definitions: AnchorDefinition[] = [];
  const definedIds: string[] = [];
  for (const id of ids.slice(0, MAX_ANCHOR_IDENTIFIERS)) {
    if (id.length < 3) continue;
    const hits = collectRawHits(io, id, memo);
    if (hits.length === 0) continue;
    // Declarations first: parse at most a few files (shaped hits, then the rest).
    const ordered = [...hits.filter((hit) => hit.shaped), ...hits.filter((hit) => !hit.shaped)].slice(0, 24);
    const found: AnchorDefinition[] = [];
    for (const hit of ordered) {
      const definition = await definitionFromHit(io, hit, memo, symbolMemo);
      if (definition === undefined) continue;
      if (found.some((entry) => entry.path === definition.path && entry.startLine === definition.startLine)) continue;
      found.push(definition);
    }
    if (found.length === 0) continue;
    const chosen = chooseDefinitions(found);
    if (chosen === undefined) continue;
    definedIds.push(id);
    definitions.push(...chosen);
  }
  return { definitions, literalHits: [], definedIds };
}

/** `resolveAnchorDefinitions` without a parser: declarations by shape, extents by bracket depth / indentation. */
export function resolveAnchorDefinitionsSync(io: AnchorIO, ids: readonly string[]): AnchorResolution {
  const memo = new Map<string, string[] | undefined>();
  const definitions: AnchorDefinition[] = [];
  const definedIds: string[] = [];
  for (const id of ids.slice(0, MAX_ANCHOR_IDENTIFIERS)) {
    if (id.length < 3) continue;
    const found: AnchorDefinition[] = [];
    // Without a parser a declaration is trusted only where its shape is unmistakable: a
    // dotted chain's assignment, or a top-level (column 0) statement — never a member.
    for (const hit of collectRawHits(io, id, memo).filter((entry) => entry.shaped && entry.ownerType === undefined && (id.includes(".") || entry.column0)).slice(0, 24)) {
      const lines = linesOf(io, hit.path, memo);
      if (lines === undefined) continue;
      const extent = extentFromLines(lines, hit.path, hit.line);
      const end = extent.end > extent.start ? extent.end : Math.min(lines.length, hit.line + FALLBACK_DEFINITION_LINES - 1);
      if (found.some((entry) => entry.path === hit.path && entry.startLine === hit.line)) continue;
      found.push({
        id, path: hit.path, startLine: hit.line, endLine: Math.max(hit.line, end), symbol: id,
        lineText: hit.lineText, implementation: isImplementationAnchorPath(hit.path),
      });
    }
    if (found.length === 0) continue;
    const chosen = chooseDefinitions(found);
    if (chosen === undefined) continue;
    definedIds.push(id);
    definitions.push(...chosen);
  }
  return { definitions, literalHits: [], definedIds };
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

/** Exact-text occurrences of each literal the request quotes or brackets (cap 2 per literal, implementation first). */
export async function resolveAnchorLiterals(io: AnchorIO, literals: readonly string[]): Promise<AnchorLiteralHit[]> {
  const memo = new Map<string, string[] | undefined>();
  const symbolMemo = new Map<string, readonly AnchorSymbol[] | null>();
  const out: AnchorLiteralHit[] = [];
  for (const literal of literals.slice(0, MAX_ANCHOR_LITERALS)) {
    // A quoted common word ("total", "value") is a phrase of the request, not text to find:
    // a literal is distinctive when it is long, or carries punctuation / a space.
    if (literal.length < 4 || (literal.length < 6 && !/[^A-Za-z0-9_]/.test(literal))) continue;
    let matches: ReturnType<typeof scanLiteral>;
    try {
      matches = scanLiteral(literal, io.workspace, { caseInsensitive: false, ...(io.scopePath ? { path: io.scopePath } : {}) });
    } catch {
      continue;
    }
    // …and rare: found everywhere, it locates nothing.
    if (matches.length > MAX_LITERAL_OCCURRENCES) continue;
    const candidates = matches
      .filter((match) => {
        const language = languageForPath(match.path);
        return language !== undefined && !NON_DECLARING_LANGUAGES.has(language);
      })
      .map((match, order) => ({ match, order, implementation: isImplementationAnchorPath(match.path) }))
      .sort((a, b) => Number(b.implementation) - Number(a.implementation) || a.order - b.order);
    const perFile = new Set<string>();
    let kept = 0;
    for (const { match, implementation } of candidates) {
      if (kept >= MAX_HITS_PER_LITERAL) break;
      if (perFile.has(match.path)) continue;
      const lines = linesOf(io, match.path, memo);
      if (lines === undefined) continue;
      let symbols: readonly AnchorSymbol[] | null = null;
      if (io.parsedSymbols !== undefined) {
        if (symbolMemo.has(match.path)) symbols = symbolMemo.get(match.path) ?? null;
        else {
          const lang = languageForPath(match.path);
          const text = io.read(match.path);
          try {
            symbols = lang !== undefined && text !== undefined ? await io.parsedSymbols(text, lang, match.path) : null;
          } catch {
            symbols = null;
          }
          symbolMemo.set(match.path, symbols);
        }
      }
      const enclosing = (symbols ?? [])
        .filter((symbol) =>
          (symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class")
          && match.line >= symbol.startLine && match.line <= symbol.endLine
          && symbol.endLine - symbol.startLine + 1 <= LITERAL_SYMBOL_MAX_LINES)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      const startLine = enclosing?.startLine ?? Math.max(1, match.line - LITERAL_WINDOW_BEFORE);
      const endLine = enclosing?.endLine ?? Math.min(lines.length, match.line + LITERAL_WINDOW_AFTER);
      perFile.add(match.path);
      kept += 1;
      out.push({
        literal, path: match.path, line: match.line, startLine, endLine,
        ...(enclosing !== undefined ? { symbol: enclosing.name } : {}),
        lineText: (lines[match.line - 1] ?? "").trim(), implementation,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remembered resolutions
// ---------------------------------------------------------------------------

interface StoredResolution {
  readonly at: number;
  readonly resolution: AnchorResolution;
}

const resolutionStore = new Map<string, StoredResolution>();
const RESOLUTION_STORE_MAX = 24;
/** A remembered resolution older than this is recomputed (files may have been added since). */
const RESOLUTION_TTL_MS = 30_000;

function storeKey(workspace: string, query: string): string {
  return `${workspace}\u0000${query}`;
}

export function rememberAnchorResolution(workspace: string, query: string, resolution: AnchorResolution): void {
  if (resolutionStore.size >= RESOLUTION_STORE_MAX) resolutionStore.delete(resolutionStore.keys().next().value as string);
  resolutionStore.set(storeKey(workspace, query), { at: Date.now(), resolution });
}

/** The remembered resolution when it is fresh and the declarations it names are still where it says. */
export function recallAnchorResolution(io: Pick<AnchorIO, "workspace" | "read">, query: string): AnchorResolution | undefined {
  const key = storeKey(io.workspace, query);
  const stored = resolutionStore.get(key);
  if (stored === undefined) return undefined;
  if (Date.now() - stored.at > RESOLUTION_TTL_MS) {
    resolutionStore.delete(key);
    return undefined;
  }
  for (const definition of stored.resolution.definitions) {
    const text = io.read(definition.path);
    const line = text?.split(/\r?\n/)[definition.startLine - 1];
    if (line === undefined || line.trim() !== definition.lineText) {
      resolutionStore.delete(key);
      return undefined;
    }
  }
  return stored.resolution;
}

/** Forget every remembered resolution (tests, workspace resets). */
export function resetAnchorResolutions(): void {
  resolutionStore.clear();
  anchorMemo.clear();
}

/**
 * The definitions of `anchorId` for the readiness gate: the remembered
 * resolution the pack builder minted its candidates from, else a synchronous
 * resolution of the request's anchors (remembered for the next call). Empty
 * when the workspace does not define the name — or defines it in so many
 * files that no one definition is the subject.
 */
export function anchorDefinitionsFor(io: AnchorIO, query: string, anchorId: string): readonly AnchorDefinition[] {
  let resolution = recallAnchorResolution(io, query);
  if (resolution === undefined) {
    const ids = anchorIdentifiersOf(query);
    if (!ids.includes(anchorId)) return [];
    resolution = resolveAnchorDefinitionsSync({ ...io, query }, ids);
    rememberAnchorResolution(io.workspace, query, resolution);
  }
  return resolution.definitions.filter((definition) => definition.id === anchorId);
}

/** Convenience for hosts without a cache: read a workspace file directly. */
export function plainAnchorReader(workspace: string): (relPath: string) => string | undefined {
  return (relPath) => {
    try {
      return fs.readFileSync(path.join(workspace, relPath), "utf8");
    } catch {
      return undefined;
    }
  };
}
