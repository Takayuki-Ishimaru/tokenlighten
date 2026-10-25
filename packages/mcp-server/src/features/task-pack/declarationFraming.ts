// declarationFraming.ts — a plain word the request FRAMES as a declaration it
// names: "the big Transport struct", "type Transport", "impl Decimal",
// "struct engine", "Transport 構造体". Pure, like requestFacets.ts.
//
// WHY. `explicitCodeIdentifiers` (readCodeTaskPack.ts) reads how a word is
// SPELLED: an underscore, a camelCase step, an inner capital, three capitals, a
// backtick. A Go, Rust or C type is very often one plain word — `Transport`,
// `Command`, `Server`, `Decimal`, `parser`, `state`, `engine` (18 of the 27
// map-sized types of the audited Go standard library) — which none of those
// rules admits, so the request "Explain what the big Transport struct in
// net/http/transport.go does" named no identifier at all: the first candidate was
// a test file that mentions the word, three round trips of its fragments, and no
// map. The same request with the word in backticks reaches the declaration in one
// (`answer-explicit-identifier-recovery`), because the backticks SAY it is code.
// A declaration-kind noun beside the word says the same thing.
//
// WHAT COUNTS. One word, framed by one of the nouns that name a declaration —
// struct, type, class, interface, enum, trait, impl (Japanese 型, 構造体, クラス,
// 列挙型, トレイト, インターフェース) — in a form prose rarely takes by accident:
//
//   noun first, the name capitalized   "type Transport", "struct Engine", "impl Decimal",
//                                      "impl<T> Wrapper<T>", "the class Order"
//   noun first, `struct` and a plain   "struct engine"        (C and Go write their types so)
//   lowercase name
//   name first, capitalized, inside a  "the big Transport struct", "the Order class" — never
//   sentence                           the first word of one ("Explain type inference",
//                                      "Describe class hierarchies" name a verb)
//   name first, a file reference       "the parser type (in parser.go)", "decoder struct in decode.go"
//   follows                            — the one form in which a lowercase name is safe
//   name then a Japanese noun          "Transport 構造体", "decoder 型", "Order クラス"
//
// WHAT DOES NOT: "this type of error", "a struct of arrays", "any type", "the
// type system", "the impl details", "struct tags", "型を変換", "Explain type
// inference", "the String type" — a determiner, preposition, auxiliary or
// question word, the name of a language or of a builtin type, another
// declaration noun, and the plain nouns that follow `struct` / `type` in prose
// (field, tag, layout, definition, parameter …) are never the name. A word the
// request frames is a CANDIDATE like the backticked one: it ranks and it owes
// evidence, and a framed word the workspace does not declare costs a `find`.

/** Words that are no declaration's name where a frame captures them, compared lower-case. */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  // Grammar: determiners, pronouns, prepositions, conjunctions, auxiliaries, question words.
  "a", "an", "the", "this", "that", "these", "those", "any", "each", "every", "some", "all", "both", "either", "neither",
  "another", "other", "such", "same", "one", "two", "no", "not", "its", "it", "our", "your", "their", "his", "her", "my",
  "we", "you", "they", "he", "she", "who", "whom", "whose", "which", "what", "when", "where", "why", "how", "whether",
  "if", "then", "than", "so", "as", "at", "by", "for", "from", "in", "into", "of", "on", "onto", "off", "over", "under",
  "with", "within", "without", "about", "around", "between", "through", "via", "per", "to", "up", "down", "out",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "has", "have", "had", "can",
  "could", "may", "might", "must", "shall", "should", "will", "would", "and", "or", "but", "nor", "yet", "also", "only",
  "just", "even", "still", "more", "most", "less", "least", "very", "too", "please", "there", "here",
  // Adjectives and modifiers that stand before a noun in prose.
  "new", "old", "own", "big", "large", "small", "little", "main", "basic", "core", "base", "general", "generic",
  "common", "simple", "plain", "custom", "default", "public", "private", "protected", "static", "final", "abstract",
  "sealed", "internal", "external", "inner", "outer", "nested", "local", "global", "whole", "entire", "given", "named",
  "following", "above", "below", "related", "relevant", "specific", "particular", "existing", "current", "original",
  "first", "last", "next", "previous", "single", "multiple", "parent", "child", "sub", "super", "root", "top",
  // Declaration nouns, whatever the other side of the frame is.
  "struct", "structs", "type", "types", "class", "classes", "interface", "interfaces", "enum", "enums", "trait", "traits",
  "impl", "record", "records", "object", "objects", "union", "alias", "module", "modules", "package", "namespace",
  "function", "functions", "method", "methods", "constructor", "pointer", "pointers", "reference", "references",
  // The plain nouns that follow `struct` / `type` / `class` in prose.
  "field", "fields", "tag", "tags", "literal", "literals", "layout", "embedding", "definition", "definitions",
  "declaration", "declarations", "member", "members", "name", "names", "value", "values", "instance", "instances",
  "parameter", "parameters", "argument", "arguments", "receiver", "receivers", "hierarchy", "hierarchies", "diagram",
  "system", "systems", "safety", "inference", "checking", "check", "conversion", "conversions", "cast", "casts",
  "annotation", "annotations", "signature", "signatures", "size", "sizes", "alignment", "padding", "initialization",
  "initialisation", "init", "comparison", "equality", "copy", "copies", "update", "updates", "change", "changes",
  "details", "detail", "design", "model", "models", "usage", "example", "examples", "code", "text", "data", "file",
  "files", "line", "lines", "logic", "part", "section", "bug", "bugs", "issue", "issues", "user", "users",
  // Imperatives and verbs that open a request or follow a determiner.
  "explain", "describe", "show", "list", "summarize", "summarise", "review", "find", "read", "check", "trace", "walk",
  "document", "outline", "analyze", "analyse", "inspect", "compare", "map", "give", "tell", "look", "see", "use", "uses",
  "using", "used", "make", "makes", "made", "get", "gets", "set", "sets", "run", "runs", "call", "calls", "called",
  "handle", "handles", "define", "defines", "defined", "declare", "declares", "declared", "implement", "implements",
  "implemented", "return", "returns", "returned", "create", "creates", "created", "build", "builds", "built", "need",
  "needs", "want", "wants", "write", "writes", "wrote", "fix", "fixes", "add", "adds", "remove", "removes",
  "explains", "describes", "shows", "lists", "summarizes", "summarises", "reviews", "finds", "reads", "checks", "traces",
  "documents", "outlines", "analyzes", "analyses", "inspects", "compares", "maps", "gives", "tells", "looks",
  // More modifiers that stand between a determiner and a declaration noun.
  "exported", "unexported", "anonymous", "embedded", "opaque", "concrete", "underlying", "primary", "central", "key",
  "important", "interesting", "actual", "real", "full", "complete", "usual", "typical", "special", "separate",
  // Languages and file formats: "a Go struct", "a Rust trait", "the Java class", "JSON 型".
  "go", "golang", "rust", "java", "python", "c", "cpp", "csharp", "kotlin", "swift", "ruby", "php", "scala", "typescript",
  "javascript", "ts", "js", "es5", "es6", "dart", "lua", "perl", "haskell", "sql", "json", "xml", "yaml", "html", "css",
  "http", "https", "grpc", "rest", "api", "sdk", "cli", "gui", "ui",
  // Builtin and library type names that no workspace declares: "the String type", "an Option type".
  "string", "str", "int", "integer", "uint", "long", "short", "byte", "bytes", "char", "rune", "float", "double",
  "number", "bool", "boolean", "array", "tuple", "vec", "slice", "date", "time", "void", "null", "nil", "none",
  "unknown", "never", "symbol", "bigint", "error", "errors", "exception", "exceptions", "result", "option", "optional",
  "self", "map", "dict", "hash", "queue", "stack", "buffer",
]);

/** A name needs at least this many characters (`T`, `K`, `x` are type parameters and loop variables). */
const MIN_NAME_LENGTH = 2;

/** The nouns of a frame, English. `impl` is Rust's alone: a name FOLLOWS it. */
const NOUNS_EN = "struct|type|class|interface|enum|trait";

/** Not part of a longer word, a path, a member access or a quoted span's inside. */
const BEFORE = "(?<![\\w$./`-])";

// Noun first, the name capitalized: "type Transport", "impl<T> Wrapper<T>", "the class Order".
const NOUN_THEN_CAPITALIZED_RE = new RegExp(`${BEFORE}(?:(?:${NOUNS_EN})[ \\t]+|impl[ \\t]*(?:<[^<>\\n]*>[ \\t]*)?)\`?([A-Z][A-Za-z0-9_]*)\`?(?![\\w$])`, "gu");
// `struct` and a plain lowercase name: "struct engine" (a C or Go type).
const STRUCT_THEN_LOWERCASE_RE = new RegExp(`${BEFORE}struct[ \\t]+\`?([a-z_][a-z0-9_]*)\`?(?![\\w$])`, "gu");
// Name first, capitalized: "the big Transport struct", "the Order class".
const CAPITALIZED_THEN_NOUN_RE = new RegExp(`${BEFORE}\`?([A-Z][A-Za-z0-9_]*)\`?[ \\t]+(?:${NOUNS_EN})(?![\\w$])`, "gu");
// Name first, a file reference after the noun: "the parser type (in parser.go)", "decoder struct in decode.go".
const NAME_NOUN_IN_FILE_RE = new RegExp(`${BEFORE}\`?([A-Za-z_][A-Za-z0-9_]*)\`?[ \\t]+(?:${NOUNS_EN})(?![\\w$])[ \\t(,]*(?:in|from|inside|within|of)[ \\t]+\`?(?:\\.{0,2}\\/)?(?:[\\w.-]+\\/)*[\\w-]+\\.[A-Za-z][A-Za-z0-9]{0,5}\`?(?![\\w/])`, "gu");
// Name then a Japanese declaration noun: "Transport 構造体", "decoder 型", "Order クラス". `型` is not the head of a
// compound ("型タスク", "型引数", "型エラー": "answer 型タスク" is an answer-type task) and `クラス` is not "クラスタ".
const NAME_THEN_JA_NOUN_RE = new RegExp(`${BEFORE}\`?([A-Za-z_][A-Za-z0-9_]*)\`?[ \\t]*(?:列挙型|構造体|トレイト|インターフェース|インタフェース|クラス(?!タ)|型(?![ァ-ヶー一-龠々]))`, "gu");
/** A ticket or task id ("T13", "W1", "T05c"): Japanese prose says "T13 型のタスク" for a kind of task. */
const TASK_ID_RE = /^[A-Za-z]{1,2}\d+[a-z]?$/u;

/**
 * True when the word at `index` of `text` opens a sentence or a line: nothing
 * but a bullet, a number, a quote or a bracket before it on its line, or a
 * sentence end (`. ! ? : ;`, their Japanese forms) right before it.
 */
function opensSentence(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (/^[\s>*\-•#\d.)(「『"'[\]]*$/u.test(prefix)) return true;
  return /[.!?:;。！？：；]$/u.test(prefix.trimEnd());
}

/**
 * True when the word right before `index` (on its line) is a word that could be
 * the NAME of the noun at `index`: "the Transport struct dials" is the Transport
 * struct, not a struct called `dials`; "the big struct engine" and "of struct
 * engine" have a modifier or a preposition there and name `engine`.
 */
function nounHasAName(text: string, index: number): boolean {
  const word = /([A-Za-z_][A-Za-z0-9_]*)[ \t]+$/u.exec(text.slice(Math.max(0, index - 80), index))?.[1];
  return word !== undefined && !NOT_A_NAME.has(word.toLowerCase());
}

/** The frames, and whether the NAME comes first in them (only then can it be the first word of a sentence). */
const FRAMES: ReadonlyArray<{ readonly pattern: RegExp; readonly nameFirst: boolean }> = [
  { pattern: NOUN_THEN_CAPITALIZED_RE, nameFirst: false },
  { pattern: STRUCT_THEN_LOWERCASE_RE, nameFirst: false },
  { pattern: CAPITALIZED_THEN_NOUN_RE, nameFirst: true },
  { pattern: NAME_NOUN_IN_FILE_RE, nameFirst: true },
  { pattern: NAME_THEN_JA_NOUN_RE, nameFirst: true },
];

/**
 * The words `text` frames as the declarations it names (see the module doc), in
 * order of first appearance and without repeats (case-insensitive), spelled as
 * the request spells them. `text` is the request with its citation and
 * evaluation-input spans masked and its path spans INTACT (a file reference is
 * part of one form); a word inside a path or a backtick span is never framed
 * from the inside.
 *
 * A capitalized name that opens its sentence is never taken from a name-first
 * frame ("Explain type inference", "Describe class hierarchies": a verb), except
 * before a Japanese noun, which no verb of English precedes.
 */
export function declarationFramedNames(text: string): string[] {
  const found: Array<{ readonly name: string; readonly index: number }> = [];
  for (const { pattern, nameFirst } of FRAMES) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]!;
      const index = (match.index ?? 0) + match[0].indexOf(name);
      if (nameFirst && pattern !== NAME_THEN_JA_NOUN_RE && /^[A-Z]/u.test(name) && opensSentence(text, index)) continue;
      // A noun-first frame is the noun's own only when no name stands before the noun.
      if (!nameFirst && nounHasAName(text, match.index ?? 0)) continue;
      found.push({ name, index });
    }
  }
  found.sort((left, right) => left.index - right.index);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { name } of found) {
    const key = name.toLowerCase();
    if (name.length < MIN_NAME_LENGTH || seen.has(key) || NOT_A_NAME.has(key) || TASK_ID_RE.test(name)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
