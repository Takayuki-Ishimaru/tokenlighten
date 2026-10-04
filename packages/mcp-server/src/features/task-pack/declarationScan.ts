/**
 * declarationScan.ts — declaration scan shared by the default-OFF V15-FUI
 * usage inventory (usageInventory.ts) and, through it, any consumer that
 * needs "which identifiers does this served body declare".
 *
 * CONTRACT: `declarationsIn(filePath, body)` returns the declarations it
 * recognizes in line order — `symbol` (the declared name), `line` (1-based),
 * `exported` (true when the language marks the name as part of the file's
 * public surface: `export`, a capitalized Go name, a `public` Java type or
 * member, a Python top-level name, a non-`static` C/C++ declaration),
 * `kind` and, for a member-level declaration, `container` — and `[]` for a
 * file whose language it does not scan.
 *
 * Every rule is a language rule, never keyed to a fixture-specific name.
 * The scan runs on a MASKED copy of the source (comments and string/char
 * literal contents replaced by spaces, columns preserved), so a keyword in a
 * comment, a string, a Go raw string or a text block is never a declaration,
 * and brace/paren depth can be tracked without being fooled by literals.
 * Precision over recall: a statement or a call is never reported as a
 * declaration; a construct the scan cannot classify yields nothing.
 *
 * The scan is bounded (20,000 lines or 1 MiB of text, 2,000 characters per
 * line; the first 4,000 lines were all that earlier versions looked at).
 * Results that earlier versions returned (function/class/type
 * declarations of TS/JS, Python, Go and Java) keep their symbol, line and
 * `exported` value; newer rules only ADD entries or fill `kind`/`container`.
 *
 * Languages (`.ext` decides):
 *  - Go: `func`/`type`/`const`/`var` at column 0, parenthesized blocks (iota
 *    members included), methods (`kind:"member"`, `container` = receiver type);
 *  - Java: types (nested types carry their outer `container`), `static final`
 *    and interface fields (`constant`), enum constants (`enum-member`),
 *    methods (`member`; `exported` iff `public`, interface members implicit);
 *  - Kotlin: classes/interfaces/objects/enums/`fun interface`/typealias,
 *    top-level `fun`/`val`/`var`/`const val`, enum entries, class members;
 *  - Python: `def`/`class`, column-0 assignments outside brackets (UPPER_CASE
 *    is a `constant`), members of `Enum`/`IntEnum`/`StrEnum`/`Flag` classes;
 *  - TS/JS: exported declarations, members of an exported enum, top-level keys
 *    of an exported `const X = { … }` object literal;
 *  - C/C++/Objective-C: a statement-level scan with a namespace/class/enum
 *    scope stack — functions, prototypes, out-of-line members
 *    (`Class::method`), types, enumerators, typedefs/aliases, variables,
 *    members, `#define`s (also enums and functions behind export/attribute
 *    macros, `OF((…))` wrappers, function-pointer declarators). Preprocessor
 *    text is read with `#if 0` regions removed; other conditional branches are
 *    all scanned, each from the state at its `#if`.
 *
 * A served SLICE that starts inside a scope (its first code line is
 * indented): C-family reports nothing until that scope closes rather than
 * reporting body statements as declarations; Java reads the slice as an
 * unnamed type body (`static final` fields and modifier-led method heads
 * cannot occur in a method body); Kotlin reports only declarations that carry
 * a visibility/`override`/`const`/… modifier (a local cannot), and nested
 * types.
 *
 * `analyzeCFamilySource` (the preprocessor pass) is shared with cIncludes.ts.
 */
import * as path from "path";

export interface DeclaredSymbol {
  symbol: string;
  /** 1-based line of the declaration. */
  line: number;
  exported: boolean;
  /** What the declaration introduces, when the scan can tell. */
  kind?: "function" | "type" | "constant" | "variable" | "member" | "enum-member" | "macro";
  /**
   * Enclosing type/namespace for a member-level declaration (a C++
   * `Class::method`, an enum's member, a Go method's receiver type).
   */
  container?: string;
}

/** A scan covers at most this many lines … */
const MAX_DECL_LINES_SCANNED = 20000;
/** … and at most this much text (1 MiB); the rest of a larger file is not scanned. */
const MAX_DECL_CHARS_SCANNED = 1024 * 1024;
/** Longer lines (minified bundles, data blobs) are truncated before scanning. */
const MAX_LINE_CHARS = 2000;
/** Upper bound on the tokens one file contributes to a token scan. */
const MAX_TOKENS = 400000;
/** Token visits the anonymous-typedef body lookaheads of one C/C++ scan may spend altogether (a few times MAX_TOKENS). */
const MAX_TYPEDEF_LOOKAHEAD_TOKENS = 1500000;

const TSJS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

const TS_EXPORTED_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TS_TOPLEVEL_RE = /^(?:async\s+)?(function\*?|class)\s+([A-Za-z_$][\w$]*)/;
const PY_DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
const GO_DECL_RE = /^(func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/;
const JAVA_TYPE_RE = /^\s*(?:public\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/;
const JAVA_PUBLIC_RE = /^\s*public\b/;

function tsKind(keyword: string): DeclaredSymbol["kind"] {
  if (keyword.startsWith("function")) return "function";
  if (keyword === "const") return "constant";
  if (keyword === "let" || keyword === "var") return "variable";
  return "type";
}

// ---------------------------------------------------------------------------
// Source masking — comments and literal contents become spaces (same columns)
// ---------------------------------------------------------------------------

interface MaskSyntax {
  /** `// …` line comments. */
  slashComments: boolean;
  /** `# …` line comments (Python). */
  hashComments: boolean;
  /** Slash-star block comments. */
  blockComments: boolean;
  /** Block comments nest (Kotlin). */
  nestedBlocks: boolean;
  /** `'…'` is a single-line literal (char/rune/string). */
  singleQuote: boolean;
  /** C++14 digit separators: `1'000` is not a character literal. */
  digitSeparators: boolean;
  /** Backtick: Go raw string, JS/TS template literal, Kotlin quoted name. */
  backtick: "none" | "raw" | "template" | "name";
  /** `"""…"""` multi-line literals (Java text blocks, Kotlin raw strings). */
  tripleQuote: boolean;
  /** Triple-quoted literals take no backslash escapes (Kotlin). */
  tripleRaw: boolean;
  /** `'''…'''` multi-line literals as well (Python). */
  tripleSingle: boolean;
  /** `${ … }` inside a literal re-enters code (Kotlin strings, JS templates). */
  dollarBrace: boolean;
  /** `${ … }` also applies inside plain double-quoted strings (Kotlin). */
  dollarInQuotes: boolean;
  /** C++ raw string literals `R"delim( … )delim"`. */
  cppRaw: boolean;
  /** JS/TS regular-expression literals. */
  regex: boolean;
  /** A trailing backslash continues `//` comments and quoted literals (C/C++). */
  lineSplice: boolean;
}

const SYN_GO: MaskSyntax = {
  slashComments: true, hashComments: false, blockComments: true, nestedBlocks: false, singleQuote: true,
  digitSeparators: false, backtick: "raw", tripleQuote: false, tripleRaw: false, tripleSingle: false, dollarBrace: false,
  dollarInQuotes: false, cppRaw: false, regex: false, lineSplice: false,
};
const SYN_JAVA: MaskSyntax = { ...SYN_GO, backtick: "none", tripleQuote: true };
const SYN_TS: MaskSyntax = { ...SYN_GO, backtick: "template", dollarBrace: true, regex: true };
const SYN_PY: MaskSyntax = {
  ...SYN_GO, slashComments: false, hashComments: true, blockComments: false, tripleQuote: true, tripleSingle: true, lineSplice: true,
};
const SYN_KOTLIN: MaskSyntax = {
  ...SYN_GO, nestedBlocks: true, backtick: "name", tripleQuote: true, tripleRaw: true, dollarBrace: true, dollarInQuotes: true,
};

interface StrState {
  /** The text that closes the literal. */
  end: string;
  /** No backslash escapes inside. */
  raw: boolean;
  /** May continue on the next line. */
  multi: boolean;
  /** `${` re-enters code. */
  template: boolean;
}
interface ExprFrame {
  depth: number;
  saved: StrState;
}

function blank(chars: string[], from: number, to: number): void {
  const end = Math.min(to, chars.length);
  for (let k = from; k < end; k++) chars[k] = " ";
}

/** `"` at `quote` opens a C++ raw string: `R"`, `u8R"`, `uR"`, `UR"`, `LR"` not glued to a longer identifier. */
function isCppRawStart(raw: string, quote: number): boolean {
  if (quote < 1 || raw[quote - 1] !== "R") return false;
  let start = quote - 1;
  if (start >= 2 && raw.slice(start - 2, start) === "u8") start -= 2;
  else if (start >= 1 && /[uUL]/.test(raw[start - 1]!)) start -= 1;
  return !(start > 0 && /[\w$]/.test(raw[start - 1]!));
}

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "yield", "await", "instanceof"]);

/**
 * Index of the closing `/` of a regular-expression literal opened at `i`, or
 * -1 when the `/` is a division (decided from the previous significant
 * character or keyword) or the literal does not close on this line.
 */
function regexLiteralEnd(raw: string, i: number, chars: readonly string[]): number {
  let p = i - 1;
  while (p >= 0 && (chars[p] === " " || chars[p] === "\t")) p--;
  if (p < 0) return -1;
  if (!REGEX_PRECEDERS.includes(chars[p]!)) {
    let w = p;
    while (w >= 0 && /[A-Za-z_$]/.test(chars[w]!)) w--;
    if (w === p || !REGEX_KEYWORDS.has(raw.slice(w + 1, p + 1))) return -1;
  }
  let inClass = false;
  for (let k = i + 1; k < raw.length; k++) {
    const d = raw[k]!;
    if (d === "\\") { k++; continue; }
    if (inClass) { if (d === "]") inClass = false; }
    else if (d === "[") inClass = true;
    else if (d === "/") return k > i + 1 ? k : -1;
  }
  return -1;
}

function isDigitSeparator(raw: string, i: number): boolean {
  const prev = raw[i - 1];
  const next = raw[i + 1];
  if (prev === undefined || next === undefined || !/[0-9A-Fa-f]/.test(prev) || !/[0-9A-Fa-f]/.test(next)) return false;
  let s = i - 1;
  while (s > 0 && /[0-9A-Za-z_.']/.test(raw[s - 1]!)) s--;
  return /[0-9]/.test(raw[s]!);
}

/**
 * Mask `lines`: comment text and the inside of string/char literals become
 * spaces; delimiters stay. Column positions are preserved, multi-line
 * comments/literals carry across lines, and an unterminated single-line
 * literal ends at the end of its line (a stray quote can only damage its own
 * line).
 */
function maskSource(lines: readonly string[], syn: MaskSyntax): string[] {
  const out: string[] = new Array<string>(lines.length);
  let block = 0;
  let str: StrState | undefined;
  const frames: ExprFrame[] = [];
  let carryComment = false;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    const n = raw.length;
    if (n === 0) { out[ln] = ""; continue; }
    const chars = raw.split("");
    if (carryComment) {
      blank(chars, 0, n);
      carryComment = syn.lineSplice && /\\[ \t]*$/.test(raw);
      out[ln] = chars.join("");
      continue;
    }
    let i = 0;
    while (i < n) {
      if (block > 0) {
        if (syn.nestedBlocks && raw.startsWith("/*", i)) { block++; blank(chars, i, i + 2); i += 2; continue; }
        if (raw.startsWith("*/", i)) { block--; blank(chars, i, i + 2); i += 2; continue; }
        chars[i] = " ";
        i++;
        continue;
      }
      const c = raw[i]!;
      if (str !== undefined) {
        if (!str.raw && c === "\\") { blank(chars, i, i + 2); i += 2; continue; }
        if (str.template && c === "$" && raw[i + 1] === "{") {
          frames.push({ depth: 1, saved: str });
          str = undefined;
          blank(chars, i, i + 2);
          i += 2;
          continue;
        }
        if (raw.startsWith(str.end, i)) {
          if (str.end.length > 1 && str.end[0] === ")") blank(chars, i, i + str.end.length - 1);
          i += str.end.length;
          str = undefined;
          continue;
        }
        chars[i] = " ";
        i++;
        continue;
      }
      const next = raw[i + 1];
      if (syn.slashComments && c === "/" && next === "/") {
        blank(chars, i, n);
        carryComment = syn.lineSplice && /\\[ \t]*$/.test(raw);
        i = n;
        break;
      }
      if (syn.hashComments && c === "#") { blank(chars, i, n); i = n; break; }
      if (syn.blockComments && c === "/" && next === "*") { block = 1; blank(chars, i, i + 2); i += 2; continue; }
      if (c === "\"") {
        if (syn.cppRaw && isCppRawStart(raw, i)) {
          const open = raw.indexOf("(", i + 1);
          const delim = open > 0 ? raw.slice(i + 1, open) : "";
          if (open > 0 && delim.length <= 16 && /^[^\s()\\"]*$/.test(delim)) {
            str = { end: ")" + delim + "\"", raw: true, multi: true, template: false };
            blank(chars, i + 1, open + 1);
            i = open + 1;
            continue;
          }
        }
        if (syn.tripleQuote && raw.startsWith("\"\"\"", i)) {
          str = { end: "\"\"\"", raw: syn.tripleRaw, multi: true, template: syn.dollarInQuotes };
          i += 3;
          continue;
        }
        str = { end: "\"", raw: false, multi: false, template: syn.dollarInQuotes };
        i++;
        continue;
      }
      if (c === "'" && syn.tripleSingle && raw.startsWith("'''", i)) {
        str = { end: "'''", raw: false, multi: true, template: false };
        i += 3;
        continue;
      }
      if (c === "'" && syn.singleQuote && !(syn.digitSeparators && isDigitSeparator(raw, i))) {
        str = { end: "'", raw: false, multi: false, template: false };
        i++;
        continue;
      }
      if (c === "`" && syn.backtick !== "none") {
        if (syn.backtick === "raw") str = { end: "`", raw: true, multi: true, template: false };
        else if (syn.backtick === "template") str = { end: "`", raw: false, multi: true, template: syn.dollarBrace };
        else str = { end: "`", raw: true, multi: false, template: false };
        i++;
        continue;
      }
      if (frames.length > 0) {
        const top = frames[frames.length - 1]!;
        if (c === "{") top.depth++;
        else if (c === "}") {
          top.depth--;
          if (top.depth === 0) {
            frames.pop();
            str = top.saved;
            chars[i] = " ";
            i++;
            continue;
          }
        }
      }
      if (syn.regex && c === "/" && next !== "/" && next !== "*") {
        const close = regexLiteralEnd(raw, i, chars);
        if (close > 0) { blank(chars, i + 1, close); i = close + 1; continue; }
      }
      i++;
    }
    if (str !== undefined && !str.multi) {
      if (!(syn.lineSplice && raw.endsWith("\\"))) { str = undefined; frames.length = 0; }
    } else if (frames.length > 0 && !frames[0]!.saved.multi) {
      frames.length = 0;
      str = undefined;
    }
    out[ln] = chars.join("");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens over masked text (Java and C/C++ scans)
// ---------------------------------------------------------------------------

interface Tok {
  s: string;
  /** 1-based source line. */
  line: number;
  /** A collapsed `()`/`[]` group (C/C++ scan): the inner tokens are `T[from..to)`. */
  from?: number;
  to?: number;
  /** A collapsed `[[…]]` attribute group. */
  attr?: boolean;
  /** A collapsed `(…)` group whose content starts with `(` (`OF((args))`-style parameter wrappers). */
  double?: boolean;
}

const TOKEN_RE = /(?:[A-Za-z_$]|[^\x01-\x7f\s])(?:[\w$]|[^\x01-\x7f\s])*|\d[\w.]*|"[^"]*"|'[^']*'|::|->|<=>|<=|>=|==|!=|\.\.\.|\S/g;
const IDENT_TOKEN_RE = /^(?:[A-Za-z_$]|[^\x01-\x7f\s])/;

function isIdentTok(s: string): boolean {
  return IDENT_TOKEN_RE.test(s);
}

function tokenize(masked: readonly string[]): Tok[] {
  const out: Tok[] = [];
  for (let ln = 0; ln < masked.length && out.length < MAX_TOKENS; ln++) {
    const line = masked[ln]!;
    if (line.length === 0 || line.trim().length === 0) continue;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(line)) !== null) {
      const text = m[0];
      const first = text[0]!;
      out.push({ s: text.length > 1 && (first === "\"" || first === "'") ? first + first : text, line: ln + 1 });
    }
  }
  return out;
}

/** Index of the token closing the group opened at `i` (`open`/`close` counted only); the last token when unterminated. */
function matchClose(T: readonly Tok[], i: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k < T.length; k++) {
    const s = T[k]!.s;
    if (s === open) depth++;
    else if (s === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return T.length - 1;
}

function mergeLegacy(fresh: DeclaredSymbol[], legacy: readonly DeclaredSymbol[]): DeclaredSymbol[] {
  if (legacy.length === 0) return fresh;
  const byKey = new Map<string, DeclaredSymbol>();
  for (const d of fresh) byKey.set(`${d.symbol}@${d.line}`, d);
  const out = [...fresh];
  for (const d of legacy) {
    const existing = byKey.get(`${d.symbol}@${d.line}`);
    if (existing !== undefined) existing.exported = d.exported;
    else out.push(d);
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_TOPLEVEL_RE = /^(?:func|type|const|var|package|import)\b/;
const GO_BLOCK_RE = /^(const|var|type)\s*\(/;
const GO_SINGLE_RE = /^(const|var)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)(?=\s|=|$|;)/;
const GO_VALUE_MEMBER_RE = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)(?=\s|=|$|;)/;
const GO_TYPE_MEMBER_RE = /^\s*([A-Za-z_]\w*)(?=\s|\[|=|$)/;
const GO_RECEIVER_TYPE_RE = /^\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/;
// A line ending in an operator or comma continues the same statement (an opening bracket deepens `depth` instead).
const GO_CONTINUES_RE = /[-+*/%&|^<>=,.]$/;

function bracketDelta(line: string): number {
  let delta = 0;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k]!;
    if (ch === "(" || ch === "{" || ch === "[") delta++;
    else if (ch === ")" || ch === "}" || ch === "]") delta--;
  }
  return delta;
}

function pushGoNames(out: DeclaredSymbol[], names: string, line: number, kind: "constant" | "variable"): void {
  for (const raw of names.split(",")) {
    const name = raw.trim();
    if (name === "" || name === "_") continue;
    out.push({ symbol: name, line, exported: /^[A-Z]/.test(name), kind });
  }
}

/**
 * Go: `func`/`type`/`const`/`var` at column 0 (gofmt), parenthesized
 * `const`/`var`/`type` blocks (every block member, iota continuations
 * included), methods with their receiver type as `container`.
 */
function scanGo(masked: readonly string[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  let block: "const" | "var" | "type" | undefined;
  let depth = 0;
  let continued = false;
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!;
    if (line.trim().length === 0) continue;
    const column0 = line.charCodeAt(0) > 32;
    // A top-level keyword at column 0 cannot sit inside a declaration block: resync after unbalanced code.
    if (column0 && GO_TOPLEVEL_RE.test(line)) { block = undefined; depth = 0; continued = false; }
    const startDepth = depth;
    if (block === undefined) {
      if (column0 && depth === 0) {
        const decl = GO_DECL_RE.exec(line);
        const name = decl?.[2];
        if (decl && name) {
          const isFunc = decl[1]!.startsWith("func");
          const entry: DeclaredSymbol = { symbol: name, line: i + 1, exported: /^[A-Z]/.test(name), kind: isFunc ? "function" : "type" };
          if (isFunc) {
            const receiver = /\(([^)]*)\)/.exec(decl[1]!);
            const container = receiver ? GO_RECEIVER_TYPE_RE.exec(receiver[1]!)?.[1] : undefined;
            if (container !== undefined) { entry.kind = "member"; entry.container = container; }
          }
          out.push(entry);
        } else {
          const open = GO_BLOCK_RE.exec(line);
          if (open) block = open[1] as "const" | "var" | "type";
          else {
            const single = GO_SINGLE_RE.exec(line);
            if (single) pushGoNames(out, single[2]!, i + 1, single[1] === "const" ? "constant" : "variable");
          }
        }
      }
    } else if (startDepth === 1 && !continued) {
      if (block === "type") {
        const member = GO_TYPE_MEMBER_RE.exec(line);
        if (member?.[1] && member[1] !== "_") out.push({ symbol: member[1], line: i + 1, exported: /^[A-Z]/.test(member[1]), kind: "type" });
      } else {
        const member = GO_VALUE_MEMBER_RE.exec(line);
        if (member) pushGoNames(out, member[1]!, i + 1, block === "const" ? "constant" : "variable");
      }
    }
    depth += bracketDelta(line);
    if (depth < 0) depth = 0;
    if (block !== undefined && depth === 0) block = undefined;
    continued = GO_CONTINUES_RE.test(line.trimEnd());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_MODIFIERS = new Set([
  "public", "protected", "private", "static", "final", "abstract", "synchronized", "native", "transient", "volatile",
  "strictfp", "default", "sealed",
]);

interface JavaScope {
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  name: string;
  /** The type is `public` (or an implicitly public member of one). */
  exported: boolean;
}

/** Index just past the annotation starting at `T[i]` (`@`); `@interface` is not an annotation. */
function skipAnnotation(T: readonly Tok[], i: number): number {
  let k = i + 1;
  if (k < T.length && isIdentTok(T[k]!.s)) {
    k++;
    while (k + 1 < T.length && T[k]!.s === "." && isIdentTok(T[k + 1]!.s)) k += 2;
  }
  // Raw token streams carry the argument list as `(`…`)`; a statement head has it collapsed into one `()` token.
  if (k < T.length && T[k]!.s === "()") k++;
  else if (k < T.length && T[k]!.s === "(") k = matchClose(T, k, "(", ")") + 1;
  return k;
}

interface JavaDecorations {
  mods: Set<string>;
  /** Tokens after the leading annotations/modifiers (annotations elsewhere are dropped too). */
  rest: Tok[];
}

function javaStrip(head: readonly Tok[]): JavaDecorations {
  const mods = new Set<string>();
  const rest: Tok[] = [];
  let leading = true;
  for (let k = 0; k < head.length; k++) {
    const t = head[k]!;
    if (t.s === "@" && head[k + 1]?.s !== "interface") {
      k = skipAnnotation(head, k) - 1;
      continue;
    }
    if (leading && JAVA_MODIFIERS.has(t.s)) { mods.add(t.s); continue; }
    if (leading && t.s === "non" && head[k + 1]?.s === "-" && head[k + 2]?.s === "sealed") { k += 2; continue; }
    leading = false;
    rest.push(t);
  }
  return { mods, rest };
}

function javaTypeHead(head: readonly Tok[]): { kind: JavaScope["kind"]; name: Tok; mods: Set<string> } | undefined {
  const { mods, rest } = javaStrip(head);
  let k = 0;
  let kind: JavaScope["kind"] | undefined;
  const first = rest[k]?.s;
  if (first === "@" && rest[k + 1]?.s === "interface") { kind = "annotation"; k += 2; }
  else if (first === "class" || first === "interface" || first === "enum") { kind = first; k += 1; }
  else if (first === "record" && rest[k + 1] !== undefined && isIdentTok(rest[k + 1]!.s) && (rest[k + 2]?.s === "()" || rest[k + 2]?.s === "<")) { kind = "record"; k += 1; }
  if (kind === undefined) return undefined;
  const name = rest[k];
  if (name === undefined || !isIdentTok(name.s)) return undefined;
  return { kind, name, mods };
}

function javaMemberExported(mods: ReadonlySet<string>, scope: JavaScope): boolean {
  const implicit = (scope.kind === "interface" || scope.kind === "annotation") && !mods.has("private");
  return (mods.has("public") || implicit) && scope.exported;
}

/** Names declared by a field statement: `Type A = 1, B[] = …;` → A, B. */
function javaFieldNames(rest: readonly Tok[]): Tok[] {
  const names: Tok[] = [];
  let angle = 0;
  let k = 0;
  let last: Tok | undefined;
  // First declarator: the last identifier before `=`, `,` (outside generics) or the end.
  for (; k < rest.length; k++) {
    const s = rest[k]!.s;
    if (s === "<") angle++;
    else if (s === ">") angle = Math.max(0, angle - 1);
    else if (angle === 0 && (s === "=" || s === ",")) break;
    else if (isIdentTok(s) && angle === 0) last = rest[k];
  }
  if (last !== undefined) names.push(last);
  // Further declarators: `, Name` followed by `=`, `,`, `[` or the end.
  for (; k < rest.length && names.length < 16; k++) {
    if (rest[k]!.s !== ",") continue;
    const nameTok = rest[k + 1];
    const after = rest[k + 2]?.s;
    if (nameTok !== undefined && isIdentTok(nameTok.s) && (after === undefined || after === "=" || after === "," || after === "[")) names.push(nameTok);
  }
  return names;
}

function javaStatement(head: readonly Tok[], scopes: readonly JavaScope[], out: DeclaredSymbol[]): void {
  const scope = scopes[scopes.length - 1];
  if (scope === undefined || head.length === 0) return;
  const { mods, rest } = javaStrip(head);
  if (rest.length === 0) return;
  const eq = rest.findIndex((t) => t.s === "=");
  const paren = rest.findIndex((t) => t.s === "()");
  if (paren >= 0 && (eq < 0 || paren < eq)) {
    javaMethod(rest, paren, mods, scope, out);
    return;
  }
  const constant = scope.kind === "interface" || scope.kind === "annotation" || (mods.has("static") && mods.has("final"));
  if (!constant) return;
  for (const name of javaFieldNames(rest)) {
    out.push({ symbol: name.s, line: name.line, exported: javaMemberExported(mods, scope), kind: "constant", ...containerOfJava(scope) });
  }
}

/** Statement words that can precede a call or a group without declaring anything (`return foo(x);`, `else if (…)`). */
const JAVA_STATEMENT_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "synchronized", "try", "do", "else", "return", "throw", "new", "assert", "yield", "case", "instanceof",
]);

/** The container a member of `scope` reports; an implicit scope (a slice that starts inside a type body) has no name. */
function containerOfJava(scope: JavaScope): { container?: string } {
  return scope.name === "" ? {} : { container: scope.name };
}

function javaMethod(rest: readonly Tok[], parenIdx: number, mods: ReadonlySet<string>, scope: JavaScope, out: DeclaredSymbol[]): void {
  const name = rest[parenIdx - 1];
  const before = rest[parenIdx - 2];
  // No return type (constructor, compact constructor) or an unrecognizable shape: not reported.
  if (name === undefined || before === undefined || !isIdentTok(name.s) || JAVA_STATEMENT_WORDS.has(name.s) || JAVA_STATEMENT_WORDS.has(before.s)) return;
  if (!(isIdentTok(before.s) || before.s === ">" || before.s === "]")) return;
  out.push({ symbol: name.s, line: name.line, exported: javaMemberExported(mods, scope), kind: "member", ...containerOfJava(scope) });
}

/** Enum constants after the body's `{` (index `start`); returns where the ordinary body (or the closing brace) resumes. */
function javaEnumConstants(T: readonly Tok[], start: number, scope: JavaScope, out: DeclaredSymbol[]): number {
  let i = start;
  for (;;) {
    while (i < T.length && T[i]!.s === "@" && T[i + 1]?.s !== "interface") i = skipAnnotation(T, i);
    const t = T[i];
    if (t === undefined) return i;
    if (t.s === ";") return i + 1;
    if (t.s === "}" || !isIdentTok(t.s)) return i;
    out.push({ symbol: t.s, line: t.line, exported: scope.exported, kind: "enum-member", ...containerOfJava(scope) });
    i++;
    if (T[i]?.s === "(") i = matchClose(T, i, "(", ")") + 1;
    if (T[i]?.s === "{") i = matchClose(T, i, "{", "}") + 1;
    if (T[i]?.s === ",") { i++; continue; }
    if (T[i]?.s === ";") return i + 1;
    return i;
  }
}

function scanJava(masked: readonly string[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const T = tokenize(masked);
  const scopes: JavaScope[] = [];
  // A served slice whose first code line is indented starts inside a type body: its members are read in an unnamed scope
  // (`static final` fields and modifier-led method heads cannot occur in a method body, so nothing else is reported as one).
  const firstCode = masked.find((l) => l.trim().length > 0);
  if (firstCode !== undefined && /^\s/.test(firstCode)) scopes.push({ kind: "class", name: "", exported: true });
  let head: Tok[] = [];
  let i = 0;
  while (i < T.length) {
    const t = T[i]!;
    if (t.s === "(") {
      head.push({ s: "()", line: t.line });
      i = matchClose(T, i, "(", ")") + 1;
    } else if (t.s === ";") {
      javaStatement(head, scopes, out);
      head = [];
      i++;
    } else if (t.s === "}") {
      scopes.pop();
      head = [];
      i++;
    } else if (t.s === "{") {
      const type = javaTypeHead(head);
      if (type !== undefined) {
        const parent = scopes[scopes.length - 1];
        const implicitPublic = parent !== undefined && (parent.kind === "interface" || parent.kind === "annotation") && !type.mods.has("private");
        const exported = type.mods.has("public") || implicitPublic;
        const scope: JavaScope = { kind: type.kind, name: type.name.s, exported };
        const entry: DeclaredSymbol = { symbol: type.name.s, line: type.name.line, exported, kind: "type" };
        if (parent !== undefined && parent.name !== "") entry.container = parent.name;
        out.push(entry);
        scopes.push(scope);
        head = [];
        i++;
        if (type.kind === "enum") i = javaEnumConstants(T, i, scope, out);
      } else if (head.some((h) => h.s === "=")) {
        // Array initializer / anonymous class / lambda body inside a field initializer: part of the statement.
        head.push({ s: "{}", line: t.line });
        i = matchClose(T, i, "{", "}") + 1;
      } else {
        // Method or constructor body, static/instance initializer block: report a method head, skip the body.
        const scope = scopes[scopes.length - 1];
        if (scope !== undefined) javaStatement(head, scopes, out);
        head = [];
        i = matchClose(T, i, "{", "}") + 1;
      }
    } else {
      head.push(t);
      i++;
    }
  }
  return out;
}

function legacyJava(masked: readonly string[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!;
    const decl = JAVA_TYPE_RE.exec(line);
    if (decl?.[1]) out.push({ symbol: decl[1], line: i + 1, exported: JAVA_PUBLIC_RE.test(line), kind: "type" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const KT_MODIFIERS =
  "public|private|protected|internal|open|abstract|final|sealed|data|enum|inner|value|annotation|inline|expect|actual|external|const|lateinit|override|suspend|operator|infix|tailrec|vararg|noinline|crossinline|reified|companion";
const KT_DECL_RE = new RegExp(
  `^\\s*(?:@[\\w.:]+(?:\\([^)]*\\))?\\s*)*((?:(?:${KT_MODIFIERS})\\s+)*)(class|interface|object|typealias|fun|val|var)\\b(.*)$`,
);
const KT_TYPE_NAME_RE = /^\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)/;
const KT_FUN_INTERFACE_RE = /^\s+interface\s+([A-Za-z_]\w*)/;
const KT_PROPERTY_NAME_RE = /^\s*(?:<[^>]*>\s+)?(?:[A-Za-z_]\w*(?:<[^>]*>)?\??\.)*([A-Za-z_]\w*)\s*(?=[:=]|$|\bby\b|\bget\b|\bset\b|\()/;
const KT_UPPER_RE = /^[A-Z][A-Z0-9_]*$/;

interface KtScope {
  kind: "class" | "interface" | "object" | "enum" | "body";
  /** Enclosing type name for a class-like scope; members report it as `container`. */
  name: string;
  exported: boolean;
  /** Enum entry list still open (before the first `;`). */
  entries: boolean;
  expectEntry: boolean;
  /** A served slice that starts inside an unknown scope: only modifier-led members are declarations. */
  implicit?: boolean;
}

/** Modifiers a member or top-level declaration can carry but a local one cannot. */
const KT_MEMBER_ONLY_MODIFIERS = ["public", "private", "protected", "internal", "override", "abstract", "open", "const", "lateinit", "operator", "infix"];

function ktVisible(mods: ReadonlySet<string>): boolean {
  return !(mods.has("private") || mods.has("protected") || mods.has("internal"));
}

function scanKotlin(masked: readonly string[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const scopes: KtScope[] = [];
  let paren = 0;
  let pending: KtScope | undefined;
  const IDENT_AT = /[A-Za-z_]\w*/y;
  // A served slice whose first code line is indented starts inside some scope (a class body, or a function body whose locals
  // look the same): only modifier-led members are declarations there, and they carry no container.
  const firstCode = masked.find((l) => l.trim().length > 0);
  if (firstCode !== undefined && /^\s/.test(firstCode)) scopes.push({ kind: "class", name: "", exported: true, entries: false, expectEntry: false, implicit: true });
  for (let li = 0; li < masked.length; li++) {
    const line = masked[li]!;
    if (line.trim().length === 0) continue;
    // A header waits for its `{` only across continuation lines.
    if (pending !== undefined && paren === 0 && !/^\s*[{:,)]|^\s*where\b/.test(line)) pending = undefined;
    const top = scopes[scopes.length - 1];
    const declLevel = paren === 0 && (top === undefined || (top.kind !== "body" && !top.entries));
    if (declLevel) {
      const m = KT_DECL_RE.exec(line);
      if (m) {
        const mods = new Set(m[1]!.trim().split(/\s+/).filter((s) => s.length > 0));
        const keyword = m[2]!;
        const rest = m[3]!;
        const inType = top !== undefined;
        const visible = ktVisible(mods) && (top?.exported ?? true);
        const container = top === undefined || top.name === "" ? undefined : top.name;
        // Unknown scope: an unmodified `val`/`var`/`fun` may be a local.
        const ambiguous = top?.implicit === true && (keyword === "val" || keyword === "var" || keyword === "fun") && !KT_MEMBER_ONLY_MODIFIERS.some((mod) => mods.has(mod));
        if (keyword === "class" || keyword === "interface" || keyword === "object" || (keyword === "fun" && KT_FUN_INTERFACE_RE.test(rest))) {
          const isFunInterface = keyword === "fun";
          const name = (isFunInterface ? KT_FUN_INTERFACE_RE.exec(rest) : KT_TYPE_NAME_RE.exec(rest))?.[1];
          const scopeKind: KtScope["kind"] = isFunInterface ? "interface" : mods.has("enum") ? "enum" : keyword === "class" ? "class" : keyword === "interface" ? "interface" : "object";
          if (name !== undefined && !(keyword === "object" && /^\s*:/.test(rest))) {
            const entry: DeclaredSymbol = { symbol: name, line: li + 1, exported: visible, kind: "type" };
            if (inType && container !== undefined) entry.container = container;
            out.push(entry);
            pending = { kind: scopeKind, name, exported: visible, entries: scopeKind === "enum", expectEntry: true };
          } else if (mods.has("companion") && container !== undefined) {
            pending = { kind: "object", name: container, exported: visible, entries: false, expectEntry: false };
          } else {
            pending = undefined;
          }
        } else if (keyword === "typealias") {
          const name = KT_TYPE_NAME_RE.exec(rest)?.[1];
          if (name !== undefined) out.push({ symbol: name, line: li + 1, exported: visible, kind: "type" });
          pending = undefined;
        } else if (keyword === "fun") {
          const open = rest.indexOf("(");
          const name = open >= 0 ? /([A-Za-z_]\w*)\s*$/.exec(rest.slice(0, open))?.[1] : undefined;
          if (name !== undefined && !ambiguous) {
            const entry: DeclaredSymbol = { symbol: name, line: li + 1, exported: visible, kind: inType ? "member" : "function" };
            if (inType && container !== undefined) entry.container = container;
            out.push(entry);
          }
          pending = undefined;
        } else {
          const name = KT_PROPERTY_NAME_RE.exec(rest)?.[1];
          if (name !== undefined && !ambiguous) {
            const constant = mods.has("const") || (keyword === "val" && KT_UPPER_RE.test(name) && (!inType || top!.kind === "object"));
            const kind: DeclaredSymbol["kind"] = constant ? "constant" : inType ? "member" : "variable";
            const entry: DeclaredSymbol = { symbol: name, line: li + 1, exported: visible, kind };
            if (inType && container !== undefined) entry.container = container;
            out.push(entry);
          }
          pending = undefined;
        }
      }
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!;
      if (ch === "(" || ch === "[") paren++;
      else if (ch === ")" || ch === "]") { if (paren > 0) paren--; }
      else if (ch === "{") {
        if (paren === 0 && pending !== undefined) scopes.push(pending);
        else scopes.push({ kind: "body", name: "", exported: false, entries: false, expectEntry: false });
        pending = undefined;
      } else if (ch === "}") {
        scopes.pop();
      } else {
        const scope = scopes[scopes.length - 1];
        if (scope !== undefined && scope.kind === "enum" && scope.entries && paren === 0) {
          if (ch === ",") scope.expectEntry = true;
          else if (ch === ";") scope.entries = false;
          else if (ch === "@") {
            IDENT_AT.lastIndex = k + 1;
            if (IDENT_AT.test(line)) k = IDENT_AT.lastIndex - 1;
          } else if (scope.expectEntry && /[A-Za-z_]/.test(ch)) {
            IDENT_AT.lastIndex = k;
            const id = IDENT_AT.exec(line);
            if (id) {
              out.push({ symbol: id[0], line: li + 1, exported: scope.exported, kind: "enum-member", container: scope.name });
              scope.expectEntry = false;
              k += id[0].length - 1;
            }
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_EXPORT_EXT_RE =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TS_DECLARE_RE = /^declare\s+(?:abstract\s+)?(?:const\s+)?(function\*?|class|interface|type|enum|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TS_ABSTRACT_RE = /^abstract\s+class\s+([A-Za-z_$][\w$]*)/;
// Words a declaration regex can capture in the name slot (`export const enum X`, `export default class extends B`): never symbols.
const TS_KEYWORD_SYMBOLS = new Set(["extends", "implements", "enum"]);
const MAX_BODY_LINES = 3000;
const MAX_ENUM_MEMBERS = 200;
const MAX_OBJECT_KEYS = 64;
const NAME_LIKE_KEY_RE = /^(?=.*[A-Za-z])[A-Za-z0-9_$][\w$.-]{0,63}$/;
const KEY_TERMINATORS = ":(,}<";
/**
 * A line that begins a module-level `export`/`import` statement. No object literal or enum body contains one (a dynamic
 * `import(…)`, a key called `export` or `import` and an enum member named like a keyword do not match), so a body scan that meets
 * one is reading unterminated text and stops there: every `export const X = {` then scans only up to the next statement, which
 * keeps the total work of a file linear.
 */
const MODULE_STATEMENT_START_RE =
  /^\s*(?:export\s+(?:default|declare|abstract|async|const|let|var|function|class|interface|type|enum|namespace|module)\b|export\s*[{*]|import\s+(?:type\b|[A-Za-z_$"'{*]))/;

interface BodyEntry {
  name: string;
  line: number;
}

/** First non-space character at or after (`line`, `col`), looking at most two lines further. */
function nextSignificant(masked: readonly string[], line: number, col: number): string | undefined {
  for (let li = line; li < masked.length && li <= line + 2; li++) {
    const text = masked[li]!;
    for (let c = li === line ? col : 0; c < text.length; c++) {
      const ch = text[c]!;
      if (ch !== " " && ch !== "\t") return ch;
    }
  }
  return undefined;
}

/**
 * Top-level keys of the object literal / enum body whose `{` is at
 * (`startLine`, `startCol`) of the masked text: `a`, `a: 1`, `'a-b': 1`,
 * `a() {}`, `get a() {}`, enum `A = 1`. Computed keys, spreads and nested
 * levels are not reported. Quoted key text is read from `raw`. The scan ends
 * at the closing bracket, at a `;` between members or at the next module-level
 * `export`/`import` statement (an unterminated body), whichever comes first.
 */
function braceEntries(
  raw: readonly string[],
  masked: readonly string[],
  startLine: number,
  startCol: number,
  allowEquals: boolean,
  maxEntries: number,
): BodyEntry[] {
  const entries: BodyEntry[] = [];
  let depth = 0;
  let expectKey = false;
  const lastLine = Math.min(masked.length, startLine + MAX_BODY_LINES);
  for (let li = startLine, col = startCol; li < lastLine; li++, col = 0) {
    const m = masked[li]!;
    if (li > startLine && MODULE_STATEMENT_START_RE.test(m)) return entries;
    for (; col < m.length; col++) {
      const ch = m[col]!;
      if (ch === "{" || ch === "(" || ch === "[") {
        depth++;
        if (depth === 1) expectKey = true;
        continue;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        depth--;
        if (depth <= 0) return entries;
        continue;
      }
      if (depth !== 1) continue;
      // Members are separated by commas; a `;` between them means the text is not a literal body after all.
      if (ch === ";") return entries;
      if (ch === ",") { expectKey = true; continue; }
      if (!expectKey || ch === " " || ch === "\t") continue;
      expectKey = false;
      if (/[A-Za-z_$]/.test(ch)) {
        const id = /^[A-Za-z_$][\w$]*/.exec(m.slice(col))![0];
        const after = col + id.length;
        const nxt = nextSignificant(masked, li, after);
        col = after - 1;
        if ((id === "get" || id === "set" || id === "async" || id === "static") && nxt !== undefined && /[A-Za-z_$'"*[]/.test(nxt)) {
          expectKey = true;
          continue;
        }
        if (nxt !== undefined && (KEY_TERMINATORS.includes(nxt) || (allowEquals && nxt === "="))) entries.push({ name: id, line: li + 1 });
      } else if (ch === "'" || ch === "\"") {
        const close = m.indexOf(ch, col + 1);
        if (close > 0) {
          const text = raw[li]!.slice(col + 1, close);
          const nxt = nextSignificant(masked, li, close + 1);
          if (nxt !== undefined && (KEY_TERMINATORS.includes(nxt) || (allowEquals && nxt === "=")) && NAME_LIKE_KEY_RE.test(text)) entries.push({ name: text, line: li + 1 });
          col = close;
        }
      }
      if (entries.length >= maxEntries) return entries;
    }
  }
  return entries;
}

/** Position of the first `{` at/after (`line`, `col`) within three lines, or undefined. */
function findOpenBrace(masked: readonly string[], line: number, col: number): { line: number; col: number } | undefined {
  for (let li = line; li < masked.length && li <= line + 2; li++) {
    const at = masked[li]!.indexOf("{", li === line ? col : 0);
    if (at >= 0) return { line: li, col: at };
    if (li === line && masked[li]!.indexOf(";", col) >= 0) return undefined;
  }
  return undefined;
}

/**
 * TS/JS: `export function/class/interface/type/enum/const/let/var` (also
 * `default`, `declare`, `abstract`, `namespace`), a same-line top-level
 * `function`/`class` (not exported), members of an exported enum, and the
 * top-level keys of an exported `const X = { … }` object literal.
 */
function scanTsJs(raw: readonly string[], masked: readonly string[], declarationFile: boolean): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!;
    if (line.length === 0) continue;
    let match = TS_EXPORTED_RE.exec(line);
    if (!match?.[2] || TS_KEYWORD_SYMBOLS.has(match[2])) match = TS_EXPORT_EXT_RE.exec(line);
    if (match?.[2]) {
      const keyword = match[1]!;
      const name = match[2];
      if (TS_KEYWORD_SYMBOLS.has(name)) continue;
      out.push({ symbol: name, line: i + 1, exported: true, kind: tsKind(keyword) });
      if (keyword === "enum") {
        const open = findOpenBrace(masked, i, match[0].length);
        if (open !== undefined) {
          for (const e of braceEntries(raw, masked, open.line, open.col, true, MAX_ENUM_MEMBERS)) {
            out.push({ symbol: e.name, line: e.line, exported: true, kind: "enum-member", container: name });
          }
        }
      } else if (keyword === "const") {
        const rest = line.slice(match[0].length);
        const literal = /^\s*(?::[^=]*)?=\s*(?:Object\.freeze\s*\(\s*)?\{/.exec(rest);
        if (literal) {
          const col = match[0].length + literal[0].length - 1;
          for (const e of braceEntries(raw, masked, i, col, false, MAX_OBJECT_KEYS)) {
            out.push({ symbol: e.name, line: e.line, exported: true, kind: "member", container: name });
          }
        }
      }
      continue;
    }
    const top = TS_TOPLEVEL_RE.exec(line);
    if (top?.[2] && !TS_KEYWORD_SYMBOLS.has(top[2])) { out.push({ symbol: top[2], line: i + 1, exported: false, kind: tsKind(top[1]!) }); continue; }
    // Ambient declarations (`declare function f(): void;`): global in a `.d.ts`, private to the module elsewhere.
    const ambient = TS_DECLARE_RE.exec(line);
    if (ambient?.[2] && !TS_KEYWORD_SYMBOLS.has(ambient[2])) {
      out.push({ symbol: ambient[2], line: i + 1, exported: declarationFile, kind: tsKind(ambient[1]!) });
      continue;
    }
    const abstractClass = TS_ABSTRACT_RE.exec(line);
    if (abstractClass?.[1]) out.push({ symbol: abstractClass[1], line: i + 1, exported: false, kind: "type" });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  "if", "elif", "else", "while", "for", "try", "except", "finally", "with", "def", "class", "return", "import", "from", "pass",
  "break", "continue", "raise", "assert", "del", "global", "nonlocal", "lambda", "yield", "await", "async", "match", "case",
  "and", "or", "not", "in", "is", "None", "True", "False",
]);
const PY_ASSIGN_RE = /^\(?\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*){0,7})\s*\)?\s*(?::\s*[^=]+?)?\s*=(?!=)/;
const PY_UPPER_RE = /^_?[A-Z][A-Z0-9_]*$/;
const PY_ENUM_BASE_RE = /(?:^|\.)(?:Enum|IntEnum|StrEnum|Flag|IntFlag|ReprEnum)$/;
const PY_CLASS_BASES_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/;
const PY_MEMBER_RE = /^\s*([A-Za-z_]\w*)\s*=(?!=)/;
const MAX_PY_ENUM_LINES = 500;

function pythonEnumMembers(masked: readonly string[], out: DeclaredSymbol[]): void {
  for (let i = 0; i < masked.length; i++) {
    const header = PY_CLASS_BASES_RE.exec(masked[i]!);
    if (!header || !header[3]!.split(",").some((b) => PY_ENUM_BASE_RE.test(b.trim()))) continue;
    const classIndent = header[1]!.length;
    let bodyIndent = -1;
    const last = Math.min(masked.length, i + 1 + MAX_PY_ENUM_LINES);
    for (let k = i + 1; k < last; k++) {
      const text = masked[k]!;
      if (text.trim().length === 0) continue;
      const indent = /^\s*/.exec(text)![0].length;
      if (indent <= classIndent) break;
      if (bodyIndent < 0) bodyIndent = indent;
      if (indent !== bodyIndent) continue;
      const member = PY_MEMBER_RE.exec(text);
      if (member?.[1] && !member[1].startsWith("_") && !PY_KEYWORDS.has(member[1])) {
        out.push({ symbol: member[1], line: k + 1, exported: true, kind: "enum-member", container: header[2]! });
      }
    }
  }
}

/**
 * Python: top-level `def`/`class` (as before), column-0 assignments outside
 * brackets (`NAME = …`, `NAME: T = …`, `A, B = …`; UPPER_CASE is a constant,
 * dunder names are skipped, a leading underscore is not exported), and the
 * members of `Enum`/`IntEnum`/`StrEnum`/`Flag`/`IntFlag` subclasses.
 */
function scanPython(masked: readonly string[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  let depth = 0;
  let backslash = false;
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!;
    const column0 = line.length > 0 && line.charCodeAt(0) > 32;
    if (column0) {
      const def = PY_DEF_RE.exec(line);
      if (def?.[1]) { depth = 0; out.push({ symbol: def[1], line: i + 1, exported: true, kind: "function" }); }
      else {
        const cls = PY_CLASS_RE.exec(line);
        if (cls?.[1]) { depth = 0; out.push({ symbol: cls[1], line: i + 1, exported: true, kind: "type" }); }
        else if (depth === 0 && !backslash) {
          const assign = PY_ASSIGN_RE.exec(line.length > 300 ? line.slice(0, 300) : line);
          if (assign) {
            for (const raw of assign[1]!.split(",")) {
              const name = raw.trim();
              if (name === "_" || PY_KEYWORDS.has(name) || (name.startsWith("__") && name.endsWith("__"))) continue;
              out.push({ symbol: name, line: i + 1, exported: !name.startsWith("_"), kind: PY_UPPER_RE.test(name) ? "constant" : "variable" });
            }
          }
        }
      }
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; }
    }
    backslash = /\\\s*$/.test(line);
  }
  pythonEnumMembers(masked, out);
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// C / C++ (and Objective-C)
// ---------------------------------------------------------------------------

const C_DECL_EXTENSIONS = new Set([
  ".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".inl", ".tpp", ".cu", ".cuh", ".m", ".mm",
]);
const SYN_C: MaskSyntax = { ...SYN_GO, digitSeparators: true, cppRaw: true, lineSplice: true, backtick: "none" };

/** Conditional-compilation markers left in the code view where an `#if`/`#else`/`#endif` stood. */
const EV_IF = "\x01";
const EV_ELSE = "\x02";
const EV_ENDIF = "\x03";
const ZERO_IF_RE = /^\s*\(*\s*0\s*\)*\s*$/;
const INCLUDE_RE = /^\s*#\s*(?:include|import|include_next)\s*(?:([<"])([^>"\r\n]+)[>"])/;
const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_]\w*)(\()?/;
const DIRECTIVE_RE = /^\s*#\s*([A-Za-z_]+)/;

/** A live `#include`/`#import` directive of a C-family source. */
export interface CInclude {
  /** 1-based line of the directive. */
  line: number;
  /** The path between the delimiters. */
  target: string;
  /** `<x>` (true) or `"x"` (false). */
  angled: boolean;
}

export interface CFamilyView {
  /**
   * Masked source with every preprocessor directive and every `#if 0` region
   * blanked; `#if`/`#else`/`#endif` leave one marker character each.
   */
  code: string[];
  /** `#define NAME` (object- and function-like), except include guards. */
  macros: DeclaredSymbol[];
  /** Live `#include`/`#import` directives in statement order. */
  includes: CInclude[];
}

function blankLine(length: number, marker = ""): string {
  return marker + " ".repeat(Math.max(0, length - marker.length));
}

/**
 * Preprocessor pass shared by the declaration scan and the include resolver:
 * masks comments and literals (raw strings included), folds directive
 * continuation lines, skips `#if 0` regions (nesting-aware; `#else`/`#elif`
 * of an `#if 0` are live; every other conditional is NOT evaluated), and
 * collects `#define` names and `#include` targets.
 */
export function analyzeCFamilySource(lines: readonly string[]): CFamilyView {
  const masked = maskSource(lines, SYN_C);
  const n = masked.length;
  const code: string[] = new Array<string>(n);
  const macros: DeclaredSymbol[] = [];
  const includes: CInclude[] = [];
  const conds: Array<"ev" | "zero"> = [];
  let dead = false;
  let deadNest = 0;
  let guard: string | undefined;
  let guardArmed = false;
  let sawConditional = false;
  let i = 0;
  while (i < n) {
    const m = masked[i]!;
    if (!m.trimStart().startsWith("#")) {
      code[i] = dead ? blankLine(m.length) : m;
      i++;
      continue;
    }
    let end = i;
    let text = m;
    while (end + 1 < n && /\\[ \t]*$/.test(lines[end]!)) {
      end++;
      text += " " + masked[end]!;
    }
    const directive = DIRECTIVE_RE.exec(text);
    const name = directive?.[1] ?? "";
    const rest = directive === null ? "" : text.slice(directive[0].length);
    const armed = guardArmed;
    guardArmed = false;
    let marker = "";
    if (dead) {
      if (name === "if" || name === "ifdef" || name === "ifndef") deadNest++;
      else if (name === "endif") {
        if (deadNest > 0) deadNest--;
        else { dead = false; conds.pop(); }
      } else if ((name === "else" || name.startsWith("elif")) && deadNest === 0) dead = false;
    } else if (name === "define") {
      const def = DEFINE_RE.exec(text);
      if (def?.[1]) {
        const isGuard = armed && def[1] === guard && /^\s*(?:1)?\s*$/.test(text.slice(def[0].length));
        if (!isGuard) macros.push({ symbol: def[1], line: i + 1, exported: true, kind: "macro" });
      }
    } else if (name === "include" || name === "import" || name === "include_next") {
      const inc = INCLUDE_RE.exec(lines[i]!);
      if (inc?.[2]) includes.push({ line: i + 1, target: inc[2].trim(), angled: inc[1] === "<" });
    } else if (name === "if" || name === "ifdef" || name === "ifndef") {
      if (name === "if" && ZERO_IF_RE.test(rest)) {
        conds.push("zero");
        dead = true;
        deadNest = 0;
      } else {
        conds.push("ev");
        marker = EV_IF;
      }
      if (!sawConditional) {
        sawConditional = true;
        const g = name === "ifndef" ? /^\s*([A-Za-z_]\w*)/.exec(rest)?.[1] : name === "if" ? /^\s*!\s*defined\s*\(?\s*([A-Za-z_]\w*)/.exec(rest)?.[1] : undefined;
        if (g !== undefined) { guard = g; guardArmed = true; }
      }
    } else if (name === "else" || name.startsWith("elif")) {
      if (conds[conds.length - 1] === "ev") marker = EV_ELSE;
    } else if (name === "endif") {
      if (conds.pop() === "ev") marker = EV_ENDIF;
    }
    code[i] = blankLine(m.length, marker);
    for (let k = i + 1; k <= end; k++) code[k] = blankLine(masked[k]!.length);
    i = end + 1;
  }
  return { code, macros, includes };
}

const C_TYPE_KEYWORDS = new Set([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool", "_Bool", "wchar_t", "char8_t",
  "char16_t", "char32_t", "auto", "_Complex", "__int64", "__int128",
]);
/** Words that are never reported as a declared name. */
const C_RESERVED = new Set([
  ...C_TYPE_KEYWORDS,
  "if", "else", "for", "while", "do", "switch", "case", "default", "return", "break", "continue", "goto", "sizeof", "alignof",
  "_Alignof", "typedef", "struct", "union", "enum", "class", "namespace", "template", "typename", "using", "public", "private",
  "protected", "virtual", "static", "extern", "inline", "const", "volatile", "register", "new", "delete", "this", "throw", "try",
  "catch", "operator", "noexcept", "constexpr", "consteval", "constinit", "explicit", "friend", "mutable", "true", "false",
  "nullptr", "static_assert", "_Static_assert", "decltype", "typeof", "asm", "co_await", "co_return", "co_yield", "concept",
  "requires", "final", "override", "export",
]);
/** Declaration specifiers that are not part of a type name. */
const C_SPECIFIERS = new Set([
  "static", "extern", "inline", "constexpr", "consteval", "constinit", "const", "volatile", "register", "thread_local",
  "_Thread_local", "mutable", "virtual", "explicit", "friend", "typedef", "__inline", "__inline__", "_Noreturn",
  "__extension__", "restrict", "__restrict", "__restrict__", "final", "override", "export",
]);
/** Words that open a parenthesized group belonging to a type, never a declarator. */
const C_TYPE_GROUP_WORDS = new Set(["decltype", "typeof", "__typeof__", "__typeof", "_Atomic", "__underlying_type", "sizeof", "alignof", "_Alignof"]);
/** Words that open an attribute-like group: dropped from a declaration head. */
const C_ATTRIBUTE_WORDS = new Set(["__attribute__", "__attribute", "__declspec", "alignas", "_Alignas", "__asm__", "__asm", "asm", "_Pragma"]);
/** What may follow a parameter list without starting a new declaration. */
const C_POST_QUALIFIERS = new Set(["const", "volatile", "noexcept", "override", "final", "throw", "try", "requires", "mutable"]);
const C_MACRO_NAME_RE = /^(?:_*[A-Z][A-Z0-9_]+|_+[A-Z]|_*[A-Z][A-Z0-9]*_\w+)$/;
/** A wrapper-macro name: ALL_CAPS, or `Prefix_ALLCAPS` (`PyAPI_DATA`). */
const C_WRAPPER_MACRO_RE = /^(?:_*[A-Z][A-Z0-9_]+|_*[A-Z][A-Za-z0-9]*_[A-Z][A-Z0-9_]*)$/;
/** No lowercase at all: a macro rather than a `Prefix_FunctionName`. */
const C_ALLCAPS_RE = /^_*[A-Z][A-Z0-9_]*$/;
/** Nullability / ownership qualifiers that may precede a declarator name inside a pointer group (`int (* _Nullable cb)(void)`). */
const C_POINTER_QUALIFIERS = new Set([
  "const", "volatile", "restrict", "__restrict", "__restrict__", "_Nullable", "_Nonnull", "_Null_unspecified", "__nullable", "__nonnull",
  "__null_unspecified", "__unsafe_unretained", "__strong", "__weak", "__autoreleasing", "_Atomic",
]);
/** `NS_ENUM`, `CF_OPTIONS`, `OS_ENUM`, `NS_CLOSED_ENUM` …: macros that define an enum. */
const C_ENUM_MACRO_RE = /^(?:[A-Z][A-Z0-9_]*_)?(?:ENUM|OPTIONS)$/;
/** An ALL_CAPS macro with an underscore, the shape of `FMT_BEGIN_NAMESPACE` / `G_BEGIN_DECLS` / `EXPORT_API`. */
const C_BARE_MACRO_RE = /^_*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Words that can only start a declaration: a bare macro in front of one of them ran into it without a semicolon. */
const C_DECLARATION_OPENERS = new Set([
  "template", "namespace", "class", "struct", "union", "enum", "typedef", "using", "extern", "static", "inline", "constexpr",
  "consteval", "constinit", "virtual", "friend", "concept", "explicit", "thread_local",
]);
const C_DEFINITION_KEYS = new Set(["class", "struct", "union", "enum"]);
/** Statement openers that never declare anything at declaration scope. */
const C_SKIPPED_STATEMENTS = new Set([
  "namespace", "friend", "static_assert", "_Static_assert", "template", "return", "goto", "break", "continue", "throw", "delete",
  "case", "default", "asm", "co_return",
]);

interface CScope {
  kind: "namespace" | "extern" | "class";
  name: string | undefined;
  access: "public" | "private" | "protected";
  /** Entities directly inside may be externally visible (false: anonymous namespace, non-public nested type). */
  exported: boolean;
  /** Reported as `container` by members declared directly inside. */
  container: string | undefined;
  /** `typedef struct { … } Name;` — the declarators after the closing brace name types. */
  typedef: boolean;
  /** Line of the tag name (0 when anonymous). */
  line?: number;
}
interface CTail {
  typedef: boolean;
  /** The tag already reported for the body, and its line (a `typedef struct T {…} T;` on one line repeats it). */
  name: string | undefined;
  line: number;
}
interface CState {
  stack: CScope[];
  head: Tok[];
  tail: CTail | undefined;
}

/** Index of the token closing the group opened at `i`, conditional-compilation aware; the last token when unterminated. */
function matchCloseC(T: readonly Tok[], i: number, open: string, close: string): number {
  let depth = 0;
  const frames: Array<{ snap: number; firstEnd: number | undefined }> = [{ snap: 0, firstEnd: undefined }];
  let alternative = 0;
  for (let k = i; k < T.length; k++) {
    const s = T[k]!.s;
    if (s === open) depth++;
    else if (s === close) {
      depth--;
      if (depth === 0 && alternative === 0) return k;
    } else if (s === EV_IF) frames.push({ snap: depth, firstEnd: undefined });
    else if (s === EV_ELSE) {
      const f = frames[frames.length - 1]!;
      if (f.firstEnd === undefined) { f.firstEnd = depth; alternative++; }
      depth = f.snap;
    } else if (s === EV_ENDIF) {
      const f = frames.length > 1 ? frames.pop()! : frames[0]!;
      if (f.firstEnd !== undefined) {
        depth = f.firstEnd;
        alternative--;
        f.firstEnd = undefined;
      }
    }
  }
  return T.length - 1;
}

function isEvent(s: string): boolean {
  return s === EV_IF || s === EV_ELSE || s === EV_ENDIF;
}

/** Index of the `<` matching the `>` at `idx` (-1 when none). */
function matchingAngleStart(tokens: readonly Tok[], idx: number): number {
  let depth = 0;
  for (let k = idx; k >= 0; k--) {
    const s = tokens[k]!.s;
    if (s === ">") depth++;
    else if (s === "<") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * `X(args) name(…)` / `X(args) name[…]` / `X(args) name;` — X is a macro that wraps the return type (`NCURSES_EXPORT(int) addch(…)`,
 * `PyAPI_FUNC(int) PyFoo(…)`, `XMLPARSEAPI(void) XML_Foo(…)`) and `name` is the declarator. Two macro calls in a row are not this.
 */
function wrapsType(tokens: readonly Tok[], k: number): boolean {
  const g = tokens[k];
  if (g === undefined || g.s !== "()" || g.double === true || k < 1) return false;
  const x = tokens[k - 1]!.s;
  if (!isIdentTok(x) || C_RESERVED.has(x) || C_TYPE_GROUP_WORDS.has(x)) return false;
  const y = tokens[k + 1]?.s;
  if (y === undefined || !isIdentTok(y) || C_POST_QUALIFIERS.has(y) || C_RESERVED.has(y)) return false;
  const after = tokens[k + 2]?.s;
  // A call-shaped declarator (`name(…)` or `name OF((…))`) must not itself look like a macro, and a dunder-named call after a
  // group is an attribute (`int printf(…) __printflike(1, 2);`), not a declarator.
  if (after === "()" || (after !== undefined && isIdentTok(after) && tokens[k + 3]?.double === true)) return !C_ALLCAPS_RE.test(y) && !y.startsWith("__");
  // `EXPORT_VAR(type) name;`: only a wrapper-looking macro; `get(args) _NOEXCEPT {` is a function with a trailing macro word.
  return (after === undefined || after === "[]" || after === "=" || after === ",") && C_WRAPPER_MACRO_RE.test(x);
}

/** Index just past a C++20 requires-clause constraint-expression starting at `head[from]`: atoms joined by `&&` / `||`. */
function skipConstraint(head: readonly Tok[], from: number): number {
  const atom = (start: number): number => {
    let j = start;
    if (head[j]?.s === "!") j++;
    if (head[j]?.s === "()") return j + 1;
    if (head[j]?.s === "::") j++;
    if (head[j] === undefined || !isIdentTok(head[j]!.s)) return j;
    j++;
    for (;;) {
      if (head[j]?.s === "<") {
        let depth = 0;
        for (; j < head.length; j++) {
          if (head[j]!.s === "<") depth++;
          else if (head[j]!.s === ">") {
            depth--;
            if (depth === 0) { j++; break; }
          }
        }
        continue;
      }
      if (head[j]?.s === "::" && head[j + 1] !== undefined && isIdentTok(head[j + 1]!.s)) { j += 2; continue; }
      return j;
    }
  };
  let j = atom(from);
  while ((head[j]?.s === "&" && head[j + 1]?.s === "&") || (head[j]?.s === "|" && head[j + 1]?.s === "|")) j = atom(j + 2);
  return j;
}

interface NormHead {
  tokens: Tok[];
  /** A leading `extern "C"` / `extern "C++"` was dropped. */
  externC: boolean;
}

/**
 * The declaration part of a statement head: `template <…>` headers,
 * attributes (`[[…]]`, `__attribute__((…))`, `__declspec(…)`, `alignas(…)`),
 * the `extern "C"` linkage prefix, `export`, and any leading
 * `MACRO(args)` invocation that runs into the declaration without a
 * semicolon (Qt `Q_PROPERTY(…) int x() const;`, `NAMESPACE_BEGIN(a) …`) are
 * dropped.
 */
function normalizeHead(head: readonly Tok[]): NormHead {
  const tokens: Tok[] = [];
  let externC = false;
  for (let k = 0; k < head.length; k++) {
    const t = head[k]!;
    const s = t.s;
    if (s === "template" && head[k + 1]?.s === "<") {
      let depth = 0;
      let j = k + 1;
      for (; j < head.length; j++) {
        const u = head[j]!.s;
        if (u === "<") depth++;
        else if (u === ">") {
          depth--;
          if (depth === 0) break;
        }
      }
      k = j;
      continue;
    }
    if (s === "requires" && tokens.length === 0 && head[k + 1]?.s !== "requires") {
      k = skipConstraint(head, k + 1) - 1;
      continue;
    }
    if (t.attr === true || s === "export" || isEvent(s)) continue;
    if (C_ATTRIBUTE_WORDS.has(s) && head[k + 1]?.s === "()") { k++; continue; }
    if (s === "extern" && head[k + 1]?.s === "\"\"") { externC = true; k++; continue; }
    tokens.push(t);
  }
  // Macros that run into the declaration (no semicolon) are not part of it: `NAMESPACE_BEGIN template <…> struct X {`,
  // `__deprecated_msg("…") int foo(void);`, `Q_PROPERTY(…) int x() const;`. Repeat: several may be stacked.
  for (;;) {
    if (tokens.length >= 2 && C_BARE_MACRO_RE.test(tokens[0]!.s)) {
      let run = 1;
      while (run < tokens.length && C_BARE_MACRO_RE.test(tokens[run]!.s)) run++;
      if (run < tokens.length && C_DECLARATION_OPENERS.has(tokens[run]!.s)) {
        tokens.splice(0, run);
        continue;
      }
    }
    if (tokens.length >= 3 && isIdentTok(tokens[0]!.s) && tokens[0]!.s.startsWith("__") && tokens[1]!.s === "()") {
      tokens.splice(0, 2);
      continue;
    }
    let cut = -1;
    for (let k = 1; k < tokens.length - 1; k++) {
      if (tokens[k]!.s !== "()") continue;
      // An `OF((args))` parameter-list wrapper belongs to the declarator before it; only a call that wraps a type or stands alone is cut.
      if (C_MACRO_NAME_RE.test(tokens[k - 1]!.s) && tokens[k]!.double !== true && !wrapsType(tokens, k)) {
        const next = tokens[k + 1]!.s;
        if (isIdentTok(next) && !C_POST_QUALIFIERS.has(next)) cut = k;
      }
      break;
    }
    if (cut < 0) break;
    tokens.splice(0, cut + 1);
  }
  return { tokens, externC };
}

/** Index of the parameter-list group of a function-like declaration head (before any `=`), or -1. */
function findFunctionGroup(tokens: readonly Tok[]): number {
  // `operator==`, `operator()` …: the symbol characters are part of the name, so the first group after `operator` is the parameter list.
  const op = tokens.findIndex((t) => t.s === "operator");
  if (op >= 0) return tokens.findIndex((t, k) => k > op && t.s === "()");
  let angle = 0;
  for (let k = 0; k < tokens.length; k++) {
    const s = tokens[k]!.s;
    if (s === "<") angle++;
    else if (s === ">") angle = Math.max(0, angle - 1);
    else if (s === "=" && angle === 0) return -1;
    else if (s === "()" && angle === 0) {
      const prev = tokens[k - 1]?.s;
      if (prev !== undefined && C_TYPE_GROUP_WORDS.has(prev)) continue;
      // `EXPORT(type) name(args)`: a call that wraps the return type is not the parameter list.
      if (wrapsType(tokens, k)) continue;
      // `static const T table[] ATTRIBUTE_MACRO(x) = {…};`: a call after an array declarator is an attribute (a function is never an array).
      if (k >= 2 && tokens[k - 2]!.s === "[]") continue;
      // `extern long timezone __DARWIN_ALIAS(timezone);`: a dunder macro call after a declarator is an attribute.
      if (prev !== undefined && prev.startsWith("__") && tokens[k]!.double !== true && k >= 3 && isIdentTok(tokens[k - 2]!.s) && !C_SPECIFIERS.has(tokens[k - 2]!.s) && !C_RESERVED.has(tokens[k - 2]!.s)) {
        const typeBefore = tokens[k - 3]!.s;
        // `long timezone __DARWIN_ALIAS(x)` / `char *p __attr(x)`: a builtin type or pointer before the name; an ALL_CAPS dunder call is a macro anyway.
        if (C_TYPE_KEYWORDS.has(typeBefore) || typeBefore === "*" || typeBefore === "&" || C_ALLCAPS_RE.test(prev)) continue;
      }
      return k;
    }
  }
  return -1;
}

interface DeclaratorId {
  qualifier: string | undefined;
  dtor: boolean;
  /** Index of the first token of the (possibly qualified) declarator-id. */
  start: number;
}

function declaratorId(tokens: readonly Tok[], nameIdx: number): DeclaratorId {
  let start = nameIdx;
  let dtor = false;
  let qualifier: string | undefined;
  if (tokens[start - 1]?.s === "~") { dtor = true; start--; }
  while (tokens[start - 1]?.s === "::") {
    let q = start - 2;
    if (tokens[q]?.s === ">") q = matchingAngleStart(tokens, q) - 1;
    const qt = q >= 0 ? tokens[q] : undefined;
    if (qt !== undefined && isIdentTok(qt.s)) {
      if (qualifier === undefined) qualifier = qt.s;
      start = q;
    } else {
      start--;
      break;
    }
  }
  return { qualifier, dtor, start };
}

interface FuncInfo {
  name: Tok;
  qualifier: string | undefined;
  dtor: boolean;
  start: number;
  /** A function-pointer declarator (`int (*fp)(int)`), not a function. */
  pointer: boolean;
  /** The declarator sits inside the first group (`void (*name(args))(int)` declares a function). */
  viaGroup: boolean;
  /** The parameter list is wrapped in a macro (`name OF((args))`). */
  wrapped: boolean;
}

/** Calling-convention words that precede the `*` of a function-pointer declarator (`(WINAPI *fp)`); an all-caps type name (`(WINDOW *)`) is not one. */
const C_CALLING_CONVENTIONS = new Set([
  "WINAPI", "CALLBACK", "APIENTRY", "PASCAL", "NTAPI", "WSAAPI", "CDECL", "STDCALL", "FASTCALL", "THISCALL", "VKAPI_PTR", "GLAPIENTRY",
  "EGLAPIENTRY", "GL_APIENTRY", "PNG_CALLBACK", "JNICALL",
]);

function isCallingConvention(s: string): boolean {
  return s.startsWith("__") || C_CALLING_CONVENTIONS.has(s);
}

function functionInfo(T: readonly Tok[], tokens: readonly Tok[], g: number): FuncInfo | undefined {
  for (let k = 0; k < g; k++) if (tokens[k]!.s === "operator") return undefined;
  const group = tokens[g]!;
  const inner = T.slice(group.from!, group.to!).filter((t) => !isEvent(t.s));
  // The real parameter list follows, possibly through an `OF((…))`-style wrapper macro.
  const groupFollows = tokens[g + 1]?.s === "()" || (tokens[g + 1] !== undefined && C_MACRO_NAME_RE.test(tokens[g + 1]!.s) && tokens[g + 2]?.double === true);
  // A declarator inside the group: `ret (*name)(args)`, `ret (WINAPI *name)(args)`, `ret (*name(args))(args)`, `ret (*(*name)(args))(args)`.
  // A parameter list never starts with `*`, and `(CONV *name)` followed by the real parameter list is a declarator too.
  const first = inner[0]?.s;
  const isStar = (s: string | undefined): boolean => s === "*" || s === "&" || s === "^";
  if (isStar(first) || (first !== undefined && isIdentTok(first) && isStar(inner[1]?.s) && (isCallingConvention(first) || groupFollows))) {
    let q = 0;
    while (q < inner.length) {
      const s = inner[q]!.s;
      // A calling-convention word is followed by more declarator (`__stdcall *fp`); the last word is the name (`*const __clone`).
      const conv = isIdentTok(s) && (isStar(inner[q + 1]?.s) || (isCallingConvention(s) && inner[q + 1]?.s === "("));
      if (!(isStar(s) || s === "(" || C_POINTER_QUALIFIERS.has(s) || conv)) break;
      q++;
    }
    const nm = inner[q];
    if (nm === undefined || !isIdentTok(nm.s) || C_RESERVED.has(nm.s)) return undefined;
    return { name: nm, qualifier: undefined, dtor: false, start: g, pointer: inner[q + 1]?.s !== "(", viaGroup: true, wrapped: false };
  }
  // `LUA_API int (lua_gettop) (lua_State *L)`, `BZ_API(name) (params)`: a lone identifier in the group names the function.
  if (inner.length === 1 && isIdentTok(inner[0]!.s) && !C_RESERVED.has(inner[0]!.s) && groupFollows) {
    // `BZ_API(name) (params)`: a macro-like word before the group belongs to the declarator; `xp_error (name) (params)`: a return type does not.
    const before = tokens[g - 1];
    const start = before !== undefined && isIdentTok(before.s) && C_MACRO_NAME_RE.test(before.s) && !C_SPECIFIERS.has(before.s) && !C_RESERVED.has(before.s) ? g - 1 : g;
    return { name: inner[0]!, qualifier: undefined, dtor: false, start, pointer: false, viaGroup: true, wrapped: false };
  }
  let nameIdx = g - 1;
  let wrapped = false;
  // `name OF((args))`-style wrappers around a parameter list: the function name precedes the macro.
  if (nameIdx >= 1 && group.double === true && isIdentTok(tokens[nameIdx]!.s) && C_MACRO_NAME_RE.test(tokens[nameIdx]!.s) && isIdentTok(tokens[nameIdx - 1]!.s)) {
    nameIdx--;
    wrapped = true;
  }
  const nameTok = tokens[nameIdx];
  if (nameTok === undefined) return undefined;
  if (isIdentTok(nameTok.s) && !C_RESERVED.has(nameTok.s)) {
    const id = declaratorId(tokens, nameIdx);
    return { name: nameTok, qualifier: id.qualifier, dtor: id.dtor, start: id.start, pointer: false, viaGroup: false, wrapped };
  }
  return undefined;
}

function countTypeTokens(tokens: readonly Tok[], end: number): number {
  let count = 0;
  for (let k = 0; k < end; k++) {
    const s = tokens[k]!.s;
    // A dunder ALL_CAPS macro (`__BEGIN_DECLS`, `__OSX_AVAILABLE`) that ran into the declaration is not a type.
    if (isIdentTok(s) && !C_SPECIFIERS.has(s) && !(s.startsWith("__") && C_MACRO_NAME_RE.test(s))) count++;
  }
  return count;
}

/** The first parameter reads as `Type [name]` (a function declaration), not as an argument expression (`Foo x(1, 2);`). */
function paramsLookLikeDeclarations(T: readonly Tok[], group: Tok): boolean {
  const inner = T.slice(group.from!, group.to!).filter((t) => !isEvent(t.s));
  if (inner.length === 0) return true;
  if (!isIdentTok(inner[0]!.s)) return false;
  let depth = 0;
  for (const t of inner) {
    const s = t.s;
    if (s === "(" || s === "[" || s === "<") depth++;
    else if (s === ")" || s === "]" || s === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (s === "," || s === "=")) break;
    else if (isIdentTok(s) || s === "*" || s === "&" || s === "::" || s === "..." || depth > 0) continue;
    else return false;
  }
  return true;
}

/** Names declared by a variable statement: `static const int a = 1, *b;` → a, b. */
function declaratorNames(tokens: readonly Tok[], requireType: boolean): Tok[] {
  const segments: Tok[][] = [];
  let cur: Tok[] = [];
  let angle = 0;
  for (const t of tokens) {
    if (t.s === "<") angle++;
    else if (t.s === ">") angle = Math.max(0, angle - 1);
    if (t.s === "," && angle === 0) {
      segments.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  segments.push(cur);
  const names: Tok[] = [];
  for (let index = 0; index < segments.length && names.length < 32; index++) {
    const ids: Tok[] = [];
    /** Whether the token before ids[k] in the segment was an identifier (no `*`, no group in between). */
    const afterWord: boolean[] = [];
    let depth = 0;
    let previousToken = "";
    for (const t of segments[index]!) {
      const s = t.s;
      const before = previousToken;
      previousToken = s;
      if (s === "<") { depth++; continue; }
      if (s === ">") { depth = Math.max(0, depth - 1); continue; }
      if (depth > 0) continue;
      if (s === "()") {
        const previous = ids[ids.length - 1];
        // `EXPORT_VAR(type) name`: the macro call is the type; a dunder macro call after the name is an attribute.
        if (previous !== undefined && C_MACRO_NAME_RE.test(previous.s) && !previous.s.startsWith("__")) continue;
        break;
      }
      if (s === "=" || s === ":" || s === "{}" || (s === "[]" && ids.length > 0)) break;
      // The tag of `struct foo` is part of the type, not a declarator word.
      if (isIdentTok(s) && C_DEFINITION_KEYS.has(before)) continue;
      if (isIdentTok(s) && !C_SPECIFIERS.has(s)) {
        ids.push(t);
        afterWord.push(before !== "" && isIdentTok(before) && !C_SPECIFIERS.has(before));
      }
    }
    let n = ids.length - 1;
    // A dunder word right after the name (`FILE *__stdinp __swift_unsafe;`) is an attribute while a type and a name remain before it.
    while (n >= 2 && ids[n]!.s.startsWith("__") && afterWord[n] === true && !C_RESERVED.has(ids[n - 1]!.s)) n--;
    const last = ids[n];
    if (last === undefined || C_RESERVED.has(last.s)) continue;
    if (index === 0 && requireType && n === 0) return [];
    names.push(last);
  }
  return names;
}

/** `const` applies to the declared object itself (not only to a pointee), or the declaration is `constexpr`. */
function isConstDeclarator(tokens: readonly Tok[], name: Tok): boolean {
  const idx = tokens.indexOf(name);
  if (idx < 0) return false;
  let lastPointer = -1;
  for (let k = 0; k < idx; k++) {
    const s = tokens[k]!.s;
    if (s === "constexpr") return true;
    if (s === "*" || s === "&") lastPointer = k;
  }
  for (let k = lastPointer + 1; k < idx; k++) if (tokens[k]!.s === "const") return true;
  return false;
}

/** Top-level comma-separated arguments of a collapsed group (raw tokens `T[from..to)`). */
function groupArgs(T: readonly Tok[], group: Tok): Tok[][] {
  const args: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (let k = group.from!; k < group.to!; k++) {
    const t = T[k]!;
    if (isEvent(t.s)) continue;
    if (t.s === "(" || t.s === "[" || t.s === "{") depth++;
    else if (t.s === ")" || t.s === "]" || t.s === "}") depth = Math.max(0, depth - 1);
    if (t.s === "," && depth === 0) {
      args.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length > 0 || args.length > 0) args.push(cur);
  return args;
}

function isTypeKeyStatement(tokens: readonly Tok[]): boolean {
  return C_DEFINITION_KEYS.has(tokens[0]?.s ?? "");
}

/**
 * C/C++/Objective-C declarations: functions and prototypes, out-of-line
 * members (`ret Class::method(`), classes/structs/unions/enums, enumerators,
 * typedefs and aliases, variables, members and fields inside class bodies.
 * A statement-level scan over comment/string-free tokens with a
 * namespace/class/enum scope stack: nothing inside a function body, an
 * initializer or a lambda is ever a declaration.
 */
function scanCDeclarations(T: Tok[]): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const namespaces = new Set<string>();
  let stack: CScope[] = [];
  let head: Tok[] = [];
  let tail: CTail | undefined;
  /** Statements still to skip inside the parameter declarations of a K&R-style definition (`int f(a, b) int a; int b; { … }`). */
  let oldStyleParams = 0;
  const conds: Array<{ snap: CState; first: CState | undefined }> = [];

  const top = (): CScope | undefined => stack[stack.length - 1];
  const inClass = (): boolean => top()?.kind === "class";
  const visible = (fileStatic: boolean): boolean => {
    const s = top();
    if (s === undefined) return !fileStatic;
    return s.kind === "class" ? s.exported && s.access === "public" : s.exported && !fileStatic;
  };
  const containerOf = (): string | undefined => {
    const s = top();
    return s !== undefined && s.kind === "class" ? s.container : undefined;
  };
  const emit = (name: Tok, kind: NonNullable<DeclaredSymbol["kind"]>, exported: boolean, container?: string): void => {
    if (C_RESERVED.has(name.s)) return;
    const entry: DeclaredSymbol = { symbol: name.s, line: name.line, exported, kind };
    if (container !== undefined) entry.container = container;
    out.push(entry);
  };
  const clone = (): CState => ({ stack: stack.slice(), head: head.slice(), tail });
  const restore = (state: CState): void => {
    stack = state.stack.slice();
    head = state.head.slice();
    tail = state.tail;
  };

  const declareVariables = (tokens: readonly Tok[]): void => {
    const names = declaratorNames(tokens, true);
    if (names.length === 0) return;
    const cls = inClass();
    const isStatic = tokens.some((t) => t.s === "static");
    for (const name of names) {
      const constant = isConstDeclarator(tokens, name);
      // `T Class::member = …;` defines a static data member out of line.
      const qualifier = declaratorId(tokens, tokens.indexOf(name)).qualifier;
      if (qualifier !== undefined && !namespaces.has(qualifier)) {
        emit(name, constant ? "constant" : "member", visible(false), qualifier);
        continue;
      }
      const kind: NonNullable<DeclaredSymbol["kind"]> = cls ? (constant && isStatic ? "constant" : "member") : constant ? "constant" : "variable";
      emit(name, kind, visible(isStatic && !cls), containerOf());
    }
  };

  const declareFunction = (tokens: Tok[], g: number): void => {
    const info = functionInfo(T, tokens, g);
    if (info === undefined || info.dtor) return;
    const typeCount = countTypeTokens(tokens, info.start);
    const after = tokens[g + 1]?.s;
    if (after !== undefined && (C_TYPE_KEYWORDS.has(after) || after === "struct" || after === "union" || after === "enum" || after === "register") && !info.viaGroup) {
      // A type specifier follows the parameter list: the parameters are a K&R identifier list and the declarations after
      // them (`int a; char *b;`) are theirs, not ours.
      const inner = T.slice(tokens[g]!.from!, tokens[g]!.to!).filter((t) => !isEvent(t.s));
      if (inner.length > 0 && inner.every((t) => t.s === "," || (isIdentTok(t.s) && !C_TYPE_KEYWORDS.has(t.s)))) oldStyleParams = 24;
    }
    const isStatic = tokens.slice(0, info.start).some((t) => t.s === "static");
    const cls = inClass();
    if (info.pointer) {
      if (typeCount > 0) emit(info.name, cls ? "member" : "variable", visible(isStatic && !cls), containerOf());
      return;
    }
    if (typeCount === 0) {
      // A constructor: only an out-of-line definition names something this file does not already declare as a type.
      if (info.qualifier !== undefined && info.qualifier === info.name.s) emit(info.name, "member", visible(false), info.qualifier);
      return;
    }
    if (!info.viaGroup && !info.wrapped && !paramsLookLikeDeclarations(T, tokens[g]!)) {
      emit(info.name, cls ? "member" : "variable", visible(isStatic && !cls), containerOf());
      return;
    }
    if (info.qualifier !== undefined) {
      if (namespaces.has(info.qualifier)) emit(info.name, "function", visible(false));
      else emit(info.name, "member", visible(false), info.qualifier);
    } else if (cls) emit(info.name, "member", visible(false), containerOf());
    else emit(info.name, "function", visible(isStatic));
  };

  const declareTypedef = (tokens: Tok[]): void => {
    const rest = tokens.slice(1);
    const g = findFunctionGroup(rest);
    if (g >= 0) {
      const info = functionInfo(T, rest, g);
      if (info !== undefined && (info.pointer || info.viaGroup || info.start < g) && countTypeTokens(rest, info.start) > 0) emit(info.name, "type", visible(false), containerOf());
      return;
    }
    for (const name of declaratorNames(rest, true)) emit(name, "type", visible(false), containerOf());
  };

  const declareTail = (tokens: readonly Tok[], info: CTail): void => {
    const norm = normalizeHead(tokens).tokens;
    const cls = inClass();
    for (const name of declaratorNames(norm, false)) {
      if (info.typedef) {
        if (name.s !== info.name || name.line !== info.line) emit(name, "type", visible(false), containerOf());
      } else emit(name, cls ? "member" : isConstDeclarator(norm, name) ? "constant" : "variable", visible(false), containerOf());
    }
  };

  /** Statement terminated by `;` at declaration scope. */
  const statement = (): void => {
    if (tail !== undefined) {
      declareTail(head, tail);
      tail = undefined;
      return;
    }
    if (oldStyleParams > 0) {
      oldStyleParams--;
      return;
    }
    const norm = normalizeHead(head);
    const tokens = norm.tokens;
    if (tokens.length === 0 || tokens[0]!.s === "@") return;
    const first = tokens[0]!.s;
    // `OS_ENUM(name, type, A = 0, B, …);`: an enum whose enumerators are macro arguments.
    const enumCall = tokens.findIndex((t, k) => t.s === "()" && k >= 1 && C_ENUM_MACRO_RE.test(tokens[k - 1]!.s));
    if (enumCall >= 0 && enumCall === tokens.length - 1 && tokens.slice(0, enumCall - 1).every((t) => C_SPECIFIERS.has(t.s))) {
      const args = groupArgs(T, tokens[enumCall]!);
      const nameTok = args[0]?.length === 1 ? args[0][0] : undefined;
      if (args.length >= 3 && nameTok !== undefined && isIdentTok(nameTok.s)) {
        const pub = visible(false);
        emit(nameTok, "type", pub, containerOf());
        for (const arg of args.slice(2)) {
          const id = arg[0];
          if (id !== undefined && isIdentTok(id.s) && !C_RESERVED.has(id.s) && (arg.length === 1 || arg[1]!.s === "=")) {
            out.push({ symbol: id.s, line: id.line, exported: pub, kind: "enum-member", container: nameTok.s });
          }
        }
        return;
      }
    }
    if (first === "typedef") { declareTypedef(tokens); return; }
    if (first === "using") {
      const alias = tokens[1];
      // `using Name ATTRIBUTE_MACRO = …;`: macro words and groups may sit between the name and `=`.
      let eq = 2;
      while (tokens[eq] !== undefined && tokens[eq]!.s !== "=" && (tokens[eq]!.s === "()" || tokens[eq]!.s === "[]" || (isIdentTok(tokens[eq]!.s) && C_MACRO_NAME_RE.test(tokens[eq]!.s)))) eq++;
      if (alias !== undefined && isIdentTok(alias.s) && tokens[eq]?.s === "=") emit(alias, "type", visible(false), containerOf());
      return;
    }
    if (first === "concept") {
      if (tokens[1] !== undefined && tokens[2]?.s === "=") emit(tokens[1], "type", visible(false), containerOf());
      return;
    }
    if (C_SKIPPED_STATEMENTS.has(first) || (first === "extern" && tokens[1]?.s === "template") || tokens.slice(0, 3).some((t) => t.s === "friend")) return;
    if (isTypeKeyStatement(tokens)) {
      // `struct Foo;` / `class EXPORT Foo;` / `enum class E : int;` forward declarations declare nothing new; `struct Foo x;` declares x.
      let k = 1;
      if (first === "enum" && (tokens[k]?.s === "class" || tokens[k]?.s === "struct")) k++;
      let forward = true;
      let angle = 0;
      const names: string[] = [];
      for (let j = k; j < tokens.length; j++) {
        const s = tokens[j]!.s;
        if (s === ":") break;
        if (s === "<") angle++;
        else if (s === ">") angle = Math.max(0, angle - 1);
        else if (angle > 0 || s === "::") continue;
        else if (isIdentTok(s)) names.push(s);
        else { forward = false; break; }
      }
      if (forward && (names.length <= 1 || (names.length === 2 && C_ALLCAPS_RE.test(names[0]!)) || tokens.slice(k).some((t) => t.s === ":"))) return;
    }
    const g = findFunctionGroup(tokens);
    if (g >= 0) declareFunction(tokens, g);
    else declareVariables(tokens);
  };

  const enumBody = (start: number, container: string | undefined, exported: boolean): number => {
    let i = start;
    let expect = true;
    while (i < T.length) {
      const t = T[i]!;
      const s = t.s;
      if (s === "}") return i + 1;
      if (isEvent(s)) { i++; continue; }
      if (s === "(" || s === "[" || s === "{") {
        i = matchCloseC(T, i, s, s === "(" ? ")" : s === "[" ? "]" : "}") + 1;
        continue;
      }
      if (s === ",") { expect = true; i++; continue; }
      if (expect) {
        expect = false;
        const next = T[i + 1]?.s;
        // An enumerator may be followed by an availability/attribute macro (`kName API_AVAILABLE(x) = 1`, `kName __deprecated`).
        if (isIdentTok(s) && !C_RESERVED.has(s) && (next === "=" || next === "," || next === "}" || next === "[" || (next !== undefined && isIdentTok(next) && C_MACRO_NAME_RE.test(next)))) {
          const entry: DeclaredSymbol = { symbol: s, line: t.line, exported, kind: "enum-member" };
          if (container !== undefined) entry.container = container;
          out.push(entry);
        }
      }
      i++;
    }
    return i;
  };

  /** Name token of a class/struct/union/enum head: the last identifier before `:` (an export macro may precede it). */
  const tagName = (tokens: readonly Tok[], from: number): Tok | undefined => {
    let angle = 0;
    let name: Tok | undefined;
    for (let k = from; k < tokens.length; k++) {
      const s = tokens[k]!.s;
      if (s === ":") break;
      if (s === "<") angle++;
      else if (s === ">") angle = Math.max(0, angle - 1);
      else if (angle === 0 && isIdentTok(s) && s !== "final" && tokens[k + 1]?.s !== "()") name = tokens[k];
    }
    return name;
  };

  /**
   * Token visits the body lookaheads of `typedefTag` may spend in one scan. A body is looked at once per enclosing anonymous
   * typedef, so a real file stays far below this; unterminated text (thousands of `typedef struct {` that never close) would
   * otherwise look ahead to the end of the file from every one of them.
   */
  let typedefLookahead = MAX_TYPEDEF_LOOKAHEAD_TOKENS;

  /** The declarator naming an anonymous `typedef struct/enum { … } Name;` body opened at `open`. */
  const typedefTag = (open: number): Tok | undefined => {
    if (typedefLookahead <= 0) return undefined;
    const close = matchCloseC(T, open, "{", "}");
    typedefLookahead -= close - open + 1;
    let k = close + 1;
    let last: Tok | undefined;
    for (; k < T.length; k++) {
      const s = T[k]!.s;
      if (s === ";" || s === "," || s === "{") break;
      if (s === "(" || s === "[") { k = matchCloseC(T, k, s, s === "(" ? ")" : "]"); continue; }
      if (isIdentTok(s) && !C_ATTRIBUTE_WORDS.has(s) && !C_SPECIFIERS.has(s)) last = T[k];
    }
    return last;
  };

  /** `{` at declaration scope: returns the index to continue from. */
  const openBrace = (i: number): number => {
    oldStyleParams = 0;
    const norm = normalizeHead(head);
    const tokens = norm.tokens;
    const skipBody = (): number => matchCloseC(T, i, "{", "}") + 1;
    const first = tokens[0]?.s;
    if (first === "namespace" || (first === "inline" && tokens[1]?.s === "namespace")) {
      const names = tokens.slice(first === "namespace" ? 1 : 2).filter((t) => isIdentTok(t.s));
      for (const nm of names) namespaces.add(nm.s);
      const pub = visible(false);
      stack.push({ kind: "namespace", name: names[names.length - 1]?.s, access: "public", exported: pub && names.length > 0, container: undefined, typedef: false });
      head = [];
      return i + 1;
    }
    if (norm.externC && tokens.length === 0) {
      stack.push({ kind: "extern", name: undefined, access: "public", exported: visible(false), container: undefined, typedef: false });
      head = [];
      return i + 1;
    }
    // `DNS_SERVICE_FLAGS_ENUM { … };`: an enum keyword hidden behind a macro.
    if (tokens.length === 1 && C_ENUM_MACRO_RE.test(tokens[0]!.s)) {
      const pub = visible(false);
      const next = enumBody(i + 1, undefined, pub);
      tail = { typedef: false, name: undefined, line: 0 };
      head = [];
      return next;
    }
    // `typedef NS_ENUM(NSInteger, Name) { … };`: an enum defined through a macro.
    const enumCall = tokens.findIndex((t, k) => t.s === "()" && k >= 1 && C_ENUM_MACRO_RE.test(tokens[k - 1]!.s));
    if (enumCall >= 0 && enumCall === tokens.length - 1 && tokens.slice(0, enumCall - 1).every((t) => C_SPECIFIERS.has(t.s))) {
      const args = groupArgs(T, tokens[enumCall]!);
      const lastArg = args[args.length - 1];
      const enumName = args.length >= 2 && lastArg !== undefined && lastArg.length === 1 && isIdentTok(lastArg[0]!.s) ? lastArg[0] : undefined;
      const pub = visible(false);
      if (enumName !== undefined) emit(enumName, "type", pub, containerOf());
      const next = enumBody(i + 1, enumName?.s, pub);
      tail = { typedef: false, name: enumName?.s, line: enumName?.line ?? 0 };
      head = [];
      return next;
    }
    // class / struct / union / enum definition: only specifiers may precede the key and no initializer or parameter list may follow.
    const keyIdx = tokens.findIndex((t) => C_DEFINITION_KEYS.has(t.s));
    if (keyIdx >= 0 && tokens.slice(0, keyIdx).every((t) => C_SPECIFIERS.has(t.s)) && !tokens.some((t) => t.s === "=")) {
      const key = tokens[keyIdx]!.s;
      const body = tokens.slice(keyIdx + 1);
      let angle = 0;
      let macroCalls = 0;
      for (let b = 0; b < body.length; b++) {
        const w = body[b]!.s;
        if (w === "<") angle++;
        else if (w === ">") angle = Math.max(0, angle - 1);
        else if (w === "()" && angle === 0 && !(b > 0 && (C_MACRO_NAME_RE.test(body[b - 1]!.s) || C_TYPE_GROUP_WORDS.has(body[b - 1]!.s)))) macroCalls++;
      }
      if (macroCalls === 0) {
        const typedef = tokens.slice(0, keyIdx).some((t) => t.s === "typedef");
        let from = keyIdx + 1;
        if (key === "enum" && (tokens[from]?.s === "class" || tokens[from]?.s === "struct")) from++;
        const name = tagName(tokens, from);
        const pub = visible(false);
        if (name !== undefined) emit(name, "type", pub, containerOf());
        // An anonymous `typedef struct { … } Name;` body belongs to the typedef name.
        const owner = name?.s ?? (typedef ? typedefTag(i)?.s : undefined);
        if (key === "enum") {
          const next = enumBody(i + 1, owner, pub);
          tail = { typedef, name: name?.s, line: name?.line ?? 0 };
          head = [];
          return next;
        }
        stack.push({
          kind: "class",
          name: name?.s,
          access: key === "class" ? "private" : "public",
          exported: pub,
          container: owner ?? containerOf(),
          typedef,
          line: name?.line ?? 0,
        });
        head = [];
        return i + 1;
      }
    }
    const g = findFunctionGroup(tokens);
    if (g >= 0) {
      const last = tokens[tokens.length - 1]!;
      const initList = tokens.slice(g + 1).some((t) => t.s === ":");
      if (initList && (isIdentTok(last.s) || last.s === ">") && !C_POST_QUALIFIERS.has(last.s)) {
        // A member initializer `x{…}` of a constructor's initializer list, not the body.
        head.push({ s: "{}", line: T[i]!.line });
        return skipBody();
      }
      declareFunction(tokens, g);
      head = [];
      return skipBody();
    }
    const last = tokens[tokens.length - 1];
    if (tokens.some((t) => t.s === "=") || (tokens.length >= 2 && last !== undefined && (isIdentTok(last.s) || last.s === ">") && !C_RESERVED.has(last.s))) {
      // Initializer (`= { … }`, lambda body) or brace-initialized variable: part of the statement.
      head.push({ s: "{}", line: T[i]!.line });
      return skipBody();
    }
    head = [];
    return skipBody();
  };

  /** Objective-C `@interface`/`@implementation`/`@protocol` … `@end`; returns the index after `@end`. */
  const objcContainer = (i: number): number => {
    const kind = T[i + 1]!.s;
    const nameTok = T[i + 2];
    if (nameTok === undefined || !isIdentTok(nameTok.s)) return i + 1;
    const category = T[i + 3]?.s === "(";
    if (!category) emit(nameTok, "type", true);
    let k = i + 3;
    while (k < T.length) {
      const t = T[k]!;
      if (t.s === "@" && T[k + 1]?.s === "end") return k + 2;
      if (t.s === "{") { k = matchCloseC(T, k, "{", "}") + 1; continue; }
      if ((t.s === "-" || t.s === "+") && T[k + 1]?.s === "(") {
        const afterType = matchCloseC(T, k + 1, "(", ")") + 1;
        const sel = T[afterType];
        if (sel !== undefined && isIdentTok(sel.s)) emit(sel, "member", true, nameTok.s);
        k = afterType + 1;
        while (k < T.length && T[k]!.s !== ";" && T[k]!.s !== "{" && !(T[k]!.s === "@" && T[k + 1]?.s === "end")) {
          k = T[k]!.s === "(" ? matchCloseC(T, k, "(", ")") + 1 : k + 1;
        }
        if (T[k]?.s === "{") k = matchCloseC(T, k, "{", "}") + 1;
        else if (T[k]?.s === ";") k++;
        continue;
      }
      if (t.s === "@" && T[k + 1]?.s === "property") {
        k += 2;
        if (T[k]?.s === "(") k = matchCloseC(T, k, "(", ")") + 1;
        let last: Tok | undefined;
        while (k < T.length && T[k]!.s !== ";" && !(T[k]!.s === "@" && T[k + 1]?.s === "end")) {
          if (isIdentTok(T[k]!.s)) last = T[k];
          k = T[k]!.s === "(" ? matchCloseC(T, k, "(", ")") + 1 : k + 1;
        }
        if (last !== undefined && kind !== "implementation") emit(last, "member", true, nameTok.s);
        continue;
      }
      k++;
    }
    return k;
  };

  let i = 0;
  while (i < T.length) {
    const t = T[i]!;
    const s = t.s;
    if (s === EV_IF) {
      conds.push({ snap: clone(), first: undefined });
      i++;
    } else if (s === EV_ELSE) {
      const c = conds[conds.length - 1];
      if (c !== undefined) {
        if (c.first === undefined) c.first = clone();
        restore(c.snap);
      }
      i++;
    } else if (s === EV_ENDIF) {
      const c = conds.pop();
      if (c?.first !== undefined) restore(c.first);
      i++;
    } else if (s === "(" || s === "[") {
      const close = matchCloseC(T, i, s, s === "(" ? ")" : "]");
      head.push({ s: s === "(" ? "()" : "[]", line: t.line, from: i + 1, to: close, attr: s === "[" && T[i + 1]?.s === "[", double: s === "(" && T[i + 1]?.s === "(" });
      i = close + 1;
    } else if (s === ";") {
      statement();
      head = [];
      i++;
    } else if (s === "{") {
      i = openBrace(i);
    } else if (s === "}") {
      const closed = stack.pop();
      head = [];
      tail = closed !== undefined && closed.kind === "class" ? { typedef: closed.typedef, name: closed.name, line: closed.line ?? 0 } : undefined;
      i++;
    } else if (s === ":") {
      const scope = top();
      const last = head[head.length - 1]?.s;
      const prev = head[head.length - 2]?.s;
      const isAccess = (w: string | undefined): w is "public" | "private" | "protected" => w === "public" || w === "private" || w === "protected";
      // An access label ends whatever macro invocations (`Q_OBJECT`, `Q_PROPERTY(…)`) ran into it without a semicolon.
      if (scope !== undefined && scope.kind === "class" && (isAccess(last) || (isAccess(prev) && (last === "slots" || last === "Q_SLOTS")))) {
        const access = isAccess(last) ? last : (prev as "public" | "private" | "protected");
        stack[stack.length - 1] = { ...scope, access };
        head = [];
      } else if (scope !== undefined && scope.kind === "class" && (last === "signals" || last === "Q_SIGNALS" || last === "slots" || last === "Q_SLOTS")) {
        stack[stack.length - 1] = { ...scope, access: "public" };
        head = [];
      } else head.push(t);
      i++;
    } else if (s === "@" && (T[i + 1]?.s === "interface" || T[i + 1]?.s === "implementation" || T[i + 1]?.s === "protocol")) {
      head = []; // availability macros ahead of the `@interface` ran into it without a semicolon
      i = objcContainer(i);
    } else {
      head.push(t);
      i++;
    }
  }
  return out;
}

function scanCFamily(lines: readonly string[]): DeclaredSymbol[] {
  const view = analyzeCFamilySource(lines);
  const tokens = tokenize(view.code);
  // A served slice whose first code line is indented starts inside some scope (a function or class body): nothing is
  // declared at that level, so the leading part is skipped up to the brace that closes it.
  const first = view.code.find((l) => l.trim().length > 0);
  if (first !== undefined && /^\s/.test(first) && tokens.length > 0) tokens.unshift({ s: "{", line: 0 });
  const out = scanCDeclarations(tokens);
  for (const macro of view.macros) out.push(macro);
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function cappedLines(body: string): string[] {
  const lines = (body.length > MAX_DECL_CHARS_SCANNED ? body.slice(0, MAX_DECL_CHARS_SCANNED) : body).split(/\r?\n/);
  const limit = Math.min(lines.length, MAX_DECL_LINES_SCANNED);
  const out: string[] = new Array<string>(limit);
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    out[i] = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
  }
  return out;
}

export function declarationsIn(filePath: string, body: string): DeclaredSymbol[] {
  // The scan runs inside pack hooks: an unforeseen input must cost recall, never the response.
  try {
    return scanByExtension(filePath, body);
  } catch {
    return [];
  }
}

function scanByExtension(filePath: string, body: string): DeclaredSymbol[] {
  const ext = path.posix.extname(filePath.replace(/\\/g, "/")).toLowerCase();
  if (TSJS_EXTENSIONS.includes(ext)) {
    const lines = cappedLines(body);
    return scanTsJs(lines, maskSource(lines, SYN_TS), /\.d\.[cm]?ts$/i.test(filePath));
  }
  if (C_DECL_EXTENSIONS.has(ext)) return scanCFamily(cappedLines(body));
  if (ext === ".py") return scanPython(maskSource(cappedLines(body), SYN_PY));
  if (ext === ".go") return scanGo(maskSource(cappedLines(body), SYN_GO));
  if (ext === ".java") {
    const masked = maskSource(cappedLines(body), SYN_JAVA);
    return mergeLegacy(scanJava(masked), legacyJava(masked));
  }
  if (ext === ".kt" || ext === ".kts") return scanKotlin(maskSource(cappedLines(body), SYN_KOTLIN));
  return [];
}
