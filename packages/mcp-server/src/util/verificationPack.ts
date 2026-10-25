/**
 * verificationPack.ts — verification working-set facts for the verifying
 * phase (2026-07-25 harness-desertion forensics, v2 facts-first redesign).
 *
 * Evidence from live agent transcripts: on fix tasks agents hand-build
 * verification harnesses AFTER their last successful tl_edit_file call, and the
 * expensive misses were DIAGNOSES, not bodies — (i) an edited file that does
 * not compile standalone because it uses a type whose header it never
 * includes, (ii) the link set (paired sources of included
 * headers), (iii) which existing tests actually reference the edited files.
 * Serving mock bodies measured 18 KB read / 0 used — bodies are the wrong
 * currency; short facts plus handles are the right one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { walkCodeFiles } from "../tools/walkRepo.js";
import { classifySurface } from "./impact.js";
import { handleTable, shaOfText } from "./handles.js";
import { laneScopedKey } from "./laneKey.js";
import { countLines } from "./countLines.js";
import { projectRootOf } from "../features/locator/locateTaskContext.js";
import { classifyNodeTestRunnability, type NodePackageManifestLike } from "./nodeTestRunnability.js";
import { choosePythonInterpreter, pythonInterpreterSeamInstalled } from "./pythonInterpreter.js";
import type { SyntaxCheck, TaskVerificationRecipe } from "@tokenlighten/types";
import {goVerificationEntry, goPackageName, samePackageGoTest} from "./goVerification.js";

/**
 * Body state for a kit entry that carries no `code` in THIS response.
 * `"omitted"` = never served — fetch it (`verification.next_call` batches every
 * omitted body into one tl_read_file call). `"served-earlier"` = the body already
 * rode an earlier response this session, so your context is current and a
 * re-fetch buys nothing. ONE marker for both meanings read as "never served"
 * and drove native re-reads (2026-07-31 verify-kit-gap forensics).
 */
export type BodyMarker = "omitted" | "served-earlier";

export interface VerificationSurface {
  path: string;
  role: "test" | "mock";
  bytes: number;
  /** Edited rel paths this file references (by basename or stem token). */
  references: string[];
  handle: string;
  /** Whole-file body — TEST files only (a mock body conflicts with real headers). */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
  /**
   * K1 (2026-08-01 verify-kit-diet): `code` holds only the harness entry's
   * head segment (HARNESS_ENTRY_HEAD_LINES), not the whole file — set only
   * when the full body exceeded the per-file cap and this surface is the one
   * that mined harness.build_command.
   */
  content_completeness?: "partial";
  /** Mocks ride handle-only with an explicit scope warning. */
  scope_note?: string;
}

export interface CompileFact {
  path: string;
  /** Workspace headers defining identifiers this file uses but never includes. */
  missing_includes: string[];
  /** Server-attached handles for missing_includes — the same batched verification.next_call serves them (2026-07-31 escapefix-3 forensics: plain path strings were unreachable by any single call, so agents spliced them natively). */
  missing_include_handles?: Array<{ path: string; handle: string }>;
  /** Exact, bounded one-line extern declarations needed when constructing a standalone harness. */
  extern_declarations?: string[];
  note: string;
}

export interface LinkSetEntry {
  path: string;
  bytes: number;
  reason: string;
  handle: string;
  /** Whole-file body — inlined within the shared verification-kit budget. */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
}

/** A mock header the harness must satisfy — always sliceable through `handle`. */
export interface MockHeaderEntry {
  path: string;
  bytes: number;
  handle: string;
  /** Whole-file body — exempt from the per-file cap (see kitBudgetAllocator). */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
  /**
   * L6 (2026-08-08 kit-recipe fix): a mock REPLACES the real header(s) it
   * stubs — linking both into one harness redefines the same enums/structs
   * and fails to build. Names the shadowed real header/directory when that
   * relationship is cheaply derivable from the mock's own filename, else a
   * generic replaces-not-supplements sentence. Always present: every mock
   * header carries this warning, not just the ones this kit can name.
   */
  note: string;
}

export interface HarnessInfo {
  /**
   * 2026-10-19 (decision window 6t-6): a ready-to-run `-fsyntax-only` check of
   * the edited translation units, present exactly when no build system sits
   * above the edits and the host has a compiler for their language. The kit
   * used to say "verify by syntax-only compile" and stop there; every arm-A
   * solver on that window's two C/C++ tasks then composed its own line, and
   * 25 turns ($1.21) went to reading the toolchain's output wrong (see
   * nativeSyntaxCheck). It checks that the edits compile, never what they do,
   * so it rides beside `build_command`, not instead of it.
   *
   * 2026-10-20 (window 6t-7): for Python edits it is `<interpreter> -m
   * py_compile`, present exactly when the PATH's python3 falls short of the
   * project (requires-python, declared modules) and another interpreter
   * meets it (pythonSyntaxCheck); its note says why and to run smoke checks
   * with that interpreter.
   */
  syntax_check?: SyntaxCheck;
  /**
   * First "// Build:"/"# Compile:"/"* Run:"-style marker mined from a
   * referencing test's own header — or, when NO existing test documents one, a
   * command SYNTHESIZED for a harness the caller has yet to author (in which
   * case `build_command_synthesized` is true). Mining always wins.
   *
   * `cwd` (L4, 2026-08-08): present exactly when this command was MINED — a
   * mined command is authored relative to its own source file's directory
   * (a test file's own "// Build: g++ -I../include foo.cpp" is written to
   * run FROM that test's directory), while the caller's shell sits at the
   * workspace root. Rewriting the mined TEXT to be root-relative would risk
   * silently misquoting what the test file actually says; naming the
   * directory to run it FROM keeps the text an honest quote. A synthesized
   * command never carries this — it is already composed from workspace-root-
   * relative paths.
   */
  build_command?: { text: string; source: string; cwd?: string };
  /**
   * Present exactly when `build_command` was synthesized rather than mined: its
   * text names a `<your_harness.*>` file that does not exist yet, so it is a
   * template to substitute into, never a command to run verbatim.
   */
  build_command_synthesized?: true;
  /**
   * L3 (2026-08-07): one further invocation per project source that owns its
   * OWN entry point. A binary has exactly one entry, so such a source can
   * never share `build_command`'s link line with the `<your_harness.*>`
   * placeholder — putting them together is a guaranteed duplicate-`main` link
   * failure, and the agent pays a turn per failed invocation discovering that.
   * Each entry gets its own complete command instead of being silently
   * accumulated onto one. W3 (2026-08-07 L3 recalibration): gated by its OWN
   * per-command budget, independent of whether `build_command` fit its — this
   * CAN ride alongside a DEGRADED `link_candidates` (below) when the primary
   * line missed budget but an individual entrypoint's own, usually much
   * shorter, recipe did not. L4 (2026-08-08): also computed when `build_command`
   * was MINED rather than synthesized — mining answers "how does the EXISTING
   * documented test build", not "how does a session-created entrypoint build",
   * so a mined command must never suppress this field for a DIFFERENT source
   * that owns its own main(). The mined source itself is excluded (its build is
   * already covered by mining) but still counted as a link input, same as today.
   */
  entrypoint_commands?: Array<{ text: string; source: string; entrypoint: string }>;
  /**
   * L3 (2026-08-07): the link inputs a harness needs, emitted INSTEAD of
   * `build_command` when no SOUND single PRIMARY invocation could be
   * composed — the two never ride together. It MAY still ride alongside
   * `entrypoint_commands` (W3, 2026-08-07): a degraded primary says nothing
   * about whether an individual entry-owning source's own recipe also fit
   * its budget. The previous behavior was to drop trailing link-set sources
   * until the command fit its character budget and publish the remainder as
   * a runnable string; that string then failed with undefined symbols, and
   * the agent spent a turn per missing object re-deriving what this server
   * had already computed and thrown away (a measured 6-invocation loop). A
   * command that will not link is worse than an explicit list of what to
   * link, so the list is what ships: `validated: false` says outright that
   * no invocation is being promised.
   */
  link_candidates?: {
    paths: string[];
    validated: false;
    reason: "no-compiler-on-host" | "sources-exceed-command-budget" | "every-source-owns-an-entrypoint";
    note: string;
  };
  /**
   * How to CREATE a harness/test file at all. 2026-08-01 forensics: an agent
   * with ZERO native reads still authored three standalone harness files with
   * native Write/Edit — the kit named every ingredient of the harness but never
   * said the writing tool it was already using could make a new file.
   */
  create_note?: string;
  /** Native mock headers (.h/.hpp/.hh/.hxx) in an edited file's project root — handle always, body within the kit budget. */
  mock_headers?: MockHeaderEntry[];
}

export interface ToolchainInfo {
  cxx?: string;
  cc?: string;
  python3?: boolean;
  /** go.mod projects: whether the Go test runner was found on PATH. */
  go?: boolean;
  build_entry?: string;
  /**
   * Native edits with NO CMakeLists.txt/Makefile/meson.build anywhere up-tree.
   * Stating the ABSENCE removes the native find/README round two separate
   * measured agent attempts each spent asking "is there a build system here?".
   */
  build_entry_absent?: boolean;
  test_entry?: string;
  /** Directory of the detected Node test script or Go module ("." = workspace root). */
  test_entry_dir?: string;
  /**
   * node: install evidence is reachable from `test_entry_dir` (`node_modules`, Yarn PnP) or the script
   * needs nothing installed; python: a venv runner exists. OMITTED (never `false`-by-default) — not
   * `true` or `false` — when a node monorepo member's install may be hoisted one level above the
   * workspace root, outside what this server can see: `verify_note` then says so instead of asserting
   * either way (external v0.14.3 evaluation, 2026-09-27 §6.2, finding #18(c)).
   */
  deps_installed?: boolean;
  /** Present when `deps_installed === false`, or omitted because it could not be determined. */
  verify_note?: string;
}

/** One-line advisory for a verification gap that should change how the agent verifies: dependencies confirmed missing, or install status undetermined. */
export function verificationDependencyNote(manifest: Pick<VerificationManifest, "toolchain">): string | undefined {
  return manifest.toolchain?.deps_installed !== true && typeof manifest.toolchain?.verify_note === "string"
    ? manifest.toolchain.verify_note
    : undefined;
}

export interface VerificationManifest {
  version: 2;
  /** Default strategy; "harness" only when a referencing test exists. */
  verify_strategy: "syntax_only+diff" | "harness";
  surfaces: VerificationSurface[];
  compile_facts: CompileFact[];
  link_set: LinkSetEntry[];
  omitted: number;
  /** Build-command mining + mock-header inventory — omitted when neither yields anything. */
  harness?: HarnessInfo;
  /** Local compiler/build-entry/test-entry facts — omitted for non-native, non-compile-fact edits. */
  toolchain?: ToolchainInfo;
  /** Provenance-only execution recipe; additive to harness/toolchain, never an oracle. */
  recipe?: TaskVerificationRecipe;
  /**
   * S8: server-attached (server.ts labelKitBodies). Repo paths some OTHER kit
   * field names — toolchain.build_entry, harness.build_command.source, recipe
   * refs — that carry no body anywhere else, paired with a handle so the same
   * batched `next_call` can serve them. Never a path already in context.
   */
  named_paths?: Array<{ path: string; handle: string; named_by: string }>;
  note: string;
  /**
   * K3 (2026-08-01 verify-kit-diet): true when this exact kit content already
   * rode the immediately-preceding call for this workspace root — every
   * other field above collapses to its cheapest form (empty arrays, no
   * harness/toolchain/recipe) and `kit_ref` names the unchanged content.
   */
  kit_unchanged?: true;
  /** Present exactly when `kit_unchanged` is true: sha12 of the repeated kit. */
  kit_ref?: string;
}

// ONE inline budget for the whole verification kit (2026-07-30 native-IO-escape
// forensics). The previous split — 16 KB for test surfaces, a separate 8 KB for
// link_set, and mock headers "capped and content-free" by design — NAMED
// artifacts it never served, so agents `cat`ed exactly the named-but-unserved
// files run after run. One budget also lowers the worst-case kit from 24 KB
// to 16 KB. Spend order is by how expensive the alternative source is: mock
// headers (no other cheap source) > link_set sources > paired headers > test
// bodies (the test is already named and usually re-read anyway).
// PER-FILE CAP EXEMPTION (2026-07-31 verify-kit-gap forensics): a family with
// no cheaper source must not be structurally excluded by the per-file cap. The
// ONLY mock header measured in practice was 9848 B, so priority 1 could never
// actually inline it and agents `cat`ed it every time the kit was served.
// Mock headers therefore spend against the REMAINING TOTAL; every other family
// keeps the 4 KB per-file cap, and the 16 KB total still bounds the worst case.
const KIT_INLINE_FILE_CAP_BYTES = 4 * 1024;
const KIT_INLINE_TOTAL_CAP_BYTES = 16 * 1024;
// K1 (2026-08-01 verify-kit-diet): a link_set candidate at or under this size
// is "small" — the 2026-07-31 verify-kit-gap escapes were ALL files in
// roughly this range (os_mutex.h ~1.2KB, hal_uart.h ~1.7KB, mavlink.hpp
// ~1.0KB) that a handful of larger link_set sources spent the shared budget
// ahead of. Header-first, small-first spend order (kitBudgetAllocator callers
// below) keeps them from ever being starved by a source that merely fits
// under the 4KB per-file cap.
const SMALL_VERIFY_SURFACE_BYTES = 2 * 1024;
/** K1: how much of the harness entry's head rides when its full body cannot. */
const HARNESS_ENTRY_HEAD_LINES = 50;
// K2: minimum qualifying-identifier count before the relevance gate acts —
// a one-or-two-token edit carries too little signal to judge another file's
// relevance by (a single incidental token false-dropped legitimate
// referencing tests during development; see collectChangedIdentifiers).
const MIN_EDIT_IDENTIFIER_TOKENS = 3;
// K3: bounded LRU-ish cache of the last kit fingerprint served per workspace.
const KIT_DEDUPE_CACHE_MAX_WORKSPACES = 32;
const SCAN_FILE_CAP_BYTES = 64 * 1024;
const MAX_SURFACES = 6;
const MAX_LINK_SET = 8;
const MAX_PAIRED_HEADERS = 6;
const MAX_MISSING_INCLUDES = 4;
const MAX_EXTERN_DECLARATIONS = 8;
const MAX_MOCK_HEADERS = 6;
const MAX_RECIPE_TARGETS = 12;
const MAX_RECIPE_ASSERTIONS = 6;
const MAX_RECIPE_CONTRACTS = 4;
const MAX_RECIPE_MOCK_CONTROLS = 6;

const NATIVE_SOURCE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx"]);
const NATIVE_HEADER_EXTS = [".h", ".hpp", ".hh", ".hxx"];
const NATIVE_EXTS = new Set([...NATIVE_SOURCE_EXTS, ...NATIVE_HEADER_EXTS]);
const PYTHON_SURFACE_EXTS = new Set([".py", ".pyi"]);
const NODE_SURFACE_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const GO_SURFACE_EXTS = new Set([".go"]);
/** Directory names an `include/` mirror of a source tree is spelled with. */
const SOURCE_DIR_NAMES = ["src", "source", "sources", "lib"];
const HEADER_DIR_NAME = "include";

// Live A/B forensics (2026-07-26): agents escaped to native `cat` for
// exactly the files link_set NAMES but never serves — mock headers, small
// paired RTOS sources, and the build command documented atop a test file
// (`head -30 test/test_foo.cpp` to recover "// Build: g++ ..."). The
// constants below mine that same comment and inventory those same headers.
const BUILD_COMMAND_RE = /(?:\/\/|#|\*)\s*(?:Build|Compile|Run)\s*:\s*(.*)/i;
const BUILD_COMMAND_MAX_CHARS = 200;
const BUILD_COMMAND_SCAN_LINES = 40;
// 2026-08-01 forensics: mining needs a test file that DOCUMENTS a command,
// and on one measured edit no test referenced the edited sources at all. The
// kit served every other harness ingredient (extern declarations, link_set,
// an inlined mock header, build_entry_absent) and the agent — zero native
// reads to that point — still hand-rolled six failing clang++ invocations.
// The compiler, the link set and the include roots were all already known
// here, so the command is synthesized for the harness the caller is about
// to author.
const SYNTH_BUILD_COMMAND_SOURCE = "synthesized";
const SYNTH_HARNESS_PLACEHOLDER_STEM = "your_harness";
const SYNTH_CXX_STD = "-std=c++17";
const SYNTH_C_STD = "-std=c11";
const MAX_SYNTH_INCLUDE_ROOTS = 4;
// W3 (2026-08-07 L3 recalibration): this budget guards RESPONSE-ENVELOPE
// bloat, not link-line correctness — sound-or-silent degradation (never
// truncation) still applies above it, unchanged. 480 was calibrated for the
// OLD truncating synthesizer (drop trailing sources until the string fit)
// and carried over unchanged when L3 (above) replaced truncation with
// degradation, so a realistic HONEST 7-translation-unit link line (~50-70
// chars per path) already exceeded it: the 2026-08-07 bench run measured
// 11/11 previously-served build_command sections on the bench's C++ task
// degrade to 0/17 sound ones, and entrypoint_commands — gated on the SAME
// budget, computed only after this check used to return — never got a
// chance to run. 2048 comfortably fits a realistic 10-15-TU line; a line
// that still exceeds THIS budget keeps degrading rather than dropping
// sources to fit.
const SYNTH_BUILD_COMMAND_MAX_CHARS = 2048;
/** Extensions that make a link set C++ rather than C (a `.h` stays C by default). */
const CXX_FAMILY_EXTS = new Set([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);
const BUILD_ENTRY_NAMES = ["CMakeLists.txt", "Makefile", "meson.build"];
const PY_TEST_MARKER_NAMES = ["pytest.ini", "setup.cfg", "pyproject.toml"];
const GO_TEST_MARKER_NAMES = ["go.mod"];
const GO_CANDIDATES = ["go"];
const CXX_CANDIDATES = ["clang++", "g++"];
const CC_CANDIDATES = ["clang", "gcc", "cc"];
const PYTHON3_CANDIDATES = ["python3"];
const ASSERTION_RE = /\b(?:assert|expect|require|check|verify)(?:[_A-Za-z0-9]*|\s*)\s*\(/i;
const CONTRACT_RE = /\b(?:must|shall|required|guarantee|contract)\b|(?:すること|必要|保証|契約)/i;
const MOCK_CONTROL_RE = /^\s*#\s*(?:define|ifn?def)\s+([A-Z][A-Z0-9_]{2,})\b/;
const BUILD_DEFINE_RE = /(?:^|\s)-D([A-Z][A-Z0-9_]{2,})(?:=\S+)?/g;

function isGoTestPath(relPath: string): boolean {
  return GO_SURFACE_EXTS.has(path.posix.extname(relPath).toLowerCase())
    && path.posix.basename(relPath).endsWith("_test.go");
}

function stemOf(relPath: string): string {
  const base = path.posix.basename(relPath);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

// A repeated Node basename (run.mjs, index.ts, ...) is not a module identity.
// Resolve relative module specifiers before accepting such a filename mention.
// Keep the existing heuristic for unique names and non-Node languages.
function nodeReferenceMatches(candidate: string, content: string, edited: string): boolean {
  const extension = path.posix.extname(edited).toLowerCase();
  const bare = edited.slice(0, -extension.length);
  const aliases = new Set([edited, bare]);
  if (extension === ".ts" || extension === ".tsx") aliases.add(bare + ".js");
  if (extension === ".tsx") aliases.add(bare + ".jsx");
  if (extension === ".mts") aliases.add(bare + ".mjs");
  if (extension === ".cts") aliases.add(bare + ".cjs");
  if (path.posix.basename(bare) === "index") aliases.add(path.posix.dirname(bare));
  const specifiers = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"'\r\n]+)["']/g;
  for (const match of content.matchAll(specifiers)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(candidate), specifier));
    if (aliases.has(resolved)) return true;
  }
  // Test drivers also address scripts by an explicit workspace-relative path.
  return edited.includes("/") && [JSON.stringify(edited), "'" + edited + "'"].some(literal => content.includes(literal));
}

function isMockish(relPath: string): boolean {
  return /(?:^|[/_.])mocks?(?:[/_.]|$)/.test(relPath.toLowerCase());
}

// K2 (2026-08-01 verify-kit-diet): a deliberately simple, language-agnostic
// identifier scan — consistent with the rest of this file's regex-based
// facts (ASSERTION_RE, CONTRACT_RE, MOCK_CONTROL_RE) rather than a real
// parser. Stopwords are common keywords/directives across C/C++/TS/Python so
// a shared word ("return", "import") never manufactures false relevance.
const IDENTIFIER_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const IDENTIFIER_STOPWORDS = new Set([
  "void", "const", "static", "return", "include", "define", "pragma", "struct",
  "class", "namespace", "using", "typedef", "public", "private", "protected",
  "virtual", "template", "export", "import", "from", "default", "function",
  "interface", "extends", "implements", "async", "await", "this", "self",
  "true", "false", "null", "undefined", "pass", "elif", "else", "for", "while",
  "break", "continue", "switch", "case", "catch", "throw", "finally", "new",
  "delete", "sizeof", "enum", "union", "type", "with", "yield", "lambda",
  "raise", "except", "exports", "require", "package", "global",
]);

/** Identifier-shaped tokens in `content`, case-sensitive, stopwords dropped. */
export function identifierTokens(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(IDENTIFIER_TOKEN_RE)) {
    if (!IDENTIFIER_STOPWORDS.has(m[0].toLowerCase())) out.add(m[0]);
  }
  return out;
}

/**
 * K2: identifiers this edit actually touched. Uses the caller's explicit set
 * when supplied (e.g. a future call site mining search/replace hunk text);
 * otherwise falls back to this same-session proxy — the edited files' own
 * CURRENT (post-edit) content — since buildVerificationManifest runs after
 * the edit lands and only ever receives edited rel paths from its existing
 * callers (server.ts attachVerification, readCodeTaskPack.ts construct-
 * receiver). Bounded the same way every other small-file scan in this module
 * is (SCAN_FILE_CAP_BYTES).
 */
function collectChangedIdentifiers(
  workspace: string,
  editedRelPaths: readonly string[],
  explicit: readonly string[] | undefined,
): Set<string> {
  if (explicit !== undefined && explicit.length > 0) return new Set(explicit);
  const out = new Set<string>();
  for (const rel of editedRelPaths) {
    const content = readSmall(workspace, rel);
    if (content === undefined) continue;
    for (const tok of identifierTokens(content)) out.add(tok);
  }
  return out;
}

/** Direct #include targets (quoted or angled), as written. */
function directIncludes(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gm)) {
    out.add(m[1]!);
  }
  return out;
}

/**
 * Explicit one-line extern declarations are high-precision harness facts:
 * unlike inferred call graphs, they are authored linkage requirements and
 * their exact spelling is enough to declare a compatible harness stub.
 */
function externDeclarations(content: string): string[] {
  const out: string[] = [];
  const declarationRe = /^\s*(extern(?:\s+"C")?\s+(?!template\b)[^;{}\r\n]{1,240};)\s*(?:\/\/.*)?$/gm;
  for (const match of content.matchAll(declarationRe)) {
    const declaration = match[1]!.replace(/\s+/g, " ").trim();
    if (!out.includes(declaration)) out.push(declaration);
    if (out.length >= MAX_EXTERN_DECLARATIONS) break;
  }
  return out;
}

/**
 * Header→paired-source mapping (mirrors the task-pack native pairing):
 * include/foo/bar.hpp pairs src/foo/bar.{cpp,cc,cxx,c} and vice versa.
 */
function pairedSources(includeTarget: string, byRel: Map<string, number>): string[] {
  const ext = path.posix.extname(includeTarget).toLowerCase();
  if (!NATIVE_HEADER_EXTS.includes(ext)) return [];
  const stem = includeTarget.slice(0, includeTarget.length - ext.length);
  const out: string[] = [];
  for (const rel of byRel.keys()) {
    const relExt = path.posix.extname(rel).toLowerCase();
    if (!NATIVE_SOURCE_EXTS.has(relExt)) continue;
    const relStem = rel.slice(0, rel.length - relExt.length);
    if (relStem.endsWith(stem) || relStem.replace("/src/", "/include/").endsWith(stem)) {
      out.push(rel);
    }
  }
  return out;
}

/** Replace the last `from` segment of a posix dir with `to` (src/x -> include/x). */
function mirrorDir(dir: string, from: string, to: string): string {
  const segments = dir.split("/");
  const index = segments.lastIndexOf(from);
  if (index < 0) return dir;
  segments[index] = to;
  return segments.join("/");
}

/**
 * Source→sibling-header pairing (the inverse of `pairedSources`): same stem in
 * the same directory or in that directory's `include/` mirror. A harness that
 * compiles a link-set source needs the source's OWN declarations too, and the
 * 2026-07-30 forensics measured agents reading exactly those headers natively
 * because link_set paired headers→sources but never sources→headers.
 */
function pairedHeaders(sourceRel: string, byRel: ReadonlyMap<string, number>): string[] {
  const ext = path.posix.extname(sourceRel).toLowerCase();
  if (!NATIVE_SOURCE_EXTS.has(ext)) return [];
  const stem = path.posix.basename(sourceRel, path.posix.extname(sourceRel));
  const dir = path.posix.dirname(sourceRel);
  const dirs = new Set([dir === "." ? "" : dir]);
  for (const name of SOURCE_DIR_NAMES) dirs.add(mirrorDir(dir, name, HEADER_DIR_NAME));
  const out: string[] = [];
  for (const headerExt of NATIVE_HEADER_EXTS) {
    for (const candidateDir of dirs) {
      const rel = candidateDir === "" || candidateDir === "." ? `${stem}${headerExt}` : `${candidateDir}/${stem}${headerExt}`;
      if (byRel.has(rel) && !out.includes(rel)) out.push(rel);
    }
  }
  return out;
}

/** Identifier-ish tokens defined by a header (typedef/struct/class/enum/using). */
function definedIdentifiers(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/\btypedef\b[^;{]*?\b([A-Za-z_]\w*)\s*;/g)) out.add(m[1]!);
  for (const m of content.matchAll(/\b(?:struct|class|enum(?:\s+class)?|union)\s+([A-Za-z_]\w*)/g)) out.add(m[1]!);
  for (const m of content.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=/g)) out.add(m[1]!);
  return out;
}

interface WalkedFile {
  rel: string;
  bytes: number;
}

function readSmall(workspace: string, rel: string): string | undefined {
  try {
    const abs = path.join(workspace, rel);
    if (fs.statSync(abs).size > SCAN_FILE_CAP_BYTES) return undefined;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** First Build/Compile/Run marker, including shell-style continuation lines. */
function extractBuildCommand(content: string): string | undefined {
  const lines = content.split(/\r?\n/).slice(0, BUILD_COMMAND_SCAN_LINES);
  let text: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const match = BUILD_COMMAND_RE.exec(lines[index]!);
    if (match === null) continue;
    const parts = [match[1]!.trim()];
    if (parts[0] === "" && index + 1 < lines.length) {
      index += 1;
      parts[0] = lines[index]!
        .replace(/^\s*(?:\/\/|#|\*)?\s*/, "")
        .replace(/\s*\*\/\s*$/, "")
        .trim();
    }
    while (parts.at(-1)?.endsWith("\\") && index + 1 < lines.length) {
      parts[parts.length - 1] = parts.at(-1)!.slice(0, -1).trimEnd();
      index += 1;
      const continuation = lines[index]!
        .replace(/^\s*(?:\/\/|#|\*)?\s*/, "")
        .replace(/\s*\*\/\s*$/, "")
        .trim();
      if (continuation.length === 0) break;
      parts.push(continuation);
    }
    text = parts.join(" ").replace(/\s+/g, " ").trim();
    break;
  }
  if (text === undefined) return undefined;
  if (text.length === 0) return undefined;
  return text.length > BUILD_COMMAND_MAX_CHARS ? text.slice(0, BUILD_COMMAND_MAX_CHARS) : text;
}

/**
 * The `-I` root a header must be reached THROUGH, not the directory it sits in:
 * a tree that mirrors sources under `include/` is included as
 * `#include "rtos/os_mutex.h"`, so firmware/include/rtos/os_mutex.h contributes
 * `firmware/include` (the longest directory prefix ending in `include`). Trees
 * without that convention contribute the header's own directory.
 */
function includeRootOf(headerRel: string): string | undefined {
  const dir = path.posix.dirname(headerRel);
  if (dir === "" || dir === ".") return undefined;
  const segments = dir.split("/");
  const index = segments.lastIndexOf(HEADER_DIR_NAME);
  return index < 0 ? dir : segments.slice(0, index + 1).join("/");
}

/** What one synthesis attempt produced: a sound recipe set, or an honest list. */
interface SynthesizedHarnessBuild {
  command?: { text: string; source: string };
  entrypoint_commands?: Array<{ text: string; source: string; entrypoint: string }>;
  link_candidates?: NonNullable<HarnessInfo["link_candidates"]>;
}

/** How many entry-owning sources earn their own recipe before the list is cut. */
const MAX_SYNTH_ENTRYPOINT_COMMANDS = 3;

/**
 * L3 (2026-08-07): does this translation unit provide the program's entry
 * point? A definition of `main`, or one of the standard single-header test
 * frameworks' "this TU supplies main" opt-in macros. Framework-level, not
 * project-level: nothing here knows any particular repository's layout.
 *
 * Conservative by construction — a false positive only costs the source its
 * own separate recipe, while a false negative puts two entry points on one
 * link line, which never links.
 */
const ENTRYPOINT_DEFINITION_RE = /^[ \t]*(?:\[\[[^\]]*\]\][ \t]*)*(?:extern[ \t]+"C"[ \t]+)?(?:static[ \t]+)?(?:int|void|auto)[ \t\n]+main[ \t]*\(/m;
const ENTRYPOINT_FRAMEWORK_MACRO_RE = /^[ \t]*#[ \t]*define[ \t]+(?:CATCH_CONFIG_MAIN|CATCH_CONFIG_RUNNER|BOOST_TEST_MODULE|DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN|UNITY_MAIN)\b/m;

function ownsEntrypoint(rel: string, readContent: (rel: string) => string | undefined): boolean {
  const content = readContent(rel);
  if (content === undefined) return false;
  return ENTRYPOINT_DEFINITION_RE.test(content) || ENTRYPOINT_FRAMEWORK_MACRO_RE.test(content);
}

/** The degraded, explicitly unvalidated form: what to link, with no promise. */
function degradedLinkCandidates(
  sources: readonly string[],
  reason: NonNullable<HarnessInfo["link_candidates"]>["reason"],
): NonNullable<HarnessInfo["link_candidates"]> {
  const note = reason === "no-compiler-on-host"
    ? "no matching compiler was found on this host, so no invocation is promised; these are the translation units a harness for this change has to link"
    : reason === "every-source-owns-an-entrypoint"
      ? "every candidate source defines its own entry point, so none can be linked into one harness binary; build them as separate programs"
      : "the full link line exceeds this field's character budget, and dropping members to fit would produce a command that fails with undefined symbols; these are the translation units to link";
  return { paths: [...sources], validated: false, reason, note };
}

/** Include roots for `headerRels`, first-seen order, deduped. */
function uniqueIncludeRoots(headerRels: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of headerRels) {
    const root = includeRootOf(rel);
    if (root === undefined || out.includes(root)) continue;
    out.push(root);
  }
  return out;
}

/**
 * L4 (2026-08-08 kit-recipe fix): the setup EVERY harness-recipe composer
 * needs — probed compiler, the sources a standalone harness has to link, the
 * `-I` roots their headers live under, and the entrypoint/linkable partition
 * — factored out of `synthesizeHarnessBuildCommand` so the mining-coexistence
 * path below (`synthesizeEntrypointCommandsForMinedHarness`) composes recipes
 * from the IDENTICAL sources/roots/partition, never a re-derived
 * approximation. `undefined` = nothing to link (no link set at all — the
 * served route is the syntax-only compile of the edited file itself);
 * `{ degraded }` = a link set exists but no matching compiler is on the host.
 */
type HarnessSynthPrep =
  | undefined
  | { degraded: NonNullable<HarnessInfo["link_candidates"]> }
  | {
      harnessFile: string;
      sources: string[];
      entrypointSources: string[];
      linkable: string[];
      compose: (entry: string, keptSources: readonly string[], outStem: string) => string;
    };

function prepareHarnessSynthesis(
  toolchain: ToolchainInfo | undefined,
  nativeEdited: readonly string[],
  linkSet: readonly LinkSetEntry[],
  compileFacts: readonly CompileFact[],
  mockHeaders: readonly MockHeaderEntry[],
  byRel: ReadonlyMap<string, number>,
  readContent: (rel: string) => string | undefined,
): HarnessSynthPrep {
  if (linkSet.length === 0) return undefined;
  const extOf = (rel: string): string => path.posix.extname(rel).toLowerCase();
  const isSource = (rel: string): boolean => NATIVE_SOURCE_EXTS.has(extOf(rel));
  const isHeader = (rel: string): boolean => NATIVE_HEADER_EXTS.includes(extOf(rel));
  const linkPaths = linkSet.map((entry) => entry.path);
  const sources = [...new Set([...nativeEdited.filter(isSource), ...linkPaths.filter(isSource)])];
  // The compiler must match the language: `clang` on a C++ link set fails to
  // link the C++ runtime, which is the same failed-invocation loop this field
  // exists to end. probeToolchain reports what is actually installed, never a
  // guess — with no matching compiler there is no invocation to promise, so
  // L3 degrades to the link list instead of inventing a command.
  const cxxFamily = [...nativeEdited, ...linkPaths].some((rel) => CXX_FAMILY_EXTS.has(extOf(rel)));
  const compiler = cxxFamily ? toolchain?.cxx : toolchain?.cc;
  if (compiler === undefined) {
    return sources.length > 0
      ? { degraded: degradedLinkCandidates(sources, "no-compiler-on-host") }
      : undefined;
  }
  // Roots the harness needs, in need order: the edited file's OWN declarations
  // (its paired header is never in link_set — link_set excludes edited paths),
  // then the link set's headers, then the headers compile_facts named missing,
  // then the mocks.
  const headerRoots = uniqueIncludeRoots([
    ...nativeEdited.flatMap((rel) => pairedHeaders(rel, byRel)),
    ...nativeEdited.filter(isHeader),
    ...linkPaths.filter(isHeader),
    ...compileFacts.flatMap((fact) => fact.missing_includes),
  ]);
  const mockRoots = uniqueIncludeRoots(mockHeaders.map((entry) => entry.path))
    .filter((root) => !headerRoots.includes(root));
  const reservedForMocks = Math.min(mockRoots.length, 1);
  const roots = [
    ...headerRoots.slice(0, Math.max(1, MAX_SYNTH_INCLUDE_ROOTS - reservedForMocks)),
    ...mockRoots,
  ].slice(0, MAX_SYNTH_INCLUDE_ROOTS);
  const harnessFile = `<${SYNTH_HARNESS_PLACEHOLDER_STEM}${cxxFamily ? ".cpp" : ".c"}>`;
  // A C++ harness over a link set that includes C sources compiles them all as
  // C++ ON PURPOSE: one consistent name mangling, which links with or without
  // `extern "C"` guards in the headers. Splitting the two (C sources through the
  // C driver, then linking) fails with undefined mangled symbols unless every
  // header happens to be guarded — measured, and the same failed-link class
  // burned six invocations in one observed run. Stating `-x c++` also
  // silences the driver's "treating 'c' input as 'c++'" deprecation warning.
  const explicitLanguage = cxxFamily && sources.some((rel) => extOf(rel) === ".c") ? ["-x", "c++"] : [];
  // L3 (2026-08-07), defect (i): a binary has exactly ONE entry point. A
  // project source that defines its own can never share a link line with the
  // `<your_harness.*>` placeholder (which is the harness's entry) or with
  // another such source — that is a duplicate-`main` link failure every time,
  // and the agent pays a turn per invocation discovering it. Partition first,
  // then emit one complete recipe per entry rather than accumulating them.
  const entrypointSources = sources.filter((rel) => ownsEntrypoint(rel, readContent));
  const linkable = sources.filter((rel) => !entrypointSources.includes(rel));
  // Each recipe names its OWN output: two commands writing the same binary
  // would have the second silently clobber the first.
  const compose = (entry: string, keptSources: readonly string[], outStem: string): string => [
    compiler,
    cxxFamily ? SYNTH_CXX_STD : SYNTH_C_STD,
    ...explicitLanguage,
    entry,
    ...keptSources,
    ...roots.map((root) => `-I ${root}`),
    "-o",
    `<${outStem}>`,
  ].join(" ");
  return { harnessFile, sources, entrypointSources, linkable, compose };
}

/**
 * One recipe per entrypoint-owning source in `prep.entrypointSources`
 * (bounded by MAX_SYNTH_ENTRYPOINT_COMMANDS, dropped if over budget), each
 * linking `prep.linkable` — which by construction never includes another
 * entrypoint owner, so no recipe this returns can carry two entry points.
 * `excludeSource` (L4) additionally skips the ONE source a MINED
 * `build_command` already covers; every other caller passes no exclusion and
 * gets exactly the pre-L4 enumeration.
 */
function composeEntrypointCommands(
  prep: {
    entrypointSources: readonly string[];
    linkable: readonly string[];
    compose: (entry: string, keptSources: readonly string[], outStem: string) => string;
  },
  excludeSource?: string,
): Array<{ text: string; source: string; entrypoint: string }> {
  const out: Array<{ text: string; source: string; entrypoint: string }> = [];
  const candidates = excludeSource === undefined
    ? prep.entrypointSources
    : prep.entrypointSources.filter((rel) => rel !== excludeSource);
  for (const entry of candidates.slice(0, MAX_SYNTH_ENTRYPOINT_COMMANDS)) {
    const withoutSelf = prep.linkable.filter((rel) => rel !== entry);
    const entryText = prep.compose(entry, withoutSelf, stemOf(entry));
    if (entryText.length > SYNTH_BUILD_COMMAND_MAX_CHARS) continue;
    out.push({ text: entryText, source: SYNTH_BUILD_COMMAND_SOURCE, entrypoint: entry });
  }
  return out;
}

/**
 * The compile command for a harness the caller has YET TO AUTHOR, synthesized
 * from facts this manifest already holds: the probed compiler, the sources a
 * standalone harness has to link (the edited implementation FIRST — it is the
 * thing under test — then the link set), and the `-I` roots their headers live
 * under, with mock-header directories last so a real header still wins the
 * search path. Emitted only when mining found nothing; a test-documented
 * command always wins. Never emitted without a link set: with nothing to link,
 * the served route is the syntax-only compile of the edited file itself.
 */
function synthesizeHarnessBuildCommand(
  toolchain: ToolchainInfo | undefined,
  nativeEdited: readonly string[],
  linkSet: readonly LinkSetEntry[],
  compileFacts: readonly CompileFact[],
  mockHeaders: readonly MockHeaderEntry[],
  byRel: ReadonlyMap<string, number>,
  readContent: (rel: string) => string | undefined,
): SynthesizedHarnessBuild | undefined {
  const prep = prepareHarnessSynthesis(toolchain, nativeEdited, linkSet, compileFacts, mockHeaders, byRel, readContent);
  if (prep === undefined) return undefined;
  if ("degraded" in prep) return { link_candidates: prep.degraded };

  // L3 defect (ii)+(iii): the character budget used to be honoured by DROPPING
  // trailing link-set sources — which are the real link dependencies, since
  // `sources` lists the edited files first — and shipping the remainder as a
  // runnable string. That string links with undefined symbols, and re-deriving
  // the evicted objects one failed invocation at a time is exactly the loop
  // this field exists to prevent. A command that cannot link is worse than an
  // honest list, so an over-budget synthesis degrades instead of truncating.
  if (prep.linkable.length === 0) {
    return { link_candidates: degradedLinkCandidates(prep.sources, "every-source-owns-an-entrypoint") };
  }
  const text = prep.compose(prep.harnessFile, prep.linkable, SYNTH_HARNESS_PLACEHOLDER_STEM);
  const primaryFits = text.length <= SYNTH_BUILD_COMMAND_MAX_CHARS;

  // W3 (2026-08-07 L3 recalibration): entrypoint_commands are computed
  // UNCONDITIONALLY from here on — each gated by its OWN per-command budget
  // check below, never short-circuited by the PRIMARY command's budget. The
  // previous shape returned as soon as the primary line missed budget, so
  // this loop — entrypoint_commands, L3(i)'s headline feature — never ran on
  // any over-budget primary and was measured emitted 0 times across 60 bench
  // cells, even when an individual entrypoint recipe (one entry plus the
  // shared link set, never every entry point at once) would have fit
  // comfortably under budget on its own.
  const entrypointCommands = composeEntrypointCommands(prep);
  // The primary command degrades ALONE when it misses budget — never by
  // dropping sources to fit, so the whole-or-nothing principle above is
  // unchanged — but a degraded primary no longer suppresses whatever
  // entrypoint recipes DID independently fit; they ride alongside the
  // degraded link_candidates instead of being discarded along with it.
  if (!primaryFits) {
    return {
      link_candidates: degradedLinkCandidates(prep.sources, "sources-exceed-command-budget"),
      ...(entrypointCommands.length > 0 ? { entrypoint_commands: entrypointCommands } : {}),
    };
  }
  return {
    command: { text, source: SYNTH_BUILD_COMMAND_SOURCE },
    ...(entrypointCommands.length > 0 ? { entrypoint_commands: entrypointCommands } : {}),
  };
}

/**
 * L4 (2026-08-08 kit-recipe fix, Blocker 1): entrypoint_commands computed
 * ALONGSIDE a MINED build_command, instead of `synthesizeHarnessBuildCommand`
 * (and therefore entrypoint_commands, L3's headline feature) being
 * structurally unreachable for the WHOLE kit whenever some OTHER, unrelated
 * test happened to document a build command. Measured: a mined command from
 * one test file (documenting how to build THAT test) short-circuited the
 * synthesizer unconditionally, so a session that created a brand-new
 * main()-owning file — which the mined command cannot possibly describe —
 * never got a recipe for it; T13 rep1 hand-rebuilt a link closure over 4
 * turns / 2 failed builds to rediscover a source this server already knew
 * belonged in it.
 *
 * Reuses `prepareHarnessSynthesis`/`composeEntrypointCommands` so the
 * entrypoint recipe's link closure is never a re-derived approximation of
 * what the full synthesizer would have computed. Never returns a primary
 * `command` or `link_candidates` — mining already owns that slot
 * (`HarnessInfo.build_command`'s own contract: mined and synthesized never
 * ride together) — only the per-entrypoint recipes a mined command cannot
 * describe. Unlike the full synthesizer, an empty `linkable` here is not a
 * reason to degrade: entrypoint-only mode never composes the
 * shared-placeholder PRIMARY command `linkable` exists to feed, so a
 * self-contained entrypoint (nothing else to link) still gets a short, valid
 * recipe instead of losing it to a degradation branch built for a different
 * question. `minedSource` is excluded from the entrypoint enumeration (its
 * own build is already covered by mining) but — same as any other
 * non-entrypoint-owning source — stays available as a link input for every
 * OTHER entrypoint's recipe.
 */
function synthesizeEntrypointCommandsForMinedHarness(
  toolchain: ToolchainInfo | undefined,
  nativeEdited: readonly string[],
  linkSet: readonly LinkSetEntry[],
  compileFacts: readonly CompileFact[],
  mockHeaders: readonly MockHeaderEntry[],
  byRel: ReadonlyMap<string, number>,
  readContent: (rel: string) => string | undefined,
  minedSource: string,
): Array<{ text: string; source: string; entrypoint: string }> | undefined {
  const prep = prepareHarnessSynthesis(toolchain, nativeEdited, linkSet, compileFacts, mockHeaders, byRel, readContent);
  if (prep === undefined || "degraded" in prep) return undefined;
  const commands = composeEntrypointCommands(prep, minedSource);
  return commands.length > 0 ? commands : undefined;
}

// ---------------------------------------------------------------------------
// harness.syntax_check (2026-10-19, decision window 6t-6 forensics,
// bench/workflows/runs/2026-10-19-v016-decision-6t-6, T05c and T13, arm A).
// The kit said "verify by syntax-only compile" and named the compiler but gave
// no command, so each of the six cells composed its own `clang++ -I…` line
// (five of them `-fsyntax-only`). 25 turns ($1.21) then went to reading the
// toolchain's output wrong: the macOS xcrun shim's "couldn't create cache
// file" warning taken for a compile error, a `| grep -v` or `| head` status
// taken for the compiler's. 18 of those turns came after such a kit. The
// command below is composed from the edits' own #include directives,
// resolved the way the preprocessor resolves them, and prints the compiler's
// own exit status.
// ---------------------------------------------------------------------------

/** Translation units one command names before the rest are listed `unchecked`. */
const SYNTAX_CHECK_MAX_UNITS = 8;
/** Files one include closure reads; the closure decides `-I` roots and header coverage only. */
const INCLUDE_SCAN_MAX_FILES = 200;
/**
 * POSIX shells: print the COMPILER's status. A pipe the caller adds reports
 * its own (`| grep -v` exits 1 when it filters every line), which is one of
 * the two misreadings this field exists to end.
 */
const SYNTAX_CHECK_EXIT_ECHO = '; echo "exit=$?"';
const SYNTAX_CHECK_NOTE = "run from the workspace root: a clean pass prints only exit=0";
const SYNTAX_CHECK_NOTE_WIN32 = "run from the workspace root: exit code 0 is a pass";
/**
 * The other misreading. On darwin, /usr/bin's clang++, clang, cc, git and
 * python3 are xcrun shims, and a shell that cannot write the per-user temp dir
 * xcrun caches in (a sandboxed one) prints this line on every call while the
 * tool itself runs normally. Four of the window's six arm-A cells then spent
 * 4-7 turns each on TMPDIR, SDK paths and deliberately broken files, proving
 * that the compiler worked.
 */
const SYNTAX_CHECK_XCRUN_CLAUSE = "; a \"couldn't create cache file\" line is the macOS xcrun shim's, not a compile error";
const INCLUDE_DIRECTIVE_RE = /^[ \t]*#[ \t]*include[ \t]*([<"])([^">\r\n]+)[">]/gm;

/** `base/rel` normalized ("" = the workspace root), or undefined when it would leave the workspace. */
function joinWorkspaceRel(base: string, rel: string): string | undefined {
  const joined = path.posix.normalize(base === "" ? rel : `${base}/${rel}`);
  if (joined === ".") return "";
  if (joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined)) return undefined;
  return joined;
}

/** The workspace-relative directory holding `rel` ("" at the root). */
function dirOfRel(rel: string): string {
  const dir = path.posix.dirname(rel);
  return dir === "." ? "" : dir;
}

/** Leading directory segments two workspace paths share. */
function sharedDirSegments(a: string, b: string): number {
  const left = dirOfRel(a).split("/");
  const right = dirOfRel(b).split("/");
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] !== "" && left[shared] === right[shared]) shared += 1;
  return shared;
}

interface IncludeScan {
  /** `-I` roots in first-need order ("" = the workspace root). */
  roots: string[];
  /** Every workspace file the scanned units reach, the units included. */
  reached: Set<string>;
  add(units: readonly string[]): void;
}

/**
 * The preprocessor's own search, over the workspace's files: a quoted include
 * first beside its includer, then every root found so far, then each ancestor
 * D of the includer's directory as `D/<target>` and `D/include/<target>`, then
 * the workspace header whose path ends in `/<target>` nearest the includer.
 * A target the last two find contributes its root; a system header resolves
 * to nothing and contributes nothing. Nothing here knows a project's names.
 */
function createIncludeScan(
  byRel: ReadonlyMap<string, number>,
  readContent: (rel: string) => string | undefined,
): IncludeScan {
  const roots: string[] = [];
  const reached = new Set<string>();
  const queue: string[] = [];
  let scanned = 0;
  let byBasename: Map<string, string[]> | undefined;
  const endingIn = (target: string): string[] => {
    if (byBasename === undefined) {
      byBasename = new Map();
      for (const rel of byRel.keys()) {
        const name = path.posix.basename(rel);
        const list = byBasename.get(name);
        if (list === undefined) byBasename.set(name, [rel]);
        else list.push(rel);
      }
    }
    return (byBasename.get(path.posix.basename(target)) ?? []).filter((rel) => rel.endsWith(`/${target}`));
  };
  const resolve = (from: string, target: string, quoted: boolean): { rel: string; root?: string } | undefined => {
    const fromDir = dirOfRel(from);
    if (quoted) {
      const local = joinWorkspaceRel(fromDir, target);
      if (local !== undefined && byRel.has(local)) return { rel: local };
    }
    for (const root of roots) {
      const viaRoot = joinWorkspaceRel(root, target);
      if (viaRoot !== undefined && byRel.has(viaRoot)) return { rel: viaRoot };
    }
    for (let dir = fromDir; ; dir = dirOfRel(dir)) {
      for (const base of [dir, joinWorkspaceRel(dir, HEADER_DIR_NAME)]) {
        if (base === undefined) continue;
        const candidate = joinWorkspaceRel(base, target);
        if (candidate !== undefined && byRel.has(candidate)) return { rel: candidate, root: base };
      }
      if (dir === "") break;
    }
    if (target.startsWith("../")) return undefined;
    const nearest = endingIn(target).sort((a, b) =>
      sharedDirSegments(b, from) - sharedDirSegments(a, from) || a.length - b.length || a.localeCompare(b))[0];
    return nearest === undefined ? undefined : { rel: nearest, root: nearest.slice(0, nearest.length - target.length - 1) };
  };
  return {
    roots,
    reached,
    add(units) {
      for (const unit of units) {
        if (reached.has(unit)) continue;
        reached.add(unit);
        queue.push(unit);
      }
      while (queue.length > 0 && scanned < INCLUDE_SCAN_MAX_FILES) {
        const rel = queue.shift()!;
        scanned += 1;
        const content = readContent(rel);
        if (content === undefined) continue;
        for (const match of content.matchAll(INCLUDE_DIRECTIVE_RE)) {
          const target = path.posix.normalize(match[2]!.trim().replace(/\\/g, "/"));
          if (target === "." || target === "" || path.posix.isAbsolute(target)) continue;
          const hit = resolve(rel, target, match[1] === '"');
          if (hit === undefined) continue;
          if (hit.root !== undefined && !roots.includes(hit.root)) roots.push(hit.root);
          if (reached.has(hit.rel)) continue;
          reached.add(hit.rel);
          queue.push(hit.rel);
        }
      }
    },
  };
}

/** The source a header declares: same stem beside it, or in the `src/`-style mirror of its `include/` directory. */
function pairedSourceOfHeader(headerRel: string, byRel: ReadonlyMap<string, number>): string | undefined {
  const ext = path.posix.extname(headerRel);
  if (!NATIVE_HEADER_EXTS.includes(ext.toLowerCase())) return undefined;
  const stem = path.posix.basename(headerRel, ext);
  const dir = dirOfRel(headerRel);
  for (const candidateDir of new Set([dir, ...SOURCE_DIR_NAMES.map((name) => mirrorDir(dir, HEADER_DIR_NAME, name))])) {
    for (const sourceExt of NATIVE_SOURCE_EXTS) {
      const rel = candidateDir === "" ? `${stem}${sourceExt}` : `${candidateDir}/${stem}${sourceExt}`;
      if (byRel.has(rel)) return rel;
    }
  }
  return undefined;
}

/** One shell word: as written when it needs no quoting, else quoted for the platform's shell. */
function shellWord(word: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./+=:@%,-]+$/.test(word)) return word;
  return platform === "win32" ? `"${word.replace(/"/g, '\\"')}"` : `'${word.replace(/'/g, "'\\''")}'`;
}

/** The `-std=` flag a documented build line states for each language family. */
function documentedStd(text: string | undefined): { cxx?: string; c?: string } {
  const out: { cxx?: string; c?: string } = {};
  for (const match of (text ?? "").matchAll(/(?:^|\s)(-std=(\S+))/g)) {
    const value = match[2]!.toLowerCase();
    if (/^(?:c|gnu)\+\+/.test(value)) out.cxx ??= match[1]!;
    else if (/^(?:c|gnu)\d|^iso9899:/.test(value)) out.c ??= match[1]!;
  }
  return out;
}

/**
 * The ready-to-run syntax check of the native files among `paths`, or
 * undefined when none exists on disk or the host has no compiler for any of
 * them. Translation units are checked directly; a header through a checked
 * unit that reaches it, else through the source it pairs with. `-I` roots
 * come from createIncludeScan, `-std` from `options.std` (a documented build
 * line) or the same defaults the synthesized harness command uses.
 * Exported for the task pack's verify hint (readCodeTaskPack.ts
 * discoverVerificationHints), which states the same command before any edit.
 */
export function nativeSyntaxCheck(
  workspace: string,
  paths: readonly string[],
  options: {
    toolchain?: Pick<ToolchainInfo, "cxx" | "cc">;
    /** Workspace files to resolve includes against; walked when absent. */
    byRel?: ReadonlyMap<string, number>;
    std?: { cxx?: string; c?: string };
    maxUnits?: number;
    platform?: NodeJS.Platform;
  } = {},
): SyntaxCheck | undefined {
  const extOf = (rel: string): string => path.posix.extname(rel).toLowerCase();
  const native = [...new Set(paths.map((rel) => rel.replace(/\\/g, "/")))].filter((rel) => NATIVE_EXTS.has(extOf(rel)));
  if (native.length === 0) return undefined;
  const isFile = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(workspace, rel)).isFile();
    } catch {
      return false;
    }
  };
  const byRel = options.byRel
    ?? new Map(walkCodeFiles(workspace, {}).map((file) => [file.relPath.replace(/\\/g, "/"), 0] as const));
  const readContent = (rel: string): string | undefined => readSmall(workspace, rel);
  const toolchain = options.toolchain ?? probeToolchain();
  const platform = options.platform ?? process.platform;
  const maxUnits = options.maxUnits ?? SYNTAX_CHECK_MAX_UNITS;
  const families = [
    { compiler: toolchain.cxx, std: options.std?.cxx ?? SYNTH_CXX_STD, units: [] as string[], scan: createIncludeScan(byRel, readContent) },
    { compiler: toolchain.cc, std: options.std?.c ?? SYNTH_C_STD, units: [] as string[], scan: createIncludeScan(byRel, readContent) },
  ];
  const familyOf = (rel: string) => families[extOf(rel) === ".c" ? 1 : 0]!;
  /** Make `unit` a checked translation unit; false when its family has no compiler or no room. */
  const enroll = (unit: string): boolean => {
    const family = familyOf(unit);
    if (family.units.includes(unit)) return true;
    if (family.compiler === undefined || family.units.length >= maxUnits) return false;
    family.units.push(unit);
    family.scan.add([unit]);
    return true;
  };
  const unchecked: string[] = [];
  for (const rel of native) {
    if (NATIVE_SOURCE_EXTS.has(extOf(rel)) && isFile(rel) && !enroll(rel)) unchecked.push(rel);
  }
  for (const header of native) {
    if (NATIVE_SOURCE_EXTS.has(extOf(header)) || !isFile(header)) continue;
    if (families.some((family) => family.scan.reached.has(header))) continue;
    const paired = pairedSourceOfHeader(header, byRel);
    if (paired !== undefined && enroll(paired) && familyOf(paired).scan.reached.has(header)) continue;
    unchecked.push(header);
  }
  const commands = families
    .filter((family) => family.units.length > 0)
    .map((family) => [
      family.compiler!,
      family.std,
      "-fsyntax-only",
      ...family.scan.roots.map((root) => `-I ${shellWord(root === "" ? "." : root, platform)}`),
      ...family.units.map((unit) => shellWord(unit, platform)),
    ].join(" ") + (platform === "win32" ? "" : SYNTAX_CHECK_EXIT_ECHO));
  if (commands.length === 0) return undefined;
  return {
    commands,
    ...(unchecked.length > 0 ? { unchecked } : {}),
    note: platform === "win32"
      ? SYNTAX_CHECK_NOTE_WIN32
      : `${SYNTAX_CHECK_NOTE}${platform === "darwin" ? SYNTAX_CHECK_XCRUN_CLAUSE : ""}`,
  };
}

// ---------------------------------------------------------------------------
// The Python counterpart (2026-10-20, decision window 6t-7 forensics,
// bench/workflows/runs/2026-10-20-v016-decision-6t-7, T10 arm A). The edit kit
// said verification was not applicable to the edited module (no referencing
// test, mock or compile fact) and the first pack asked for "ONE smoke run"
// without naming an interpreter. The host's python3 was the Xcode shim's 3.9.6
// against requires-python >=3.10, and every cell spent 4-7 Bash turns finding
// /opt/homebrew/bin/python3.12. pythonInterpreter.ts picks the interpreter;
// this states the check and why.
// ---------------------------------------------------------------------------

/**
 * `<interpreter> -m py_compile <files>` for the .py files among `paths`, with
 * pythonInterpreter.ts's one-line why, or undefined when the PATH's python3
 * already satisfies their project (the common case adds nothing), when no
 * candidate does, or when a test pinned the toolchain lookup
 * (setToolchainPathLookupForTest) without pinning the Python probe. Exported
 * for the task pack's verify (readCodeTaskPack.ts discoverVerificationHints
 * and attachPythonInterpreterHint), which states the same check before any
 * edit.
 */
export function pythonSyntaxCheck(
  workspace: string,
  paths: readonly string[],
  options: {
    /** Modules the caller knows the target needs (openpyxl for an .xlsx source). */
    extraModules?: readonly string[];
    maxUnits?: number;
    platform?: NodeJS.Platform;
    /** Accept files not on disk yet: a pack's create target. */
    includeMissing?: boolean;
  } = {},
): SyntaxCheck | undefined {
  if (pathLookupOverride !== undefined && !pythonInterpreterSeamInstalled()) return undefined;
  const platform = options.platform ?? process.platform;
  const files = [...new Set(paths.map((rel) => path.posix.normalize(rel.replace(/\\/g, "/"))))]
    .filter((rel) => path.posix.extname(rel).toLowerCase() === ".py")
    .filter((rel) => {
      if (options.includeMissing === true) return true;
      try {
        return fs.statSync(path.join(workspace, rel)).isFile();
      } catch {
        return false;
      }
    });
  if (files.length === 0) return undefined;
  const clause = platform === "darwin" ? SYNTAX_CHECK_XCRUN_CLAUSE : "";
  const choice = choosePythonInterpreter(workspace, files, {
    locate: locateOnPath,
    ...(options.extraModules !== undefined ? { extraModules: options.extraModules } : {}),
    noteMaxBytes: KIT_NOTE_MAX_BYTES - Buffer.byteLength(clause, "utf8"),
  });
  if (choice === undefined) return undefined;
  const checked = choice.files.slice(0, options.maxUnits ?? SYNTAX_CHECK_MAX_UNITS);
  const unchecked = files.filter((rel) => !checked.includes(rel));
  return {
    commands: [
      [choice.interpreter, "-m", "py_compile", ...checked].map((word) => shellWord(word, platform)).join(" ")
        + (platform === "win32" ? "" : SYNTAX_CHECK_EXIT_ECHO),
    ],
    ...(unchecked.length > 0 ? { unchecked } : {}),
    note: `${choice.note}${clause}`,
  };
}

/**
 * `rel:line` of every assertion line whose ±24-line window contains EVERY
 * behavior anchor. Exported for the P1 evidence resolver (D7 behavioral
 * class), which calls it one anchor at a time so each hit can name the anchor
 * that produced it.
 */
export function assertionRefs(
  entries: readonly { rel: string; role: "test" | "mock"; content: string }[],
  behaviorAnchors: readonly string[],
): string[] {
  const refs: string[] = [];
  const anchors = behaviorAnchors
    .map((anchor) => anchor.toLowerCase())
    .filter((anchor, index, all) => anchor.length > 0 && all.indexOf(anchor) === index);
  for (const entry of entries) {
    if (entry.role !== "test") continue;
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!ASSERTION_RE.test(lines[index]!)) continue;
      if (anchors.length > 0) {
        const context = lines
          .slice(Math.max(0, index - 24), Math.min(lines.length, index + 25))
          .join("\n")
          .toLowerCase();
        if (!anchors.every((anchor) => context.includes(anchor))) continue;
      }
      refs.push(`${entry.rel}:${index + 1}`);
      if (refs.length >= MAX_RECIPE_ASSERTIONS) return refs;
    }
  }
  return refs;
}

function contractRefs(
  workspace: string,
  editedRoots: ReadonlySet<string>,
  needles: ReadonlyMap<string, string>,
): string[] {
  const refs: string[] = [];
  for (const file of walkCodeFiles(workspace, { extraExts: [".md", ".markdown", ".txt"] })) {
    if (!/\.(?:md|markdown|txt)$/i.test(file.relPath)) continue;
    if (!editedRoots.has(projectRootOf(file.relPath, workspace))) continue;
    const content = readSmall(workspace, file.relPath);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const lower = line.toLowerCase();
      if (!CONTRACT_RE.test(line)) continue;
      if (![...needles.keys()].some((needle) => lower.includes(needle))) continue;
      refs.push(`${file.relPath}:${index + 1}`);
      if (refs.length >= MAX_RECIPE_CONTRACTS) return refs;
    }
  }
  return refs;
}

function mockControlRefs(
  workspace: string,
  selected: readonly { rel: string; role: "test" | "mock"; content: string }[],
  mockHeaders: readonly { path: string; bytes: number }[],
  buildCommand: { text: string; source: string } | undefined,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const sources = new Map(selected
    .filter((entry) => entry.role === "mock")
    .map((entry) => [entry.rel, entry.content]));
  for (const header of mockHeaders) {
    if (!sources.has(header.path)) {
      const content = readSmall(workspace, header.path);
      if (content !== undefined) sources.set(header.path, content);
    }
  }
  for (const [source, content] of sources) {
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const symbol = MOCK_CONTROL_RE.exec(lines[index]!)?.[1];
      if (symbol === undefined || seen.has(symbol)) continue;
      seen.add(symbol);
      refs.push(`${source}:${index + 1}#${symbol}`);
      if (refs.length >= MAX_RECIPE_MOCK_CONTROLS) return refs;
    }
  }
  if (buildCommand !== undefined) {
    for (const match of buildCommand.text.matchAll(BUILD_DEFINE_RE)) {
      const symbol = match[1]!;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      refs.push(`${buildCommand.source}:1#${symbol}`);
      if (refs.length >= MAX_RECIPE_MOCK_CONTROLS) break;
    }
  }
  return refs;
}

/**
 * First candidate name (in priority order) found in any PATH directory.
 * Directories are checked in PATH order so a prepended/local dir wins over a
 * later system one; fs-only — no child_process, no shelling out to `which`.
 */
function executableSuffixes(): readonly string[] {
  // POSIX: an executable carries no mandatory extension, so the bare
  // candidate name is the whole probe — byte-identical to the pre-fix loop.
  if (process.platform !== "win32") return [""];
  // win32: a real toolchain ships `clang++.exe` / `g++.exe` and NEVER an
  // extensionless twin on PATH, so a bare-name `existsSync` reports "no C/C++
  // toolchain found" on every Windows box that HAS one installed. PATHEXT is
  // the platform's own answer to "which suffixes make this name runnable";
  // the fallback matches cmd.exe's built-in default. The bare name still
  // comes first so an extensionless MSYS/Cygwin shim keeps winning.
  const raw = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw.split(";").map((ext) => ext.trim()).filter((ext) => ext.length > 0);
  return ["", ...exts];
}

/** The first PATH hit among `candidates`: PATH order first, then candidate priority, then suffix. */
function firstOnPath(candidates: readonly string[]): { dir: string; name: string; suffix: string } | undefined {
  // path.delimiter is ";" on win32 and ":" elsewhere — a hardcoded ":" both
  // fails to split a win32 PATH and mis-splits inside each entry's drive
  // letter ("C:\\..."); see core2/config.ts's TOKENLIGHTEN_ALLOWED_PARENTS
  // parsing for the same pattern.
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const suffixes = executableSuffixes();
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    for (const name of candidates) {
      for (const suffix of suffixes) {
        try {
          if (fs.existsSync(path.join(dir, name + suffix))) return { dir, name, suffix };
        } catch {
          // unreadable PATH entry — keep scanning
        }
      }
    }
  }
  return undefined;
}

function findOnPath(candidates: readonly string[]): string | undefined {
  // The BARE name is returned, never `name + suffix`: the value is spelled
  // into a verification command, and every Windows shell resolves `clang++`
  // through PATHEXT itself — so the emitted manifest stays identical across
  // platforms.
  return firstOnPath(candidates)?.name;
}

/**
 * Where `name` resolves on PATH: the absolute path of the file found, suffix
 * included. pythonSyntaxCheck probes and names one specific interpreter, so
 * unlike findOnPath it needs the file, not the name a shell would resolve.
 */
function locateOnPath(name: string): string | undefined {
  const hit = firstOnPath([name]);
  return hit === undefined ? undefined : path.resolve(hit.dir, hit.name + hit.suffix);
}

/** PATH lookup seam: `(candidates) => first name present`, injectable for tests. */
export type PathLookup = (candidates: readonly string[]) => string | undefined;

let pathLookupOverride: PathLookup | undefined;

/**
 * Test seam: pin the toolchain PATH probe so a verdict assertion does not
 * depend on what the host happens to have installed. Pass `undefined` to
 * restore the real PATH scan.
 */
export function setToolchainPathLookupForTest(lookup: PathLookup | undefined): void {
  pathLookupOverride = lookup;
}

export interface ToolchainProbe {
  /** First C++ compiler found on PATH. */
  cxx?: string;
  /** First C compiler found on PATH. */
  cc?: string;
  python3: boolean;
  go: boolean;
}

/**
 * The single "what can this host actually run" probe, shared by the edit-time
 * manifest and the pack-time runnability verdict. Before it was shared, the two
 * disagreed: the manifest probed clang++/g++ while the pack-time verdict knew
 * only npm/pytest, so a C++ fix task was told verification was unavailable with
 * clang++ on PATH (2026-07-30 forensics).
 */
export function probeToolchain(lookup: PathLookup = pathLookupOverride ?? findOnPath): ToolchainProbe {
  const cxx = lookup(CXX_CANDIDATES);
  const cc = lookup(CC_CANDIDATES);
  return {
    ...(cxx !== undefined ? { cxx } : {}),
    ...(cc !== undefined ? { cc } : {}),
    python3: lookup(PYTHON3_CANDIDATES) !== undefined,
    go: lookup(GO_CANDIDATES) !== undefined,
  };
}

/** Which toolchain a surface/edit set belongs to. */
export type ToolchainDomain = "native" | "python" | "node" | "go" | "other";

/**
 * Plurality vote over file extensions, ties broken native > python > node so
 * the family that gates a COMPILE wins. This is what keeps an unrelated
 * ancestor package.json from claiming a C/C++ surface set as an npm project.
 */
export function surfaceToolchainDomain(paths: readonly string[]): ToolchainDomain {
  let native = 0;
  let python = 0;
  let node = 0;
  let go = 0;
  for (const rel of paths) {
    const ext = path.posix.extname(rel).toLowerCase();
    if (NATIVE_EXTS.has(ext)) native += 1;
    else if (PYTHON_SURFACE_EXTS.has(ext)) python += 1;
    else if (NODE_SURFACE_EXTS.has(ext)) node += 1;
    else if (GO_SURFACE_EXTS.has(ext)) go += 1;
  }
  const top = Math.max(native, python, node, go);
  if (top === 0) return "other";
  if (native === top) return "native";
  if (python === top) return "python";
  if (node === top) return "node";
  return "go";
}

/**
 * Nearest CMakeLists.txt/Makefile/meson.build walking up from `fromDir` to the workspace root ("" = root).
 *
 * Copilot standard-setup evaluation (2026-10-02): `fromDir` can be ABSOLUTE — a caller-supplied absolute
 * `targets[].path` reaches the pack's native verdict unnormalized — and `dirname("/")` is "/" forever, so
 * the walk never reached its "" stop: `tl_read_file {query:"Report RETRY_LIMIT constant value.",
 * targets:[{path:<absolute .cpp>}]}` spun at 100% CPU (an existsSync per build-entry name per turn) until the
 * host gave up. An absolute dir inside the workspace is walked as its workspace-relative form, one outside it
 * has no build entry this workspace owns, and a dir that is its own parent ends the walk. A spelling that
 * only reaches the workspace through a symlink (macOS /var vs /private/var, a linked checkout) is compared
 * by real path (review 2026-10-02).
 */
export function findBuildEntry(workspace: string, fromDir: string): string | undefined {
  let dir = fromDir;
  if (path.isAbsolute(dir)) {
    const escapes = (rel: string): boolean => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    let rel = path.relative(workspace, dir);
    if (escapes(rel)) {
      try {
        rel = path.relative(fs.realpathSync.native(workspace), fs.realpathSync.native(dir));
      } catch {
        return undefined;
      }
      if (escapes(rel)) return undefined;
    }
    dir = rel.split(path.sep).join("/");
  }
  for (;;) {
    for (const name of BUILD_ENTRY_NAMES) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (fs.existsSync(path.join(workspace, rel))) return rel;
    }
    if (dir === "") return undefined;
    const parent = path.posix.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent === "." ? "" : parent;
  }
}

/** What can actually be RUN to verify these edits, and whether it can run NOW. */
interface TestEntryFact {
  /** "npm test" | "pytest" | "go test ./pkg/...". */
  command: string;
  /** node only: directory whose package.json declared scripts.test ("" = workspace root). */
  dir?: string;
  /**
   * node: install evidence (`node_modules`, or a Yarn PnP loader/cache — see `hasInstallEvidence`) is
   * reachable, or the script needs nothing installed; python: a venv runner exists at the matched root.
   * `undefined` (node only): not determinable — see `installEvidenceJustAboveWorkspaceRoot`. Mirrors the
   * pack-time runnability verdict (readCodeTaskPack.ts buildVerificationVerdict) rather than importing it,
   * so the edit-time kit and the pack-time verdict cannot disagree about the same checkout while each
   * stays inside its own module boundary; that verdict has no wire slot for "not determinable" and keeps
   * its pre-existing (boolean-only) call shape, which this module's default parameter preserves exactly.
   */
  deps_installed: boolean | undefined;
}

/** Yarn PnP's generated loader — its presence is as definitive as a `node_modules` directory. */
const YARN_PNP_LOADER_NAMES = ["pnp.cjs", "pnp.js"].map((name) => `.${name}`);

/**
 * `node_modules` is a directory at `<workspace>/<rel>`, OR the same location carries Yarn PnP install
 * evidence (`.pnp.cjs`/`.pnp.js` — the generated loader a `yarn install` under `nodeLinker: pnp` writes,
 * or a populated `.yarn/cache`) — PnP replaces node_modules entirely, so its absence must never read as
 * "not installed" (external v0.14.3 evaluation, 2026-09-27 §6.2, finding #18(b)).
 */
function hasInstallEvidence(workspace: string, rel: string): boolean {
  const dir = path.join(workspace, rel);
  try {
    if (fs.statSync(path.join(dir, "node_modules")).isDirectory()) return true;
  } catch {
    // absent — keep checking other markers
  }
  for (const name of YARN_PNP_LOADER_NAMES) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return true;
    } catch {
      // absent — keep checking
    }
  }
  try {
    if (fs.statSync(path.join(dir, ".yarn", "cache")).isDirectory()) return true;
  } catch {
    // absent
  }
  return false;
}

/**
 * True when `<dir>` or any ancestor up to (and including) the workspace root carries install evidence
 * (`hasInstallEvidence`) — Node's own resolution walks upward, so a hoisted monorepo install counts. Never
 * looks outside the workspace; kept under its original name (readCodeTaskPack.ts imports it by this exact
 * name and must not disagree with this module about what "reachable" means).
 */
export function nodeModulesReachableFrom(workspace: string, dir: string): boolean {
  let rel = dir === "." ? "" : dir;
  for (;;) {
    if (hasInstallEvidence(workspace, rel)) return true;
    if (rel === "") return false;
    const parent = path.posix.dirname(rel);
    rel = parent === "." || parent === "/" ? "" : parent;
  }
}

/**
 * One bounded, content-free existence peek exactly at the workspace root's OWN parent — never further,
 * never workspace-internal content, and never used to grant "installed" — for the ONE ambiguity
 * `nodeModulesReachableFrom` cannot resolve honestly by walking inside the workspace: a monorepo member
 * opened directly as the workspace root, whose install is hoisted to the true monorepo root one level
 * above (external v0.14.3 evaluation, 2026-09-27 §6.2, finding #18(c)). `false` whenever the workspace
 * itself has no parent (already a filesystem/drive root), so there is nothing to be ambiguous about.
 */
export function installEvidenceJustAboveWorkspaceRoot(workspace: string): boolean {
  const parent = path.dirname(workspace);
  if (parent === workspace) return false;
  return hasInstallEvidence(parent, "");
}

/** Installed-runner markers for a python root — same list the pack-time verdict stats. */
const PY_RUNNER_MARKERS = [".venv/bin/pytest", "venv/bin/pytest", ".venv/bin/python", "venv/bin/python"];

function existsAtRoot(workspace: string, root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(workspace, root === "" ? rel : `${root}/${rel}`));
  } catch {
    return false;
  }
}

/**
 * "npm test" when a candidate root's package.json declares scripts.test;
 * else "pytest" when a Python marker exists at a candidate root and a .py
 * file was edited. Deliberately simple — no attempt to parse test runners
 * beyond these two well-known conventions.
 *
 * The npm branch requires a node file in the EDIT set: a C++ firmware harness
 * was served `test_entry:"npm test"` purely because an ancestor directory
 * happened to hold an unrelated package.json (2026-07-30 forensics).
 *
 * The RUNNABILITY half is 2026-07-31: an agent spent `cat package.json`
 * (x2), `grep workspaces` and `find node_modules` natively to learn "npm test
 * exists but the dependencies are not installed" — a fact two fs stats know.
 */
function detectTestEntry(
  workspace: string,
  roots: readonly string[],
  editedFiles: readonly string[],
): TestEntryFact | undefined {
  const editsNode = editedFiles.some((f) => NODE_SURFACE_EXTS.has(path.posix.extname(f).toLowerCase()));
  const editsGo = editedFiles.some((f) => GO_SURFACE_EXTS.has(path.posix.extname(f).toLowerCase()));
  if (editsNode) {
    for (const root of roots) {
      const rel = root === "" ? "package.json" : `${root}/package.json`;
      try {
        const abs = path.join(workspace, rel);
        if (!fs.existsSync(abs)) continue;
        const pkg = JSON.parse(fs.readFileSync(abs, "utf8")) as NodePackageManifestLike;
        const test = pkg.scripts?.["test"];
        if (typeof test !== "string" || test.length === 0) continue;
        // 2026-09-27 (external evaluation §6.2): "node_modules exists" is not the runnability test. A
        // zero-dependency `node --test …` suite runs with no install at all, and a monorepo member resolves a
        // hoisted install from an ancestor directory. Same classifier as the pack-time verdict
        // (readCodeTaskPack.ts buildVerificationVerdict), so the two can never disagree — that call site
        // passes only two arguments and keeps its pre-existing boolean-only verdict (the third parameter's
        // default preserves its behavior exactly); only THIS kit's wire shape has a slot for "not determinable".
        const verdict = classifyNodeTestRunnability(pkg, nodeModulesReachableFrom(workspace, root), installEvidenceJustAboveWorkspaceRoot(workspace));
        const installed = verdict.reason === "not-determinable" ? undefined : verdict.runnable;
        return { command: "npm test", dir: root, deps_installed: installed };
      } catch {
        // malformed/unreadable package.json — keep scanning other roots
      }
    }
  }
  if (editsGo) {
    const editedGoFiles = editedFiles
      .filter((rel) => GO_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()));
    if (editedGoFiles.length > 0) {
      const hasSamePackageTest = walkCodeFiles(workspace, {})
        .filter((file) => isGoTestPath(file.relPath))
        .some((file) => {
          const root = projectRootOf(file.relPath, workspace);
          if (!roots.includes(root)) return false;
          const testPackage = goPackageName(readSmall(workspace, file.relPath) ?? "");
          if (testPackage === undefined) return false;
          return editedGoFiles.some((editedRel) =>
            path.posix.dirname(editedRel) === path.posix.dirname(file.relPath)
            && goPackageName(readSmall(workspace, editedRel) ?? "") === testPackage);
        });
      if (hasSamePackageTest && roots.some((root) => GO_TEST_MARKER_NAMES.some((name) => existsAtRoot(workspace, root, name)))) {
        const entry = goVerificationEntry(workspace, editedGoFiles);
        if (entry) return {...entry, deps_installed: (pathLookupOverride ?? findOnPath)(GO_CANDIDATES) !== undefined};
      }
    }
    return undefined;
  }
  if (!editedFiles.some((f) => f.toLowerCase().endsWith(".py"))) return undefined;
  for (const root of roots) {
    if (!PY_TEST_MARKER_NAMES.some((name) => existsAtRoot(workspace, root, name))) continue;
    return {
      command: "pytest",
      deps_installed: PY_RUNNER_MARKERS.some((marker) => existsAtRoot(workspace, root, marker)),
    };
  }
  return undefined;
}

/** Per-call options for one kit spend. */
interface KitSpendOptions {
  /**
   * Inline against the REMAINING TOTAL budget instead of the 4 KB per-file cap.
   * Set only for families with no cheaper source (mock headers) — see the budget
   * comment above KIT_INLINE_FILE_CAP_BYTES.
   */
  fileCapExempt?: boolean;
}

type KitSpend = (rel: string, bytes: number, known?: string, options?: KitSpendOptions) => string | undefined;

/**
 * A single-spender over the shared verification-kit inline budget. Call it in
 * priority order: the first callers get bodies, later ones fall back to their
 * handle. `known` short-circuits the disk read when the content is already in
 * hand. Returns undefined when the file is over its applicable cap, over the
 * remaining budget, empty, or unreadable.
 */
function kitBudgetAllocator(workspace: string): KitSpend {
  let remaining = KIT_INLINE_TOTAL_CAP_BYTES;
  return (rel, bytes, known, options) => {
    const fileCap = options?.fileCapExempt === true ? KIT_INLINE_TOTAL_CAP_BYTES : KIT_INLINE_FILE_CAP_BYTES;
    if (bytes <= 0 || bytes > fileCap || bytes > remaining) return undefined;
    const content = known ?? readSmall(workspace, rel);
    if (content === undefined) return undefined;
    remaining -= bytes;
    return content;
  };
}

/**
 * `{ code }` when a body was served, else the explicit `{ body: "omitted" }`
 * marker. Build time only ever produces "omitted" (nothing here knows the
 * session); the response layer re-labels an entry "served-earlier" when the
 * served-surface ledger proves the body rode an earlier response (server.ts).
 */
function bodyField(code: string | undefined): { code: string } | { body: BodyMarker } {
  return code !== undefined ? { code } : { body: "omitted" };
}

/** S1: what identifies the whole-file bytes a kit entry for `rel` would serve. */
export interface VerificationBodyIdentity {
  /** sha of the CURRENT on-disk content — the per-entry served-ledger key. */
  sha: string;
  /** Line count, for asking the read ledger whether the whole file was served. */
  lines: number;
}

/**
 * S1 (2026-08-07 kit-entry-dedupe): identity of the bytes a kit entry for
 * `rel` would carry right now. `undefined` when the file is unreadable or
 * past the scan cap — callers must then SERVE, never claim served-earlier:
 * an unprovable "already in your context" is the failure mode that sends
 * agents to native `cat` (2026-07-31 named-but-unserved forensics, 20/31).
 */
export function verificationBodyIdentity(
  workspace: string,
  rel: string,
): VerificationBodyIdentity | undefined {
  const content = readSmall(workspace, rel);
  if (content === undefined) return undefined;
  return { sha: shaOfText(content), lines: countLines(content) };
}

/**
 * S2 (2026-08-07 note diet): every note this kit emits is ONE canonical
 * sentence under this cap. The 2026-08-04 run measured 23 kits carrying an
 * average 1,028 B of note prose — 11.1% of all TL bytes — restating the same
 * delivery policy every time. Policy that never varies is guide material (it
 * is paid once, as resident bytes); a note may only carry what THIS kit
 * decided. Pinned by verificationPack.spec.ts.
 */
export const KIT_NOTE_MAX_BYTES = 240;

/** verify_strategy === "harness". */
const KIT_NOTE_HARNESS =
  "referencing tests exist — follow harness/recipe; read only bodies named by next; compile_facts/link_set close standalone-compile failures";

/** verify_strategy === "syntax_only+diff". */
const KIT_NOTE_SYNTAX_ONLY =
  "no referencing test — verify by syntax-only compile + git diff; compile_facts/link_set close standalone-compile failures";

/** K3 note for the collapsed kit_unchanged receipt — short on purpose. */
const KIT_UNCHANGED_NOTE =
  "byte-identical to the kit already served this session — kit_ref names it; nothing was dropped";

/**
 * L6 (2026-08-08 kit-recipe fix): a mock header carries no note on what real
 * header(s) it stubs, so an agent linked a mock alongside the real header it
 * replaces and hit an enumerator-redefinition build failure (measured, a
 * 2-turn recovery). Fallback when the shadowed directory is not cheaply
 * derivable from the mock's own filename — still actionable on its own.
 */
const MOCK_HEADER_GENERIC_NOTE =
  "this mock REPLACES the real header(s) it stubs — do not include both in one harness";

/**
 * L6: strip a leading/trailing "mock(s)" filename token — "hal_mock.h" ->
 * "hal", "mock_hal.h" -> "hal" — the cheap half of "what does this shadow".
 * Empty when the basename IS just "mock"/"mocks" (nothing left to look up).
 */
function mockHeaderStem(mockRel: string): string {
  return stemOf(mockRel).replace(/^mocks?[_-]/, "").replace(/[_-]?mocks?$/, "");
}

/**
 * L6: the real header directory this mock most likely shadows — the SAME
 * project's `include/<mockHeaderStem>` (the include/-tree convention
 * `pairedHeaders`/`includeRootOf` already assume elsewhere in this file),
 * kept only when it actually holds a real (non-mock) header. `undefined`
 * rather than a wrong guess when the stem is empty or nothing matches;
 * callers fall back to MOCK_HEADER_GENERIC_NOTE.
 */
function shadowedHeaderDir(
  mockRel: string,
  workspace: string,
  byRel: ReadonlyMap<string, number>,
): string | undefined {
  const stem = mockHeaderStem(mockRel);
  if (stem.length === 0) return undefined;
  const projectRoot = projectRootOf(mockRel, workspace);
  const candidateDir = projectRoot === "" ? `${HEADER_DIR_NAME}/${stem}` : `${projectRoot}/${HEADER_DIR_NAME}/${stem}`;
  const hasRealHeader = [...byRel.keys()].some((rel) =>
    path.posix.dirname(rel) === candidateDir
    && NATIVE_HEADER_EXTS.includes(path.posix.extname(rel).toLowerCase())
    && !isMockish(rel));
  return hasRealHeader ? candidateDir : undefined;
}

/**
 * L6 (2026-08-08 kit-recipe fix): the mock_headers note — names the shadowed
 * real-header directory when `shadowedHeaderDir` can derive one cheaply,
 * else MOCK_HEADER_GENERIC_NOTE. Bounded by KIT_NOTE_MAX_BYTES like every
 * other kit note; a derived sentence that somehow exceeds it (an unusually
 * deep path) falls back to the generic form rather than truncate mid-path.
 */
function mockHeaderNote(mockRel: string, workspace: string, byRel: ReadonlyMap<string, number>): string {
  const dir = shadowedHeaderDir(mockRel, workspace, byRel);
  if (dir === undefined) return MOCK_HEADER_GENERIC_NOTE;
  const note = `this mock REPLACES the real headers under ${dir}/ — do not include both in one harness`;
  return Buffer.byteLength(note, "utf8") <= KIT_NOTE_MAX_BYTES ? note : MOCK_HEADER_GENERIC_NOTE;
}

/**
 * K3 (2026-08-01 verify-kit-diet): strips the ephemeral `handle` field (see
 * HandleTable.upsert — stable per canonical key but can churn on table
 * eviction in a long session) so the fingerprint reflects INFORMATIONAL
 * content only, never a handle-table implementation detail.
 */
function stripHandles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHandles);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "handle") continue;
      out[k] = stripHandles(v);
    }
    return out;
  }
  return value;
}

/**
 * K3: sha12 fingerprint of a manifest's informational content.
 *
 * `entrypointOwningSources` (L4, 2026-08-08 kit-recipe fix, Blocker 2): the
 * session-edited/created native SOURCE paths that own their own main() —
 * folded in explicitly rather than trusted to already be reflected somewhere
 * inside `manifest`. `harness.entrypoint_commands` is BY CONSTRUCTION a
 * function of this exact set, but it is nested three levels deep behind a
 * compiler probe, a link set, and a per-command character budget — any one
 * of which can leave it `undefined` on a call where the set still legitimately
 * grew (no matching compiler, an empty link set, an over-budget recipe). A
 * fingerprint keyed on `manifest` ALONE would then find nothing to change and
 * hand a `create:true` call introducing a new entrypoint the SAME
 * `kit_unchanged` receipt as any other repeat — collapsing `surfaces`/
 * `link_set`/`harness` to their empty forms and silently deciding, on this
 * server's own behalf, that the one field a create call's harness recipe is
 * about had nothing new to say. Sorted for order-independence.
 */
function fingerprintManifest(manifest: VerificationManifest, entrypointOwningSources: readonly string[]): string {
  const json = JSON.stringify({
    manifest: stripHandles(manifest),
    entrypoint_owning: [...entrypointOwningSources].sort(),
  });
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
}

interface KitDedupeState {
  sha12: string;
}

// K3: module-level, NOT session.ts state — bounded LRU-ish so a long-running
// server does not grow this unboundedly across many distinct workspaces.
const kitDedupeCache = new Map<string, KitDedupeState>();

/**
 * FX-M1/B3 (F-V13-3 class, 4th instance): keyed by (workspace root, CALLER'S
 * LANE), not the root alone — `laneScopedKey` returns the root string itself
 * when no lane is bound, so a single lane-less agent keys byte-identical to
 * before this fix. Mirrors the exact fix `packServeLog.ts`'s `_logKey` and
 * `priorPackStore.ts` already apply for the same reason: a root-only key
 * pooled every concurrent lane's most-recently-served kit fingerprint, so
 * lane B's OWN first-ever kit could collapse to `kit_unchanged:true` purely
 * because lane A's last kit (never seen by B) happened to fingerprint
 * identically — a false "already in your context" claim.
 */
function _kitDedupeKey(workspaceRoot: string): string {
  return laneScopedKey(workspaceRoot);
}

/**
 * K3: true when `sha12` matches the fingerprint this function last recorded
 * for `workspaceRoot` (i.e. the immediately-preceding kit for this
 * workspace was byte-identical). Always (re)records `sha12` as the newest
 * entry — delete-then-set touches Map insertion-order recency, so the
 * least-recently-touched workspace is the one evicted once the bound is hit.
 */
function checkAndRememberKitFingerprint(workspaceRoot: string, sha12: string): boolean {
  const key = _kitDedupeKey(workspaceRoot);
  const prior = kitDedupeCache.get(key);
  const unchanged = prior !== undefined && prior.sha12 === sha12;
  kitDedupeCache.delete(key);
  kitDedupeCache.set(key, { sha12 });
  if (kitDedupeCache.size > KIT_DEDUPE_CACHE_MAX_WORKSPACES) {
    const oldest = kitDedupeCache.keys().next().value;
    if (oldest !== undefined) kitDedupeCache.delete(oldest);
  }
  return unchanged;
}

/** Test seam: clear the module-level kit-dedupe cache between test cases. */
export function resetVerificationKitDedupeForTest(): void {
  kitDedupeCache.clear();
}

/**
 * FIX-3b: absence is a FACT worth stating. Two separate measured agent
 * attempts each spent a native find/README round discovering there is no
 * build system; findBuildEntry already knew, and silently dropped it
 * (2026-07-31 forensics).
 *
 * D3 (W3, 2026-08-07): three variants, chosen by which harness field the
 * RESPONSE actually carries — a 2026-08-07 bench run measured the old
 * single (command-only) wording ride 17/17 degraded, link_candidates-only
 * harness sections, naming a field none of them had.
 */
const BUILD_ENTRY_ABSENT_NOTE_COMMAND =
  "; no build system exists above the edited sources — compile directly via harness.build_command/toolchain";
/** Same fact, degraded response: no build_command here — link_candidates is what to read instead. */
const BUILD_ENTRY_ABSENT_NOTE_LINK_CANDIDATES =
  "; no build system exists above the edited sources — compile directly via harness.link_candidates/toolchain";
/** Same fact, neither harness field exists yet (nothing to link): name only toolchain. */
const BUILD_ENTRY_ABSENT_NOTE_GENERIC =
  "; no build system exists above the edited sources — compile directly via toolchain";

/**
 * harness.create_note. One 2026-08-01 measured run authored THREE standalone
 * C++ harness files with native Write/Edit while making zero native reads:
 * the kit had served every ingredient but never stated that new files are an
 * tl_edit_file call. Naming the tool is the whole fix — the alternative is a
 * native write.
 */
const HARNESS_CREATE_NOTE =
  "author new files with tl_edit_file {path, create:true, cwd, content} — never native Write/Edit; no build-system registration needed";

/** toolchain.verify_note when the detected test entry cannot actually run yet. */
const VERIFY_NO_DEPS_NOTE =
  "this test entry's dependencies are not installed — verify by diff review against the served evidence, not by installing them";

/** node only: `deps_installed` omitted because a hoisted install above the workspace root cannot be ruled out. */
const VERIFY_NOT_DETERMINABLE_NOTE =
  "whether this test entry's dependencies are installed could not be determined from inside the workspace boundary (a hoisted install may exist above the workspace root) — try running it before falling back to diff review";

/**
 * Build the manifest, or undefined when there is nothing verification-shaped
 * to say (no referencing test/mock, no native compile facts) — explain and
 * artifact tasks must never pay a byte for this section.
 */
export function buildVerificationManifest(
  workspace: string,
  editedRelPaths: readonly string[],
  options: {
    forceRecipe?: boolean;
    behaviorAnchors?: readonly string[];
    /**
     * K2 (2026-08-01 verify-kit-diet): explicit identifiers this edit
     * touched (e.g. mined from search/replace hunk text at a future call
     * site). Falls back to a same-session proxy — the edited files' own
     * current content — when omitted; see collectChangedIdentifiers.
     */
    changedIdentifiers?: readonly string[];
    /**
     * K3a (2026-08-01): consecutive-kit dedupe is OPT-IN, enabled only by the
     * edit-response attachment path (server.ts buildVerificationBody) where
     * the measured repetition happens. Wiring/completion-proof callers build
     * manifests as structural evidence — collapsing their second same-content
     * call to a receipt broke construct-receiver completion_proof.verification
     * (module-level cache leaking across pack builds in one workspace).
     */
    dedupeConsecutive?: boolean;
    /**
     * 2026-10-20 (window 6t-7): add the Python interpreter check
     * (pythonSyntaxCheck) as harness.syntax_check when no native check holds
     * it. Opt-in for the edit-response kit (server.ts), like
     * `dedupeConsecutive`: it can start interpreter probes, and the
     * structural callers (the completion recipe, verify obligations) never
     * asked which interpreter runs the edit.
     */
    pythonSyntaxCheck?: boolean;
  } = {},
): VerificationManifest | undefined {
  const edited = [...new Set(editedRelPaths.map((p) => p.replace(/\\/g, "/")).filter((p) => p.length > 0))];
  if (edited.length === 0) return undefined;
  const editedSet = new Set(edited);

  const walked: WalkedFile[] = [];
  const byRel = new Map<string, number>();
  for (const file of walkCodeFiles(workspace, {})) {
    const rel = file.relPath.replace(/\\/g, "/");
    let bytes: number;
    try {
      bytes = fs.statSync(path.join(workspace, rel)).size;
    } catch {
      continue;
    }
    walked.push({ rel, bytes });
    byRel.set(rel, bytes);
  }
  if (walked.length === 0) return undefined;

  // K2 (2026-08-01 verify-kit-diet): computed once, used both to rank/filter
  // surfaces below and left inert (relevanceGateActive false) whenever there
  // is too little signal to judge relevance by.
  const changedIdentifiers = collectChangedIdentifiers(workspace, edited, options.changedIdentifiers);
  const relevanceGateActive = changedIdentifiers.size >= MIN_EDIT_IDENTIFIER_TOKENS;

  // ---- referencing tests/mocks (name/stem match, unchanged from v1) ----
  const needles = new Map<string, string>();
  for (const rel of edited) {
    needles.set(path.posix.basename(rel).toLowerCase(), rel);
    const stem = stemOf(rel);
    if (stem.length >= 4) needles.set(stem, rel);
  }
  // Root scoping (2026-07-25 forensics): a name-needle match alone served
  // one of THIS repo's own spec files — which quotes fixture paths as test
  // data — as a "referencing test" for a fixture task, flipping the
  // strategy to "harness" and inflating verification. A candidate must live
  // in the same project root as at least one edited file (projectRootOf:
  // nearest VCS/manifest-marker dir, "" = workspace root — the "" asymmetry
  // is load-bearing: a marker-less fixture never matches a marker-bearing
  // package).
  const editedRootsAll = edited.map((rel) => projectRootOf(rel, workspace));
  const rootedEditedRoots = editedRootsAll.filter((root) => root !== "");
  // A rootless edited file must not expand candidacy to every rootless file
  // in the workspace: a 2026-07-26 measurement edited a fixture-root
  // CONTRACT.md (root "", no marker above it) alongside unrelated app files,
  // and the "" admitted this tool's own test specs — which quote task names
  // as data — as top-ranked "referencing tests". When any edited file
  // resolves to a real project root, the rooted members define the project
  // set and rootless strays ride along with them.
  const editedRoots = new Set(rootedEditedRoots.length > 0 ? rootedEditedRoots : editedRootsAll);
  const nodeNameCounts = new Map<string, number>();
  for (const file of walked) {
    if (!NODE_SURFACE_EXTS.has(path.posix.extname(file.rel).toLowerCase())) continue;
    const name = path.posix.basename(file.rel).toLowerCase();
    nodeNameCounts.set(name, (nodeNameCounts.get(name) ?? 0) + 1);
  }
  const ambiguousNodeEdits = new Set(edited.filter(rel =>
    NODE_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase())
    && (nodeNameCounts.get(path.posix.basename(rel).toLowerCase()) ?? 0) > 1));
  const matched: Array<{ rel: string; role: "test" | "mock"; bytes: number; refs: string[]; content: string; overlap: number; direct: number }> = [];
  for (const file of walked) {
    if (editedSet.has(file.rel)) continue;
    if (!editedRoots.has(projectRootOf(file.rel, workspace))) continue;
    const mock = isMockish(file.rel);
    const goPairEdited = isGoTestPath(file.rel)
      ? edited.filter((editedRel) => {
        return samePackageGoTest(editedRel, readSmall(workspace, editedRel) ?? "", file.rel, readSmall(workspace, file.rel) ?? "");
      })
      : [];
    const goPair = goPairEdited.length > 0;
    if (!mock && classifySurface(file.rel) !== "test" && !goPair) continue;
    if (file.bytes === 0 || file.bytes > SCAN_FILE_CAP_BYTES) continue;
    const content = readSmall(workspace, file.rel);
    if (content === undefined) continue;
    const lower = content.toLowerCase();
    const refs = new Set<string>();
    const directRefs = edited.filter(rel =>
      NODE_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()) && nodeReferenceMatches(file.rel, content, rel));
    for (const [needle, rel] of needles) {
      if (lower.includes(needle) && (!ambiguousNodeEdits.has(rel) || directRefs.includes(rel))) refs.add(rel);
    }
    // Short stems (run) were not needles at all. A resolved import is stronger
    // evidence than the four-character fallback threshold.
    for (const rel of directRefs) refs.add(rel);
    if (goPair) {
      for (const editedRel of goPairEdited) refs.add(editedRel);
    }
    if (refs.size === 0) continue;
    // K2: overlap is 0 (never scanned) when the gate is inactive — a pure
    // no-op that leaves ranking/filtering exactly as before.
    let overlap = 0;
    if (relevanceGateActive) {
      for (const tok of identifierTokens(content)) if (changedIdentifiers.has(tok)) overlap += 1;
    }
    matched.push({ rel: file.rel, role: mock ? "mock" : "test", bytes: file.bytes, refs: [...refs].sort(), content, overlap, direct: directRefs.length });
  }
  matched.sort((a, b) =>
    b.direct - a.direct
    || b.refs.length - a.refs.length
    || b.overlap - a.overlap
    || (a.role === b.role ? 0 : a.role === "test" ? -1 : 1)
    || a.bytes - b.bytes
    || a.rel.localeCompare(b.rel));
  // K2: the harness entry is exempt from the relevance drop below regardless
  // of overlap — a standalone harness needs it to build at all. Found here by
  // scanning the SORTED, PRE-filter list the same way the later build_command
  // mining scans `selected` (first test-role match with a Build:/Compile:/
  // Run: marker) so the drop below can never remove it before that later scan
  // ever runs.
  let harnessEntryRel: string | undefined;
  for (const entry of matched) {
    if (entry.role === "test" && extractBuildCommand(entry.content) !== undefined) {
      harnessEntryRel = entry.rel;
      break;
    }
  }
  // K2: a needle-matched surface whose OWN content shares nothing with what
  // this edit actually touched is dropped — the 2026-07-31 forensics
  // measured a needle-matched Express wiring helper (basename/stem substring
  // overlap only, zero symbol overlap) riding the kit for an unrelated
  // enum-value change. Mocks are exempt (a mock's job is to stub the
  // dependency, not restate its identifiers) and so is the harness entry.
  const relevant = !relevanceGateActive
    ? matched
    : matched.filter((entry) =>
      entry.role === "mock"
      || entry.rel === harnessEntryRel
      || entry.direct > 0
      || entry.overlap > 0);
  const selected = relevant.slice(0, MAX_SURFACES);
  const surfacesOmitted = relevant.length - selected.length;

  // ---- native compile facts + link set (edited C/C++ sources only) ----
  const compileFacts: CompileFact[] = [];
  // Bodies are allocated LAST, once every kit family is known, so the shared
  // inline budget can be spent in priority order rather than first-come.
  const linkCandidates: Array<{ path: string; bytes: number; reason: string; paired: boolean }> = [];
  const nativeEdited = edited.filter((rel) => NATIVE_EXTS.has(path.posix.extname(rel).toLowerCase()));
  if (nativeEdited.length > 0) {
    // One-pass identifier index over workspace headers (small files only).
    const headerDefs = new Map<string, string[]>();
    for (const file of walked) {
      const ext = path.posix.extname(file.rel).toLowerCase();
      if (!NATIVE_HEADER_EXTS.includes(ext) || file.bytes > SCAN_FILE_CAP_BYTES) continue;
      const content = readSmall(workspace, file.rel);
      if (content === undefined) continue;
      for (const id of definedIdentifiers(content)) {
        const existing = headerDefs.get(id);
        if (existing === undefined) headerDefs.set(id, [file.rel]);
        else if (!existing.includes(file.rel)) existing.push(file.rel);
      }
    }
    const linkSeen = new Set<string>();
    for (const rel of nativeEdited) {
      const content = readSmall(workspace, rel);
      if (content === undefined) continue;
      const includes = directIncludes(content);
      const externs = externDeclarations(content);
      const includedText = [...includes].join("\n");
      // Missing-include facts: an identifier used here, defined by exactly ONE
      // workspace header, and that header is not among the direct includes.
      // Single-definition precision keeps noise near zero.
      const missing: string[] = [];
      const used = new Set<string>();
      for (const m of content.matchAll(/\b([A-Za-z_]\w{3,})\b/g)) used.add(m[1]!);
      for (const id of used) {
        const defs = headerDefs.get(id);
        if (defs === undefined || defs.length !== 1) continue;
        const header = defs[0]!;
        if (editedSet.has(header) || rel === header) continue;
        const headerBase = path.posix.basename(header);
        if (includedText.includes(headerBase)) continue;
        if (definedIdentifiers(content).has(id)) continue;
        if (!missing.includes(header)) missing.push(header);
        if (missing.length >= MAX_MISSING_INCLUDES) break;
      }
      if (missing.length > 0 || externs.length > 0) {
        const notes = [
          missing.length > 0
            ? "uses identifiers these headers define without including them — a standalone compile needs them"
            : undefined,
          externs.length > 0
            ? "extern_declarations are exact declarations from the edited source — reuse them for harness linkage stubs"
            : undefined,
        ].filter((note): note is string => note !== undefined);
        compileFacts.push({
          path: rel,
          missing_includes: missing,
          ...(externs.length > 0 ? { extern_declarations: externs } : {}),
          note: notes.join("; "),
        });
      }
      // Link set: paired sources of this file's direct includes — forensics
      // measured agents escaping to `cat` for exactly these paired sources by
      // name. Sources are collected first so a header-rich tree can never
      // starve them out of MAX_LINK_SET.
      for (const inc of includes) {
        for (const pair of pairedSources(inc, byRel)) {
          if (pair === rel || editedSet.has(pair) || linkSeen.has(pair)) continue;
          linkSeen.add(pair);
          if (linkCandidates.length >= MAX_LINK_SET) continue;
          linkCandidates.push({
            path: pair,
            bytes: byRel.get(pair) ?? 0,
            reason: `pairs ${inc} included by ${path.posix.basename(rel)} — likely needed in a harness link set`,
            paired: false,
          });
        }
      }
    }
    // Each link-set source's OWN sibling header: a harness that compiles the
    // source needs its declarations, and link_set previously paired only
    // headers→sources, so those headers were read natively instead.
    let pairedHeaderCount = 0;
    for (const source of [...linkCandidates]) {
      for (const header of pairedHeaders(source.path, byRel)) {
        if (editedSet.has(header) || linkSeen.has(header)) continue;
        if (pairedHeaderCount >= MAX_PAIRED_HEADERS) break;
        linkSeen.add(header);
        pairedHeaderCount += 1;
        linkCandidates.push({
          path: header,
          bytes: byRel.get(header) ?? 0,
          reason: `declares ${path.posix.basename(source.path)} — its link-set source needs this header to compile`,
          paired: true,
        });
      }
    }
  }

  // ---- build-command mining. It reads only `selected`, so it can never turn
  // an otherwise-undefined manifest into a defined one; it runs before the
  // gate below because harness.syntax_check reuses the `-std` it documents. ----
  let buildCommand: { text: string; source: string } | undefined;
  for (const entry of selected) {
    if (entry.role !== "test") continue;
    const text = extractBuildCommand(entry.content);
    if (text !== undefined) {
      buildCommand = { text, source: entry.rel };
      break;
    }
  }
  // harness.syntax_check: a native edit with no build system above it, on a
  // host with a compiler for its language, has one thing worth saying even
  // when nothing references it, which is how to compile it. That is why it is
  // decided before the gate; the toolchain block below reuses the probe and
  // the build-entry walk.
  let probed: ToolchainProbe | undefined;
  const probeOnce = (): ToolchainProbe => (probed ??= probeToolchain());
  const firstNativeDir = nativeEdited.length > 0 ? path.posix.dirname(nativeEdited[0]!) : undefined;
  const nativeBuildEntry = firstNativeDir === undefined
    ? undefined
    : findBuildEntry(workspace, firstNativeDir === "." ? "" : firstNativeDir);
  const nativeCheck = firstNativeDir !== undefined && nativeBuildEntry === undefined
    ? nativeSyntaxCheck(workspace, nativeEdited, { toolchain: probeOnce(), byRel, std: documentedStd(buildCommand?.text) })
    : undefined;
  // The Python counterpart decides before the gate for the same reason: an
  // edited module nothing references still has an interpreter worth naming
  // when the PATH's python3 cannot run it.
  const syntaxCheck = nativeCheck
    ?? (options.pythonSyntaxCheck === true ? pythonSyntaxCheck(workspace, edited) : undefined);

  const testEntryRoots = [...new Set(editedRootsAll)];
  if (!testEntryRoots.includes("")) testEntryRoots.push("");
  // Editing a same-package Go test removes it from referencing surfaces, but
  // does not erase its proven module suite or require a new exploratory read.
  const goTestEntry = edited.some(rel => GO_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()))
    ? detectTestEntry(workspace, testEntryRoots, edited) : undefined;
  if (selected.length === 0 && compileFacts.length === 0 && linkCandidates.length === 0 && syntaxCheck === undefined && goTestEntry === undefined) return undefined;

  // ---- harness: mock-header inventory. Computed only now that we know a
  // manifest will be returned — enrichment alone must never turn an
  // otherwise-undefined manifest into a defined one. ----
  // Cross-family guard (2026-08-27 field-eval defect): mock_headers is a
  // NATIVE-only kit family by contract — MockHeaderEntry's own doc says so
  // ("Native mock headers (.h/.hpp/.hh/.hxx)") — but this filter chain only
  // ever checked the CANDIDATE header's own extension, its project root, and
  // a path-pattern name match; it never checked whether the EDIT itself was
  // native. Two independent first-party reports measured a pure-TypeScript
  // edit's kit carry a ~10KB unrelated C aerospace-firmware HAL mock header
  // (shared project root, "mock" in the path, zero relation to the edit) —
  // the kit contract requires tests/mocks REFERENCING the edit, and a C
  // header cannot reference a TypeScript change by construction.
  // `nativeEdited` — computed above from the SAME NATIVE_EXTS family map
  // this function already uses throughout, never a parallel scheme — makes
  // cross-family admission structurally IMPOSSIBLE rather than merely
  // unlikely: a non-native edit can never reach the candidate scan below at
  // all, no matter how project-root or name-pattern coincidence lines up. A
  // native edit's own candidate set (and a same-family C-tree's mocks) is
  // completely unaffected.
  const mockHeaderCandidates = nativeEdited.length === 0 ? [] : walked
    .filter((f) => !editedSet.has(f.rel))
    .filter((f) => isMockish(f.rel))
    .filter((f) => NATIVE_HEADER_EXTS.includes(path.posix.extname(f.rel).toLowerCase()))
    .filter((f) => editedRoots.has(projectRootOf(f.rel, workspace)))
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .slice(0, MAX_MOCK_HEADERS);

  // ---- kit body allocation: ONE budget, spent in priority order. Every entry
  // below is handle-bearing whether or not its body fits; an entry without a
  // body says so (`body:"omitted"`) so it never reads as an empty file. ----
  const spend = kitBudgetAllocator(workspace);
  const mockHeaders: MockHeaderEntry[] = mockHeaderCandidates.map((f) => ({
    path: f.rel,
    bytes: f.bytes,
    handle: handleTable.upsert({ kind: "file", path: f.rel, workspaceRoot: workspace }).id,
    // Priority 1 AND per-file-cap exempt: no cheaper source exists for a mock
    // header, so a 4 KB cap structurally defeated its own priority (the
    // largest mock header measured in practice was 9848 B and could never
    // inline).
    ...bodyField(spend(f.rel, f.bytes, undefined, { fileCapExempt: true })),
    // L6 (2026-08-08 kit-recipe fix): every mock header states what it
    // replaces, whether or not the shadow relationship was cheaply derivable.
    note: mockHeaderNote(f.rel, workspace, byRel),
  }));
  // K1 (2026-08-01 verify-kit-diet): spend order is DECOUPLED from array
  // order (below) — small files (≤ SMALL_VERIFY_SURFACE_BYTES), headers
  // before sources, always get first crack at the shared budget so a handful
  // of ≤4KB sources can never starve the small headers agents actually read
  // (2026-07-31 verify-kit-gap forensics: os_mutex.h/hal_uart.h/mavlink.hpp
  // were named but consistently unspent because MAX_LINK_SET sources spent
  // ahead of them in array order).
  const linkSpendOrder = [...linkCandidates].sort((a, b) => {
    const aSmall = a.bytes <= SMALL_VERIFY_SURFACE_BYTES ? 0 : 1;
    const bSmall = b.bytes <= SMALL_VERIFY_SURFACE_BYTES ? 0 : 1;
    if (aSmall !== bSmall) return aSmall - bSmall;
    const aHeader = a.paired ? 0 : 1; // paired===true is always a header — see pairedHeaders
    const bHeader = b.paired ? 0 : 1;
    if (aHeader !== bHeader) return aHeader - bHeader;
    return a.bytes - b.bytes;
  });
  const linkBodies = new Map<string, string | undefined>();
  for (const candidate of linkSpendOrder) linkBodies.set(candidate.path, spend(candidate.path, candidate.bytes));
  const linkSet: LinkSetEntry[] = [
    ...linkCandidates.filter((entry) => !entry.paired),
    ...linkCandidates.filter((entry) => entry.paired),
  ].map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    reason: entry.reason,
    handle: handleTable.upsert({ kind: "file", path: entry.path, workspaceRoot: workspace }).id,
    ...bodyField(linkBodies.get(entry.path)),
  }));
  const surfaces: VerificationSurface[] = selected.map((entry) => {
    // A mock surface stays body-less by role, not by budget: a partial mock
    // conflicts with the real headers a harness includes, so its scope_note is
    // the useful fact. Test bodies spend last — the test is already named.
    const fullBodyFits = entry.role === "test" && entry.bytes <= KIT_INLINE_FILE_CAP_BYTES;
    const code = fullBodyFits ? spend(entry.rel, entry.bytes, entry.content) : undefined;
    // K1: the harness entry's head is where the Build:/Compile:/Run: marker
    // and includes live — the 2026-07-31 forensics measured agents `head`ing
    // exactly this once its full body was too big to inline whole.
    let headCode: string | undefined;
    if (!fullBodyFits && entry.role === "test" && entry.rel === harnessEntryRel) {
      const headText = entry.content.split(/\r?\n/).slice(0, HARNESS_ENTRY_HEAD_LINES).join("\n");
      headCode = spend(entry.rel, Buffer.byteLength(headText, "utf8"), headText);
    }
    return {
      path: entry.rel,
      role: entry.role,
      bytes: entry.bytes,
      references: entry.refs,
      handle: handleTable.upsert({ kind: "file", path: entry.rel, workspaceRoot: workspace }).id,
      ...bodyField(code ?? headCode),
      ...(headCode !== undefined ? { content_completeness: "partial" as const } : {}),
      ...(entry.role === "mock"
        ? { scope_note: "partial mock — may conflict with the real headers your harness includes" }
        : {}),
    };
  });
  // ---- toolchain: local compiler/build-entry/test-entry facts.
  const testEntry = goTestEntry ?? detectTestEntry(workspace, testEntryRoots, edited);
  const nativeRelevant = compileFacts.length > 0 || linkSet.length > 0 || nativeEdited.length > 0;
  const pythonRelevant = edited.some((rel) => PYTHON_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()));
  const goRelevant = edited.some((rel) => GO_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()));
  let toolchain: ToolchainInfo | undefined;
  let buildEntryAbsent = false;
  if (nativeRelevant || testEntry !== undefined) {
    const probe = nativeRelevant || pythonRelevant || goRelevant ? probeOnce() : undefined;
    let buildEntry: string | undefined;
    if (nativeEdited.length > 0) {
      buildEntry = nativeBuildEntry;
      buildEntryAbsent = buildEntry === undefined;
    }
    const toolchainCandidate: ToolchainInfo = {
      ...(nativeRelevant && probe?.cxx !== undefined ? { cxx: probe.cxx } : {}),
      ...(nativeRelevant && probe?.cc !== undefined ? { cc: probe.cc } : {}),
      ...(pythonRelevant && probe?.python3 === true ? { python3: true } : {}),
      ...(goRelevant && probe?.go === true ? { go: true } : {}),
      ...(buildEntry !== undefined ? { build_entry: buildEntry } : {}),
      ...(buildEntryAbsent ? { build_entry_absent: true } : {}),
      ...(testEntry !== undefined ? { test_entry: testEntry.command } : {}),
      ...(testEntry?.dir !== undefined ? { test_entry_dir: testEntry.dir === "" ? "." : testEntry.dir } : {}),
      ...(testEntry?.deps_installed !== undefined ? { deps_installed: testEntry.deps_installed } : {}),
      ...(testEntry?.deps_installed === false ? { verify_note: VERIFY_NO_DEPS_NOTE } : {}),
      ...(testEntry !== undefined && testEntry.deps_installed === undefined ? { verify_note: VERIFY_NOT_DETERMINABLE_NOTE } : {}),
    };
    if (Object.keys(toolchainCandidate).length > 0) toolchain = toolchainCandidate;
  }

  // ---- harness assembly, AFTER the toolchain facts: whether the caller is
  // about to AUTHOR a harness (no build entry, nothing runnable) and which
  // compiler the host actually has are toolchain facts, and both decide what
  // the harness object owes. Mining still wins — a synthesized command never
  // overwrites one a real test documents (2026-08-01: the runs that stayed
  // clean all had a MINED command to reuse; this one had none and paid for
  // it in native writes and failed link attempts). ----
  const authoringLikely = toolchain?.build_entry_absent === true || toolchain?.test_entry === undefined;
  // Entry-point detection reads the candidate sources; a link_set entry whose
  // body this kit already holds is answered without touching disk. Shared by
  // both branches below so mining and the L4 mining-coexistence path agree on
  // exactly what "reading a source" means.
  const readEntrypointCandidate = (rel: string): string | undefined =>
    linkSet.find((entry) => entry.path === rel)?.code ?? readSmall(workspace, rel);
  const synthesized = buildCommand === undefined
    ? synthesizeHarnessBuildCommand(
        toolchain,
        nativeEdited,
        linkSet,
        compileFacts,
        mockHeaders,
        byRel,
        readEntrypointCandidate,
      )
    : undefined;
  // L4 (2026-08-08 kit-recipe fix, Blocker 1): mining wins the PRIMARY slot,
  // but it only ever describes how the test that documented it builds — never
  // a DIFFERENT source the session just gave its own main(). Computed only
  // when there IS a mined command (the full synthesizer above already covers
  // entrypoint_commands in every other case), so this and `synthesized` are
  // never both attempted for the same manifest.
  const entrypointCommandsAlongsideMining = buildCommand === undefined
    ? undefined
    : synthesizeEntrypointCommandsForMinedHarness(
        toolchain,
        nativeEdited,
        linkSet,
        compileFacts,
        mockHeaders,
        byRel,
        readEntrypointCandidate,
        buildCommand.source,
      );
  const synthesizedCommand = synthesized?.command;
  // L4 Blocker 3: a mined command is authored relative to ITS OWN source
  // file's directory (see HarnessInfo.build_command's doc) — annotate `cwd`
  // rather than rewrite the mined TEXT, so the served string stays an exact,
  // honest quote of what the test file says.
  const minedCommand = buildCommand === undefined
    ? undefined
    : { ...buildCommand, cwd: path.posix.dirname(buildCommand.source) };
  const harnessCommand = minedCommand ?? synthesizedCommand;
  // Named apart from this function's own `linkCandidates` (the link_set
  // selection pool): this one is the DEGRADED harness recipe, not a pool.
  const harnessLinkCandidates = synthesized?.link_candidates;
  const entrypointCommands = synthesized?.entrypoint_commands ?? entrypointCommandsAlongsideMining;
  const harness: HarnessInfo | undefined =
    syntaxCheck !== undefined || harnessCommand !== undefined || harnessLinkCandidates !== undefined || mockHeaders.length > 0
      || (authoringLikely && nativeRelevant)
      ? {
          ...(syntaxCheck !== undefined ? { syntax_check: syntaxCheck } : {}),
          ...(harnessCommand !== undefined ? { build_command: harnessCommand } : {}),
          ...(synthesizedCommand !== undefined ? { build_command_synthesized: true as const } : {}),
          ...(entrypointCommands !== undefined ? { entrypoint_commands: entrypointCommands } : {}),
          ...(harnessLinkCandidates !== undefined ? { link_candidates: harnessLinkCandidates } : {}),
          ...(authoringLikely ? { create_note: HARNESS_CREATE_NOTE } : {}),
          ...(mockHeaders.length > 0 ? { mock_headers: mockHeaders } : {}),
        }
      : undefined;

  let recipe: TaskVerificationRecipe | undefined;
  // v0.14 flag inventory (2026-08-31): the response-wide TL_VERIFICATION_RECIPE
  // experiment was deleted (bench-inconclusive since the 2026-08-14 freeze).
  // The recipe machinery itself stays: the semantic-wiring completion contract
  // is its non-experimental consumer and forces it explicitly.
  if (options.forceRecipe === true) {
    const assertions = assertionRefs(selected, options.behaviorAnchors ?? []);
    const contracts = contractRefs(workspace, editedRoots, needles);
    const mockControls = mockControlRefs(workspace, selected, mockHeaders, buildCommand);
    const compileTargets = [...new Set([
      ...nativeEdited,
      ...selected.filter((entry) => entry.role === "test").map((entry) => entry.rel),
      ...linkSet.map((entry) => entry.path),
    ])].slice(0, MAX_RECIPE_TARGETS);
    const entry = buildCommand?.text ?? toolchain?.test_entry ?? toolchain?.build_entry;
    const gaps: string[] = [];
    if (assertions.length === 0) gaps.push("no existing test asserts this behavior");
    if (entry === undefined) gaps.push("no executable test/build entry found");
    if (
      buildCommand !== undefined
      && nativeEdited.some((edited) => !buildCommand.text.includes(path.posix.basename(edited)))
    ) {
      gaps.push("executable entry does not compile every edited implementation target");
    }
    // A3 (2026-08-27, T03/T13 frontier-full-guard follow-up): the aggregate
    // gap above names THAT some edited target is uncovered, never WHICH —
    // measured residual (bench/workflows/experiments/2026-08-26-t03-t13-
    // frontier-full-guard-results.md): a 6-target C++ edit still let solvers
    // treat one mined entry as if it proved every target. Name each
    // uncovered native target individually and honestly, from the SAME
    // buildCommand.text membership check just above — a covered target
    // needs no new line, its proof is already `entry`/`cwd`, grounded in
    // `buildCommand.source`. No command is ever invented for an uncovered
    // target; only multi-target edits are enumerated (a single target is
    // already fully named by the aggregate gap above).
    if (buildCommand !== undefined && nativeEdited.length > 1) {
      for (const rel of nativeEdited) {
        if (!buildCommand.text.includes(path.posix.basename(rel))) {
          gaps.push(
            `no workspace-proven syntax/compile action for edited target ${rel} `
            + `(only ${buildCommand.source}'s entry is workspace-proven)`,
          );
        }
      }
    }
    // A3: a defined entry can still fail to be proof of THIS change —
    // assertionRefs already requires every named behavior anchor to appear
    // near an assertion line, so assertions.length === 0 alongside a
    // defined, anchor-scoped entry means precisely that: a real, runnable
    // entry exists but does not assert the edited behavior. The T13
    // follow-up measured solvers running exactly such an entry (a MAVLink
    // test) and treating its pass as proof of unrelated edited health
    // wiring; name the anchors so the entry can never be mistaken for
    // behavior proof.
    const anchors = options.behaviorAnchors;
    if (entry !== undefined && assertions.length === 0 && anchors !== undefined && anchors.length > 0) {
      gaps.push(`executable entry is not a direct proof of ${[...new Set(anchors)].join(" and ")}`);
    }
    const confidence = assertions.length > 0 && entry !== undefined
      ? undefined
      : assertions.length > 0 || entry !== undefined || contracts.length > 0
        ? "medium" as const
        : "low" as const;
    recipe = {
      compile_targets: compileTargets,
      ...(buildCommand !== undefined ? { cwd: path.posix.dirname(buildCommand.source) } : {}),
      ...(entry !== undefined ? { entry } : {}),
      ...(assertions.length > 0 ? { assertion_refs: assertions } : {}),
      ...(contracts.length > 0 ? { contract_refs: contracts } : {}),
      ...(mockControls.length > 0 ? { mock_controls: mockControls } : {}),
      ...(gaps.length > 0 ? { gaps } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }

  const strategy: VerificationManifest["verify_strategy"] =
    surfaces.some((s) => s.role === "test") || goTestEntry !== undefined ? "harness" : "syntax_only+diff";
  // D3 (W3, 2026-08-07 L3 recalibration): this clause used to be conditioned
  // on `buildEntryAbsent` ALONE and always named `harness.build_command` —
  // but build-entry absence says nothing about which harness field the
  // RESPONSE actually carries. A 2026-08-07 bench run measured this exact
  // sentence ride 17/17 degraded (link_candidates-only) harness sections,
  // naming a field those responses did not have. Name only what `harness`
  // (just assembled above) actually carries.
  const buildEntryAbsentNote = !buildEntryAbsent
    ? ""
    : harness?.build_command !== undefined
      ? BUILD_ENTRY_ABSENT_NOTE_COMMAND
      : harness?.link_candidates !== undefined
        ? BUILD_ENTRY_ABSENT_NOTE_LINK_CANDIDATES
        : BUILD_ENTRY_ABSENT_NOTE_GENERIC;
  const fullManifest: VerificationManifest = {
    version: 2,
    verify_strategy: strategy,
    surfaces,
    compile_facts: compileFacts,
    link_set: linkSet,
    omitted: surfacesOmitted,
    ...(harness !== undefined ? { harness } : {}),
    ...(toolchain !== undefined ? { toolchain } : {}),
    ...(recipe !== undefined ? { recipe } : {}),
    // S2: canonical sentence only. The delivery policy that used to ride here
    // every time (body states, inline budget, build_command provenance) is
    // invariant, so it lives in the agent guide and is paid once per session.
    note: (goTestEntry !== undefined && surfaces.length === 0
      ? "module test entry found — run it from toolchain.test_entry_dir; edited tests are already in the edit context"
      : toolchain?.test_entry !== undefined && toolchain.deps_installed === true
        ? "run toolchain.test_entry from toolchain.test_entry_dir; use served test context; read only omitted bodies via next"
        : strategy === "harness" ? KIT_NOTE_HARNESS : KIT_NOTE_SYNTAX_ONLY) + buildEntryAbsentNote,
  };
  // K3 (2026-08-01 verify-kit-diet): a workspace whose kit content is
  // byte-identical to what THIS function returned last call gets a compact
  // receipt instead of a repeat — the 2026-07-31 forensics measured the
  // SAME ~2.5KB kit riding two consecutive edit responses for one enum-value
  // change. Any change to the edited-file set or to on-disk content changes
  // fullManifest and therefore its fingerprint, so it always re-serves in
  // full — no separate diff-hash bookkeeping needed.
  //
  // L4 (2026-08-08, Blocker 2): the entrypoint-owning subset of nativeEdited,
  // folded into the fingerprint EXPLICITLY (see fingerprintManifest's doc) —
  // computed independently of whether mining or synthesis actually produced
  // an entrypoint_commands entry this call, so a create that grows this set
  // can never be told "kit_unchanged" merely because every OTHER kit family
  // happened to compute the same content again.
  const entrypointOwningEditedSources = nativeEdited
    .filter((rel) => NATIVE_SOURCE_EXTS.has(path.posix.extname(rel).toLowerCase()))
    .filter((rel) => ownsEntrypoint(rel, (rel2) => readSmall(workspace, rel2)));
  const fingerprint = fingerprintManifest(fullManifest, entrypointOwningEditedSources);
  if (options.dedupeConsecutive === true && checkAndRememberKitFingerprint(workspace, fingerprint)) {
    return {
      version: 2,
      verify_strategy: strategy,
      surfaces: [],
      compile_facts: [],
      link_set: [],
      omitted: 0,
      note: KIT_UNCHANGED_NOTE,
      kit_unchanged: true,
      kit_ref: fingerprint,
    };
  }
  return fullManifest;
}
