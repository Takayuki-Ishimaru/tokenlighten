/**
 * frontierNeighbours.ts — V15-NBR (2026-09-29), `TL_NEIGHBOUR_INDEX`, default
 * OFF. One of two independent v0.15.0 candidate prototypes prepared for a
 * small paid A/B engagement probe (measure-v015/REPORT.md's "Extra finding";
 * ideation-v015-fable.md candidate 5) — the USER decides adoption from the
 * probe, not this wave.
 *
 * MEASUREMENT THIS ANSWERS. Of the largest waste class in the 09-20 Claude
 * Code bench (5.1 reads/cell of a file the first pack never named), 61% read
 * a file whose basename stem was already MENTIONED in the served pack's
 * bodies (measure-v015/neighbours.py, a read-only classification of 17 real
 * solver transcripts) — an import/include the model could have batched into
 * one turn had the pack named it. Upper bound ~3 reads/cell (~10% of cell
 * cost) IF the model batches; this ships OFF because that "if" is model
 * behaviour a replay cannot observe (see brief-v15-probe.md).
 *
 * WHAT THIS ADDS. `attachFrontierNeighbourIndex` appends up to 8 BODYLESS
 * rows (`result.neighbours`, wired onto `plan.neighbours` by
 * readFamily.ts's PLAN_MEMBERS) for workspace files a served surface's file
 * imports/includes and this response has not already served — `path`, a
 * minted `handle` (so a batched `tl_read_file {targets:[{handle},…]}` call can
 * fetch them in one turn), and a short `why` provenance string. Capped at
 * ~1 KiB, RANKED best-first. These rows are NEVER evidence: nothing in this
 * module touches `result.surfaces`, `result.missing`, `result.route`, or any
 * certificate/obligation, and nothing here is booked as served (contrast with
 * `frontier_index`'s "import-neighbor" rows, a DIFFERENT, SF-owned
 * complete-working-set claim this module does not touch or extend; a path
 * that `frontier_index` / `served_earlier` already names is never repeated).
 *
 * IMPORTS COME FROM THE WHOLE FILE. Each served surface's imports are read
 * from its FULL file (capped at 1 MiB), never from the served slice: a pack
 * that served one function still has the file's import head, and the `line`
 * in `imported by <path>:<line>` is a real line of that file. The served
 * slice (`surface.code`, or the file's `range` when the pack only says
 * `code_unchanged`) feeds exactly one signal, "use" below. Edge resolution
 * (which import names which workspace file) is import-resolution work
 * (importResolution.ts and the per-family importResolve*.ts / cIncludes.ts
 * modules); this module only ranks what they return.
 *
 * RANKING (deterministic; every weight is in `NEIGHBOUR_WEIGHTS`). Candidates
 * are all edges of all served surfaces (the first 8), minus paths the model
 * already holds, merged by path keeping the best-scoring provenance:
 *
 *   score = relevance + use + relation + importer − penalty
 *
 *   relevance (a, strongest, ≤ 24) — the request against the candidate:
 *     +12  the query names the candidate's file (`priceUtil.ts`, `a/b/x.py`);
 *     +10 / +8  an explicit identifier the query names (`explicitIdentifiersIn`)
 *           equals a name the import binds (exact case / any case);
 *     + 9 / +7  … equals a symbol the candidate itself declares
 *           (`declarationsIn`, read only for the ~24 best candidates by the
 *           cheaper signals, ≤ 256 KiB per file);
 *     + 7  … equals the candidate's file stem (or its directory for
 *           `index`/`__init__`/`mod`), ignoring case and separators;
 *     + 3 / 2 / 3  per distinct concept term (`conceptTermsIn`: EN stems and
 *           JA glossary stems, plus the sub-words of the explicit
 *           identifiers, plus katakana loanwords when the JA bridge's
 *           vocabulary is ALREADY cached for this pack) equal to a sub-word of
 *           a bound name / a declared symbol / the path BELOW the project
 *           root (`projectRootsOf`); at most three terms count (≤ 9), so one
 *           weak match never beats a used import (+5) but two do. A term
 *           that matches more than half of ≥ 6 candidates discriminates
 *           nothing and is ignored, and so is a term that names the
 *           importer's OWN project (a sub-word of its project root's
 *           directory name or of its manifest's package/module name —
 *           `projectNameTermsOf`): "libfoo" tells nothing inside libfoo, and
 *           is never a row's `(matches …)` label. The explicit identifiers
 *           include the member of every qualified `A.b` / `A::b` / `A#b` the
 *           query names.
 *   use (b, ≤ 7) — +5 when a name the import binds occurs as a whole word in
 *     the importer's served slice OUTSIDE its import statements (+1 per extra
 *     name, ≤ +2). An edge that binds nothing (`#include`, a counterpart,
 *     `import "./x"`) uses the candidate's declared symbols instead.
 *   relation (d) — +5 for a `counterpart` of the FIRST served surface (it
 *     ranks with used imports), +2 for a counterpart of a later one.
 *   importer (c) — +3 for the first (focal) served surface, +1 for the second.
 *   penalty — −10 for a test file (unless the importer is a test or the query
 *     mentions tests), a vendored/third-party directory, or a generated file.
 *
 *   Ties break on importer order, edge line, then path.
 *
 * SELECTION (precision over recall). Only candidates with a signal (relevance,
 * use or counterpart) are emitted. When NO candidate has a signal: a request
 * that carries terms gets nothing (the file's first imports would be a guess),
 * while a request without terms (no query, only scaffolding words, or only
 * the importers' own project names) gets the first imports in statement
 * order. A query that asks about imports or dependencies themselves keeps
 * every candidate. At most 8 rows and ~1 KiB
 * serialized — less when the pack has less room left (`PlanAidOptions.headroom`:
 * the cap is `min(1 KiB, headroom − 48)`, nothing under 120 bytes); when the
 * byte cap bites the LOWEST-ranked rows are dropped first, never re-ordered.
 * Only the first 2,000 characters of a query are examined.
 *
 * `why` by kind: `imported by <path>:<line>`, `included by <path>:<line>`,
 * `referenced by <path>:<line>` (the `:<line>` is omitted when no statement
 * spells the edge), `counterpart of <path>`; a row the query explains carries
 * one ` (matches "<term>")` suffix (the file name, else the explicit
 * identifier, else the concept term, ≤ 24 characters).
 *
 * LANGUAGE COVERAGE. Whatever `resolveImportsOf` resolves (TS/JS, Python, Go,
 * Java/Kotlin, C/C++). The ranking is language-neutral except two syntax
 * scans, both generic: which lines of a served slice are import statements
 * (`codeLinesOutsideImports`), and the sub-word split of identifiers.
 *
 * SHARED HELPERS. The request-term extraction, sub-word/stem matching, the
 * project-name terms, the capped file reader, the served-slice helpers and
 * the test/vendored/generated path classifiers are exported for
 * usageInventory.ts (which must not be imported back from here: keep the
 * dependency one-way).
 *
 * WORKSPACE SAFETY. Every read, stat or listing of a workspace path in this
 * module and in usageInventory.ts (importer, candidate, declarations,
 * manifests, directory listings, project roots) is preceded by
 * `realPathInside` (importGraphShared.ts): a symlink inside the workspace that
 * points out of it is never stat'ed, opened, listed or read, and a FIFO or
 * device is never opened. `projectRootsChecked` also refuses absolute,
 * drive-lettered, empty and `..`-led paths.
 *
 * OFF (default): `attachFrontierNeighbourIndex` returns on its first line.
 * Nothing else in this module ever runs; a pack is byte-identical to
 * pre-NBR output by construction, not by a downstream branch that could
 * drift.
 */
import * as fs from "fs";
import * as path from "path";
import { handleTable } from "../../util/handles.js";
import { countLines } from "../../util/countLines.js";
import { neighbourIndexEnabled } from "../../util/flags.js";
import { stripPathSpans } from "../../util/queryShape.js";
import { jaBridgeVocabPerCallStorage } from "../retrieval/jaBridgeWorkspaceVocab.js";
import { bridgeJaQuery, containsJapanese } from "../retrieval/jaQueryBridge.js";
import { declarationsIn, type DeclaredSymbol } from "./declarationScan.js";
import {
  isLineComment,
  listDirectory,
  posixDirname,
  projectRootsOf,
  realPathInside,
  withinWorkspace,
  type ResolvedImport,
} from "./importGraphShared.js";
import { languageFamilyOf, resolveImportsOf, type LanguageFamily } from "./importResolution.js";
import { conceptTermsIn, explicitIdentifiersIn, qualifiedMemberPairsIn } from "./requestFacets.js";
import type { TaskPackResult, TaskPackSurface } from "./model.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Up to 8 candidate files per pack (brief-v15-probe.md). */
const MAX_NEIGHBOURS = 8;
/** ~1 KiB total, serialized (brief-v15-probe.md). */
const MAX_NEIGHBOURS_BYTES = 1024;
/** Served surfaces whose imports are considered (a pack rarely serves more). */
const MAX_SURFACES = 8;
/** An importing file is read up to this many bytes (imports live at the head). */
const MAX_IMPORTER_BYTES = 1024 * 1024;
/** A candidate's declarations are scanned from at most this many bytes. */
const MAX_DECLARATION_BYTES = 256 * 1024;
/** A candidate larger than this is never offered (the row's handle needs its line count). */
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
/** Only the best candidates by the cheap signals get their declarations read. */
const MAX_DECLARATION_READS = 24;
/** A served slice is tokenized up to this many bytes / lines. */
const MAX_SLICE_BYTES = 256 * 1024;
const MAX_SLICE_LINES = 6000;
/** A longer line (a minified bundle, a data blob) is cut before any per-line scan. */
const MAX_LINE_CHARS = 2000;
/**
 * Query text considered for term extraction. The identifier / path-span scans behind it are super-linear on a
 * pathological run (`A.b.A.b.…` cost ~250 ms at 6,000 characters, ~30 ms at 2,000), and a real request is a few hundred.
 */
const MAX_QUERY_CHARS = 2000;
/** Query text scanned for file names (a regex over untrusted length). */
const MAX_QUERY_FILE_SCAN_CHARS = 2000;
const MAX_EXPLICIT_IDENTIFIERS = 16;
const MAX_CONCEPT_TERMS = 40;
const MAX_QUERY_FILES = 6;
/** `projectRootsOf` lookups for candidates outside the importer's own project. */
const MAX_ROOT_LOOKUPS = 24;
/** Distinct declared symbols folded into one candidate's sub-word set. */
const MAX_DECLARED_FOR_WORDS = 300;
/** A concept term matching over half of at least this many candidates is ignored. */
const UBIQUITY_MIN_CANDIDATES = 6;
const MATCH_LABEL_MAX_CHARS = 24;

/** The ranking formula's weights; see the module doc. Exported so tests and callers state them once. */
export const NEIGHBOUR_WEIGHTS = {
  fileNamed: 12,
  identifierName: 10,
  identifierNameFold: 8,
  identifierDeclared: 9,
  identifierDeclaredFold: 7,
  identifierPath: 7,
  termName: 3,
  termDeclared: 2,
  termPath: 3,
  /** At most this many distinct concept terms count. */
  termCount: 3,
  relevanceCap: 24,
  used: 5,
  usedExtra: 1,
  usedExtraCap: 2,
  counterpartFirst: 5,
  counterpartLater: 2,
  /** Indexed by the importing surface's position in `result.surfaces`. */
  importer: [3, 1] as readonly number[],
  penalty: 10,
} as const;

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

/**
 * Words of a QUESTION about code that carry no discriminating power when
 * matched against identifiers and paths: closed-class English, code-question
 * scaffolding, and the glossary stems (`get`, `data`, `file`, …) that are
 * generic identifier sub-words. Stems, lower case. Applied to concept terms,
 * never to explicit (code-shaped) identifiers.
 */
export const QUERY_GENERIC_WORDS: ReadonlySet<string> = new Set([
  // closed class
  "after", "before", "while", "during", "between", "without", "within", "inside", "outside", "across", "over", "than",
  "then", "some", "many", "more", "most", "less", "only", "also", "just", "other", "another", "same", "such", "both",
  "either", "neither", "every", "very", "much", "still", "even", "ever", "never", "always", "often", "once", "here",
  "why", "whom", "whose", "been", "being", "are", "has", "had", "having", "did", "doing", "done", "may", "might",
  "must", "shall", "into", "onto", "upon", "out", "off", "per", "via", "where", "whether", "whenever", "wherever",
  "see", "seen", "get", "got", "let", "its", "our", "their", "them", "they", "these", "those", "your", "his", "her",
  "you", "one", "two", "three", "first", "last", "next", "prev", "previous", "like", "need", "want", "know", "look",
  "give", "take", "put", "use", "used", "using", "usage", "make", "made", "way", "thing", "stuff", "kind", "sort",
  // code-question scaffolding
  "function", "method", "class", "file", "code", "module", "package", "implementation", "implement", "implemented",
  "define", "defined", "definition", "declare", "declared", "logic", "work", "happen", "behavior", "behaviour",
  "call", "called", "calling", "invoke", "return", "returned", "value", "type", "name", "list", "data", "object",
  "string", "number", "param", "parameter", "argument", "arg", "variable", "field", "property", "step", "flow", "line",
  "text", "item", "case", "result", "output", "input", "set", "add", "new", "fix", "change", "modify", "support",
  "feature", "configured", "configure", "src", "run", "main", "start", "end", "path", "pass", "test", "spec",
]);

/**
 * Identifier words too generic to count as "use" or as an inventory target on
 * their own (lower case; compared case-insensitively). Language keywords are
 * listed separately in usageInventory.ts; this is the cross-language
 * "everything has one" set. An identifier the QUERY names explicitly is exempt.
 */
export const GENERIC_IDENTIFIER_STOPLIST: ReadonlySet<string> = new Set([
  "get", "set", "run", "main", "init", "data", "value", "values", "self", "this", "true", "false", "null", "none", "nil",
  "undefined", "string", "object", "list", "map", "int", "str", "bool", "float", "char", "byte", "name", "names", "id",
  "ids", "key", "keys", "index", "item", "items", "test", "tests", "args", "argv", "arg", "params", "param", "options",
  "opts", "opt", "config", "cfg", "result", "results", "response", "request", "req", "res", "ret", "tmp", "temp", "foo",
  "bar", "baz", "obj", "ctx", "context", "err", "error", "errors", "msg", "message", "text", "count", "size", "len",
  "length", "max", "min", "sum", "total", "next", "prev", "node", "parent", "child", "children", "path", "file", "files",
  "dir", "url", "uri", "type", "types", "kind", "mode", "state", "status", "flag", "flags", "info", "util", "utils",
  "helper", "helpers", "common", "default", "callback", "handler", "event", "events", "log", "logger", "debug", "warn",
  "start", "stop", "end", "begin", "open", "close", "read", "write", "load", "save", "send", "make", "build", "create",
  "delete", "update", "add", "remove", "find", "parse", "format", "check", "handle", "process", "execute", "call",
  "apply", "reset", "clear", "copy", "clone", "merge", "sort", "filter", "reduce", "each", "all", "any", "one", "new",
  "old", "own", "call", "then", "catch", "finally", "resolve", "reject", "promise", "async", "await", "yield", "self",
  "cls", "super", "print", "println", "printf", "assert", "expect", "describe", "before", "after", "setup", "teardown",
  "api", "url", "uri", "http", "https", "json", "xml", "html", "css", "sql", "uuid", "utf", "ascii", "todo", "fixme",
  "note", "xxx", "post", "put", "patch", "head", "options", "trace", "fatal", "info",
]);

/** Directory/file words that say nothing about a file's topic (matched against path segments, lower case). */
const PATH_NOISE_SEGMENTS: ReadonlySet<string> = new Set([
  "src", "source", "sources", "main", "java", "kotlin", "scala", "groovy", "lib", "libs", "app", "apps", "pkg", "internal",
  "cmd", "include", "includes", "inc", "com", "org", "net", "io", "index", "mod", "init", "__init__", "dist", "build",
  "out", "test", "tests", "spec", "specs", "__tests__", "resources", "res", "default",
]);

const TEST_DIRS: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "spec", "specs", "testing", "e2e", "__mocks__", "testdata", "fixtures", "__fixtures__",
  "unittest", "unittests",
]);
const VENDORED_DIRS: ReadonlySet<string> = new Set([
  "vendor", "vendors", "third_party", "third-party", "thirdparty", "external", "externals", "extern", "deps",
  "node_modules", "site-packages", "bower_components",
]);
const GENERATED_DIRS: ReadonlySet<string> = new Set(["gen", "generated", "__generated__", "dist", "build", "out"]);

/** A test file by directory or by name, across the common ecosystems (JS `.test.`/`.spec.`, Go `_test.go`, Python `test_*.py`, JUnit `*Test.java`, C++ `*_test.cc`). */
export function isTestPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/");
  const base = segments[segments.length - 1] ?? "";
  for (let i = 0; i < segments.length - 1; i++) if (TEST_DIRS.has(segments[i]!.toLowerCase())) return true;
  return (
    /(?:^|[._-])(?:test|spec)\.[^./]+$/i.test(base)
    || /^test_[^/]+\.py$/i.test(base)
    || /(?:Tests?|IT|ITCase|Spec)\.(?:java|kt|scala|groovy|cs)$/.test(base)
    || /_test\.(?:c|cc|cpp|cxx|go|py|rs)$/.test(base)
    || base === "conftest.py"
  );
}

/** A vendored / third-party directory anywhere in the path. */
export function isVendoredPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/");
  for (let i = 0; i < segments.length - 1; i++) if (VENDORED_DIRS.has(segments[i]!.toLowerCase())) return true;
  return false;
}

/** A generated file by directory (`gen/`, `dist/`, …) or by name (`*.pb.*`, `*_pb2.py`, `*.generated.*`, `*_generated.*`, `*.min.*`). */
export function isGeneratedPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/");
  const base = segments[segments.length - 1] ?? "";
  for (let i = 0; i < segments.length - 1; i++) if (GENERATED_DIRS.has(segments[i]!.toLowerCase())) return true;
  return /\.pb\.[^./]+$/.test(base)
    || /_pb2(?:_grpc)?\.pyi?$/.test(base)
    || /\.generated\./.test(base)
    || /_generated\.[^./]+$/.test(base)
    || /\.min\.[^./]+$/.test(base);
}

// ---------------------------------------------------------------------------
// Sub-words and stems
// ---------------------------------------------------------------------------

/**
 * Copy of requestFacets.ts's private `stemEn` (the minimal EN pluralization
 * rule `conceptTermsIn` applies): kept in step by hand, because that module
 * does not export it and is not edited here.
 */
export function stemWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is|as)$/.test(word)) return word.slice(0, -1);
  return word;
}

const SUBWORD_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/**
 * The lower-case sub-words of an identifier or path: split on every
 * non-alphanumeric character (`_`, `-`, `.`, `/`, …), on camelCase/PascalCase
 * humps (an acronym run stays one word: `HTTPServer` → `http`, `server`) and on
 * digit boundaries. Words shorter than 2 characters and pure digits are dropped.
 */
export function subWordsOf(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[^A-Za-z0-9]+/)) {
    if (chunk.length === 0) continue;
    for (const piece of chunk.match(SUBWORD_RE) ?? []) {
      if (piece.length < 2 || /^[0-9]+$/.test(piece)) continue;
      out.push(piece.toLowerCase());
    }
  }
  return out;
}

/** Every sub-word of `text` in both its raw lower-case form and its stem — what a concept term is compared against. */
export function subWordForms(text: string): Set<string> {
  const forms = new Set<string>();
  for (const word of subWordsOf(text)) {
    forms.add(word);
    forms.add(stemWord(word));
  }
  return forms;
}

/** Lower case, separators and non-alphanumerics removed — `order_service` and `OrderService` compare equal. */
function foldIdentifier(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Request terms
// ---------------------------------------------------------------------------

/** What a request says, derived once per hook call. */
export interface RequestTerms {
  /**
   * Code-shaped identifiers the query names (`explicitIdentifiersIn`), as written, then the members of any
   * qualified `A.b` / `A::b` / `A#b` it names (the member is the subject the query asks about).
   */
  readonly identifiers: readonly string[];
  /** Owners of those qualified references that the query names ONLY as a qualifier (`A` in `A.b`, never alone). */
  readonly qualifiers: readonly string[];
  /** Concept stems: EN/JA concept words, sub-words of the explicit identifiers, bridged katakana words; generic words removed. */
  readonly concepts: readonly string[];
  /** Lower-case file names (or path tails) the query names. */
  readonly files: readonly string[];
  /** The query talks about tests, so test files are not penalized. */
  readonly mentionsTests: boolean;
  /** The query asks about imports/dependencies themselves, so every import is on topic. */
  readonly asksImports: boolean;
  /** At least one identifier, concept term or file name. */
  readonly present: boolean;
}

const EMPTY_TERMS: RequestTerms = Object.freeze({
  identifiers: [],
  qualifiers: [],
  concepts: [],
  files: [],
  mentionsTests: false,
  asksImports: false,
  present: false,
});

const QUERY_FILE_RE = /[\w@./-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w-])/g;
const MENTIONS_TESTS_RE = /\b(?:tests?|testing|specs?|unit\s+tests?|pytest|jest|vitest|junit|mocha)\b|テスト|試験/i;
const ASKS_IMPORTS_RE = /\b(?:imports?|imported|importing|dependenc(?:y|ies)|depends?\s+on)\b|#\s*include\b|\brequire\s*\(|インポート|依存|読み込|インクルード/i;

/**
 * Katakana loanwords bridged to workspace vocabulary words — ONLY when the JA
 * bridge's vocabulary for this workspace is already cached in the current
 * pack build's scope (the bridge builds it on first use, which walks and reads
 * the repository: never triggered from here). Outside a pack build, or when
 * the pack never needed the vocabulary, this contributes nothing.
 */
function katakanaBridgeWords(text: string, workspace: string): string[] {
  try {
    if (!containsJapanese(text)) return [];
    const vocab = jaBridgeVocabPerCallStorage.getStore()?.get(workspace);
    if (vocab === undefined) return [];
    const out: string[] = [];
    for (const expansion of bridgeJaQuery(text, vocab).expansions) {
      if (expansion.via === "katakana") out.push(...expansion.tokens);
    }
    return out;
  } catch {
    return [];
  }
}

/** File extensions that make `Node.js` / `README.md` look like a qualified member `Node` → `js`. */
const QUALIFIED_MEMBER_EXTENSIONS: ReadonlySet<string> = new Set([
  "js", "ts", "py", "go", "md", "json", "yml", "yaml", "txt", "java", "rb", "rs", "cs", "cc", "cpp", "hpp", "css", "html",
  "xml", "sh", "kt", "php", "toml", "lock", "csv", "sql",
]);

/** Does `owner` occur in `text` (path spans already stripped) somewhere other than as the qualifier of a `owner.member` / `owner::member` / `owner#member`? */
function namedAlone(text: string, owner: string): boolean {
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?!\\s*(?:\\.|::|#)\\s*[A-Za-z_$])`);
  return re.test(text);
}

/**
 * Terms of a request (`query` may be undefined: no signal). Deterministic and
 * bounded; never throws. The stemmer applied to the identifier side is the
 * same minimal rule `conceptTermsIn` uses, and a concept term matches a
 * sub-word in its raw or stemmed form (see `subWordForms`).
 */
export function requestTermsOf(query: string | undefined, workspace?: string): RequestTerms {
  const text = (query ?? "").slice(0, MAX_QUERY_CHARS);
  if (text.trim().length === 0) return EMPTY_TERMS;
  let identifiers: string[] = [];
  let conceptRaw: string[] = [];
  let stripped = text;
  try {
    identifiers = explicitIdentifiersIn(text).slice(0, MAX_EXPLICIT_IDENTIFIERS);
    // Path spans ("src/orderMath.ts") are not concepts; they are matched as files below.
    stripped = stripPathSpans("", text);
    conceptRaw = conceptTermsIn(stripped);
  } catch {
    /* term extraction is best-effort: no terms rather than a failed pack */
  }
  // `A.b` / `A::b` / `A#b`: the member `b` is what the query asks about (an explicit subject even when it is a plain
  // word), and `A` — unless the query also names it alone — is only the place to look for it.
  const qualifiers: string[] = [];
  try {
    for (const pair of qualifiedMemberPairsIn(text)) {
      if (QUALIFIED_MEMBER_EXTENSIONS.has(pair.member.toLowerCase())) continue; // `Node.js`, `README.md`: a file name, not a member
      if (!identifiers.includes(pair.member) && identifiers.length < MAX_EXPLICIT_IDENTIFIERS) identifiers.push(pair.member);
      if (!qualifiers.includes(pair.owner) && !namedAlone(stripped, pair.owner)) qualifiers.push(pair.owner);
    }
  } catch {
    /* a qualifier scan is a refinement: no pairs rather than a failed pack */
  }
  const foldedIdentifiers = new Set(identifiers.map((id) => id.toLowerCase()));
  const concepts = new Set<string>();
  const addConcept = (word: string): void => {
    const w = word.toLowerCase();
    if (w.length < 3 || w.length > 40 || concepts.size >= MAX_CONCEPT_TERMS) return;
    if (QUERY_GENERIC_WORDS.has(w) || QUERY_GENERIC_WORDS.has(stemWord(w))) return;
    if (foldedIdentifiers.has(w)) return; // the lower-cased spelling of an explicit identifier: matched as the identifier
    concepts.add(w);
  };
  for (const term of conceptRaw) addConcept(term);
  for (const id of identifiers) for (const word of subWordsOf(id)) addConcept(stemWord(word));
  if (workspace !== undefined) for (const word of katakanaBridgeWords(text, workspace)) addConcept(stemWord(word));

  const files = new Set<string>();
  for (const token of text.slice(0, MAX_QUERY_FILE_SCAN_CHARS).match(QUERY_FILE_RE) ?? []) {
    const cleaned = token.toLowerCase().replace(/^\.\//, "");
    if (files.size >= MAX_QUERY_FILES || !/[a-z]/.test(cleaned)) continue;
    files.add(cleaned);
  }

  const terms: RequestTerms = {
    identifiers,
    qualifiers,
    concepts: [...concepts],
    files: [...files],
    mentionsTests: MENTIONS_TESTS_RE.test(text),
    asksImports: ASKS_IMPORTS_RE.test(text),
    present: identifiers.length > 0 || concepts.size > 0 || files.size > 0,
  };
  return terms;
}

// ---------------------------------------------------------------------------
// Project names — a request term that names the project itself discriminates nothing inside it
// ---------------------------------------------------------------------------

/** Manifests that make a directory a project of its own; the config-only ones (tsconfig.json, Makefile, …) do not. */
export const STRONG_PROJECT_MANIFESTS: ReadonlySet<string> = new Set([
  "package.json", "pyproject.toml", "setup.py", "Pipfile", "go.mod", "go.work", "pom.xml", "build.gradle",
  "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Cargo.toml", "CMakeLists.txt", "meson.build",
  "configure.ac", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel",
]);

const MAX_MANIFEST_NAME_BYTES = 256 * 1024;
const MAX_PROJECT_NAMES = 12;

function tomlSectionName(text: string, header: RegExp): string | undefined {
  const m = header.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^\s*\[/m);
  return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(next === -1 ? rest : rest.slice(0, next))?.[1];
}

function firstGroup(text: string, re: RegExp): string[] {
  const m = re.exec(text);
  return m?.[1] !== undefined ? [m[1]] : [];
}

/** `module github.com/org/repo/v2` → `org`, `repo` (host and version segments dropped). */
function goModuleNames(text: string): string[] {
  const m = /^\s*module\s+(\S+)/m.exec(text);
  if (!m) return [];
  const segments = m[1]!.replace(/^["']|["']$/g, "").split("/").filter((seg) => seg.length > 0 && !/^v\d+$/.test(seg));
  const start = segments.length > 1 && segments[0]!.includes(".") ? 1 : 0;
  return segments.slice(start).slice(-2);
}

/** Manifest file → the project/package/module names it declares. Each parser is a bounded regex, never a full parse. */
const MANIFEST_NAME_PARSERS: ReadonlyArray<readonly [string, (text: string) => string[]]> = [
  ["package.json", (text) => {
    try {
      const name = (JSON.parse(text) as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    } catch {
      return firstGroup(text, /"name"\s*:\s*"([^"]+)"/);
    }
  }],
  ["pyproject.toml", (text) => {
    const name = tomlSectionName(text, /^\s*\[project\]\s*$/m) ?? tomlSectionName(text, /^\s*\[tool\.poetry\]\s*$/m);
    return name === undefined ? [] : [name];
  }],
  ["setup.py", (text) => firstGroup(text, /\bname\s*=\s*["']([^"']+)["']/)],
  ["Cargo.toml", (text) => {
    const name = tomlSectionName(text, /^\s*\[package\]\s*$/m);
    return name === undefined ? [] : [name];
  }],
  ["go.mod", goModuleNames],
  ["pom.xml", (text) => firstGroup(text.replace(/<!--[\s\S]*?-->/g, "").replace(/<parent>[\s\S]*?<\/parent>/g, ""), /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)],
  ["settings.gradle", (text) => firstGroup(text, /rootProject\.name\s*=\s*["']([^"']+)["']/)],
  ["settings.gradle.kts", (text) => firstGroup(text, /rootProject\.name\s*=\s*["']([^"']+)["']/)],
  ["CMakeLists.txt", (text) => firstGroup(text, /\bproject\s*\(\s*["']?([A-Za-z_][\w.+-]*)/i)],
  ["meson.build", (text) => firstGroup(text, /\bproject\s*\(\s*['"]([^'"]+)['"]/)],
];

const manifestNameCache = new Map<string, { mtimeMs: number; size: number; names: string[] }>();

/** Names declared by the manifests directly inside `dir`, cached per absolute path and validated by mtime + size. */
function manifestNamesIn(workspace: string, dir: string): string[] {
  const listing = new Set(listDirectoryChecked(workspace, dir));
  const out: string[] = [];
  for (const [file, parse] of MANIFEST_NAME_PARSERS) {
    if (!listing.has(file)) continue;
    const rel = dir === "" ? file : `${dir}/${file}`;
    const abs = withinWorkspace(workspace, rel);
    if (abs === undefined || !realPathInside(workspace, rel)) continue; // a manifest that is a symlink out of the workspace is never stat'ed or read
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_NAME_BYTES) continue;
      const hit = manifestNameCache.get(abs);
      if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        out.push(...hit.names);
        continue;
      }
      const text = readCapped(workspace, rel, MAX_MANIFEST_NAME_BYTES)?.text;
      const names = text === undefined ? [] : parse(text).slice(0, 4);
      if (manifestNameCache.size >= 256) manifestNameCache.clear();
      manifestNameCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, names });
      out.push(...names);
    } catch {
      /* an unreadable manifest names nothing */
    }
  }
  return out;
}

/**
 * The words that name the project a file belongs to: the sub-words (raw and
 * stemmed, like `subWordForms`) of the NEAREST project root's directory name
 * and of the package/module name its manifests declare — plus, when `scope`
 * is given (FUI's scanned directory), the same for that directory. A request
 * term equal to one of them ("libfoo", "analytics") says nothing inside that
 * project, so the relevance scorers ignore it; everywhere else it stays a term.
 * A root at the workspace itself contributes only its manifest's names (the
 * workspace directory's own name is whatever the caller happened to open).
 * Cheap: directory listings of the file's ancestors plus small cached manifests.
 */
export function projectNameTermsOf(workspace: string, surfacePath: string, scope?: string): ReadonlySet<string> {
  const names: string[] = [];
  try {
    const dirs: string[] = [];
    const roots = projectRootsChecked(workspace, surfacePath);
    const strong = roots.filter((dir) => listDirectoryChecked(workspace, dir).some((name) => STRONG_PROJECT_MANIFESTS.has(name)));
    const nearest = (strong.length > 0 ? strong : roots)[0];
    if (nearest !== undefined) dirs.push(nearest);
    if (scope !== undefined && !dirs.includes(scope)) dirs.push(scope);
    for (const dir of dirs) {
      if (dir !== "") names.push(path.posix.basename(dir));
      names.push(...manifestNamesIn(workspace, dir));
    }
  } catch {
    /* project names are a refinement, never a failure */
  }
  const forms = new Set<string>();
  for (const name of names.slice(0, MAX_PROJECT_NAMES)) for (const form of subWordForms(name)) forms.add(form);
  return forms;
}

/** `terms` without the concept terms in `projectTerms` (the same object when nothing changes). */
export function withoutProjectTerms(terms: RequestTerms, projectTerms: ReadonlySet<string> | undefined): RequestTerms {
  if (projectTerms === undefined || projectTerms.size === 0 || !terms.concepts.some((term) => projectTerms.has(term))) return terms;
  return { ...terms, concepts: terms.concepts.filter((term) => !projectTerms.has(term)) };
}

// ---------------------------------------------------------------------------
// Capped, boundary-safe file access
// ---------------------------------------------------------------------------
//
// EVERY read or listing of a workspace path in this module and in usageInventory.ts goes through the helpers
// below, which call `realPathInside` (importGraphShared.ts; symlinks resolved, cached) BEFORE touching the
// path: a symlink inside the workspace that points out of it is never stat'ed, listed, opened or read.

/** A workspace-relative POSIX path that stays inside the workspace lexically: not empty, not absolute, no drive, not `..`-led. */
export function isWorkspaceRelativePath(relPath: string): boolean {
  const posix = relPath.replace(/\\/g, "/");
  return posix.length > 0 && !path.posix.isAbsolute(posix) && !/^[A-Za-z]:/.test(posix) && posix !== ".." && !posix.startsWith("../");
}

/** Entry names of a workspace directory; [] unless its real path stays inside the workspace ("" = the workspace root). */
export function listDirectoryChecked(workspace: string, relDir: string): string[] {
  return relDir === "" || realPathInside(workspace, relDir) ? listDirectory(workspace, relDir) : [];
}

/**
 * `projectRootsOf` for a file every ancestor directory of which resolves inside the workspace; `[]` for any
 * other path — absolute, escaping, or reached through a symlink that points out (never listed).
 */
export function projectRootsChecked(workspace: string, filePath: string): string[] {
  if (!isWorkspaceRelativePath(filePath)) return [];
  let dir = posixDirname(filePath.replace(/\\/g, "/"));
  for (let depth = 0; dir !== "" && depth < 64; depth++) {
    if (!realPathInside(workspace, dir)) return [];
    dir = posixDirname(dir);
  }
  return dir === "" ? projectRootsOf(workspace, filePath) : [];
}

/**
 * The first `maxBytes` bytes of a workspace file, as UTF-8 text; `truncated`
 * says more followed. Undefined for anything that is not a regular file whose
 * real location stays inside the workspace: a symlink out of it is refused
 * before any stat or open, and a FIFO or device is never opened.
 */
export function readCapped(workspace: string, relPath: string, maxBytes: number): { text: string; truncated: boolean } | undefined {
  const abs = withinWorkspace(workspace, relPath);
  if (abs === undefined || !realPathInside(workspace, relPath)) return undefined;
  let fd: number | undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) return undefined;
    fd = fs.openSync(real, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(size);
    const read = size === 0 ? 0 : fs.readSync(fd, buffer, 0, size, 0);
    return { text: buffer.toString("utf8", 0, read), truncated: stat.size > maxBytes };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to release */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Served slices
// ---------------------------------------------------------------------------

/** `"12-40"` or `"12"` → inclusive 1-based line span; undefined for anything else. */
export function parseLineRange(range: string | undefined): [number, number] | undefined {
  if (range === undefined) return undefined;
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(range);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  return start >= 1 && end >= start ? [start, end] : undefined;
}

/**
 * The text of a surface's served slice: its `code`; or, when the pack only
 * says the identical block was served before (`code_unchanged`), the file's
 * lines of `range`; undefined when nothing of the body was served.
 */
export function servedTextOf(surface: TaskPackSurface, fileText: string | undefined): string | undefined {
  if (surface.code !== undefined) return surface.code;
  if (surface.code_unchanged !== undefined && fileText !== undefined) {
    const range = parseLineRange(surface.range);
    if (range === undefined) return fileText;
    return fileText.split(/\r?\n/).slice(range[0] - 1, range[1]).join("\n");
  }
  return undefined;
}

/** Start of an import/include statement, tested on a trimmed line, per language family. */
const IMPORT_START: Readonly<Record<LanguageFamily, RegExp>> = {
  web: /^(?:import\b|export\s+(?:type\s+)?(?:\*|\{)|(?:const|let|var)\s+[^=]+=\s*require\s*\()/,
  python: /^(?:from\s+\S+\s+import\b|import\s)/,
  go: /^import\b/,
  jvm: /^(?:import|package)\s/,
  c: /^#\s*(?:include|import)\b/,
};

function bracketDelta(line: string): number {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 40 || ch === 123 || ch === 91) delta++; // ( { [
    else if (ch === 41 || ch === 125 || ch === 93) delta--; // ) } ]
  }
  return delta;
}

/**
 * The lines of `code` that are neither comments nor part of an import/include
 * statement (a multi-line statement ends when its brackets balance; Python
 * also honours a trailing backslash and skips docstrings). What is left is
 * where a name is USED.
 * Bounded to `MAX_SLICE_BYTES` / `MAX_SLICE_LINES`.
 */
export function codeLinesOutsideImports(code: string, family: LanguageFamily | undefined): string[] {
  const text = code.length > MAX_SLICE_BYTES ? code.slice(0, MAX_SLICE_BYTES) : code;
  const lines = text.split(/\r?\n/, MAX_SLICE_LINES);
  const start = family === undefined ? undefined : IMPORT_START[family];
  const hash = family === "python";
  const out: string[] = [];
  let depth = 0;
  let continued = false;
  let inDocstring = false;
  for (const fullLine of lines) {
    const line = fullLine.length > MAX_LINE_CHARS ? fullLine.slice(0, MAX_LINE_CHARS) : fullLine;
    if (family === "python") {
      // A triple-quoted block (docstring) is prose, not use: an odd number of `"""`/`'''` on a line opens or closes one.
      const fences = (line.match(/"""|'''/g) ?? []).length;
      if (inDocstring) {
        if (fences % 2 === 1) inDocstring = false;
        continue;
      }
      if (fences % 2 === 1) {
        inDocstring = true;
        continue;
      }
    }
    if (isLineComment(line, hash)) continue;
    if (depth > 0 || continued) {
      depth = Math.max(0, depth + bracketDelta(line));
      continued = family === "python" && /\\\s*$/.test(line);
      continue;
    }
    if (start !== undefined && start.test(line.trimStart())) {
      depth = Math.max(0, bracketDelta(line));
      continued = family === "python" && /\\\s*$/.test(line);
      continue;
    }
    out.push(line);
  }
  return out;
}

const IDENT_TOKEN_RE = /[A-Za-z_$][\w$]*/g;
const QUOTED_STRING_RE = /(["'])(?:\\.|(?!\1).){0,200}\1/g;
const MAX_SLICE_TOKENS = 20000;

/** `line` without its trailing line comment (`# …` for Python, `// …` elsewhere); `line` must already have its string literals blanked. */
export function stripTrailingComment(line: string, family: LanguageFamily | undefined): string {
  const at = line.indexOf(family === "python" ? "#" : "//");
  return at === -1 ? line : line.slice(0, at);
}

/**
 * Identifier tokens that occur in `code` outside comments, import statements
 * and quoted strings — the "used" vocabulary of a served slice.
 */
export function identifierTokensOf(code: string, family: LanguageFamily | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const line of codeLinesOutsideImports(code, family)) {
    for (const token of stripTrailingComment(line.replace(QUOTED_STRING_RE, " "), family).match(IDENT_TOKEN_RE) ?? []) {
      tokens.add(token);
      if (tokens.size >= MAX_SLICE_TOKENS) return tokens;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Ranking (pure)
// ---------------------------------------------------------------------------

/** One edge of one served surface, with what the scorer needs to know about the importer. */
export interface NeighbourEdge {
  readonly edge: ResolvedImport;
  /** Workspace-relative path of the importing (served) surface. */
  readonly importer: string;
  /** Position of the importing surface in `result.surfaces`; 0 = the focal surface. */
  readonly importerIndex: number;
  readonly importerIsTest: boolean;
  /** Identifier tokens of the importer's served slice outside its import statements; undefined when no slice text is known. */
  readonly sliceTokens: ReadonlySet<string> | undefined;
  /** Words that name the importer's own project (`projectNameTermsOf`): a request term equal to one is not a relevance signal. */
  readonly projectTerms?: ReadonlySet<string>;
}

export interface RankOptions {
  /** Declarations of candidate files (only the best candidates have them). */
  readonly declared?: ReadonlyMap<string, readonly DeclaredSymbol[]>;
  /** Project root (workspace-relative directory, "" = workspace) of a candidate path; default: none. */
  readonly rootOf?: (candidatePath: string) => string;
}

export interface RankedNeighbour {
  readonly path: string;
  readonly edge: ResolvedImport;
  readonly importer: string;
  readonly importerIndex: number;
  readonly score: number;
  readonly relevance: number;
  /** Names (or, for name-less edges, declared symbols) of the candidate the served slice uses. */
  readonly used: number;
  /** What the request matched on, best first: the file name, an explicit identifier or a concept term. */
  readonly matched: string | undefined;
  readonly penalty: number;
  /** Relevance, use or a counterpart relation: the edge says something beyond "the file imports it". */
  readonly signalled: boolean;
}

interface PathInfo {
  readonly path: string;
  readonly base: string;
  readonly fold: ReadonlySet<string>;
  readonly pathForms: ReadonlySet<string>;
}

function pathSubWordForms(relPath: string, rootDir: string): Set<string> {
  let rel = relPath.replace(/\\/g, "/");
  if (rootDir !== "" && rel.startsWith(`${rootDir}/`)) rel = rel.slice(rootDir.length + 1);
  const segments = rel.split("/");
  const last = segments.pop() ?? "";
  const dot = last.lastIndexOf(".");
  segments.push(dot > 0 ? last.slice(0, dot) : last);
  const forms = new Set<string>();
  for (const segment of segments) {
    if (segment.length === 0 || PATH_NOISE_SEGMENTS.has(segment.toLowerCase())) continue;
    for (const form of subWordForms(segment)) forms.add(form);
  }
  return forms;
}

/** Folded file stems of a path: its own, plus its directory's when the file is a package/index entry point. */
function pathStemFolds(relPath: string): Set<string> {
  const segments = relPath.replace(/\\/g, "/").split("/");
  const last = segments.pop() ?? "";
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last;
  const folds = new Set<string>([foldIdentifier(stem)]);
  if (PATH_NOISE_SEGMENTS.has(stem.toLowerCase()) && segments.length > 0) folds.add(foldIdentifier(segments[segments.length - 1]!));
  folds.delete("");
  return folds;
}

function penaltyOf(candidatePath: string, input: NeighbourEdge, terms: RequestTerms): number {
  if (isTestPath(candidatePath) && !input.importerIsTest && !terms.mentionsTests) return NEIGHBOUR_WEIGHTS.penalty;
  if (isVendoredPath(candidatePath) && !isVendoredPath(input.importer)) return NEIGHBOUR_WEIGHTS.penalty;
  if (isGeneratedPath(candidatePath) && !isGeneratedPath(input.importer)) return NEIGHBOUR_WEIGHTS.penalty;
  return 0;
}

interface DeclaredInfo {
  readonly symbols: ReadonlySet<string>;
  readonly folded: ReadonlyMap<string, string>;
  readonly forms: ReadonlySet<string>;
  readonly generic: ReadonlySet<string>;
}

function declaredInfoOf(declared: readonly DeclaredSymbol[]): DeclaredInfo {
  const symbols = new Set<string>();
  const folded = new Map<string, string>();
  const forms = new Set<string>();
  const generic = new Set<string>();
  let words = 0;
  for (const decl of declared) {
    symbols.add(decl.symbol);
    const fold = decl.symbol.toLowerCase();
    if (!folded.has(fold)) folded.set(fold, decl.symbol);
    if (words++ < MAX_DECLARED_FOR_WORDS) for (const form of subWordForms(decl.symbol)) forms.add(form);
    if (GENERIC_IDENTIFIER_STOPLIST.has(fold) || decl.symbol.length < 3) generic.add(decl.symbol);
  }
  return { symbols, folded, forms, generic };
}

interface EdgeEvaluation {
  readonly fileNamed: boolean;
  readonly identifierWeight: number;
  readonly identifierLabel: string | undefined;
  /** term → best weight */
  readonly termHits: Map<string, number>;
  readonly used: number;
}

function evaluateEdge(
  input: NeighbourEdge,
  terms: RequestTerms,
  info: PathInfo,
  declared: DeclaredInfo | undefined,
): EdgeEvaluation {
  const names = input.edge.names;
  const foldedNames = new Map<string, string>();
  for (const name of names) if (!foldedNames.has(name.toLowerCase())) foldedNames.set(name.toLowerCase(), name);

  // 1. The query names the file.
  const lowerPath = info.path.toLowerCase();
  const fileNamed = terms.files.some((file) => (file.includes("/") ? lowerPath === file || lowerPath.endsWith(`/${file}`) : info.base === file));

  // 2. Explicit identifiers the query names.
  let identifierWeight = 0;
  let identifierLabel: string | undefined;
  for (const id of terms.identifiers) {
    let weight = 0;
    const fold = id.toLowerCase();
    if (names.includes(id)) weight = NEIGHBOUR_WEIGHTS.identifierName;
    else if (foldedNames.has(fold)) weight = NEIGHBOUR_WEIGHTS.identifierNameFold;
    else if (declared?.symbols.has(id)) weight = NEIGHBOUR_WEIGHTS.identifierDeclared;
    else if (declared?.folded.has(fold)) weight = NEIGHBOUR_WEIGHTS.identifierDeclaredFold;
    else if (info.fold.has(foldIdentifier(id))) weight = NEIGHBOUR_WEIGHTS.identifierPath;
    if (weight > identifierWeight) {
      identifierWeight = weight;
      identifierLabel = id;
    }
  }

  // 3. Concept terms, best surface per term.
  const termHits = new Map<string, number>();
  if (terms.concepts.length > 0) {
    const nameForms = new Set<string>();
    for (const name of names) for (const form of subWordForms(name)) nameForms.add(form);
    for (const term of terms.concepts) {
      if (input.projectTerms?.has(term)) continue; // names the project itself: not discriminating inside it
      let weight = 0;
      if (nameForms.has(term)) weight = NEIGHBOUR_WEIGHTS.termName;
      else if (declared?.forms.has(term)) weight = NEIGHBOUR_WEIGHTS.termDeclared;
      else if (info.pathForms.has(term)) weight = NEIGHBOUR_WEIGHTS.termPath;
      if (weight > 0) termHits.set(term, weight);
    }
  }

  // 4. Use in the importer's served slice.
  let used = 0;
  const tokens = input.sliceTokens;
  if (tokens !== undefined) {
    for (const name of names) if (tokens.has(name)) used++;
    const nameless = names.length === 0 || input.edge.kind === "include" || input.edge.kind === "counterpart";
    if (nameless && declared !== undefined) {
      let declaredUsed = 0;
      for (const symbol of declared.symbols) {
        if (!declared.generic.has(symbol) && tokens.has(symbol) && ++declaredUsed >= NEIGHBOUR_WEIGHTS.usedExtraCap + 1) break;
      }
      used = Math.max(used, declaredUsed);
    }
  }

  return { fileNamed, identifierWeight, identifierLabel, termHits, used };
}

function compareRanked(a: RankedNeighbour, b: RankedNeighbour): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.importerIndex !== b.importerIndex) return a.importerIndex - b.importerIndex;
  const lineA = a.edge.line > 0 ? a.edge.line : Number.MAX_SAFE_INTEGER;
  const lineB = b.edge.line > 0 ? b.edge.line : Number.MAX_SAFE_INTEGER;
  if (lineA !== lineB) return lineA < lineB ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Score every edge, merge edges to the same file (the best-scoring one keeps
 * its provenance) and return the candidates best first. Pure: all file facts
 * arrive through `edges`, `terms` and `opts`. See the module doc for the formula.
 */
export function rankNeighbourCandidates(
  edges: readonly NeighbourEdge[],
  terms: RequestTerms,
  opts: RankOptions = {},
): RankedNeighbour[] {
  const rootOf = opts.rootOf ?? (() => "");
  const infoByPath = new Map<string, PathInfo>();
  const declaredByPath = new Map<string, DeclaredInfo | undefined>();
  const infoFor = (candidatePath: string): PathInfo => {
    let info = infoByPath.get(candidatePath);
    if (info === undefined) {
      info = {
        path: candidatePath,
        base: (candidatePath.split("/").pop() ?? candidatePath).toLowerCase(),
        fold: pathStemFolds(candidatePath),
        pathForms: terms.concepts.length > 0 ? pathSubWordForms(candidatePath, rootOf(candidatePath)) : new Set<string>(),
      };
      infoByPath.set(candidatePath, info);
    }
    return info;
  };
  const declaredFor = (candidatePath: string): DeclaredInfo | undefined => {
    if (declaredByPath.has(candidatePath)) return declaredByPath.get(candidatePath);
    const symbols = opts.declared?.get(candidatePath);
    const info = symbols === undefined ? undefined : declaredInfoOf(symbols);
    declaredByPath.set(candidatePath, info);
    return info;
  };

  const evaluated = edges.map((input) => ({ input, ev: evaluateEdge(input, terms, infoFor(input.edge.path), declaredFor(input.edge.path)) }));

  // A term that matches over half of a sizeable candidate set discriminates nothing.
  const ignoredTerms = new Set<string>();
  const distinctPaths = new Set(edges.map((e) => e.edge.path));
  if (distinctPaths.size >= UBIQUITY_MIN_CANDIDATES) {
    const pathsByTerm = new Map<string, Set<string>>();
    for (const { input, ev } of evaluated) {
      for (const term of ev.termHits.keys()) {
        const set = pathsByTerm.get(term) ?? new Set<string>();
        set.add(input.edge.path);
        pathsByTerm.set(term, set);
      }
    }
    for (const [term, matchedPaths] of pathsByTerm) if (matchedPaths.size * 2 > distinctPaths.size) ignoredTerms.add(term);
  }

  const best = new Map<string, RankedNeighbour>();
  for (const { input, ev } of evaluated) {
    const weights: Array<[string, number]> = [];
    for (const [term, weight] of ev.termHits) if (!ignoredTerms.has(term)) weights.push([term, weight]);
    weights.sort((a, b) => b[1] - a[1]);
    let concept = 0;
    for (const [, weight] of weights.slice(0, NEIGHBOUR_WEIGHTS.termCount)) concept += weight;
    const relevance = Math.min(
      NEIGHBOUR_WEIGHTS.relevanceCap,
      (ev.fileNamed ? NEIGHBOUR_WEIGHTS.fileNamed : 0) + ev.identifierWeight + concept,
    );
    const matched = ev.fileNamed
      ? (input.edge.path.split("/").pop() ?? input.edge.path)
      : ev.identifierWeight > 0
        ? ev.identifierLabel
        : weights[0]?.[0];
    const use = ev.used > 0 ? NEIGHBOUR_WEIGHTS.used + Math.min(NEIGHBOUR_WEIGHTS.usedExtraCap, (ev.used - 1) * NEIGHBOUR_WEIGHTS.usedExtra) : 0;
    const relation = input.edge.kind === "counterpart"
      ? (input.importerIndex === 0 ? NEIGHBOUR_WEIGHTS.counterpartFirst : NEIGHBOUR_WEIGHTS.counterpartLater)
      : 0;
    const importerBonus = NEIGHBOUR_WEIGHTS.importer[input.importerIndex] ?? 0;
    const penalty = penaltyOf(input.edge.path, input, terms);
    const ranked: RankedNeighbour = {
      path: input.edge.path,
      edge: input.edge,
      importer: input.importer,
      importerIndex: input.importerIndex,
      score: relevance + use + relation + importerBonus - penalty,
      relevance,
      used: ev.used,
      matched,
      penalty,
      signalled: relevance > 0 || use > 0 || relation > 0,
    };
    const current = best.get(ranked.path);
    if (current === undefined || compareRanked(ranked, current) < 0) best.set(ranked.path, ranked);
  }
  return [...best.values()].sort(compareRanked);
}

/**
 * Which ranked candidates may be emitted, best first, at most `MAX_NEIGHBOURS`.
 * Candidates with a signal only; with none, the request's own terms mean
 * "nothing here is what you asked about" (emit nothing), while a request
 * without terms — or one asking about imports themselves — keeps every
 * candidate in import order.
 */
export function selectNeighbours(ranked: readonly RankedNeighbour[], terms: RequestTerms): RankedNeighbour[] {
  let pool = ranked.filter((r) => r.signalled);
  if (terms.asksImports) pool = [...ranked];
  else if (pool.length === 0) pool = terms.present ? [] : [...ranked];
  return pool.slice(0, MAX_NEIGHBOURS);
}

/** The `why` provenance string of a ranked row (no match suffix). */
export function neighbourWhy(r: Pick<RankedNeighbour, "edge" | "importer">): string {
  const at = r.edge.line > 0 ? `${r.importer}:${r.edge.line}` : r.importer;
  switch (r.edge.kind) {
    case "include": return `included by ${at}`;
    case "reference": return `referenced by ${at}`;
    case "counterpart": return `counterpart of ${r.importer}`;
    default: return `imported by ${at}`;
  }
}

function matchSuffix(r: Pick<RankedNeighbour, "matched">): string {
  if (r.matched === undefined || r.matched.length === 0) return "";
  const label = r.matched.length > MATCH_LABEL_MAX_CHARS ? r.matched.slice(0, MATCH_LABEL_MAX_CHARS) : r.matched;
  return ` (matches "${label}")`;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

interface NeighbourRow {
  path: string;
  handle: string;
  why: string;
}

// ---------------------------------------------------------------------------
// Wire headroom — the hooks run after the pack's own shed ladder
// ---------------------------------------------------------------------------

/**
 * Optional cooperation with the pack's wire budget, shared by both plan-aid hooks (`attachFrontierNeighbourIndex`,
 * `attachUsageInventory`). They run at the END of a pack build — after the shed ladder that fits the pack under its cap —
 * so a member of their own fixed size can push the pack over it. A caller that knows the pack's cap passes what is left.
 */
export interface PlanAidOptions {
  /**
   * Bytes still free in the pack's wire budget (cap minus what the pack already weighs). Called lazily, once, AFTER the
   * flag check and the cheap early returns: never when the flag is off. The member is then capped at
   * `min(its own cap, headroom() − PLAN_AID_KEY_OVERHEAD_BYTES)` and left out entirely when that is under
   * `PLAN_AID_MIN_BYTES`. A throwing or non-numeric headroom leaves the pack exactly as it was.
   */
  readonly headroom?: () => number;
}

/** What the member's own key, its separator and the wrapping cost on the wire, over the serialized rows. */
export const PLAN_AID_KEY_OVERHEAD_BYTES = 48;
/** Under this many bytes not even one row fits: attach nothing. */
export const PLAN_AID_MIN_BYTES = 120;

/**
 * The byte cap one plan-aid member may use: its own cap, or less when the pack has less room; undefined = attach nothing.
 * Without `opts.headroom` this is exactly `ownCap` (a pack is byte-identical to one built before the option existed).
 */
export function planAidCap(ownCap: number, opts?: PlanAidOptions): number | undefined {
  if (opts?.headroom === undefined) return ownCap;
  let room: number;
  try {
    room = opts.headroom();
  } catch {
    return undefined; // the room is unknown: the pack stays as the shed ladder left it
  }
  if (typeof room !== "number" || Number.isNaN(room)) return undefined;
  const cap = Math.min(ownCap, Math.floor(room) - PLAN_AID_KEY_OVERHEAD_BYTES);
  return cap < PLAN_AID_MIN_BYTES ? undefined : cap;
}

/** Drop the LOWEST-ranked (last) rows until the serialization fits; the survivors keep their order. */
function capByBytes(rows: NeighbourRow[], maxBytes: number): NeighbourRow[] {
  let kept = rows;
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept), "utf8") > maxBytes) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/** Paths the model already holds: this response's surfaces, `frontier_index` rows and earlier-served surfaces. */
function knownPathsOf(result: TaskPackResult): Set<string> {
  const known = new Set<string>(result.surfaces.map((s) => s.path));
  for (const entry of result.frontier_index ?? []) known.add(entry.path);
  for (const entry of result.served_earlier ?? []) known.add(entry.path);
  return known;
}

const declarationCache = new Map<string, { mtimeMs: number; size: number; declared: DeclaredSymbol[] }>();

/**
 * Declarations of a candidate file (its first `MAX_DECLARATION_BYTES`),
 * cached per absolute path and validated by mtime + size so repeated packs
 * over the same neighbours stay cheap. Undefined for an unreadable file.
 */
function declarationsOfCandidate(workspace: string, relPath: string): DeclaredSymbol[] | undefined {
  const abs = withinWorkspace(workspace, relPath);
  if (abs === undefined || !realPathInside(workspace, relPath)) return undefined; // never stat'ed or read through a symlink out of the workspace
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return undefined;
    const hit = declarationCache.get(abs);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.declared;
    const head = readCapped(workspace, relPath, MAX_DECLARATION_BYTES);
    if (head === undefined) return undefined;
    const declared = declarationsIn(relPath, head.text);
    if (declarationCache.size >= 256) declarationCache.clear();
    declarationCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, declared });
    return declared;
  } catch {
    return undefined; // a scan failure costs this candidate its declaration signal, never the pack
  }
}

/** Test seam and the hook's channel to the computation. */
export interface NeighbourDeps {
  /** The edge resolver the computation calls (default `resolveImportsOf`). */
  resolveImports?: (workspace: string, filePath: string, body: string) => ResolvedImport[];
  /** Serialized-byte cap of the rows (default `MAX_NEIGHBOURS_BYTES`); the lowest-ranked rows go first. */
  maxBytes?: number;
}

/**
 * Pure computation (no flag check — callers gate; unit tests call this
 * directly). Ranked best-first; see the module doc for the formula.
 */
export function computeFrontierNeighbourIndex(
  result: TaskPackResult,
  workspace: string,
  query?: string,
  deps: NeighbourDeps = {},
): NeighbourRow[] {
  const resolveImports = deps.resolveImports ?? resolveImportsOf;
  const terms = requestTermsOf(query, workspace);
  const known = knownPathsOf(result);
  const inputs: NeighbourEdge[] = [];
  const importerRoots: string[] = [];
  // Words naming each importer's own project (by directory: files of one directory share their project).
  const projectTermsByDir = new Map<string, ReadonlySet<string>>();
  const projectTermsOf = (importerPath: string): ReadonlySet<string> | undefined => {
    if (terms.concepts.length === 0) return undefined;
    const dir = posixDirname(importerPath);
    let names = projectTermsByDir.get(dir);
    if (names === undefined) {
      names = projectNameTermsOf(workspace, importerPath);
      projectTermsByDir.set(dir, names);
    }
    return names;
  };

  result.surfaces.slice(0, MAX_SURFACES).forEach((surface, importerIndex) => {
    const file = readCapped(workspace, surface.path, MAX_IMPORTER_BYTES);
    const slice = servedTextOf(surface, file?.text);
    // Imports come from the whole file; the served slice only stands in when the file cannot be read.
    const body = file?.text ?? (slice !== undefined && slice.length > MAX_IMPORTER_BYTES ? slice.slice(0, MAX_IMPORTER_BYTES) : slice) ?? "";
    if (body.length === 0) return;
    const family = languageFamilyOf(surface.path);
    const edges = resolveImports(workspace, surface.path, body).filter((edge) => !known.has(edge.path));
    if (edges.length === 0) return;
    const sliceTokens = slice === undefined ? undefined : identifierTokensOf(slice, family);
    const importerIsTest = isTestPath(surface.path);
    const projectTerms = projectTermsOf(surface.path);
    for (const edge of edges) {
      inputs.push({ edge, importer: surface.path, importerIndex, importerIsTest, sliceTokens, ...(projectTerms !== undefined ? { projectTerms } : {}) });
    }
    if (terms.concepts.length > 0) importerRoots.push(projectRootsChecked(workspace, surface.path)[0] ?? "");
  });
  if (inputs.length === 0) return [];

  let rootLookups = 0;
  const rootMemo = new Map<string, string>();
  const rootOf = (candidatePath: string): string => {
    const memo = rootMemo.get(candidatePath);
    if (memo !== undefined) return memo;
    let root = importerRoots.find((r) => r !== "" && candidatePath.startsWith(`${r}/`));
    if (root === undefined) root = rootLookups++ < MAX_ROOT_LOOKUPS ? (projectRootsChecked(workspace, candidatePath)[0] ?? "") : "";
    rootMemo.set(candidatePath, root);
    return root;
  };

  // A request whose only terms name the importers' own projects has no term worth ranking by.
  const allProjectTerms = new Set<string>();
  for (const names of projectTermsByDir.values()) for (const term of names) allProjectTerms.add(term);
  const stillPresent = terms.identifiers.length > 0 || terms.files.length > 0 || terms.concepts.some((term) => !allProjectTerms.has(term));
  const effective: RequestTerms = stillPresent === terms.present ? terms : { ...terms, present: stillPresent };

  // Pass 1: the cheap signals (names, paths, use of names, importer, relation).
  let ranked = rankNeighbourCandidates(inputs, terms, { rootOf });
  // Pass 2: declarations of the best candidates, when they can change the order.
  if (effective.present || inputs.some((input) => input.edge.names.length === 0)) {
    const declared = new Map<string, DeclaredSymbol[]>();
    for (const candidate of ranked.slice(0, MAX_DECLARATION_READS)) {
      const symbols = declarationsOfCandidate(workspace, candidate.path);
      if (symbols !== undefined) declared.set(candidate.path, symbols);
    }
    ranked = rankNeighbourCandidates(inputs, terms, { rootOf, declared });
  }

  const rows: NeighbourRow[] = [];
  const bases = new Map<string, string>();
  for (const candidate of selectNeighbours(ranked, effective)) {
    const content = readCapped(workspace, candidate.path, MAX_CANDIDATE_BYTES);
    if (content === undefined || content.truncated) continue; // vanished, refused or too large — skip, never guess
    const totalLines = Math.max(1, countLines(content.text));
    const handle = handleTable.upsert({ kind: "range", path: candidate.path, range: `1-${totalLines}`, workspaceRoot: workspace }).id;
    const base = neighbourWhy(candidate);
    bases.set(candidate.path, base);
    rows.push({ path: candidate.path, handle, why: `${base}${matchSuffix(candidate)}` });
  }
  const maxBytes = deps.maxBytes ?? MAX_NEIGHBOURS_BYTES;
  const capped = capByBytes(rows, maxBytes);
  if (capped.length === 0 && rows.length > 0) {
    // The top row alone overflowed: retry it without the optional suffix.
    const first = { ...rows[0]!, why: bases.get(rows[0]!.path) ?? rows[0]!.why };
    return capByBytes([first], maxBytes);
  }
  return capped;
}

/**
 * The hook: call once, at the END of `buildAnswerTaskPack`/
 * `buildSeededTaskPack` — after the final surface set is fixed (after WP-B's
 * `enforceCertificateWireInvariant` in the answer tail) and before booking,
 * though the ordering relative to booking is immaterial to correctness here
 * (this function only ever ADDS `result.neighbours`, never touches
 * `result.surfaces`, so nothing booking reads can be affected either way).
 * Best-effort: a failure while ranking leaves the pack exactly as it was.
 *
 * `opts.headroom` (see `PlanAidOptions`) lets the caller bound the member by
 * what is left of the pack's own wire budget: the rows are capped at
 * `min(1 KiB, headroom() − 48)` — the lowest-ranked rows go first — and
 * nothing is attached when that is under 120 bytes. Evaluated after the flag
 * check, so a flag-OFF pack never calls it.
 */
export function attachFrontierNeighbourIndex(result: TaskPackResult, workspace: string, query?: string, opts?: PlanAidOptions): void {
  if (!neighbourIndexEnabled()) return;
  if (result.ok === false) return; // refusal/broad-overview envelope — nothing served to derive neighbours from
  if (result.surfaces.length === 0) return;
  const maxBytes = planAidCap(MAX_NEIGHBOURS_BYTES, opts);
  if (maxBytes === undefined) return;
  let rows: NeighbourRow[];
  try {
    rows = computeFrontierNeighbourIndex(result, workspace, query, { maxBytes });
  } catch {
    return;
  }
  if (rows.length > 0) result.neighbours = rows;
}
