/**
 * verificationPack.ts — verification working-set facts for the verifying
 * phase (2026-07-25 harness-desertion forensics, v2 facts-first redesign).
 *
 * Evidence from live agent transcripts: on fix tasks agents hand-build
 * verification harnesses AFTER their last successful edit_file call, and the
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
import { countLines } from "./countLines.js";
import { projectRootOf } from "../features/locator/locateTaskContext.js";
import { verificationRecipeEnabled } from "./flags.js";
import type { TaskVerificationRecipe } from "@tokenlighten/types";

/**
 * Body state for a kit entry that carries no `code` in THIS response.
 * `"omitted"` = never served — fetch it (`verification.next_call` batches every
 * omitted body into one read_file call). `"served-earlier"` = the body already
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
  build_entry?: string;
  /**
   * Native edits with NO CMakeLists.txt/Makefile/meson.build anywhere up-tree.
   * Stating the ABSENCE removes the native find/README round two separate
   * measured agent attempts each spent asking "is there a build system here?".
   */
  build_entry_absent?: boolean;
  test_entry?: string;
  /** node only: directory whose package.json declared `scripts.test` ("" = workspace root). */
  test_entry_dir?: string;
  /** node: `<test_entry_dir>/node_modules` exists; python: a venv runner exists. */
  deps_installed?: boolean;
  /** Present exactly when `deps_installed === false`. */
  verify_note?: string;
}

/** One-line advisory for the only verification failure that blocks execution: missing dependencies. */
export function verificationDependencyNote(manifest: Pick<VerificationManifest, "toolchain">): string | undefined {
  return manifest.toolchain?.deps_installed === false && typeof manifest.toolchain.verify_note === "string"
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
const CXX_CANDIDATES = ["clang++", "g++"];
const CC_CANDIDATES = ["clang", "gcc", "cc"];
const PYTHON3_CANDIDATES = ["python3"];
const ASSERTION_RE = /\b(?:assert|expect|require|check|verify)(?:[_A-Za-z0-9]*|\s*)\s*\(/i;
const CONTRACT_RE = /\b(?:must|shall|required|guarantee|contract)\b|(?:すること|必要|保証|契約)/i;
const MOCK_CONTROL_RE = /^\s*#\s*(?:define|ifn?def)\s+([A-Z][A-Z0-9_]{2,})\b/;
const BUILD_DEFINE_RE = /(?:^|\s)-D([A-Z][A-Z0-9_]{2,})(?:=\S+)?/g;

function stemOf(relPath: string): string {
  const base = path.posix.basename(relPath);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
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
function identifierTokens(content: string): Set<string> {
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
function findOnPath(candidates: readonly string[]): string | undefined {
  // path.delimiter is ";" on win32 and ":" elsewhere — a hardcoded ":" both
  // fails to split a win32 PATH and mis-splits inside each entry's drive
  // letter ("C:\\..."); see core2/config.ts's TOKENLIGHTEN_ALLOWED_PARENTS
  // parsing for the same pattern.
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    for (const name of candidates) {
      try {
        if (fs.existsSync(path.join(dir, name))) return name;
      } catch {
        // unreadable PATH entry — keep scanning
      }
    }
  }
  return undefined;
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
  };
}

/** Which toolchain a surface/edit set belongs to. */
export type ToolchainDomain = "native" | "python" | "node" | "other";

/**
 * Plurality vote over file extensions, ties broken native > python > node so
 * the family that gates a COMPILE wins. This is what keeps an unrelated
 * ancestor package.json from claiming a C/C++ surface set as an npm project.
 */
export function surfaceToolchainDomain(paths: readonly string[]): ToolchainDomain {
  let native = 0;
  let python = 0;
  let node = 0;
  for (const rel of paths) {
    const ext = path.posix.extname(rel).toLowerCase();
    if (NATIVE_EXTS.has(ext)) native += 1;
    else if (PYTHON_SURFACE_EXTS.has(ext)) python += 1;
    else if (NODE_SURFACE_EXTS.has(ext)) node += 1;
  }
  const top = Math.max(native, python, node);
  if (top === 0) return "other";
  if (native === top) return "native";
  if (python === top) return "python";
  return "node";
}

/** Nearest CMakeLists.txt/Makefile/meson.build walking up from `fromDir` to the workspace root ("" = root). */
export function findBuildEntry(workspace: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    for (const name of BUILD_ENTRY_NAMES) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (fs.existsSync(path.join(workspace, rel))) return rel;
    }
    if (dir === "") return undefined;
    const parent = path.posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}

/** What can actually be RUN to verify these edits, and whether it can run NOW. */
interface TestEntryFact {
  /** "npm test" | "pytest". */
  command: string;
  /** node only: directory whose package.json declared scripts.test ("" = workspace root). */
  dir?: string;
  /**
   * node: `<dir>/node_modules` is a directory; python: a venv runner exists at
   * the matched root. Mirrors the pack-time runnability verdict
   * (readCodeTaskPack.ts buildVerificationVerdict) rather than importing it, so
   * the edit-time kit and the pack-time verdict cannot disagree about the same
   * checkout while each stays inside its own module boundary.
   */
  deps_installed: boolean;
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
  if (editsNode) {
    for (const root of roots) {
      const rel = root === "" ? "package.json" : `${root}/package.json`;
      try {
        const abs = path.join(workspace, rel);
        if (!fs.existsSync(abs)) continue;
        const pkg = JSON.parse(fs.readFileSync(abs, "utf8")) as { scripts?: Record<string, unknown> };
        const test = pkg.scripts?.test;
        if (typeof test !== "string" || test.length === 0) continue;
        let installed = false;
        try {
          installed = fs.statSync(path.join(workspace, root, "node_modules")).isDirectory();
        } catch {
          installed = false;
        }
        return { command: "npm test", dir: root, deps_installed: installed };
      } catch {
        // malformed/unreadable package.json — keep scanning other roots
      }
    }
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
  "referencing tests exist — verify through the handles above; compile_facts/link_set close standalone-compile failures";

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
 * K3: true when `sha12` matches the fingerprint this function last recorded
 * for `workspaceRoot` (i.e. the immediately-preceding kit for this
 * workspace was byte-identical). Always (re)records `sha12` as the newest
 * entry — delete-then-set touches Map insertion-order recency, so the
 * least-recently-touched workspace is the one evicted once the bound is hit.
 */
function checkAndRememberKitFingerprint(workspaceRoot: string, sha12: string): boolean {
  const prior = kitDedupeCache.get(workspaceRoot);
  const unchanged = prior !== undefined && prior.sha12 === sha12;
  kitDedupeCache.delete(workspaceRoot);
  kitDedupeCache.set(workspaceRoot, { sha12 });
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
 * edit_file call. Naming the tool is the whole fix — the alternative is a
 * native write.
 */
const HARNESS_CREATE_NOTE =
  "author new files with edit_file {path, create:true, cwd, content} — never native Write/Edit; no build-system registration needed";

/** toolchain.verify_note when the detected test entry cannot actually run yet. */
const VERIFY_NO_DEPS_NOTE =
  "this test entry's dependencies are not installed — verify by diff review against the served evidence, not by installing them";

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
  const matched: Array<{ rel: string; role: "test" | "mock"; bytes: number; refs: string[]; content: string; overlap: number }> = [];
  for (const file of walked) {
    if (editedSet.has(file.rel)) continue;
    if (!editedRoots.has(projectRootOf(file.rel, workspace))) continue;
    const mock = isMockish(file.rel);
    if (!mock && classifySurface(file.rel) !== "test") continue;
    if (file.bytes === 0 || file.bytes > SCAN_FILE_CAP_BYTES) continue;
    const content = readSmall(workspace, file.rel);
    if (content === undefined) continue;
    const lower = content.toLowerCase();
    const refs = new Set<string>();
    for (const [needle, rel] of needles) if (lower.includes(needle)) refs.add(rel);
    if (refs.size === 0) continue;
    // K2: overlap is 0 (never scanned) when the gate is inactive — a pure
    // no-op that leaves ranking/filtering exactly as before.
    let overlap = 0;
    if (relevanceGateActive) {
      for (const tok of identifierTokens(content)) if (changedIdentifiers.has(tok)) overlap += 1;
    }
    matched.push({ rel: file.rel, role: mock ? "mock" : "test", bytes: file.bytes, refs: [...refs].sort(), content, overlap });
  }
  matched.sort((a, b) =>
    b.refs.length - a.refs.length
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

  if (selected.length === 0 && compileFacts.length === 0 && linkCandidates.length === 0) return undefined;

  // ---- harness: build-command mining + mock-header inventory. Computed only
  // now that we know a manifest will be returned — enrichment alone must
  // never turn an otherwise-undefined manifest into a defined one. ----
  let buildCommand: { text: string; source: string } | undefined;
  for (const entry of selected) {
    if (entry.role !== "test") continue;
    const text = extractBuildCommand(entry.content);
    if (text !== undefined) {
      buildCommand = { text, source: entry.rel };
      break;
    }
  }
  const mockHeaderCandidates = walked
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
  // ---- toolchain: local compiler/build-entry/test-entry facts. Attached for
  // native-relevant edits OR whenever a runnable test entry was detected at all
  // — the old gate (compile facts / link set / native edits) meant node and
  // python edits NEVER got one, so an agent learned "npm test exists but
  // node_modules does not" through four native shell turns (2026-07-31).
  // Each domain contributes only its OWN fields: a TypeScript edit must not pay
  // for a C++ compiler probe it cannot use. ----
  const testEntryRoots = [...new Set(editedRootsAll)];
  if (!testEntryRoots.includes("")) testEntryRoots.push("");
  const testEntry = detectTestEntry(workspace, testEntryRoots, edited);
  const nativeRelevant = compileFacts.length > 0 || linkSet.length > 0 || nativeEdited.length > 0;
  const pythonRelevant = edited.some((rel) => PYTHON_SURFACE_EXTS.has(path.posix.extname(rel).toLowerCase()));
  let toolchain: ToolchainInfo | undefined;
  let buildEntryAbsent = false;
  // `pythonRelevant` widens which FIELDS ride, never whether the section does:
  // a .py edit with no discoverable runner still has nothing runnable to say.
  if (nativeRelevant || testEntry !== undefined) {
    // Only the domains that can USE the PATH scan pay for it (explain/doc tasks
    // still return before reaching here at all).
    const probe = nativeRelevant || pythonRelevant ? probeToolchain() : undefined;
    let buildEntry: string | undefined;
    if (nativeEdited.length > 0) {
      const firstNativeDir = path.posix.dirname(nativeEdited[0]!);
      buildEntry = findBuildEntry(workspace, firstNativeDir === "." ? "" : firstNativeDir);
      buildEntryAbsent = buildEntry === undefined;
    }
    const toolchainCandidate: ToolchainInfo = {
      ...(nativeRelevant && probe?.cxx !== undefined ? { cxx: probe.cxx } : {}),
      ...(nativeRelevant && probe?.cc !== undefined ? { cc: probe.cc } : {}),
      ...(pythonRelevant && probe?.python3 === true ? { python3: true } : {}),
      ...(buildEntry !== undefined ? { build_entry: buildEntry } : {}),
      ...(buildEntryAbsent ? { build_entry_absent: true } : {}),
      ...(testEntry !== undefined ? { test_entry: testEntry.command } : {}),
      ...(testEntry?.dir !== undefined ? { test_entry_dir: testEntry.dir } : {}),
      ...(testEntry !== undefined ? { deps_installed: testEntry.deps_installed } : {}),
      ...(testEntry?.deps_installed === false ? { verify_note: VERIFY_NO_DEPS_NOTE } : {}),
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
    harnessCommand !== undefined || harnessLinkCandidates !== undefined || mockHeaders.length > 0
      || (authoringLikely && nativeRelevant)
      ? {
          ...(harnessCommand !== undefined ? { build_command: harnessCommand } : {}),
          ...(synthesizedCommand !== undefined ? { build_command_synthesized: true as const } : {}),
          ...(entrypointCommands !== undefined ? { entrypoint_commands: entrypointCommands } : {}),
          ...(harnessLinkCandidates !== undefined ? { link_candidates: harnessLinkCandidates } : {}),
          ...(authoringLikely ? { create_note: HARNESS_CREATE_NOTE } : {}),
          ...(mockHeaders.length > 0 ? { mock_headers: mockHeaders } : {}),
        }
      : undefined;

  let recipe: TaskVerificationRecipe | undefined;
  if (verificationRecipeEnabled() || options.forceRecipe === true) {
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
    surfaces.some((s) => s.role === "test") ? "harness" : "syntax_only+diff";
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
    note: (strategy === "harness" ? KIT_NOTE_HARNESS : KIT_NOTE_SYNTAX_ONLY) + buildEntryAbsentNote,
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
