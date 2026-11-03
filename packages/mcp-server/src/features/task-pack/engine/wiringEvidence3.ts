// wiringEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskEvidenceGraph } from "@tokenlighten/types";
import type { TaskEvidenceNode } from "@tokenlighten/types";
import type { TaskEvidenceRelation } from "@tokenlighten/types";
import type { TaskEvidenceRelationKind } from "@tokenlighten/types";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { READINESS_PROBE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { maskCommentsAndStrings } from "../sfCodeMask.js";
import { readCached } from "./packBasics2.js";
import { scanLiteral } from "../../search/find/findText.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { shaOfText } from "../../../util/handles.js";

export function stripModuleExtension(relPath: string): string {
  return relPath
    .replace(/\.d\.(?:[cm]?ts|tsx)$/i, "")
    .replace(/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|jsx|mjs|mts|ts|tsx|py|rb|go|rs)$/i, "");
}

export function relationCodeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/^\s*#(?!\s*include\b).*$/gm, " ");
}

export function definedCallableNames(content: string): string[] {
  const names: string[] = [];
  const code = relationCodeOnly(content);
  for (const match of code.matchAll(/\b(?:def|fn|func|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    names.push(match[1]!);
  }
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/g)) {
    const name = match[1]!.split("::").at(-1)!;
    if (!/^(?:if|for|while|switch|catch)$/.test(name)) names.push(name);
  }
  return [...new Set(names)].slice(0, 12);
}

export function declaredCallableNames(content: string): string[] {
  const names = [...definedCallableNames(content)];
  const code = relationCodeOnly(content);
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:->\s*[^;]+)?;/g,
  )) {
    const name = match[1]!;
    if (!/^(?:if|for|while|switch|catch|return|sizeof)$/.test(name)) names.push(name);
  }
  return [...new Set(names)].slice(0, 16);
}

/**
 * D5 (2026-09-02, SF13 forensics): a `Class::method` anchor typed in a query is
 * ONE address, not two flat tokens.
 *
 * `wiringCandidateTokens`/`concreteIdentifierTokens` tokenize on identifier
 * boundaries, so `EKF::isHealthy` reached every downstream resolver as
 * ["EKF","isHealthy"], and `definedCallableNames` threw the qualifier away
 * (`split("::").at(-1)`). Three sibling headers each declaring a bare
 * `isHealthy()` were therefore indistinguishable from the one class the caller
 * named: the file that actually DEFINES `EKF::isHealthy` lost a same-role
 * `path.localeCompare` tie to `altitude_estimator.hpp` and was shed by the seed
 * cap with no disclosure at all.
 *
 * Only `::` is admitted as a member separator. `.` is ambiguous with a filename
 * (`ekf.cpp` is a path, not `ekf::cpp`) and `#` carries no member-anchor
 * meaning anywhere else in this file, so neither is treated as a qualified
 * anchor: an anchor must be unmistakable before it is allowed to outrank the
 * ordinary ranking.
 */
export interface QualifiedSymbolAnchor {
  readonly raw: string;
  readonly qualifier: string;
  readonly member: string;
}

/** Bound on qualified anchors honored from one query (each costs one literal scan). */
export const MAX_QUALIFIED_ANCHORS = 3;

/** Bound on files content-scanned while resolving one qualified anchor. */
export const QUALIFIED_ANCHOR_MAX_FILES = 64;

/** Bound on bytes read while resolving one qualified anchor. */
export const QUALIFIED_ANCHOR_MAX_BYTES = 512 * 1024;

/** Bound on qualified-anchor definition sites that may claim a seed slot or a disclosure line. */
export const MAX_QUALIFIED_ANCHOR_DEFINITIONS = 3;

/**
 * `Class::method` pairs named by `query`, in query order, deduped and bounded.
 * A deeper chain (`Outer::Inner::method`) yields its INNERMOST pair — that is
 * the pair a definition site actually spells.
 */
export function qualifiedSymbolAnchors(query: string): QualifiedSymbolAnchor[] {
  const out: QualifiedSymbolAnchor[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b(?!::)/g)) {
    const key = match[0]!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: match[0]!, qualifier: match[1]!, member: match[2]! });
    if (out.length >= MAX_QUALIFIED_ANCHORS) break;
  }
  return out;
}

/** Brace-matched body text starting at the `{` at `openIndex`. Bounded; comment-stripped input only. */
export function bracedBodyText(code: string, openIndex: number, maxLength = 200_000): string {
  let depth = 0;
  const limit = Math.min(code.length, openIndex + maxLength);
  for (let index = openIndex; index < limit; index += 1) {
    const ch = code[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, index);
    }
  }
  return code.slice(openIndex + 1, limit);
}

/**
 * How `content` relates to `anchor`:
 * - "definition" — it carries the member's BODY: an out-of-line
 *   `Qualifier::member(...) { … }` (C++/Rust-style), or a member with a brace
 *   body inside the `class`/`struct`/`interface` named `qualifier` (how TS, JS,
 *   Java and in-class C++ spell the same thing);
 * - "declaration" — that class body declares `member(...)` with no body;
 * - undefined — neither (a call site, a same-named member of a DIFFERENT class,
 *   or prose). The qualifier gate is what the flat-token path never applied.
 */
export function qualifiedAnchorSiteKind(
  content: string,
  anchor: QualifiedSymbolAnchor,
  /**
   * File-extension hint ("rs"/"swift"/"scala"/"kt", etc — whatever the
   * caller's path extension is, case-insensitive), forwarded verbatim to
   * `maskCommentsAndStrings`'s `language` option (sfCodeMask.ts). Only the
   * nested-block-comment languages act on it; every other extension (or no
   * extension at all) keeps this predicate's pre-existing, byte-identical
   * default (first-`*\/`-closes) masking.
   */
  language?: string,
): "definition" | "declaration" | undefined {
  // R9 / review R7-1: `relationCodeOnly` leaves a trailing `//` that follows a
  // non-space character, a trailing `#`, a `--` comment, and EVERY string
  // literal intact — so a commented-out or quoted `Qualifier::member(...) { }`
  // used to answer "definition" here (DESIGN-v0.14-plan.md:104). This is the
  // one predicate that asserts a file DEFINES the anchored member, and a false
  // definition seeds a pack with a file that cannot answer the question, so it
  // gets the strict, length-preserving mask instead of the token-census one.
  const code = maskCommentsAndStrings(content, { language });
  const qualifier = anchor.qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const member = anchor.member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${qualifier}::${member}\\s*\\([^;{}]*\\)[^;{}]*\\{`).test(code)) return "definition";
  const head = new RegExp(
    `\\b(?:class|struct|interface)\\s+(?:[A-Za-z_][A-Za-z0-9_]*\\s+)*${qualifier}\\b[^;{]{0,200}\\{`,
    "g",
  );
  // Not preceded by `.`, `->`, `::` or a word character: a CALL to the member
  // inside the same class body is not a declaration of it.
  const memberSite = new RegExp(`(?:^|[^.\\w>:])${member}\\s*\\([^;{}]*\\)[^;{}]*?(\\{|;)`);
  for (let match = head.exec(code); match !== null; match = head.exec(code)) {
    const site = memberSite.exec(bracedBodyText(code, match.index + match[0]!.length - 1));
    if (site === null) continue;
    return site[1] === "{" ? "definition" : "declaration";
  }
  return undefined;
}

/**
 * `x.hpp`/`x.h`/`x.d.ts` ↔ `x.cpp`/`x.cc`/`x.cxx`/`x.c`/`x.ts`/`x.js`: the
 * implementation counterpart of a declaring header, matched on the basename
 * STEM rather than an exact sibling path (`include/**\/y.hpp` beside
 * `src/**\/y.cpp` is the dominant C/C++ split). Sound because every candidate
 * offered to this predicate already mentions the anchored member, so a stem
 * match cannot promote an unrelated same-named file.
 */
export function isImplementationCounterpartOf(candidatePath: string, declarationPath: string): boolean {
  if (candidatePath === declarationPath) return false;
  const stemOf = (value: string): string =>
    path.basename(value).replace(/\.d\.(?:[cm]?ts|tsx)$/i, "").replace(/\.[^.]+$/, "").toLowerCase();
  if (stemOf(candidatePath) !== stemOf(declarationPath)) return false;
  const declaresSide = /\.d\.(?:[cm]?ts|tsx)$/i.test(declarationPath)
    || [".h", ".hh", ".hpp", ".hxx"].includes(path.extname(declarationPath).toLowerCase());
  return declaresSide && isImplementationPath(candidatePath);
}

export interface QualifiedAnchorResolution {
  /** Files that DEFINE a qualified anchor named by the query (authoritative, not lexical). */
  readonly definitions: readonly string[];
  /** Files whose `class <Qualifier>` body declares the anchored member without a body. */
  readonly declarations: readonly string[];
  /** Implementation counterparts of `declarations` that also mention the member. */
  readonly counterparts: readonly string[];
  /** First observed line of the anchored member per candidate path. */
  readonly lines: ReadonlyMap<string, number>;
}

export const EMPTY_QUALIFIED_ANCHOR_RESOLUTION: QualifiedAnchorResolution = {
  definitions: [],
  declarations: [],
  counterparts: [],
  lines: new Map<string, number>(),
};

/**
 * Resolve every qualified anchor in `query` as a UNIT, before any flat-token
 * fallback: definition sites first, then the declaring class body, then that
 * header's implementation counterpart. Bounded (`MAX_QUALIFIED_ANCHORS` scans,
 * `QUALIFIED_ANCHOR_MAX_FILES`/`_BYTES` per scan) and a zero-cost no-op for the
 * overwhelmingly common query that names no `Class::method` at all.
 */
export function resolveQualifiedSymbolAnchors(
  query: string,
  workspace: string,
  cache?: FileReadCache,
): QualifiedAnchorResolution {
  const anchors = qualifiedSymbolAnchors(query);
  if (anchors.length === 0) return EMPTY_QUALIFIED_ANCHOR_RESOLUTION;
  const definitions: string[] = [];
  const declarations: string[] = [];
  const lines = new Map<string, number>();
  const candidatePaths: string[] = [];
  for (const anchor of anchors) {
    const seenHere: string[] = [];
    for (const match of scanLiteral(anchor.member, workspace, { caseInsensitive: false })) {
      if (!lines.has(match.path)) lines.set(match.path, match.line);
      if (!seenHere.includes(match.path)) seenHere.push(match.path);
      if (!candidatePaths.includes(match.path)) candidatePaths.push(match.path);
    }
    let filesRead = 0;
    let bytesRead = 0;
    for (const relPath of [...seenHere].sort((a, b) => a.localeCompare(b))) {
      if (filesRead >= QUALIFIED_ANCHOR_MAX_FILES || bytesRead >= QUALIFIED_ANCHOR_MAX_BYTES) break;
      const content = readCached(workspace, relPath, cache);
      if (content === undefined) continue;
      filesRead += 1;
      bytesRead += Buffer.byteLength(content, "utf8");
      // Default wire for every non-nested-comment extension stays
      // byte-identical: `extensionOfRelPath` is a plain suffix read, and
      // `qualifiedAnchorSiteKind`'s own `language` param is a no-op for any
      // value NESTING_BLOCK_COMMENT_LANGUAGES (sfCodeMask.ts) does not list.
      const dotIndex = relPath.lastIndexOf(".");
      const extensionOfRelPath = dotIndex === -1 ? undefined : relPath.slice(dotIndex + 1).toLowerCase();
      const kind = qualifiedAnchorSiteKind(content, anchor, extensionOfRelPath);
      if (kind === "definition") {
        if (!definitions.includes(relPath)) definitions.push(relPath);
      } else if (kind === "declaration") {
        if (!declarations.includes(relPath)) declarations.push(relPath);
      }
    }
  }
  const counterparts: string[] = [];
  for (const declarationPath of declarations) {
    for (const candidate of candidatePaths) {
      if (definitions.includes(candidate) || declarations.includes(candidate)) continue;
      if (!isImplementationCounterpartOf(candidate, declarationPath)) continue;
      if (!counterparts.includes(candidate)) counterparts.push(candidate);
    }
  }
  return {
    definitions: definitions.slice(0, MAX_QUALIFIED_ANCHOR_DEFINITIONS),
    declarations,
    counterparts,
    lines,
  };
}

export function hasEditGradeCallArgument(
  query: string,
  destinationCode: string,
  supportingSurfaces: readonly TaskPackSurface[],
): boolean {
  const requiresLiteral = /\b(?:hard[- ]?coded|literal|replace)\b/i.test(query);
  for (const surface of supportingSurfaces) {
    const names = [surface.symbol, ...declaredCallableNames(servedSurfaceText(surface))]
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
      const call = new RegExp("\\b" + escaped + "\\s*\\(([^)]{1,1024})\\)", "m")
        .exec(destinationCode);
      if (call === null || call[1]!.trim().length === 0) continue;
      if (
        !requiresLiteral
        || /(?:\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|["'][^"']*["']|\b\d+(?:\.\d+)?\b)/.test(call[1]!)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * D7 (FX-R3b, 2026-09-04) — NON-CALLABLE DEFINITION SITES.
 *
 * `workspaceCallableDefinitionPaths` above answers only for CALLABLES
 * (`definedCallableNames` matches `def`/`fn`/`function` and `name(...) {`).
 * The SF structural extractor's `definitionPathsFor` capability was wired to
 * it alone, so a constant, class, type, enum, struct or module-level value —
 * `ENGAGEMENT_WITNESS` in the deterministic bench's own engagement fixture —
 * resolved to ZERO paths, opened only an ADVISORY concern, and therefore left
 * `annotateSemanticFrontierContinuation`'s D4 source empty: with the ten v2
 * flags on, nothing was ever marked and `demoted_count` was structurally 0
 * for every query naming a non-callable identifier. That is the same
 * inertness class D4 closed for query PHRASING, reopened by symbol KIND.
 *
 * Purely lexical, like every other probe in this family, and bounded by the
 * same readiness budgets. It is a FALLBACK: the callable resolver still wins
 * when it answers, so no existing resolution changes.
 */
export const VALUE_DEFINITION_KEYWORDS =
  "const|constexpr|let|var|val|static|final|class|interface|type|enum|struct|union|trait|namespace|module|object|record|protocol|typedef|def";

export function workspaceValueDefinitionPaths(
  token: string,
  walked: ReadonlyArray<string>,
  workspace: string,
  cache: FileReadCache | undefined,
): string[] {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A keyword-led declaration: `export const X =`, `class X {`, `enum X {`,
  // `pub static X:`, `typedef struct X;`, `type X = ...`.
  const declaration = new RegExp(
    "^[ \\t]*(?:(?:export|public|private|protected|internal|declare|pub|open|abstract|final|static|readonly|inline|extern|constexpr|const|local)\\s+)*"
      + `(?:${VALUE_DEFINITION_KEYWORDS})\\s+(?:[A-Za-z_][A-Za-z0-9_<>,:\\[\\]*&.]*\\s+)?`
      + escaped + "\\b\\s*(?:[:=<({;]|$)",
    "m",
  );
  // A column-0 assignment (Python/Ruby/shell/Make module constants) and the C
  // preprocessor's own definition form.
  const assignment = new RegExp(`^${escaped}\\s*(?::[^=\\n]+)?=`, "m");
  const define = new RegExp(`^[ \\t]*#\\s*define\\s+${escaped}\\b`, "m");
  const matches: string[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const relPath of walked) {
    if (filesRead >= READINESS_PROBE_MAX_FILES || bytesRead >= READINESS_PROBE_MAX_BYTES) break;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    filesRead += 1;
    bytesRead += Buffer.byteLength(content, "utf8");
    const code = relationCodeOnly(content);
    if (declaration.test(code) || assignment.test(code) || define.test(code)) {
      matches.push(relPath);
      if (matches.length > 3) break;
    }
  }
  return matches;
}

export function calledCallableNames(content: string): string[] {
  const code = relationCodeOnly(content);
  const names: string[] = [];
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g)) {
    const name = match[1]!;
    if (/^(?:if|for|while|switch|catch|return|sizeof)$/.test(name)) continue;
    if (match[2]!.trim().length === 0) continue;
    const tail = code.slice((match.index ?? 0) + match[0].length);
    if (/^\s*(?:const\s*)?\{/.test(tail)) continue;
    names.push(name);
  }
  return [...new Set(names)].slice(0, 6);
}

export function importLineTargetsPath(
  consumerPath: string,
  line: string,
  targetPath: string,
): boolean {
  if (!/^\s*(?:import\b|#\s*include\b|use\b|from\b|.*\brequire\s*\()/.test(line)) return false;
  const specifiers = [...line.matchAll(
    /(?:\bfrom\s*|require\s*\(\s*|#\s*include\s*)["'<]([^"'>)]+)["'>)]/g,
  )].map((match) => match[1]!);
  const pythonFrom = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/.exec(line)?.[1];
  if (pythonFrom !== undefined) specifiers.push(pythonFrom.replace(/\./g, "/"));

  const targetStem = stripModuleExtension(targetPath);
  return specifiers.some((specifier) => {
    const normalized = specifier.replace(/\\/g, "/");
    const specifierStem = stripModuleExtension(normalized);
    if (normalized.startsWith(".")) {
      return stripModuleExtension(path.posix.normalize(
        path.posix.join(path.posix.dirname(consumerPath), normalized),
      )) === targetStem;
    }
    return targetStem === specifierStem || targetStem.endsWith("/" + specifierStem);
  });
}

export function evidenceNodeId(kind: "file" | "symbol", pathValue: string, symbol = ""): string {
  return `${kind}:${shaOfText(`${pathValue}\u0000${symbol}`).slice(0, 12)}`;
}

export function evidenceRelationId(kind: TaskEvidenceRelationKind, from: string, to: string): string {
  return `relation:${kind}:${shaOfText(`${from}\u0000${to}`).slice(0, 12)}`;
}

/**
 * A read-only answer may explicitly ask how already-served files are related.
 * The mutation-oriented wiring profile is deliberately not appropriate there:
 * it infers an insertion contract and may grow the frontier.  This projection
 * is narrower.  It only records a TypeScript/JavaScript-style import when the
 * importer and its resolved, already-served target are both in the answer
 * pack.  In particular, it never creates an edge from stems, path proximity,
 * or identifier co-occurrence.
 */
export const ANSWER_IMPORT_GRAPH_EXT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;

export function buildAnswerImportEvidenceGraph(
  surfaces: readonly TaskPackSurface[],
  workspace: string,
  cache: FileReadCache | undefined,
): TaskEvidenceGraph | undefined {
  const byPath = new Map<string, TaskPackSurface>();
  for (const surface of surfaces) {
    if (!byPath.has(surface.path) && ANSWER_IMPORT_GRAPH_EXT.test(surface.path)) byPath.set(surface.path, surface);
  }
  if (byPath.size < 2) return undefined;

  const roles = new Map<string, Set<TaskEvidenceNode["roles"][number]>>();
  const relations: TaskEvidenceRelation[] = [];
  const addRole = (surface: TaskPackSurface, role: TaskEvidenceNode["roles"][number]): void => {
    const current = roles.get(surface.path) ?? new Set<TaskEvidenceNode["roles"][number]>();
    current.add(role);
    roles.set(surface.path, current);
  };
  for (const importer of byPath.values()) {
    const body = readCached(workspace, importer.path, cache)
      ?? importer.code
      ?? importer.code_unchanged
      ?? "";
    if (body === "") continue;
    for (const imported of byPath.values()) {
      if (imported.path === importer.path) continue;
      const hasExactImport = body.split(/\r?\n/).some((line) =>
        importLineTargetsPath(importer.path, line, imported.path));
      if (!hasExactImport) continue;
      const from = evidenceNodeId("file", importer.path);
      const to = evidenceNodeId("file", imported.path);
      const id = evidenceRelationId("imports", from, to);
      if (relations.some((relation) => relation.id === id)) continue;
      addRole(importer, "consumer");
      addRole(imported, "producer");
      relations.push({ id, kind: "imports", from, to, provenance: "lexical", confidence: 0.98 });
    }
  }
  if (relations.length === 0) return undefined;
  const nodes = [...roles.entries()]
    .map(([surfacePath, nodeRoles]) => {
      const surface = byPath.get(surfacePath)!;
      return {
        id: evidenceNodeId("file", surface.path),
        kind: "file" as const,
        path: surface.path,
        handle: surface.handle,
        range: surface.range,
        roles: [...nodeRoles].sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { version: 1, nodes, relations: relations.sort((left, right) => left.id.localeCompare(right.id)) };
}

/** E1: minimum length of a query token allowed to name a destination-domain family. */
export const WIRING_DOMAIN_MIN_TOKEN_LEN = 4;

/** E1: bound on the walked paths scanned for family segments. */
export const WIRING_DOMAIN_MAX_SEGMENT_FILES = 4000;

/** E1: bound on family files whose BODY is read and scored. */
export const WIRING_DOMAIN_MAX_SCORED_FILES = 48;

/** E1: bound on declarations scanned when naming the domain destination's endpoint token. */
export const WIRING_DOMAIN_MAX_SYMBOLS = 256;

/**
 * R31 finding #2 (P1, 2026-09-05): generic path/build vocabulary that must
 * never, by itself, name a destination-domain family. These words are common
 * enough to appear as a path segment in almost any repository (an entry
 * point, a test/build directory, a vendored dependency) without the query
 * actually intending to name a module family -- "main"/"test" are exactly
 * `WIRING_DOMAIN_MIN_TOKEN_LEN` (4) characters and so were not excluded by
 * the length floor alone. Applied ON TOP OF, never instead of, that floor.
 * Kept deliberately generic: no project-specific word belongs here.
 */
export const WIRING_DOMAIN_GENERIC_VOCAB = new Set([
  "main", "test", "tests", "spec", "specs", "src", "source", "app", "apps",
  "lib", "libs", "util", "utils", "common", "core", "base", "shared", "index",
  "config", "include", "internal", "impl", "pkg", "cmd", "bin", "dist",
  "build", "docs", "examples", "sample", "samples", "tools", "scripts",
  "vendor", "third_party", "node_modules", "target", "out", "tmp",
]);
