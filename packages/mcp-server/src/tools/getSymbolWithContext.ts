// get_symbol_with_context tool implementation for @tokenlighten/mcp-server.
//
// Returns symbol body + AST scope-context header:
//   - imports actually used in body
//   - enclosing class signature (body elided)
//   - sibling method signatures (bodies elided)
//   - full target symbol body
//
// Output is PLAIN text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Full spec: docs/components/02-mcp-server.md §2.3, §4.

import type { McpToolResult } from "@tokenlighten/types";
import { languageForPathWithContent } from "../util/languages.js";
import { treeSitterSkeleton, treeSitterSupports } from "../skeleton/treeSitter.js";
import type { TreeSitterPaths } from "../skeleton/types.js";
import { compressFormat } from "../util/formatCompress.js";
import { collectSymbols, type CollectedSymbol } from "../symbols/collectSymbols.js";
import { renderSymbolSkeleton } from "../symbols/renderSymbolSkeleton.js";
import { commentNote, isTokenlightenSentinelLine } from "../util/sentinelComment.js";
import { escapeRegExp, MAX_REGEX_QUERY_CHARS } from "../features/search/find/findText.js";

// ---------------------------------------------------------------------------
// D8: `GetSymbolWithContextInput` / `GetSymbolWithContextOutput` used to live
// in `@tokenlighten/types`' `mcp/legacy-read.ts`, which is DELETED. This module
// serves the ADVERTISED `read_file mode=symbol` path, so the request shape
// moves here next to its one emitter and the output shape is renamed to what
// it actually is: the payload the funnel projects onto the v1 `read.text`
// member (types `mcp/read-result.ts`). The v1 member is the contract; this
// interface is the producer-side shape it is projected from.
// ---------------------------------------------------------------------------

/** Request shape of the `read_file mode=symbol` path. */
export interface GetSymbolWithContextInput {
  /** Workspace-relative file path. */
  path: string;
  /** Exact symbol name to expand. */
  symbol: string;
  /**
   * Extra context lines to include above and below the symbol body.
   * Default: 0 (body only, scope header is always included separately).
   */
  contextLines?: number;
}

/** The `mode=symbol` payload — projection source for v1 `read.text`. */
export interface SymbolContextPayload {
  /**
   * Full source text of the target symbol, including its scope-context header
   * (imports, enclosing class signature, sibling signatures).
   * Format: see docs/components/02-mcp-server.md §4.
   */
  code: string;
  /**
   * The machine-parseable `// tokenlighten:scope ...` header line that
   * prefixes the output. Extracted separately for programmatic consumers.
   */
  scopeHeader: string;
  /** Language of the source file. */
  language: string;
  /** 1-based line range of the target symbol in the original file. */
  range: { start: number; end: number };
}

export interface GetSymbolWithContextOptions {
  treeSitterPaths?: TreeSitterPaths;
}

/**
 * Not-found failure payload — extends the base McpToolResult failure shape
 * (kept for compatibility: `error`/`code` unchanged) with a recovery payload
 * so the caller does not need a second round trip (skeleton read) to
 * self-correct a bad symbol name.
 *
 * Reports/bench/2026-07-02a: a bare "Symbol not found" error cost 2 calls /
 * ~100K cache_read to recover. This folds that recovery into the miss.
 */
export interface GetSymbolWithContextNotFound {
  ok: false;
  error: string;
  code: "not-found";
  /**
   * Up to ~5 declared symbol names from the same file, ranked by similarity
   * to the requested name. Empty when the language/file has no enumerable
   * symbols (e.g. unsupported language).
   */
  candidates?: string[];
  /**
   * Compact top-level skeleton of the file (bodies elided), capped in size.
   * Lets the caller see file structure inline instead of issuing a follow-up
   * skeleton read.
   */
  skeleton?: string;
}

/**
 * Result of {@link getSymbolWithContext}. Deliberately a *two-member* union:
 * the success case plus the single not-found failure. We do NOT include the
 * generic `McpToolResult` failure member ({ ok:false; error; code:string }),
 * because this function only ever fails with `code:"not-found"`. Keeping the
 * failure branch to exactly `GetSymbolWithContextNotFound` means `!result.ok`
 * narrows straight to it, so `candidates`/`skeleton` are accessible without an
 * extra guard — and there is no ambiguous second `ok:false` member for TS to
 * get stuck on. The success member is reused verbatim from McpToolResult (via
 * Extract) so it stays in lockstep with the shared contract.
 */
export type GetSymbolWithContextResult =
  | Extract<McpToolResult<SymbolContextPayload>, { ok: true }>
  | GetSymbolWithContextNotFound;

const DEFAULT_SIBLING_CAP = 12;
/** Max candidate symbol names returned on a not-found miss. */
const NOT_FOUND_CANDIDATES_CAP = 5;
/** Max top-level blocks rendered into the not-found skeleton. */
const NOT_FOUND_SKELETON_BLOCK_CAP = 25;
/** Hard character cap on the not-found skeleton — this is a refusal payload, not a dump. */
const NOT_FOUND_SKELETON_CHAR_CAP = 2000;

/**
 * Split source text into lines (1-based line numbers).
 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// ---------------------------------------------------------------------------
// Minimal symbol finder — regex-based, sufficient for the v0.1 scope.
// For full AST-based extraction the caller should use tree-sitter directly;
// this covers the common patterns reliably.
// ---------------------------------------------------------------------------

interface FoundSymbol {
  name: string;
  startLine: number; // 1-based
  endLine: number;   // 1-based inclusive
  /**
   * DESIGN-v0.8 B4.1: signatureStartLine is OPTIONAL here — the tree-sitter
   * path (foundFromCollected) always provides it (collectSymbols.ts's
   * enclosingSymbol.signatureStartLine, the enclosing class's bare
   * declaration line, distinct from startLine once startLine may be widened
   * to include a leading doc comment); the regex path (findSymbolRegex)
   * never widens anything, so its own startLine IS already the bare
   * declaration line — renderEnclosingScope below falls back to startLine
   * when signatureStartLine is absent, which is exactly correct for that
   * path rather than a lossy approximation.
   */
  enclosingClass?: { name: string; startLine: number; endLine: number; signatureStartLine?: number };
  source: "tree-sitter" | "regex";
}

/**
 * Resolve a caller-friendly unqualified name only when the AST inventory makes
 * it unambiguous. C/C++ collectors commonly expose out-of-class definitions as
 * `Class::method`, while callers naturally ask for `method`. Exact lookup stays
 * first, and overloads / same-named methods remain a not-found response rather
 * than silently selecting the wrong body.
 */
async function findUniqueQualifiedSuffix(
  fileContent: string,
  symbolName: string,
  language: string,
  treeSitterPaths?: TreeSitterPaths,
): Promise<FoundSymbol | undefined> {
  if (language === "unknown" || symbolName.length === 0) return undefined;

  let symbols: CollectedSymbol[];
  try {
    symbols = await collectSymbols(fileContent, language, treeSitterPaths ?? {});
  } catch {
    return undefined;
  }

  const suffixes = [`::${symbolName}`, `.${symbolName}`, `#${symbolName}`];
  const matches = symbols.filter((candidate) =>
    candidate.name !== symbolName && suffixes.some((suffix) => candidate.name.endsWith(suffix)),
  );
  if (matches.length !== 1) return undefined;

  const match = matches[0]!;
  return {
    name: match.name,
    startLine: match.startLine,
    endLine: match.endLine,
    ...(match.enclosingSymbol
      ? {
          enclosingClass: {
            name: match.enclosingSymbol.name,
            startLine: match.enclosingSymbol.startLine,
            endLine: match.enclosingSymbol.endLine,
            signatureStartLine: match.enclosingSymbol.signatureStartLine,
          },
        }
      : {}),
    source: treeSitterSupports(language) ? "tree-sitter" : "regex",
  };
}

// Function/method declaration patterns by language.
const FUNC_PATTERNS: Record<string, RegExp> = {
  typescript: /^\s*(?:export\s+)?(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?:<[^>]*>)?\s*\()/,
  typescriptreact: /^\s*(?:export\s+)?(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?:<[^>]*>)?\s*\()/,
  javascript: /^\s*(?:export\s+)?(?:(?:static|async)\s+)*(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*\()/,
  python: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
  go: /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/,
  java: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)*\w[\w<>\[\],\s]*\s+(\w+)\s*\(/,
  rust: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/,
  ruby: /^\s*def\s+(\w+)/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed)\s+)*\w[\w<>\[\]?,\s]*\s+(\w+)\s*\(/,
  php: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/,
  kotlin: /^\s*(?:(?:fun|suspend fun|override fun|private fun|internal fun|public fun|open fun)\s+)(\w+)\s*[<(]/,
  c: /^\s*\w[\w\s\*]+\s+(\w+)\s*\(/,
  cpp: /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|override)\s+)*\w[\w\s\*&:<>]*\s+(\w+)\s*\(/,
};

const CLASS_PATTERNS: Record<string, RegExp> = {
  typescript: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  typescriptreact: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  javascript: /^\s*(?:export\s+)?class\s+(\w+)/,
  python: /^\s*class\s+(\w+)/,
  java: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+(\w+)/,
  ruby: /^\s*class\s+(\w+)/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*class\s+(\w+)/,
  php: /^\s*(?:(?:abstract|final)\s+)?class\s+(\w+)/,
  kotlin: /^\s*(?:(?:data|sealed|open|abstract|inner)\s+)?class\s+(\w+)/,
  rust: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl(?:\s+\w+\s+for)?)\s+(\w+)/,
};

const DECL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(\w+)\b/,
    /^\s*(?:export\s+)?interface\s+(\w+)\b/,
    /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    /^\s*(?:export\s+)?enum\s+(\w+)\b/,
  ],
  typescriptreact: [
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(\w+)\b/,
    /^\s*(?:export\s+)?interface\s+(\w+)\b/,
    /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    /^\s*(?:export\s+)?enum\s+(\w+)\b/,
  ],
  javascript: [
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\b/,
  ],
};

/**
 * Find symbol body end line using brace-matching (for brace languages)
 * or indentation-based (for Python).
 */
function findEndLine(lines: string[], startLine: number, lang: string): number {
  const isPython = lang === "python";
  const isRuby = lang === "ruby";

  if (isPython) {
    // Indentation-based: body ends when we return to or below the def indent.
    const defLine = lines[startLine - 1] ?? "";
    const defIndent = (defLine.match(/^(\s*)/) ?? ["", ""])[1]!.length;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() === "") continue;
      const curIndent = (l.match(/^(\s*)/) ?? ["", ""])[1]!.length;
      if (curIndent <= defIndent) return i; // 1-based, line i is NOT included
    }
    return lines.length;
  }

  if (isRuby) {
    // end-keyword based
    let depth = 1;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (/^(def|class|module|do|begin|if|unless|case|while|until|for)\b/.test(l)) depth++;
      if (l === "end" || l.startsWith("end ") || l.startsWith("end#")) depth--;
      if (depth === 0) return i + 1;
    }
    return lines.length;
  }

  // Brace-based
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const l = lines[i]!;
    for (let c = 0; c < l.length; c++) {
      const ch = l[c]!;
      if (ch === "{") {
        if (!started) {
          const rest = l.slice(c + 1);
          const closesOnSameLine = rest.includes("}");
          const prefix = l.slice(0, c);
          const likelyDeclarationBody = !closesOnSameLine || /(?:\)|=|function|class|interface|enum|=>)\s*$/.test(prefix);
          if (!likelyDeclarationBody) continue;
        }
        depth++;
        started = true;
      }
      if (ch === "}") {
        depth--;
        if (started && depth === 0) return i + 1;
      }
    }
  }
  return lines.length;
}

function findStatementEndLine(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const l = lines[i]!;
    for (let c = 0; c < l.length; c++) {
      const ch = l[c]!;
      if (ch === "{" || ch === "[" || ch === "(") {
        depth++;
        started = true;
      } else if (ch === "}" || ch === "]" || ch === ")") {
        depth = Math.max(0, depth - 1);
      }
    }
    if ((started && depth === 0 && /;\s*$/.test(l)) || (!started && /;\s*$/.test(l))) {
      return i + 1;
    }
  }
  return startLine;
}

function foundFromCollected(symbol: CollectedSymbol): FoundSymbol {
  return {
    name: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    ...(symbol.enclosingSymbol ? { enclosingClass: symbol.enclosingSymbol } : {}),
    source: "tree-sitter",
  };
}

async function findSymbolWithTreeSitter(
  text: string,
  symbolName: string,
  lang: string,
  treeSitterPaths?: TreeSitterPaths,
): Promise<FoundSymbol | undefined> {
  if (!treeSitterSupports(lang)) return undefined;
  const symbols = await collectSymbols(text, lang, treeSitterPaths ?? {});
  const match = symbols.find((s) => s.name === symbolName);
  return match ? foundFromCollected(match) : undefined;
}

/**
 * Find a symbol by name in file content, with optional enclosing class.
 */
function findSymbolRegex(text: string, symbolName: string, lang: string): FoundSymbol | undefined {
  const lines = splitLines(text);
  const funcPat = FUNC_PATTERNS[lang];
  const classPat = CLASS_PATTERNS[lang];
  const declPats = DECL_PATTERNS[lang] ?? [];

  let currentClass: { name: string; startLine: number; endLine: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track class context.
    if (classPat) {
      const cm = classPat.exec(line);
      if (cm && cm[1]) {
        const classEndLine = findEndLine(lines, lineNum, lang);
        // Only update class context if we're not already inside one.
        if (!currentClass || lineNum > currentClass.endLine) {
          currentClass = { name: cm[1], startLine: lineNum, endLine: classEndLine };
        }
        if (cm[1] === symbolName) {
          return {
            name: symbolName,
            startLine: lineNum,
            endLine: classEndLine,
            source: "regex",
          };
        }
      }
    }

    // Check if this line declares our target symbol.
    if (funcPat) {
      const fm = funcPat.exec(line);
      if (fm) {
        // Capture group 1 or 2 depending on language pattern.
        const name = fm[1] ?? fm[2];
        if (name && name === symbolName) {
          const endLine = findEndLine(lines, lineNum, lang);

          // Determine enclosing class.
          const enclosing =
            currentClass && lineNum >= currentClass.startLine && lineNum <= currentClass.endLine
              ? currentClass
              : undefined;

          return {
            name: symbolName,
            startLine: lineNum,
            endLine,
            enclosingClass: enclosing,
            source: "regex",
          };
        }
      }
    }

    for (const declPat of declPats) {
      const dm = declPat.exec(line);
      if (!dm || dm[1] !== symbolName) continue;
      const isContainer = /\b(?:interface|enum)\b/.test(line);
      return {
        name: symbolName,
        startLine: lineNum,
        endLine: isContainer ? findEndLine(lines, lineNum, lang) : findStatementEndLine(lines, lineNum),
        source: "regex",
      };
    }
  }

  return undefined;
}

/**
 * Extract import lines from top of file that reference any of the given names.
 */
function extractUsedImports(text: string, lang: string, bodyText: string): string[] {
  const lines = splitLines(text);
  const importLines: string[] = [];
  const bodyIdentifiers = identifierSet(bodyText);

  for (const line of lines) {
    const identifiers = importedBindingNames(line, lang);
    if (identifiers.some((id) => bodyIdentifiers.has(id))) importLines.push(line.trimEnd());
  }
  return importLines;
}

function isIdentifierStart(ch: string | undefined): boolean {
  if (ch === "_" || ch === "$") return true;
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierContinue(ch: string | undefined): boolean {
  if (isIdentifierStart(ch)) return true;
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function identifierSet(text: string): Set<string> {
  const identifiers = new Set<string>();
  for (let cursor = 0; cursor < text.length;) {
    if (!isIdentifierStart(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor++;
    while (isIdentifierContinue(text[cursor])) cursor++;
    identifiers.add(text.slice(start, cursor));
  }
  return identifiers;
}

function keywordRemainder(value: string, keyword: string): string | undefined {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith(keyword)) return undefined;
  const boundary = trimmed[keyword.length];
  if (!isInlineWhitespace(boundary)) return undefined;
  return trimmed.slice(keyword.length).trimStart();
}

function isInlineWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && ch.trim().length === 0;
}

function asciiWords(value: string): string[] {
  const words: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (isInlineWhitespace(value[cursor])) cursor++;
    const start = cursor;
    while (cursor < value.length && !isInlineWhitespace(value[cursor])) cursor++;
    if (cursor > start) words.push(value.slice(start, cursor));
  }
  return words;
}

function firstIdentifier(value: string): string | undefined {
  const trimmed = value.trimStart();
  if (!isIdentifierStart(trimmed[0])) return undefined;
  let end = 1;
  while (isIdentifierContinue(trimmed[end])) end++;
  return trimmed.slice(0, end);
}

function pythonImportClause(line: string): string | undefined {
  const direct = keywordRemainder(line, "import");
  if (direct !== undefined) return direct;
  const from = keywordRemainder(line, "from");
  if (from === undefined) return undefined;
  const module = asciiWords(from)[0];
  return module ? keywordRemainder(from.slice(module.length), "import") : undefined;
}

function rubyRequiredBinding(line: string): string | undefined {
  const remainder = keywordRemainder(line, "require_relative") ?? keywordRemainder(line, "require");
  if (remainder === undefined || (remainder[0] !== "\"" && remainder[0] !== "'")) return undefined;
  const quote = remainder[0]!;
  const end = remainder.indexOf(quote, 1);
  if (end < 0) return undefined;
  const leaf = remainder.slice(1, end).split("/").at(-1) ?? "";
  let binding = "";
  let separating = false;
  for (const ch of leaf) {
    if (isIdentifierContinue(ch)) {
      binding += ch;
      separating = false;
    } else if (!separating) {
      binding += "_";
      separating = true;
    }
  }
  return binding || undefined;
}

function importClauseBeforeModule(line: string): string | undefined {
  const remainder = keywordRemainder(line, "import");
  if (remainder === undefined) return undefined;
  for (let cursor = remainder.length - 4; cursor > 0; cursor--) {
    if (remainder.slice(cursor, cursor + 4) !== "from") continue;
    const before = remainder[cursor - 1];
    const after = remainder[cursor + 4];
    if (!isInlineWhitespace(before) || !isInlineWhitespace(after)) continue;
    let moduleStart = cursor + 4;
    while (isInlineWhitespace(remainder[moduleStart])) moduleStart++;
    const quote = remainder[moduleStart];
    if (quote !== "\"" && quote !== "'") continue;
    if (remainder.indexOf(quote, moduleStart + 1) < 0) continue;
    return remainder.slice(0, cursor).trim();
  }
  return undefined;
}

function qualifiedImportBinding(line: string): string | undefined {
  const imported = keywordRemainder(line, "import");
  if (imported === undefined) return undefined;
  const withoutStatic = keywordRemainder(imported, "static") ?? imported;
  const words = asciiWords(withoutStatic.trimEnd().replaceAll(";", ""));
  const qualified = words[0];
  if (!qualified || qualified.split(".").some((part) => !firstIdentifier(part) || firstIdentifier(part) !== part)) {
    return undefined;
  }
  if (words.length >= 3 && words[1] === "as") return firstIdentifier(words[2]!);
  const binding = qualified.split(".").at(-1);
  return binding === "*" ? undefined : binding;
}

/** Extract only locally bound names; module-path words are not usable imports. */
function importedBindingNames(line: string, lang: string): string[] {
  if (lang === "python") {
    const clause = pythonImportClause(line);
    if (!clause) return [];
    return clause.split(",").map((part) => {
      const words = asciiWords(part.trim().replaceAll("(", "").replaceAll(")", ""));
      if (words.length >= 3 && words.at(-2) === "as") return firstIdentifier(words.at(-1)!);
      const first = words[0]?.split(".")[0];
      return first === undefined ? undefined : firstIdentifier(first);
    }).filter((name): name is string => name !== undefined);
  }
  if (lang === "ruby") {
    const binding = rubyRequiredBinding(line);
    return binding === undefined ? [] : [binding];
  }

  const fromClause = importClauseBeforeModule(line);
  if (fromClause !== undefined) {
    const names: string[] = [];
    const star = fromClause.indexOf("*");
    if (star >= 0) {
      const namespace = keywordRemainder(fromClause.slice(star + 1), "as");
      const name = namespace === undefined ? undefined : firstIdentifier(namespace);
      if (name) names.push(name);
    }
    const namedStart = fromClause.indexOf("{");
    const namedEnd = namedStart < 0 ? -1 : fromClause.indexOf("}", namedStart + 1);
    if (namedStart >= 0 && namedEnd > namedStart) {
      for (const part of fromClause.slice(namedStart + 1, namedEnd).split(",")) {
        const withoutType = keywordRemainder(part, "type") ?? part.trim();
        const words = asciiWords(withoutType);
        const alias = words.length >= 3 && words.at(-2) === "as" ? firstIdentifier(words.at(-1)!) : undefined;
        const original = firstIdentifier(words[0] ?? "");
        if (alias ?? original) names.push((alias ?? original)!);
      }
    }
    const defaultName = firstIdentifier(fromClause);
    if (defaultName && defaultName !== "type") names.push(defaultName);
    return [...new Set(names)];
  }

  const qualified = qualifiedImportBinding(line);
  return qualified === undefined ? [] : [qualified];
}

/**
 * Does `line` carry the target symbol's OWN elided skeleton entry — the
 * brace-style rendering treeSitter.ts's skeleton renderer uses, e.g.
 * `foo(...) { ... }`? Used to exclude the target from its own
 * sibling-signature list.
 *
 * CWE-1333 hardening: `targetName` is `resolvedSymbol` (`found.name`), which
 * traces back to the caller-supplied `symbol` input
 * (GetSymbolWithContextInput.symbol / task_pack `paths[].symbol`, both
 * unvalidated strings). For most languages this value only reaches here
 * after already matching a `\w+`-only declared name (findSymbolRegex's
 * equality gate forces that), but AST-derived names can legitimately carry
 * regex-active characters — Kotlin backtick-quoted names
 * (`` `handles [edge] cases` ``), C++ operator overloads (`operator[]`),
 * Ruby predicate/bang methods (`valid?`, `save!`) — so this must not
 * interpolate `targetName` into the RegExp source unescaped. Escape it to a
 * literal match (same primitive renameSymbol.ts/findReferences.ts/
 * readCodePack.ts use) and cap its length at the admission bound
 * findText.ts's find uses for caller regex text (MAX_REGEX_QUERY_CHARS). An
 * empty or over-cap name degrades to "excludes nothing" — never a thrown
 * SyntaxError — which at worst leaves the target's own elided signature in
 * the sibling list (cosmetic, not a crash); the construction is also
 * defensively wrapped even though every call site already sits inside a
 * try/catch.
 */
export function isTargetElidedSignatureLine(line: string, targetName: string): boolean {
  if (targetName.length === 0 || targetName.length > MAX_REGEX_QUERY_CHARS) return false;
  try {
    return new RegExp(`\\b${escapeRegExp(targetName)}\\b.*\\{\\s*\\.\\.\\.\\s*\\}`).test(line);
  } catch {
    return false;
  }
}

/**
 * Extract sibling method signatures from the same enclosing class (bodies elided).
 *
 * DESIGN-v0.8 B4.1: uses signatureStartLine (falling back to startLine for
 * the regex-fallback path, which never widens — see the FoundSymbol doc
 * comment above), NOT startLine, as the class body's own start. Once a
 * documented class's startLine may be widened to include its own leading
 * doc comment, slicing from startLine would feed that doc comment (plus the
 * `class Foo {` header line itself) into treeSitterSkeleton() below as if
 * it were skeleton CONTENT — treeSitterSkeleton parses classText as a
 * standalone document, so the class's own doc/header would render verbatim
 * in the "sibling signatures:" section instead of being excluded.
 */
async function extractSiblingSignatures(
  text: string,
  lang: string,
  enclosingClass: { name: string; startLine: number; endLine: number; signatureStartLine?: number },
  targetName: string,
  cap: number,
  treeSitterPaths?: TreeSitterPaths,
): Promise<string[]> {
  const lines = splitLines(text);
  const classBodyStartLine = enclosingClass.signatureStartLine ?? enclosingClass.startLine;
  const classLines = lines.slice(classBodyStartLine - 1, enclosingClass.endLine);
  const classText = classLines.join("\n");

  // Try tree-sitter skeleton on the class body to get sibling sigs.
  if (treeSitterSupports(lang)) {
    try {
      const skeleton = await treeSitterSkeleton(classText, lang, treeSitterPaths ?? {});
      if (skeleton) {
        // Filter out the target symbol from the skeleton.
        const sigs = skeleton
          .split(/\r?\n/)
          .filter(
            (l) =>
              l.trim().length > 0 &&
              !isTokenlightenSentinelLine(l) &&
              !isTargetElidedSignatureLine(l, targetName),
          )
          .slice(0, cap);
        return sigs;
      }
    } catch {
      // fall through
    }
  }

  // Regex-based sibling extraction. Same classBodyStartLine as the
  // tree-sitter path above — consistent "skip the class's own doc/header,
  // scan only the body" start line for both extraction strategies.
  const funcPat = FUNC_PATTERNS[lang];
  if (!funcPat) return [];

  const siblings: string[] = [];
  for (let i = classBodyStartLine; i < enclosingClass.endLine; i++) {
    const line = lines[i - 1]!;
    const m = funcPat.exec(line);
    if (!m) continue;
    const name = m[1] ?? m[2];
    if (!name || name === targetName) continue;
    siblings.push(line.trimEnd());
    if (siblings.length >= cap) break;
  }
  return siblings;
}

// ---------------------------------------------------------------------------
// Not-found recovery: candidate ranking + compact skeleton.
// Reuses collectSymbols() (tree-sitter symbol enumeration — the same
// machinery the FOUND path uses via findSymbolWithTreeSitter) and
// renderSymbolSkeleton() (the same skeleton renderer used elsewhere for
// read_code mode=skeleton) rather than duplicating either.
// ---------------------------------------------------------------------------

/**
 * Iterative Levenshtein edit distance, case-insensitive. Bounded to short
 * identifier-length strings so this stays cheap even over a few hundred
 * candidate names.
 */
function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Score a candidate symbol name against the requested (not-found) name.
 * Lower is better. Cheap, deterministic heuristic — exact case-insensitive
 * match ranks best (shouldn't occur, since we're already in the not-found
 * path, but kept for stability), then prefix, then substring, then edit
 * distance as a tiebreaker/fallback for typos.
 */
function candidateScore(name: string, query: string): number {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName === lowerQuery) return 0;
  if (lowerName.startsWith(lowerQuery) || lowerQuery.startsWith(lowerName)) return 1;
  if (lowerName.includes(lowerQuery) || lowerQuery.includes(lowerName)) return 2;
  // Scale edit distance into a band above the substring tier so a close
  // typo (distance 1-2) still outranks an unrelated substring hit only
  // when neither prefix nor substring applied.
  return 3 + editDistance(name, query);
}

/**
 * Rank declared symbol names by similarity to `query` and return the top
 * `cap` distinct names (stable order for equal scores: declaration order).
 */
function rankCandidates(names: string[], query: string, cap: number): string[] {
  const seen = new Set<string>();
  const scored: { name: string; score: number; index: number }[] = [];
  names.forEach((name, index) => {
    if (seen.has(name)) return;
    seen.add(name);
    scored.push({ name, score: candidateScore(name, query), index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, cap).map((s) => s.name);
}

/**
 * Build the not-found recovery payload: candidate symbol names (ranked) and
 * a capped, top-level-only skeleton of the file. Both are derived from a
 * single collectSymbols() pass — no duplicate AST walk or regex scan.
 * Returns empty candidates/skeleton (never throws) when the language has no
 * tree-sitter symbol collector; the caller still gets the base error/code.
 */
async function buildNotFoundRecovery(
  fileContent: string,
  symbolName: string,
  language: string,
  treeSitterPaths?: TreeSitterPaths,
): Promise<{ candidates: string[]; skeleton?: string }> {
  if (language === "unknown") return { candidates: [] };

  let symbols: CollectedSymbol[] = [];
  try {
    symbols = await collectSymbols(fileContent, language, treeSitterPaths ?? {});
  } catch {
    return { candidates: [] };
  }
  if (symbols.length === 0) return { candidates: [] };

  const candidates = rankCandidates(
    symbols.map((s) => s.name),
    symbolName,
    NOT_FOUND_CANDIDATES_CAP,
  );

  // Top-level only (no enclosingSymbol) keeps the skeleton compact — this is
  // a refusal payload, not a full-file dump. renderSymbolSkeleton() nests
  // methods under their class automatically for the top-level class entries.
  const topLevel = symbols.filter((s) => !s.enclosingSymbol).slice(0, NOT_FOUND_SKELETON_BLOCK_CAP);
  let skeleton: string | undefined;
  try {
    const rendered = renderSymbolSkeleton(fileContent, topLevel, language);
    if (rendered.length > 0) {
      skeleton =
        rendered.length > NOT_FOUND_SKELETON_CHAR_CAP
          ? rendered.slice(0, NOT_FOUND_SKELETON_CHAR_CAP) + "\n/* <truncated> */"
          : rendered;
    }
  } catch {
    skeleton = undefined;
  }

  return { candidates, ...(skeleton ? { skeleton } : {}) };
}

// ---------------------------------------------------------------------------
// Main tool function
// ---------------------------------------------------------------------------

/**
 * Return the full body of a named symbol plus its scope context header:
 * used imports, enclosing class signature, sibling method signatures.
 *
 * Format per docs/components/02-mcp-server.md §4.
 */
export async function getSymbolWithContext(
  fileContent: string,
  input: GetSymbolWithContextInput,
  opts: GetSymbolWithContextOptions = {},
): Promise<GetSymbolWithContextResult> {
  const { path, symbol } = input;
  const siblingSigs = (input as { siblingSigs?: boolean }).siblingSigs !== false;
  const siblingsCap = (input as { siblingsCap?: number }).siblingsCap ?? DEFAULT_SIBLING_CAP;

  // .h is dual-listed c/cpp in the MCP contract — sniff fileContent (already
  // in hand here) so a C++-shaped header resolves to "cpp" instead of the
  // static "c" answer, picking the right tree-sitter grammar below.
  const language = languageForPathWithContent(path, fileContent) ?? "unknown";

  const lines = splitLines(fileContent);

  // Find the symbol.
  const found =
    language !== "unknown"
      ? (await findSymbolWithTreeSitter(fileContent, symbol, language, opts.treeSitterPaths))
        ?? findSymbolRegex(fileContent, symbol, language)
        ?? await findUniqueQualifiedSuffix(fileContent, symbol, language, opts.treeSitterPaths)
      : undefined;

  if (!found) {
    // Fold recovery into the miss: candidates + skeleton in the SAME
    // response, so the caller can redirect without a second (skeleton) call.
    const recovery = await buildNotFoundRecovery(fileContent, symbol, language, opts.treeSitterPaths);
    return {
      ok: false,
      error: `Symbol "${symbol}" not found in ${path}`,
      code: "not-found",
      ...(recovery.candidates.length > 0 ? { candidates: recovery.candidates } : {}),
      ...(recovery.skeleton ? { skeleton: recovery.skeleton } : {}),
    };
  }

  const resolvedSymbol = found.name;

  const bodyLines = lines.slice(found.startLine - 1, found.endLine);
  const bodyText = bodyLines.join("\n");

  // Extract used imports.
  const usedImports = language !== "unknown"
    ? extractUsedImports(fileContent, language, bodyText)
    : [];

  // Enclosing class.
  const enclosingClass = found.enclosingClass;

  // Sibling signatures.
  let siblings: string[] = [];
  if (siblingSigs && enclosingClass) {
    siblings = await extractSiblingSignatures(
      fileContent,
      language,
      enclosingClass,
      resolvedSymbol,
      siblingsCap,
      opts.treeSitterPaths,
    );
  }

  // Build scope header.
  const scopeHeader = commentNote(language, `tokenlighten:scope path=${path} symbol=${resolvedSymbol} lang=${language}`);

  // Build output block per docs/components/02-mcp-server.md §4.1.
  const parts: string[] = [scopeHeader];

  if (usedImports.length > 0) {
    parts.push(commentNote(language, "imports (used in body):"));
    parts.push(...usedImports);
  }

  if (enclosingClass) {
    parts.push("");
    parts.push(commentNote(language, "enclosing scope:"));
    // DESIGN-v0.8 B4.1: signatureStartLine (falling back to startLine for
    // the regex path, which never widens) is the enclosing class's BARE
    // declaration line — startLine alone may now be the class's own leading
    // doc comment line instead of `class Foo {` when the class is documented.
    const classHeaderLine = enclosingClass.signatureStartLine ?? enclosingClass.startLine;
    const classHeader = lines.slice(classHeaderLine - 1, classHeaderLine).join("");
    parts.push(`${classHeader.replace(/\s+$/, "")} { /* <elided n=${enclosingClass.endLine - classHeaderLine}> */ }`);
  }

  if (siblings.length > 0) {
    parts.push("");
    parts.push(commentNote(language, "sibling signatures:"));
    parts.push(...siblings);
  }

  parts.push("");
  parts.push(commentNote(language, "target:"));
  parts.push(bodyText);

  const rawCode = parts.join("\n");

  // Check if we used tree-sitter (if siblings came from fallback, add note).
  const astFallback = language === "unknown" || !treeSitterSupports(language) || found.source === "regex";
  const fallbackNote = astFallback
    ? `\n${commentNote(language, "note: AST-fallback mode (no scope header); use read_file instead for unsupported languages.")}`
    : "";

  const code = compressFormat(rawCode + fallbackNote);

  return {
    ok: true,
    data: {
      code,
      scopeHeader,
      language,
      range: { start: found.startLine, end: found.endLine },
    },
  };
}
