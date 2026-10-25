// structureMapMembers.ts — OUT-OF-LINE MEMBERS for the structure map
// (TL_EFF_STRUCTURE_MAP, structureMap.ts): which callables belong to a type
// whose members are NOT declared inside the type's own range. Pure and fs-free,
// like structureMap.ts, which calls it; the parser (symbols/collectSymbols.ts)
// is read as it is and never changed — its known quirks are absorbed here.
//
// WHY. `structureMapTypeOf` took a member to be a callable whose
// `enclosingSymbol` is the type: a Java/TypeScript/Python/C#/Kotlin member, or a
// C++ method defined in the class body. Four layouts put a type's members
// elsewhere, and every one of them gave a type with "no members", so a large
// Go, Rust, C or C++ type was never mapped (the generality audit, 2026-10-24;
// design: bench/workflows/experiments/2026-10-21-codex-copilot-proxy/drafts/
// fable-analysis-r16/out-of-line-maps-design.md):
//
//   Go     `func (t *Transport) roundTrip(…)` — a top-level `method` symbol
//          with no enclosing symbol, named by the method alone; the receiver
//          type exists only in the signature line. The type's own doc comment
//          and its methods' are `//` runs, which the parser does not attach.
//   Rust   `impl Decimal { fn new(…) }`, `impl fmt::Display for Decimal { … }` —
//          an `impl` block is no symbol (it is walked through), so its `fn`s are
//          top-level `function`s; the owner is in the block's header.
//   C      `static int sched_pick(struct sched_s *s)` — a free function; a
//          signature line that mentions `struct X` is NAMED `X` by the parser
//          (17 of 384 functions of the audited firmware), and `struct X *p;`
//          anywhere is a one-line `class` symbol of its own.
//   C++    `void EKF::reset() { … }` — a top-level `function` named `EKF::reset`
//          (one qualifier level; `ns::W::run` with an Allman brace and `operator`
//          definitions are no symbol at all and are simply not members). The
//          parser sees a function by its return type: a constructor or destructor
//          is a symbol only when its body is on its signature's line, so those
//          whose body begins below (`W::W(int a)\n    : a_(a)\n{ … }` — nearly
//          every constructor with an initialiser list) are read from the text.
//
// WHAT A MEMBER IS HERE (one rule per language, all lexical, none a guess about
// anything but the signature text):
//
//   Go     a `method` whose receiver is `T` / `*T` (generic `T[K, V]` too); the
//          constructors are the `New…` / `new…` functions whose RESULT contains
//          `T` — never "any function returning a T" (`readRequest`, `parse…`).
//          A `type T interface` is never mapped: its methods are specs, not code.
//   Rust   a `fn` inside an `impl T { … }` / `impl Trait for T { … }` block of
//          the same file (generics, `where` clauses and paths read through; a
//          `&T`, `Box<T>`, tuple or `dyn` target belongs to nobody), outside a
//          `#[cfg(test)]` module; `new` is the constructor.
//   C      a function of the same file whose FIRST parameter is a pointer to the
//          struct (`struct T *`, `T *`, `T_t *`, `const T *`, `_t` / `_s`
//          read as one name), with its name re-derived from the signature text.
//          "The file is the module" is NOT a type here (no `struct`, nothing for
//          the request to name) and neither is `typedef struct { … } T_t;`
//          (the parser gives it no symbol, so the locator cannot reach it).
//   C++    a function named `T::m` of the same file; `T::T` is the constructor,
//          `T::~T` a member like any other.
//
// BESIDE THE MEMBERS the attribution returns where the declaration ends (the
// header of the map ends there, however far the members run), where its doc
// comment starts (Go's `//` run), and — for Rust — the lines that open the `impl`
// blocks the members are in (`containerHeaders`): a map that lists `fn fmt` twice
// must say which `impl` each is, and the line that names the type there is a
// mention nothing else in the map serves.
//
// WHAT IT DOES NOT DO. The members of one file only. Counterpart files — the
// `.cpp` of a `.hpp` class, the other files of a Go package, the `impl` blocks
// of another Rust module — are STAGE 2 of the design (a map over several
// paths); `cppOutOfLineMembers`' `source` parameter is the seam where a member
// file's own symbols and lines go, and the callers disclose what they leave out
// (structureMapElsewhere.ts) instead.

import { maskCommentsAndStrings } from "./sfCodeMask.js";
import type { StructureMapMember, StructureMapSpan, StructureMapSymbol, StructureMapType } from "./structureMap.js";

/** The languages whose types can have members outside their own range. */
export const OUT_OF_LINE_LANGUAGES: ReadonlySet<string> = new Set(["go", "rust", "c", "cpp"]);

/** What `outOfLineMembersOf` attributes to one type. */
export interface OutOfLineAttribution {
  /** The members declared outside the type's own range, in source order (`outOfLine: true`). */
  readonly members: StructureMapMember[];
  /** The last line of the declaration itself: the header ends here. */
  readonly declarationEnd: number;
  /** The first line of the declaration's own doc comment (Go's `//` run included). */
  readonly docStart: number;
  /**
   * The lines that OPEN the blocks the members are in — a Rust `impl Trait for T {`
   * (header through `{`), one per block of the type, empty ones (`impl Send for T {}`)
   * included. Without them a member's signature does not say whose it is (the `fmt` of
   * `impl Display` and of `impl Debug` are two stubs of the same name), and the line
   * that names the type is a mention nothing in the map serves. Absent where members
   * are not in blocks (Go, C, C++).
   */
  readonly containerHeaders?: StructureMapSpan[];
}

/**
 * A `//` doc run is attached at most this long (the structure map's own
 * STRUCTURE_MAP_DOC_MAX_LINES; imported, it would make this module and
 * structureMap.ts cyclic — structureMapOutOfLine.spec.ts pins the two equal),
 * whole or not at all: a longer run is a file preamble, not the declaration's
 * doc (collectSymbols.ts MAX_DOC_COMMENT_LINES makes the same call).
 */
const DOC_RUN_MAX_LINES = 60;

const unqualified = (name: string): string => {
  const parts = name.split(/::|\.|#/u);
  return parts[parts.length - 1] ?? name;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** True when `symbol` sits outside every type (the parser gave it no enclosing symbol): a Go method, a Rust `impl` fn, a C function, a C++ out-of-line definition. */
const isTopLevel = (symbol: StructureMapSymbol): boolean => symbol.enclosingSymbol === undefined;

/** The lines `[from, to]` of `lines` joined with spaces (a signature as one text). */
function textOf(lines: readonly string[], from: number, to: number): string {
  return lines.slice(from - 1, to).join(" ");
}

/** The index just past the bracket that closes the one at `open` in `text`, or -1. `->` and `=>` are no angle bracket. */
function closingIndex(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : opener === "<" ? ">" : opener === "{" ? "}" : undefined;
  if (closer === undefined) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (opener === "<" && ch === ">" && (text[i - 1] === "-" || text[i - 1] === "=")) continue;
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The type itself
// ---------------------------------------------------------------------------

/** A C/C++ symbol that DEFINES a type: more than one line, or a body on its first line (`struct X *p;` and `class X;` are references). */
function definesType(symbol: StructureMapSymbol, lines: readonly string[]): boolean {
  if (symbol.endLine > symbol.startLine) return true;
  return (lines[symbol.signatureStartLine - 1] ?? "").includes("{");
}

/**
 * The symbol that is `type` among the same-name type-kind `candidates`
 * overlapping the located range: the one spanning the most lines, the first of
 * equals — and, in C and C++, only a definition (a `struct X *next;` field and
 * a `class X;` forward declaration are one-line symbols named like the type).
 */
export function pickStructureMapType(
  lang: string,
  candidates: readonly StructureMapSymbol[],
  lines: readonly string[],
): StructureMapSymbol | undefined {
  let best: StructureMapSymbol | undefined;
  for (const candidate of candidates) {
    if ((lang === "c" || lang === "cpp") && !definesType(candidate, lines)) continue;
    if (best === undefined || candidate.endLine - candidate.startLine > best.endLine - best.startLine) best = candidate;
  }
  return best;
}

/** True when a type-kind symbol inside a C/C++ type is a one-line REFERENCE (`struct other *p;`), not a nested definition: such a symbol is no member. */
export function isTypeReference(lang: string, symbol: StructureMapSymbol, lines: readonly string[]): boolean {
  return (lang === "c" || lang === "cpp") && !definesType(symbol, lines);
}

/**
 * `signatureEnd`, moved to the line of a lone `{` right below it (the Allman
 * and GNU layouts of C and C++): the lexical body reader (memberRows.ts
 * `scanBraces`) takes a body to start AFTER the signature, so a `{` of its own
 * on the first body line reads as an inner block and the member's closing brace
 * never closes the body — 205 of the 380 multi-line function bodies of the
 * audited C firmware (fx-aeroctl) and 68 of the 85 unreadable C++ ones (18 of the
 * 19 out-of-line `T::m` definitions) were "unreadable" for that reason alone, all
 * Allman or GNU style; one C body stays unreadable once the brace is in the
 * signature. `signatureEnd` when the next line is no lone brace.
 */
export function allmanSignatureEnd(lines: readonly string[], signatureEnd: number, end: number): number {
  const next = signatureEnd + 1;
  if (next > end) return signatureEnd;
  return /^\s*\{\s*$/u.test(maskCommentsAndStrings(lines[next - 1] ?? "")) ? next : signatureEnd;
}

// ---------------------------------------------------------------------------
// Members: the shape every attribution builds
// ---------------------------------------------------------------------------

interface MemberInput {
  readonly name: string;
  readonly start: number;
  readonly symbol: StructureMapSymbol;
  readonly constructor: boolean;
  readonly receiver?: string;
  readonly signatureEnd?: number;
}

function memberOf(input: MemberInput): StructureMapMember {
  const { symbol } = input;
  return {
    name: input.name,
    start: Math.min(input.start, symbol.startLine),
    end: symbol.endLine,
    signatureStart: Math.max(symbol.startLine, symbol.signatureStartLine),
    signatureEnd: input.signatureEnd ?? Math.min(symbol.endLine, Math.max(symbol.signatureStartLine, symbol.signatureEndLine)),
    nestedType: false,
    constructor: input.constructor,
    outOfLine: true,
    ...(input.receiver !== undefined ? { receiver: input.receiver } : {}),
  };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * `// …` lines directly above `startLine`, as the first line of the run (or
 * `startLine` itself when there is none). A blank line ends the run, a `//go:`
 * directive (`//go:generate`, `//go:noinline`, `//go:build`) is never part of
 * it, and a run over DOC_RUN_MAX_LINES is not a doc comment. The parser attaches
 * `///`, javadoc-style and `#` runs; a Go declaration's doc is `//`, and it is
 * attached to NONE of them (24 of the 27 map-sized types of the audited
 * standard library have one, 466 of 785 methods).
 */
export function goDocStart(lines: readonly string[], startLine: number): number {
  let first = startLine;
  let count = 0;
  for (let index = startLine - 2; index >= 0; index -= 1) {
    const text = (lines[index] ?? "").trim();
    if (!text.startsWith("//") || text.startsWith("//go:")) break;
    first = index + 1;
    count += 1;
    if (count > DOC_RUN_MAX_LINES) return startLine;
  }
  return first;
}

/** `func (t *T) name(`: group 1 the receiver variable, 2 the star, 3 the receiver type, 4 the method name. A receiver may be unnamed, `_`, and generic (`*Cache[K, V]`). */
const GO_METHOD_RE = /^\s*func\s*\(\s*(?:([A-Za-z_]\w*)\s+)?(\*?)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*\(/u;

/** The receiver of the Go method whose signature is `signature`, or undefined for anything else. `variable` is absent for `_` and for an unnamed receiver. */
export function goMethodReceiver(signature: string): { readonly type: string; readonly variable?: string; readonly name: string } | undefined {
  const match = GO_METHOD_RE.exec(signature);
  if (match === null) return undefined;
  const variable = match[1];
  return { type: match[3]!, name: match[4]!, ...(variable !== undefined && variable !== "_" ? { variable } : {}) };
}

/** The result types of the Go function whose signature is `signature` (everything after the parameter list), or undefined when it does not read as `func name[…](…) result`. */
export function goResultText(signature: string): string | undefined {
  const head = /^\s*func\s+[A-Za-z_]\w*\s*/u.exec(signature);
  if (head === null) return undefined;
  let index = head[0].length;
  if (signature[index] === "[") {
    index = closingIndex(signature, index);
    if (index < 0) return undefined;
    while (/\s/u.test(signature[index] ?? "")) index += 1;
  }
  if (signature[index] !== "(") return undefined;
  index = closingIndex(signature, index);
  if (index < 0) return undefined;
  return signature.slice(index).replace(/\{\s*$/u, "").trim();
}

function goMembers(symbols: readonly StructureMapSymbol[], lines: readonly string[], type: StructureMapSymbol): OutOfLineAttribution | undefined {
  const typeName = unqualified(type.name);
  const declaration = textOf(lines, type.signatureStartLine, type.signatureEndLine);
  // A method of an interface is a spec inside the declaration, never code of its own.
  if (new RegExp(`^\\s*(?:type\\s+)?${escapeRegExp(typeName)}\\s*(?:\\[[^\\]]*\\])?\\s+interface\\b`, "u").test(declaration)) return undefined;
  const members: StructureMapMember[] = [];
  const mentionsType = new RegExp(`(?<![\\w.])${escapeRegExp(typeName)}(?![\\w])`, "u");
  for (const symbol of symbols) {
    if (!isTopLevel(symbol) || symbol === type) continue;
    if (symbol.kind !== "method" && symbol.kind !== "function") continue;
    const signature = textOf(lines, symbol.signatureStartLine, symbol.signatureEndLine);
    if (symbol.kind === "method") {
      const receiver = goMethodReceiver(maskCommentsAndStrings(signature));
      if (receiver === undefined || receiver.type !== typeName) continue;
      members.push(memberOf({
        name: receiver.name,
        start: goDocStart(lines, symbol.startLine),
        symbol,
        constructor: false,
        ...(receiver.variable !== undefined ? { receiver: receiver.variable } : {}),
      }));
      continue;
    }
    // A constructor: `New…` / `new…` whose result holds the type (`*T`, `(*T, error)`, `*T[K, V]`).
    if (!/^[Nn]ew/u.test(symbol.name)) continue;
    const result = goResultText(maskCommentsAndStrings(signature));
    if (result === undefined || !mentionsType.test(result)) continue;
    members.push(memberOf({ name: symbol.name, start: goDocStart(lines, symbol.startLine), symbol, constructor: true }));
  }
  return { members, declarationEnd: type.endLine, docStart: goDocStart(lines, type.startLine) };
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/** `text` with comments, string, raw-string and char literals blanked (newlines and offsets kept); a lifetime (`'a`) is left alone. Nested block comments are one comment. */
export function maskRustSource(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const identChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/u.test(ch);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth += 1; j += 2; }
        else if (text[j] === "*" && text[j + 1] === "/") { depth -= 1; j += 2; }
        else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (ch === "r" && (next === "\"" || next === "#") && !identChar(text[i - 1])) {
      let k = i + 1;
      while (text[k] === "#") k += 1;
      if (text[k] !== "\"") { i += 1; continue; }
      const closer = `"${"#".repeat(k - i - 1)}`;
      const end = text.indexOf(closer, k + 1);
      blank(k + 1, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + closer.length;
    } else if (ch === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (ch === "'") {
      if (next === "\\") {
        let j = i + 2;
        while (j < text.length && text[j] !== "'" && text[j] !== "\n") j += 1;
        if (text[j] === "'") { blank(i + 1, j); i = j + 1; continue; }
      } else if (text[i + 2] === "'" && next !== "'" && next !== "\n") {
        blank(i + 1, i + 2);
        i += 3;
        continue;
      }
      i += 1;
    } else i += 1;
  }
  return out.join("");
}

/** The index of the first `for` / `where` (`word`) of `text` outside every bracket pair, or -1. */
function topLevelWord(text: string, word: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    else if (ch === ">" && (text[i - 1] === "-" || text[i - 1] === "=")) continue;
    else if (ch === ">" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(word, i)
      && !/[A-Za-z0-9_]/u.test(text[i - 1] ?? " ") && !/[A-Za-z0-9_]/u.test(text[i + word.length] ?? " ")) return i;
  }
  return -1;
}

/**
 * The type an `impl` header is for: `impl Decimal`, `impl fmt::Display for
 * Decimal`, `impl<'a, T: Into<i64>> From<T> for Decimal<'a> where T: Copy`
 * are all `Decimal`. `header` is the text from `impl` up to its `{`. Undefined
 * for a target that is no plain path — `&T`, `[T]`, `(A, B)`, `dyn Tr`,
 * `*const T`, an `impl Trait` in a return type — which belongs to no map.
 */
export function rustImplTarget(header: string): string | undefined {
  let text = header.replace(/\s+/gu, " ").trim().replace(/^impl\b/u, "").trim();
  if (text.startsWith("<")) {
    const end = closingIndex(text, 0);
    if (end < 0) return undefined;
    text = text.slice(end).trim();
  }
  if (text.startsWith("!")) text = text.slice(1).trim();
  const forAt = topLevelWord(text, "for");
  let target = forAt >= 0 ? text.slice(forAt + 3).trim() : text;
  const whereAt = topLevelWord(target, "where");
  if (whereAt >= 0) target = target.slice(0, whereAt).trim();
  return /^(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*(?:<[\s\S]*>)?$/u.exec(target)?.[1];
}

/** One `impl` block of a Rust source: the type it is for and the lines of its braces. */
export interface RustImplBlock {
  readonly type: string;
  /** The line of the `impl` keyword. */
  readonly headerLine: number;
  readonly openLine: number;
  readonly closeLine: number;
}

const RUST_IMPL_START_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?(?:default\s+)?impl\b/u;
const RUST_IMPL_HEADER_MAX_CHARS = 1_000;

/**
 * Every `impl` block of `lines` (a Rust file) that is for a plain type path,
 * outside a `#[cfg(test)]` module, in source order. Lexical over the masked
 * text (`maskRustSource`): a header may span lines and carry generics, `where`
 * clauses and lifetimes; a block's range is its brace pair. A macro that
 * spells `impl $t { … }` has no type name and is skipped, and so is an `impl`
 * the header of which has no `{` before a `;`.
 */
export function rustImplBlocks(lines: readonly string[]): RustImplBlock[] {
  const masked = maskRustSource(lines.join("\n"));
  const maskedLines = masked.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < masked.length; i += 1) if (masked[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle]! <= index) low = middle; else high = middle - 1;
    }
    return low + 1;
  };
  // Every brace pair of the file, by one pass.
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const open = stack.pop();
      if (open !== undefined) closeOf.set(open, i);
    }
  }
  // #[cfg(test)] modules: an `impl` inside one is test scaffolding, not a member.
  const testModules: Array<[number, number]> = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    if (!/^\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/u.test(maskedLines[i]!)) continue;
    for (let j = i + 1; j < maskedLines.length && j <= i + 6; j += 1) {
      const text = maskedLines[j]!;
      if (/^\s*(?:#\s*\[|$)/u.test(text)) continue;
      if (/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*\{/u.test(text)) {
        const open = lineStarts[j]! + text.indexOf("{");
        const close = closeOf.get(open);
        if (close !== undefined) testModules.push([j + 1, lineOf(close)]);
      }
      break;
    }
  }
  const blocks: RustImplBlock[] = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    if (!RUST_IMPL_START_RE.test(maskedLines[i]!)) continue;
    const from = lineStarts[i]! + maskedLines[i]!.search(/\S/u);
    let open = -1;
    for (let k = from; k < masked.length && k < from + RUST_IMPL_HEADER_MAX_CHARS; k += 1) {
      const ch = masked[k];
      if (ch === ";") break;
      if (ch === "{") { open = k; break; }
    }
    if (open < 0) continue;
    const close = closeOf.get(open);
    if (close === undefined) continue;
    const type = rustImplTarget(masked.slice(from, open));
    if (type === undefined) continue;
    const headerLine = i + 1;
    if (testModules.some(([start, end]) => headerLine > start && headerLine < end)) continue;
    blocks.push({ type, headerLine, openLine: lineOf(open), closeLine: lineOf(close) });
  }
  return blocks;
}

function rustMembers(symbols: readonly StructureMapSymbol[], lines: readonly string[], type: StructureMapSymbol): OutOfLineAttribution | undefined {
  // A trait declares; only its impls carry code.
  if (type.kind === "interface") return undefined;
  const typeName = unqualified(type.name);
  const blocks = rustImplBlocks(lines).filter((block) => block.type === typeName);
  const members: StructureMapMember[] = [];
  if (blocks.length > 0) {
    for (const symbol of symbols) {
      if (!isTopLevel(symbol) || symbol === type || (symbol.kind !== "function" && symbol.kind !== "method")) continue;
      const inside = blocks.some((block) => symbol.signatureStartLine >= block.openLine && symbol.endLine <= block.closeLine);
      if (!inside) continue;
      members.push(memberOf({ name: unqualified(symbol.name), start: symbol.startLine, symbol, constructor: symbol.name === "new" }));
    }
  }
  return {
    members,
    declarationEnd: type.endLine,
    docStart: type.startLine,
    ...(blocks.length > 0 ? { containerHeaders: blocks.map((block) => ({ start: block.headerLine, end: block.openLine })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------

/** Words that precede a `(` without naming the function: control keywords and the attribute / alignment macros that wrap a parenthesised argument. */
const C_NOT_A_NAME: ReadonlySet<string> = new Set([
  "if", "while", "for", "switch", "return", "sizeof", "defined", "typeof", "__typeof__", "__attribute__", "__attribute",
  "__declspec", "__asm__", "__asm", "asm", "_Alignas", "alignas", "_Noreturn", "_Static_assert", "static_assert", "_Alignof", "alignof",
]);

/**
 * The name and the first parameter of the C function whose signature text is
 * `signature` (comments masked): the first `identifier (` that is not a keyword
 * or an attribute macro (whose parenthesised argument is stepped over), and the
 * parameter text up to the first top-level comma. The parser names a function
 * after the first `struct X` of its signature line (`static struct os_task_s
 * *tcb_alloc(void)` is "os_task_s"), so this is what names it here.
 */
export function cFunctionSignature(signature: string): { readonly name: string; readonly firstParameter: string | undefined } | undefined {
  const pattern = /([A-Za-z_]\w*)\s*\(/gu;
  for (let match = pattern.exec(signature); match !== null; match = pattern.exec(signature)) {
    const open = match.index + match[0].length - 1;
    const end = closingIndex(signature, open);
    if (end < 0) return undefined;
    if (C_NOT_A_NAME.has(match[1]!)) {
      pattern.lastIndex = end;
      continue;
    }
    const parameters = signature.slice(open + 1, end - 1);
    let depth = 0;
    let cut = parameters.length;
    for (let i = 0; i < parameters.length; i += 1) {
      const ch = parameters[i]!;
      if (ch === "(" || ch === "[" || ch === "<") depth += 1;
      else if (ch === ")" || ch === "]" || ch === ">") depth -= 1;
      else if (ch === "," && depth === 0) { cut = i; break; }
    }
    const first = parameters.slice(0, cut).trim();
    return { name: match[1]!, firstParameter: first === "" || first === "void" ? undefined : first };
  }
  return undefined;
}

/** `struct T *p`, `const T_t *restrict p`, `sched_t *` — the type name of a parameter that is a SINGLE pointer to a named type; undefined for a value, a double pointer or a compound type. */
const C_POINTER_PARAMETER_RE = /^\s*(?:(?:const|volatile|register|struct|union)\s+)*([A-Za-z_]\w*)\s*(?:(?:const|volatile|restrict|__restrict|__restrict__)\s+)*\*\s*(?:(?:const|volatile|restrict|__restrict|__restrict__)\s+)*(?:[A-Za-z_]\w*)?\s*(?:\[[^\]]*\])?\s*$/u;

/** A C type name with its `struct` / `_t` / `_s` dress off: `sched_s`, `sched_t` and `sched` are one name. */
const cBaseName = (name: string): string => name.replace(/^(?:struct|union)\s+/u, "").replace(/(?:_t|_s|_st|_struct)$/u, "");

export function cPointeeOf(parameter: string | undefined): string | undefined {
  if (parameter === undefined) return undefined;
  return C_POINTER_PARAMETER_RE.exec(parameter)?.[1];
}

function cMembers(symbols: readonly StructureMapSymbol[], lines: readonly string[], type: StructureMapSymbol): OutOfLineAttribution | undefined {
  const wanted = cBaseName(unqualified(type.name));
  const members: StructureMapMember[] = [];
  for (const symbol of symbols) {
    if (!isTopLevel(symbol) || symbol === type || symbol.kind !== "function") continue;
    const signature = cFunctionSignature(maskCommentsAndStrings(textOf(lines, symbol.signatureStartLine, symbol.signatureEndLine)).replace(/\s+/gu, " "));
    const pointee = cPointeeOf(signature?.firstParameter);
    if (signature === undefined || pointee === undefined || cBaseName(pointee) !== wanted) continue;
    members.push(memberOf({
      name: signature.name,
      start: symbol.startLine,
      symbol,
      constructor: false,
      signatureEnd: allmanSignatureEnd(lines, Math.min(symbol.endLine, Math.max(symbol.signatureStartLine, symbol.signatureEndLine)), symbol.endLine),
    }));
  }
  return { members, declarationEnd: type.endLine, docStart: type.startLine };
}

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

/**
 * The qualified name of the C++ function whose signature text is `signature`
 * (comments masked): the declarator-id in front of the FIRST `(` — `W::run`,
 * `W::~W`, `Foo<T>::bar`, `ns::W::run` — split into its owner (the last
 * qualifier, template arguments off) and its member. The parser names a
 * definition after at most one qualifier, a destructor by its bare class name
 * and a two-level qualifier with an Allman brace not at all, so the signature
 * text is what says whose it is. Undefined for a free function.
 */
export function cppQualifiedName(signature: string): { readonly owner: string; readonly qualifiedOwner: string; readonly globalQualification: boolean; readonly member: string } | undefined {
  const open = signature.indexOf("(");
  const declarator = (open < 0 ? signature : signature.slice(0, open)).trim();
  const match = /((?:::)?(?:[A-Za-z_]\w*\s*(?:<[^<>]*>)?\s*::\s*)+)(~?\s*[A-Za-z_]\w*|operator\s*[^\s(]+)\s*$/u.exec(declarator);
  if (match === null) return undefined;
  const rawPrefix = match[1]!;
  const marker = rawPrefix.startsWith("::") ? 0 : /\s::/u.exec(rawPrefix)?.index;
  const globalQualification = marker !== undefined;
  const qualifiedPrefix = marker === undefined
    ? rawPrefix
    : rawPrefix.startsWith("::") ? rawPrefix.slice(2) : rawPrefix.slice(marker + 1);
  const qualifiers = qualifiedPrefix.split("::").map((part) => part.replace(/<[^<>]*>/gu, "").trim()).filter((part) => part !== "");
  const owner = qualifiers[qualifiers.length - 1];
  return owner === undefined ? undefined : {
    owner,
    qualifiedOwner: qualifiers.join("::"),
    globalQualification,
    member: match[2]!.replace(/\s+/gu, ""),
  };
}

export interface CppNamespaceLocation { readonly line: number; readonly offset?: number }

/** Resolve many namespace locations with one masked-source scan. */
export function cppNamespacePathsAt(
  lines: readonly string[],
  locations: readonly CppNamespaceLocation[],
): Array<readonly string[] | undefined> {
  const source = maskCommentsAndStrings(lines.join("\n"));
  const lineStarts: number[] = [];
  let lineStart = 0;
  for (const line of lines) {
    lineStarts.push(lineStart);
    lineStart += line.length + 1;
  }
  const ordered = locations.map((location, index) => {
    const start = lineStarts[Math.max(0, Math.min(lineStarts.length - 1, location.line - 1))] ?? 0;
    const exactOffset = Number.isSafeInteger(location.offset) && location.offset! >= start;
    const offset = exactOffset ? Math.min(location.offset!, source.length) : start;
    return { index, offset, exactOffset };
  }).sort((left, right) => left.offset - right.offset || left.index - right.index);
  const stack: Array<string | undefined> = [];
  const answers: Array<readonly string[] | undefined> = Array(locations.length);
  let scan = 0;
  let prefixStart = 0;
  for (const request of ordered) {
    while (scan < request.offset) {
      const ch = source[scan];
      if (ch === "{") {
        const prefix = source.slice(prefixStart, scan);
        const namespace = /(?:^|\s)(?:inline\s+)?namespace(?:\s+((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*))?\s*$/u.exec(prefix);
        stack.push(namespace === null ? undefined : (namespace[1] ?? "").replace(/\s+/gu, ""));
        prefixStart = scan + 1;
      } else if (ch === "}" && stack.length > 0) {
        stack.pop();
        prefixStart = scan + 1;
      } else if (ch === ";") {
        prefixStart = scan + 1;
      }
      scan += 1;
    }
    if (!request.exactOffset || stack.some((entry) => entry === undefined)) {
      answers[request.index] = undefined;
      continue;
    }
    const namespaces = stack as string[];
    // Empty segments mark anonymous namespaces and must remain distinct from
    // the global scope (which is the empty array).
    answers[request.index] = namespaces.flatMap((entry) => entry === "" ? [""] : entry.split("::"));
  }
  return answers;
}

/** The namespace path lexically enclosing a parser offset. */
export function cppNamespacePathAt(lines: readonly string[], line: number, offset?: number): readonly string[] | undefined {
  return cppNamespacePathsAt(lines, [{ line, ...(offset === undefined ? {} : { offset }) }])[0];
}

/** C++ state inference accepts only a direct, unqualified field type in the mapped header. */
export function cppHeaderHasSafeUnqualifiedTypeReference(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  name: string,
): boolean {
  const source = maskCommentsAndStrings(lines.slice(startLine - 1, endLine).join("\n"));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (new RegExp(`\\busing\\s+${escaped}\\s*=|\\btypedef\\b[^;]*\\b${escaped}\\b`, "u").test(source)) return false;
  const fieldType = new RegExp(`(?<![A-Za-z0-9_:])${escaped}(?![A-Za-z0-9_:])\\s*(?:[*&]\\s*)*[A-Za-z_]\\w*\\s*(?:[;=,{])`, "u");
  return fieldType.test(source);
}

function sameCppNamespace(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function hasAnonymousNamespace(namespacePath: readonly string[]): boolean {
  return namespacePath.includes("");
}

function cppDefinitionTargetsType(
  qualified: { readonly qualifiedOwner: string; readonly globalQualification: boolean },
  sourceNamespace: readonly string[] | undefined,
  typeNamespace: readonly string[] | undefined,
  typeName: string,
): boolean {
  if (sourceNamespace === undefined || typeNamespace === undefined
    || hasAnonymousNamespace(sourceNamespace) || hasAnonymousNamespace(typeNamespace)) return false;
  const ownerPath = qualified.qualifiedOwner.split("::").filter((part) => part !== "");
  const targetPath = [...typeNamespace, typeName];
  if (qualified.globalQualification) return sameCppNamespace(ownerPath, targetPath);
  if (ownerPath.length === 1) return sameCppNamespace(sourceNamespace, typeNamespace);
  // A multi-part unrooted owner in a non-global scope depends on C++ name
  // lookup and can denote a nested or unrelated type. Only accept its
  // unambiguous workspace-root interpretation from global scope.
  return sourceNamespace.length === 0 && sameCppNamespace(ownerPath, targetPath);
}

/**
 * The functions of `source` that are definitions of `typeName`'s members
 * (`Owner::member`, `Owner::~Owner`), as members of the type — the out-of-line
 * definitions of a class. In Stage 1 `source` is the type's own file; STAGE 2
 * hands the counterpart file's symbols and lines here (the `.cpp` of a `.hpp`
 * class, found through `resolveImportsOf`'s counterpart edge) and stamps the
 * members with that file's path (`StructureMapMember.path`).
 */
export function cppOutOfLineMembers(
  typeName: string,
  source: { readonly symbols: readonly StructureMapSymbol[]; readonly lines: readonly string[] },
  options: { readonly path?: string; readonly namespacePath?: readonly string[]; readonly requireNamespaceMatch?: boolean } = {},
): StructureMapMember[] {
  const candidates: Array<{ readonly symbol: StructureMapSymbol; readonly qualified: NonNullable<ReturnType<typeof cppQualifiedName>> }> = [];
  for (const symbol of source.symbols) {
    // Namespace declarations are transparent owners for a free-standing
    // `Widget::member` definition. A class/function owner is not: accepting it
    // would confuse an in-class definition or a local callable with a separate
    // out-of-line member surface.
    const enclosingLine = symbol.enclosingSymbol === undefined
      ? undefined
      : source.lines[(symbol.enclosingSymbol.signatureStartLine ?? symbol.enclosingSymbol.startLine) - 1] ?? "";
    const enclosingNamespace = symbol.enclosingSymbol === undefined
      || /^\s*(?:inline\s+)?namespace(?:\s|\{|$)/u.test(maskCommentsAndStrings(enclosingLine ?? ""));
    if (!enclosingNamespace || symbol.kind !== "function") continue;
    const signature = maskCommentsAndStrings(textOf(source.lines, symbol.signatureStartLine, symbol.signatureEndLine)).replace(/\s+/gu, " ");
    const parts = symbol.name.split("::");
    const qualified = cppQualifiedName(signature)
      ?? (parts.length >= 2 ? {
        owner: parts[parts.length - 2]!,
        qualifiedOwner: parts.slice(0, -1).join("::"),
        globalQualification: false,
        member: parts[parts.length - 1]!,
      } : undefined);
    if (qualified !== undefined && qualified.owner === typeName) candidates.push({ symbol, qualified });
  }
  const candidateNamespaces = options.requireNamespaceMatch
    ? cppNamespacePathsAt(source.lines, candidates.map(({ symbol }) => ({
      line: symbol.signatureStartLine,
      ...(symbol.signatureStartIndex === undefined ? {} : { offset: symbol.signatureStartIndex }),
    })))
    : [];
  const members: StructureMapMember[] = [];
  for (const [index, { symbol, qualified }] of candidates.entries()) {
    if (options.requireNamespaceMatch && !cppDefinitionTargetsType(qualified, candidateNamespaces[index], options.namespacePath, typeName)) continue;
    members.push(memberOf({
      name: qualified.member,
      start: symbol.startLine,
      symbol,
      constructor: qualified.member === typeName,
      signatureEnd: allmanSignatureEnd(source.lines, Math.min(symbol.endLine, Math.max(symbol.signatureStartLine, symbol.signatureEndLine)), symbol.endLine),
    }));
  }
  const structors = cppStructorMembers(typeName, source);
  if (options.requireNamespaceMatch) {
    const structorNamespaces = cppNamespacePathsAt(source.lines, structors.map(({ signatureStartIndex, member }) => ({
      line: member.signatureStart,
      offset: signatureStartIndex,
    })));
    for (const [index, { member }] of structors.entries()) {
      const signature = maskCommentsAndStrings(textOf(source.lines, member.signatureStart, member.signatureEnd)).replace(/\s+/gu, " ");
      const qualified = cppQualifiedName(signature);
      if (qualified !== undefined && qualified.owner === typeName
        && cppDefinitionTargetsType(qualified, structorNamespaces[index], options.namespacePath, typeName)) members.push(member);
    }
  } else members.push(...structors.map(({ member }) => member));
  return members.map((member) => options.path === undefined ? member : { ...member, path: options.path }).sort((left, right) => left.start - right.start);
}

/** Symbol kinds that only wrap other definitions (a `namespace x { … }` block): a definition inside one is still at the top level. */
const CPP_TRANSPARENT_KINDS: ReadonlySet<string> = new Set(["namespace", "module"]);

/**
 * The `T::T(…)` and `T::~T()` definitions of `typeName` the parser gave no symbol
 * (see the header). Read from the comment- and string-masked text: a line that
 * opens with the qualified name and lies in no symbol, through the parameter list,
 * an optional `: member(init), other{init}` list (brace initialisers read through)
 * and the body's braces. A declaration (`;`), `= default` / `= delete` and a
 * function-try-block are no definition here. The signature runs to the line that
 * opens the body, so the initialiser list — what the constructor wires — is in it.
 */
function cppStructorMembers(
  typeName: string,
  source: { readonly symbols: readonly StructureMapSymbol[]; readonly lines: readonly string[] },
): Array<{ readonly member: StructureMapMember; readonly signatureStartIndex: number }> {
  const name = escapeRegExp(typeName);
  const opening = new RegExp(
    `(?:(?:inline|constexpr|explicit)\\s+)*(?:[A-Za-z_]\\w*\\s*(?:<[^<>]*>)?\\s*::\\s*)*${name}\\s*(?:<[^<>]*>)?\\s*::\\s*(~?)\\s*${name}\\s*\\(`,
    "gu",
  );
  const masked = maskCommentsAndStrings(source.lines.join("\n"));
  const maskedLines = masked.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const text of maskedLines) {
    lineStarts.push(offset);
    offset += text.length + 1;
  }
  const lineAt = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const skipSpace = (from: number): number => {
    let at = from;
    while (at < masked.length && /\s/u.test(masked[at]!)) at += 1;
    return at;
  };
  const found: Array<{ readonly member: StructureMapMember; readonly signatureStartIndex: number }> = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const text = maskedLines[index]!;
    if (!text.includes("::")) continue;
    opening.lastIndex = 0;
    for (const match of text.matchAll(opening)) {
    const line = index + 1;
    const signatureStartIndex = lineStarts[index]! + match.index;
    if (source.symbols.some((symbol) => !CPP_TRANSPARENT_KINDS.has(symbol.kind)
      && symbol.startLine <= line && line <= symbol.endLine
      && (symbol.signatureStartIndex === undefined || symbol.signatureStartIndex <= signatureStartIndex))) continue;
    const parameters = closingIndex(masked, signatureStartIndex + match[0].length - 1);
    if (parameters < 0) continue;
    let at = skipSpace(parameters);
    for (const qualifier = /^(?:noexcept|throw)\b\s*/u; ;) {
      const word = qualifier.exec(masked.slice(at, at + 16));
      if (word === null) break;
      at = skipSpace(at + word[0].length);
      if (masked[at] === "(") {
        const past = closingIndex(masked, at);
        if (past < 0) break;
        at = skipSpace(past);
      }
    }
    let bodyOpen = -1;
    if (masked[at] === "{") bodyOpen = at;
    else if (masked[at] === ":" && masked[at + 1] !== ":") {
      let item = at + 1;
      for (;;) {
        let group = item;
        while (group < masked.length && masked[group] !== "(" && masked[group] !== "{" && masked[group] !== ";") group += 1;
        if (masked[group] !== "(" && masked[group] !== "{") break;
        const past = closingIndex(masked, group);
        if (past < 0) break;
        let next = skipSpace(past);
        while (masked[next] === ".") next += 1;
        next = skipSpace(next);
        if (masked[next] === ",") {
          item = next + 1;
          continue;
        }
        if (masked[next] === "{") bodyOpen = next;
        break;
      }
    }
    if (bodyOpen < 0) continue;
    const bodyEnd = closingIndex(masked, bodyOpen);
    if (bodyEnd < 0) continue;
    const signatureEnd = lineAt(bodyOpen);
    const member = memberOf({
      name: `${match[1]}${typeName}`,
      start: line,
      symbol: {
        name: `${typeName}::${match[1]}${typeName}`,
        kind: "function",
        startLine: line,
        endLine: lineAt(bodyEnd - 1),
        signatureStartLine: line,
        signatureEndLine: signatureEnd,
      },
      constructor: match[1] === "",
      signatureEnd,
    });
    found.push({ member, signatureStartIndex });
    }
  }
  return found;
}

function cppMembers(symbols: readonly StructureMapSymbol[], lines: readonly string[], type: StructureMapSymbol): OutOfLineAttribution | undefined {
  return {
    members: cppOutOfLineMembers(unqualified(type.name), { symbols, lines }),
    declarationEnd: type.endLine,
    docStart: type.startLine,
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * The members of `type` that live outside its own range, and where its
 * declaration ends and its doc comment begins — or undefined when the type
 * takes no map in `lang` (a Go interface, a Rust trait). `symbols` are the file's
 * symbols and `lines` its lines; `lang` is one of OUT_OF_LINE_LANGUAGES.
 */
export function outOfLineMembersOf(
  lang: string,
  symbols: readonly StructureMapSymbol[],
  lines: readonly string[],
  type: StructureMapSymbol,
): OutOfLineAttribution | undefined {
  switch (lang) {
    case "go": return goMembers(symbols, lines, type);
    case "rust": return rustMembers(symbols, lines, type);
    case "c": return cMembers(symbols, lines, type);
    case "cpp": return cppMembers(symbols, lines, type);
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Geometry: what lines are the type's own
// ---------------------------------------------------------------------------

/**
 * The lines that are the type's own: its declaration (with its doc comment) and
 * each member, merged. A type whose members are all inside it owns its whole
 * range (Java: one span, `[start, end]`); a Go type's methods and the code of
 * other types between them are told apart here.
 */
export function ownRegionsOf(type: StructureMapType): StructureMapSpan[] {
  if (type.members.every((member) => member.outOfLine !== true)) return [{ start: type.start, end: type.end }];
  const spans: StructureMapSpan[] = [
    { start: type.docStart ?? type.start, end: type.declarationEnd ?? type.end },
    ...(type.containerHeaders ?? []),
    ...type.members.map((member) => ({ start: member.start, end: member.end })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: StructureMapSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * The test `coalesceAnswerRows` asks before it carries the lines between two
 * rows along: true when no line of `[start, end]` is code of something that is
 * not the type — every non-blank line is in a region the type owns. Undefined
 * for a type with no out-of-line member (the extent is all its own: nothing to
 * keep out, and the rows of every Java map coalesce as they always did).
 */
export function ownLinesBridge(type: StructureMapType, lines: readonly string[]): ((start: number, end: number) => boolean) | undefined {
  if (type.members.every((member) => member.outOfLine !== true)) return undefined;
  const regions = ownRegionsOf(type);
  return (start, end) => {
    for (let line = start; line <= end; line += 1) {
      if ((lines[line - 1] ?? "").trim() === "") continue;
      if (!regions.some((region) => region.start <= line && line <= region.end)) return false;
    }
    return true;
  };
}
