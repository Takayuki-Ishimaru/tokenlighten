// ---------------------------------------------------------------------------
// graph-evidence/adapters.ts — V11-01: the ONE concrete binding of the
// provider interfaces to real repository surfaces.
//
// WHAT IT BINDS
// -------------
//  * `graph/index.ts` `loadGraphIndex()` → an import-graph provider and a
//    reference-index provider (`createTlGraphProviders`).
//  * `symbols/collectSymbols.ts` → a declaration-only symbol provider
//    (`createParserSymbolProvider`).
//  * pure path/naming rules → a test/config/build/doc/generated role provider
//    (`createPathHeuristicsProvider`).
//
// WAVE-A POSTURE. This file may import those two read-only surfaces; NOTHING
// in production imports this file. The engine (`edges.ts`, `impact.ts`) never
// imports it either — it only sees the interfaces in `providers.ts`, which is
// what lets the specs drive the engine with fixtures and drive this adapter
// against a real workspace, independently.
//
// WHAT IT DOES NOT DO
// -------------------
//  * It does not walk the filesystem for an inventory. The caller supplies the
//    file list and the digests; E-1's overlay owns no crawler and no store.
//  * It does not refactor anything upstream. `tools/findReferences.ts` exports
//    a perfectly callable `findReferences(input, workspace)` — but it is a WIRE
//    RESPONSE BUILDER, not a library query: it is async, byte-capped
//    (MAX_RESPONSE_BYTES = 2048), match-capped (MAX_REFERENCES = 200), and
//    cursor-paginated, and it reports comment mentions through `in_comment`
//    rather than excluding them. Binding it here would mean paging a cursor to
//    exhaustion inside a bounded expansion and then treating a truncated wire
//    object as evidence — i.e. inheriting a 2 KiB response cap as a silent
//    EVIDENCE cap. So reference evidence comes from tl-graph only in wave A,
//    and `ReferenceProvider` stays open for a wave-B binding that has a real
//    reference engine (and a `in_comment` -> evidence-class rule) behind it.
//  * It never claims a call edge. tl-graph cannot distinguish a call from any
//    other mention, so `callersOf`/`calleesOf` are deliberately absent and the
//    coverage matrix reports CALLS/CALLED_BY as unsupported.
// ---------------------------------------------------------------------------

import * as crypto from "node:crypto";

import { loadGraphIndex, type GraphIndex } from "../../graph/index.js";
import {
  collectSymbolsChecked,
  type CollectSymbolsAttempt,
} from "../../symbols/collectSymbols.js";
import type { TreeSitterPaths } from "../../skeleton/types.js";
import { fileNode, symbolNode, type GraphEdgeType, type GraphNode } from "./model.js";
import type {
  DeclaredSymbolAt,
  ImportGraphProvider,
  PathEdgeType,
  PathHeuristicsProvider,
  PathRelation,
  PathRole,
  ProviderCoverage,
  ReferenceProvider,
  SymbolProvider,
  SymbolReference,
} from "./providers.js";

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** The digest form every provider in this file stamps onto its edges. */
export function contentSha(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// tl-graph providers
// ---------------------------------------------------------------------------

export interface TlGraphProviderOptions {
  /** Workspace root; only consulted when `index`/`generation` are not injected. */
  readonly workspace: string;
  /**
   * The caller's file inventory. tl-graph's `GraphIndex` cannot enumerate
   * itself, so `importedBy` is derived by inverting `importsOf` over this list
   * — which is exactly why coverage defaults to `unknown`.
   */
  readonly files: readonly string[];
  /** path → current content digest, for edge stamping. */
  readonly sourceShas: ReadonlyMap<string, string>;
  /** Languages the caller knows this index covers. */
  readonly languages: readonly string[];
  /** Overrides the default `unknown` claim; pass only with a real proof. */
  readonly coverage?: ProviderCoverage;
  /** Injected index, for tests that must not touch a filesystem. */
  readonly index?: GraphIndex;
  /** Injected generation, paired with `index`. */
  readonly generation?: string;
  readonly idPrefix?: string;
}

export interface TlGraphProviders {
  readonly imports?: ImportGraphProvider;
  readonly references?: ReferenceProvider;
  /** Empty when no graph was available. */
  readonly generation: string;
}

const TL_GRAPH_IMPORT_EDGES: readonly GraphEdgeType[] = ["IMPORTS", "IMPORTED_BY"];
const TL_GRAPH_REFERENCE_EDGES: readonly GraphEdgeType[] = ["REFERENCES"];

export function createTlGraphProviders(options: TlGraphProviderOptions): TlGraphProviders {
  const index = options.index ?? loadGraphIndex(options.workspace);
  if (index === undefined) return { generation: "" };

  // V11-05: the generation now comes straight off the loaded index's own
  // `rootHash()` accessor (graph/index.ts) instead of a second, duplicate
  // head-byte read of tl-graph.json — same string format as before
  // (`tl-graph:${rootHash}`), so every existing generation comparison and
  // fixture assertion is unaffected. `rootHash()` returns undefined for a
  // SCIP-backed index or a headless tl-graph.json; either way the provider
  // generation stays "", which fails every edge's staleness check closed.
  const rootHash = index.rootHash();
  const generation = options.generation ?? (rootHash !== undefined ? `tl-graph:${rootHash}` : "");
  const prefix = options.idPrefix ?? "tl-graph";
  const languages = [...options.languages];
  const coverage: ProviderCoverage = options.coverage ?? {
    status: "unknown",
    languages,
    reason: "tl-graph rootHash is not cross-checked against the live source index",
  };
  const shaOf = (target: string): string | undefined => options.sourceShas.get(target);

  // Reverse import map, built once, from the caller's inventory.
  let reverse: Map<string, string[]> | undefined;
  const importedBy = (target: string): readonly string[] => {
    if (reverse === undefined) {
      reverse = new Map<string, string[]>();
      for (const file of options.files) {
        for (const imported of index.importsOf(file)) {
          const bucket = reverse.get(imported);
          if (bucket === undefined) reverse.set(imported, [file]);
          else bucket.push(file);
        }
      }
      for (const bucket of reverse.values()) bucket.sort();
    }
    return reverse.get(target) ?? [];
  };

  const imports: ImportGraphProvider = {
    identity: { id: `${prefix}:imports`, kind: "import-graph", indexGeneration: generation, coverage },
    edgeTypeSupport: (language) => (languages.includes(language) ? TL_GRAPH_IMPORT_EDGES : []),
    sourceShaOf: shaOf,
    importsOf: (target) => [...index.importsOf(target)].sort(),
    importedBy,
    exportsOf: (target) => [...index.exportsOf(target)].sort(),
  };

  const references: ReferenceProvider = {
    identity: {
      id: `${prefix}:references`,
      kind: "reference-index",
      indexGeneration: generation,
      coverage,
    },
    edgeTypeSupport: (language) => (languages.includes(language) ? TL_GRAPH_REFERENCE_EDGES : []),
    sourceShaOf: shaOf,
    definitionOf: (symbol): GraphNode | undefined => {
      const location = index.definition(symbol);
      if (location === undefined) return undefined;
      return symbolNode(location.path, symbol, "reference-index", { line: location.line });
    },
    // tl-graph records the referencing FILE (its writer emits line 1 / column 0
    // for every reference), so a FILE node is the honest granularity here. A
    // symbol node would claim an enclosing declaration the index never proved.
    referencesTo: (symbol): readonly SymbolReference[] => {
      const seen = new Set<string>();
      const out: SymbolReference[] = [];
      for (const location of index.references(symbol)) {
        if (seen.has(location.path)) continue;
        seen.add(location.path);
        out.push({ node: fileNode(location.path, "reference-index") });
      }
      out.sort((a, b) => a.node.path.localeCompare(b.node.path));
      return out;
    },
    // callersOf / calleesOf are ABSENT on purpose — see this file's header.
  };

  return { imports, references, generation };
}

// ---------------------------------------------------------------------------
// Parser symbol provider (PI-06 declaration-only)
// ---------------------------------------------------------------------------

export interface SymbolSource {
  readonly path: string;
  /** Language id as `collectSymbols` spells it. */
  readonly language: string;
  readonly text: string;
}

export interface ParserSymbolProviderOptions {
  readonly sources: readonly SymbolSource[];
  readonly treeSitterPaths?: TreeSitterPaths;
  readonly id?: string;
  /** Injected collector; defaults to the repository's parser. */
  readonly collect?: (
    text: string,
    language: string,
    paths: TreeSitterPaths,
  ) => Promise<CollectSymbolsAttempt>;
}

const SYMBOL_EDGE_TYPES: readonly GraphEdgeType[] = ["EXTENDS", "IMPLEMENTS"];

/**
 * Collect declarations ONCE, then serve them synchronously.
 *
 * The async work (tree-sitter) happens here, in the factory, so expansion
 * stays synchronous and the duration bound in `bounds.ts` actually bounds
 * something. A file whose language the collector does not support, or whose
 * parse fails, falls back to a conservative line scanner and every declaration
 * from it is labelled `regex-fallback` — never silently promoted.
 *
 * HERITAGE HONESTY. `collectSymbols` yields declaration ranges, not heritage
 * clauses, so `extends`/`implements` names are extracted by regex over the
 * PARSER-DELIMITED signature text. That is stronger than a whole-file scan and
 * weaker than a parse, so it is labelled `heritageProof: "regex-fallback"`,
 * which caps the resulting EXTENDS/IMPLEMENTS edges at `structural`. A wave-B
 * provider with real heritage nodes will produce `direct` ones unchanged.
 */
export async function createParserSymbolProvider(
  options: ParserSymbolProviderOptions,
): Promise<SymbolProvider> {
  const collect = options.collect ?? collectSymbolsChecked;
  const treeSitterPaths = options.treeSitterPaths ?? {};

  const shas = new Map<string, string>();
  const languages = new Map<string, string>();
  const byPath = new Map<string, DeclaredSymbolAt[]>();
  const byName = new Map<string, DeclaredSymbolAt[]>();
  const subtypes = new Map<string, DeclaredSymbolAt[]>();
  const parsedLanguages = new Set<string>();
  let fallbackFiles = 0;

  for (const source of options.sources) {
    shas.set(source.path, contentSha(source.text));
    languages.set(source.path, source.language);

    const attempt = await collect(source.text, source.language, treeSitterPaths);
    const declarations: DeclaredSymbolAt[] = [];

    if (attempt.parserAvailable) {
      parsedLanguages.add(source.language);
      for (const symbol of attempt.symbols) {
        const signature = source.text.slice(symbol.signatureStartIndex, symbol.signatureEndIndex);
        const heritage = heritageOfSignature(signature, source.language);
        declarations.push({
          path: source.path,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.startLine,
          proof: "parser",
          heritageProof: "regex-fallback",
          ...(heritage.extendsNames.length > 0 ? { extendsNames: heritage.extendsNames } : {}),
          ...(heritage.implementsNames.length > 0
            ? { implementsNames: heritage.implementsNames }
            : {}),
        });
      }
    } else {
      fallbackFiles += 1;
      declarations.push(...scanDeclarations(source));
    }

    byPath.set(source.path, declarations);
    for (const declaration of declarations) {
      const named = byName.get(declaration.name);
      if (named === undefined) byName.set(declaration.name, [declaration]);
      else named.push(declaration);

      for (const base of [
        ...(declaration.extendsNames ?? []),
        ...(declaration.implementsNames ?? []),
      ]) {
        const bucket = subtypes.get(base);
        if (bucket === undefined) subtypes.set(base, [declaration]);
        else if (!bucket.includes(declaration)) bucket.push(declaration);
      }
    }
  }

  const coverage: ProviderCoverage =
    options.sources.length === 0
      ? { status: "unknown", languages: [], reason: "no sources were collected" }
      : fallbackFiles === 0
        ? { status: "complete", languages: [...parsedLanguages].sort() }
        : {
            status: "partial",
            languages: [...parsedLanguages].sort(),
            reason: `${fallbackFiles} file(s) fell back to a regex declaration scan`,
          };

  const files = [...shas.keys()].sort();

  return {
    identity: {
      id: options.id ?? "parser:symbols",
      kind: "symbol",
      // The generation is the digest of the collected corpus: any file whose
      // content moved produces a different generation, so an edge stamped by an
      // earlier corpus is discarded rather than silently reused.
      indexGeneration: corpusGeneration(files, shas),
      coverage,
    },
    edgeTypeSupport: (language) => (parsedLanguages.has(language) ? SYMBOL_EDGE_TYPES : []),
    files: () => files,
    declarationsIn: (target) => byPath.get(target) ?? [],
    declarationsOf: (name) => byName.get(name) ?? [],
    subtypesOf: (name) => subtypes.get(name) ?? [],
    languageOf: (target) => languages.get(target),
    sourceShaOf: (target) => shas.get(target),
  };
}

function corpusGeneration(files: readonly string[], shas: ReadonlyMap<string, string>): string {
  if (files.length === 0) return "";
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\n");
    hash.update(shas.get(file) ?? "");
    hash.update("\n");
  }
  return `parser:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Heritage / declaration text rules
// ---------------------------------------------------------------------------

function baseNamesFrom(clause: string): string[] {
  const out: string[] = [];
  for (const raw of clause.split(",")) {
    // Keyword arguments (`metaclass=...`) and unpacking are not base types.
    if (raw.includes("=") || raw.includes("*")) continue;
    const withoutGenerics = raw.replace(/<[\s\S]*$/, "").trim();
    const segments = withoutGenerics.split(".");
    const last = (segments[segments.length - 1] ?? "").trim();
    const match = /^[A-Za-z_$][\w$]*/.exec(last);
    if (match !== null) out.push(match[0]);
  }
  return out;
}

function heritageOfSignature(
  signature: string,
  language: string,
): { extendsNames: string[]; implementsNames: string[] } {
  const normalized = signature.replace(/\s+/g, " ");
  if (language.toLowerCase() === "python") {
    const bases = /\bclass\s+[A-Za-z_]\w*\s*\(([^)]*)\)/.exec(normalized);
    const clause = bases?.[1];
    return {
      extendsNames: clause === undefined ? [] : baseNamesFrom(clause),
      implementsNames: [],
    };
  }
  const extendsClause = /\bextends\s+([^{]+?)(?:\bimplements\b|\{|$)/.exec(normalized)?.[1];
  const implementsClause = /\bimplements\s+([^{]+?)(?:\{|$)/.exec(normalized)?.[1];
  return {
    extendsNames: extendsClause === undefined ? [] : baseNamesFrom(extendsClause),
    implementsNames: implementsClause === undefined ? [] : baseNamesFrom(implementsClause),
  };
}

const BRACE_DECL_RE =
  /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const INDENT_DECL_RE = /^[ \t]*(class|def)\s+([A-Za-z_]\w*)/;

/**
 * The labelled fallback. Every declaration it finds carries
 * `proof: "regex-fallback"`, so `classifyEdge` refuses `direct` on any edge
 * touching one — the plan's "regex-fallback nodes must be labelled, never
 * silently promoted" rule, enforced by the model rather than by convention.
 */
function scanDeclarations(source: SymbolSource): DeclaredSymbolAt[] {
  const python = source.language.toLowerCase() === "python";
  const pattern = python ? INDENT_DECL_RE : BRACE_DECL_RE;
  const out: DeclaredSymbolAt[] = [];
  const lines = source.text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = pattern.exec(line);
    if (match === null) continue;
    const keyword = match[1] ?? "";
    const name = match[2] ?? "";
    if (name === "") continue;
    const heritage = heritageOfSignature(line, source.language);
    out.push({
      path: source.path,
      name,
      kind: keyword === "def" ? "function" : keyword,
      line: i + 1,
      proof: "regex-fallback",
      heritageProof: "regex-fallback",
      ...(heritage.extendsNames.length > 0 ? { extendsNames: heritage.extendsNames } : {}),
      ...(heritage.implementsNames.length > 0 ? { implementsNames: heritage.implementsNames } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path heuristics provider
// ---------------------------------------------------------------------------

export interface PathHeuristicsOptions {
  readonly files: readonly string[];
  readonly sourceShas?: ReadonlyMap<string, string>;
  /** Languages this provider claims to have processed. */
  readonly languages?: readonly string[];
  readonly id?: string;
  /** Cap on the files one config is proposed to configure. */
  readonly maxConfiguredFiles?: number;
  /** Cap on the ancestor configs proposed for one file. */
  readonly maxAncestorConfigs?: number;
  /** Cap on the counterparts proposed for one naming relation. */
  readonly maxCounterparts?: number;
}

const DEFAULT_MAX_CONFIGURED_FILES = 32;
const DEFAULT_MAX_ANCESTOR_CONFIGS = 8;
const DEFAULT_MAX_COUNTERPARTS = 8;

const PATH_PROVIDER_EDGE_TYPES: readonly GraphEdgeType[] = [
  "TESTED_BY",
  "CONFIGURES",
  "GENERATED_FROM",
];

/** Rule names are direction-INDEPENDENT so both endpoints derive the same edge. */
const RULE_TEST = "test-stem-mirror";
const RULE_CONFIG = "config-directory-scope";
const RULE_GENERATED = "generated-stem-mirror";

const SCHEMA_EXTENSIONS = new Set([
  "proto",
  "graphql",
  "gql",
  "thrift",
  "avsc",
  "idl",
  "yaml",
  "yml",
  "json",
]);

/**
 * Naming and path-proximity rules only — the `heuristic` tier by construction.
 * Every node it mints carries `proof: "path"` via `edges.ts`, so
 * `classifyEdge` cannot reach `direct` from here whatever the rule says; a
 * proposal becomes `structural` only when an import graph independently
 * corroborates it.
 *
 * Coverage is ALWAYS `partial`: a naming rule cannot know what it missed. That
 * does not block closure on its own — `aggregateProviderCoverage` weighs only
 * the providers whose evidence can close — it simply prevents a path rule from
 * ever being read as a completeness proof.
 */
export function createPathHeuristicsProvider(
  options: PathHeuristicsOptions,
): PathHeuristicsProvider {
  const files = [...options.files].sort();
  const maxConfigured = options.maxConfiguredFiles ?? DEFAULT_MAX_CONFIGURED_FILES;
  const maxAncestors = options.maxAncestorConfigs ?? DEFAULT_MAX_ANCESTOR_CONFIGS;
  const maxCounterparts = options.maxCounterparts ?? DEFAULT_MAX_COUNTERPARTS;

  const roles = new Map<string, PathRole>();
  for (const file of files) roles.set(file, classifyPathRole(file));
  const roleOf = (target: string): PathRole => roles.get(target) ?? classifyPathRole(target);

  // Indexes, built once.
  const plainByStem = new Map<string, string[]>();
  const testsBySubjectStem = new Map<string, string[]>();
  const generatedBySourceStem = new Map<string, string[]>();
  const configsByDir = new Map<string, string[]>();

  for (const file of files) {
    const role = roleOf(file);
    const dir = dirOf(file);
    if (role === "config") push(configsByDir, dir, file);
    if (role === "test") push(testsBySubjectStem, testSubjectStem(baseOf(file)), file);
    else if (role === "generated") push(generatedBySourceStem, generatedSourceStem(baseOf(file)), file);
    else push(plainByStem, stemOf(baseOf(file)), file);
  }

  const near = (target: string, candidates: readonly string[]): readonly string[] => {
    const dir = dirOf(target);
    return [...candidates]
      .filter((candidate) => candidate !== target)
      .sort((a, b) => {
        const byDir = Number(dirOf(b) === dir) - Number(dirOf(a) === dir);
        if (byDir !== 0) return byDir;
        const byDepth = a.split("/").length - b.split("/").length;
        if (byDepth !== 0) return byDepth;
        return a.localeCompare(b);
      })
      .slice(0, maxCounterparts);
  };

  const relatedTo = (target: string, type: PathEdgeType): readonly PathRelation[] => {
    const role = roleOf(target);
    switch (type) {
      case "TESTED_BY": {
        if (role === "test") {
          const subjects = near(target, plainByStem.get(testSubjectStem(baseOf(target))) ?? []);
          return subjects.map((subject) => relation(subject, "incoming", RULE_TEST, true));
        }
        const tests = near(target, testsBySubjectStem.get(stemOf(baseOf(target))) ?? []);
        return tests.map((test) => relation(test, "outgoing", RULE_TEST, true));
      }
      case "CONFIGURES": {
        if (role === "config") {
          // The SUBTREE, not just the directory: a config's scope is everything
          // beneath it, which is what makes this the mirror image of
          // `ancestorConfigs` below. Both directions must derive the same edge,
          // or a config seed could not reach what it configures. The cap is why
          // a root-level config does not turn one seed into the whole repo.
          const scoped = subtreeOf(target, files, roleOf).slice(0, maxConfigured);
          return scoped.map((subject) => relation(subject, "outgoing", RULE_CONFIG, false));
        }
        return ancestorConfigs(target, configsByDir, maxAncestors).map((config) =>
          relation(config, "incoming", RULE_CONFIG, false),
        );
      }
      case "GENERATED_FROM": {
        if (role === "generated") {
          const stem = generatedSourceStem(baseOf(target));
          const sources = [...near(target, plainByStem.get(stem) ?? [])].sort(schemaFirst);
          return sources.map((source) => relation(source, "outgoing", RULE_GENERATED, true));
        }
        const generated = near(target, generatedBySourceStem.get(stemOf(baseOf(target))) ?? []);
        return generated.map((product) => relation(product, "incoming", RULE_GENERATED, true));
      }
    }
  };

  return {
    identity: {
      id: options.id ?? "path:heuristics",
      kind: "path-heuristics",
      indexGeneration: inventoryGeneration(files),
      coverage: {
        status: "partial",
        languages: [...(options.languages ?? [])],
        reason: "naming and path-proximity rules only; cannot know what it missed",
      },
    },
    // Naming rules are language-agnostic; what varies is whether the caller
    // told this provider it had processed the language (the coverage list).
    edgeTypeSupport: () => PATH_PROVIDER_EDGE_TYPES,
    sourceShaOf: (target) => options.sourceShas?.get(target),
    roleOf,
    relatedTo,
  };
}

function relation(
  target: string,
  direction: PathRelation["direction"],
  rule: string,
  exactStemMatch: boolean,
): PathRelation {
  return { path: target, direction, rule, exactStemMatch };
}

function push(index: Map<string, string[]>, key: string, value: string): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [value]);
  else bucket.push(value);
}

function schemaFirst(a: string, b: string): number {
  const rank = (target: string): number => (SCHEMA_EXTENSIONS.has(extOf(target)) ? 0 : 1);
  const byRank = rank(a) - rank(b);
  return byRank !== 0 ? byRank : a.localeCompare(b);
}

/** Non-config files at or below `config`'s directory, in path order. */
function subtreeOf(
  config: string,
  files: readonly string[],
  roleOf: (target: string) => PathRole,
): readonly string[] {
  const dir = dirOf(config);
  const prefix = dir === "" ? "" : `${dir}/`;
  return files.filter(
    (candidate) =>
      candidate !== config && candidate.startsWith(prefix) && roleOf(candidate) !== "config",
  );
}

function ancestorConfigs(
  target: string,
  configsByDir: ReadonlyMap<string, string[]>,
  max: number,
): readonly string[] {
  const out: string[] = [];
  const segments = target.split("/");
  for (let depth = segments.length - 1; depth >= 0 && out.length < max; depth--) {
    const dir = segments.slice(0, depth).join("/");
    for (const config of configsByDir.get(dir) ?? []) {
      if (config !== target && !out.includes(config)) out.push(config);
      if (out.length >= max) break;
    }
  }
  return out;
}

function inventoryGeneration(files: readonly string[]): string {
  if (files.length === 0) return "";
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\n");
  }
  return `path-inventory:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

function baseOf(target: string): string {
  const segments = target.split("/");
  return segments[segments.length - 1] ?? target;
}

function dirOf(target: string): string {
  const index = target.lastIndexOf("/");
  return index < 0 ? "" : target.slice(0, index);
}

function extOf(target: string): string {
  const base = baseOf(target);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function stemOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

const TEST_SEGMENTS = new Set(["__tests__", "test", "tests", "spec", "specs"]);
const GENERATED_SEGMENTS = new Set(["generated", "__generated__", "gen"]);
const CONFIG_SEGMENTS = new Set(["config", ".config"]);

const CONFIG_BASENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "cargo.toml",
  "go.mod",
  "composer.json",
  "gemfile",
]);
const BUILD_BASENAMES = new Set([
  "makefile",
  "cmakelists.txt",
  "dockerfile",
  "build",
  "build.bazel",
  "workspace",
  "rakefile",
  "pom.xml",
]);
const CONFIG_EXTENSIONS = new Set(["ini", "cfg", "toml", "yaml", "yml", "properties"]);
const DOC_EXTENSIONS = new Set(["md", "rst", "txt", "adoc"]);

/**
 * Ordered rules, first match wins. `generated` is tested BEFORE `test` so a
 * generated fixture is reported as generated rather than as a hand-written
 * test — the more specific provenance claim is the more useful one.
 */
export function classifyPathRole(target: string): PathRole {
  const base = baseOf(target).toLowerCase();
  const segments = target.toLowerCase().split("/").slice(0, -1);

  if (
    segments.some((segment) => GENERATED_SEGMENTS.has(segment)) ||
    /\.(g|generated)\.[a-z0-9]+$/.test(base) ||
    /\.pb\.[a-z0-9]+$/.test(base) ||
    /_pb2\.py$/.test(base)
  ) {
    return "generated";
  }
  if (
    segments.some((segment) => TEST_SEGMENTS.has(segment)) ||
    /\.(spec|test)\.[a-z0-9]+$/.test(base) ||
    /^test_.+\.py$/.test(base) ||
    /_test\.(go|py|rb)$/.test(base) ||
    /tests?\.(java|cs|kt)$/.test(base)
  ) {
    return "test";
  }
  if (
    CONFIG_BASENAMES.has(base) ||
    segments.some((segment) => CONFIG_SEGMENTS.has(segment)) ||
    /^tsconfig(\..+)?\.json$/.test(base) ||
    /^\.eslintrc(\..+)?$/.test(base) ||
    /\.config\.[a-z0-9]+$/.test(base) ||
    CONFIG_EXTENSIONS.has(extOf(base))
  ) {
    return "config";
  }
  if (BUILD_BASENAMES.has(base) || /\.(mk|bazel|gradle)$/.test(base)) {
    return "build";
  }
  if (DOC_EXTENSIONS.has(extOf(base))) {
    return "doc";
  }
  return "source";
}

/** `foo.spec.ts` / `test_foo.py` / `foo_test.go` / `FooTest.java` → `foo`. */
export function testSubjectStem(base: string): string {
  const withoutExt = stemOf(base);
  const suffixed = /^(.*)\.(spec|test)$/.exec(withoutExt);
  if (suffixed?.[1] !== undefined) return suffixed[1];
  const prefixed = /^test_(.+)$/.exec(withoutExt);
  if (prefixed?.[1] !== undefined) return prefixed[1];
  const underscored = /^(.+)_test$/.exec(withoutExt);
  if (underscored?.[1] !== undefined) return underscored[1];
  const camel = /^(.+?)Tests?$/.exec(withoutExt);
  if (camel?.[1] !== undefined) return camel[1];
  return withoutExt;
}

/** `foo.pb.go` / `foo_pb2.py` / `foo.g.ts` / `foo.generated.ts` → `foo`. */
export function generatedSourceStem(base: string): string {
  const withoutExt = stemOf(base);
  const dotted = /^(.*)\.(g|generated|pb)$/.exec(withoutExt);
  if (dotted?.[1] !== undefined) return dotted[1];
  const pb2 = /^(.+)_pb2$/.exec(withoutExt);
  if (pb2?.[1] !== undefined) return pb2[1];
  return withoutExt;
}
