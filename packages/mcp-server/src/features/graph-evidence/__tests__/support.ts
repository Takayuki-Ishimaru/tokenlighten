// ---------------------------------------------------------------------------
// support.ts — injected fixture providers for the graph-evidence specs.
//
// NOT a spec file (vitest collects only *.spec.ts / *.test.ts). It exists so
// the engine can be driven against a workspace whose ground truth is known BY
// CONSTRUCTION — which is what makes a precision claim meaningful — without
// touching a filesystem or a parser.
// ---------------------------------------------------------------------------

import { fileNode, symbolNode, type GraphEdgeType, type GraphNode } from "../model.js";
import type {
  DeclaredSymbolAt,
  ImportGraphProvider,
  ProviderCoverage,
  ReferenceProvider,
  SymbolProvider,
  SymbolReference,
} from "../providers.js";
import { makeGenerationView, type GenerationView } from "../stale.js";

export const REF_ID = "fixture:references";
export const IMPORT_ID = "fixture:imports";
export const SYMBOL_ID = "fixture:symbols";
export const PATH_ID = "fixture:paths";

export const REF_GENERATION = "fixture-ref-gen-1";
export const IMPORT_GENERATION = "fixture-import-gen-1";
export const SYMBOL_GENERATION = "fixture-symbol-gen-1";
export const PATH_GENERATION = "fixture-path-gen-1";

/** Digest for a fixture path — stable, and different for different paths. */
export function fixtureSha(target: string): string {
  return `sha256:fixture-${target}`;
}

export function shaMapFor(paths: readonly string[]): ReadonlyMap<string, string> {
  return new Map(paths.map((target) => [target, fixtureSha(target)] as const));
}

function completeCoverage(languages: readonly string[]): ProviderCoverage {
  return { status: "complete", languages: [...languages] };
}

// ---------------------------------------------------------------------------
// Reference index
// ---------------------------------------------------------------------------

export interface ReferenceFixture {
  /** symbol → declaring file. */
  readonly definitions: Readonly<Record<string, { path: string; line: number }>>;
  /** symbol → referencing FILE paths (tl-graph's real granularity). */
  readonly references: Readonly<Record<string, readonly string[]>>;
  /** symbol → calling FILE paths. Omit entirely to model an index that cannot prove calls. */
  readonly callers?: Readonly<Record<string, readonly string[]>>;
  readonly languages?: readonly string[];
  readonly coverage?: ProviderCoverage;
  readonly generation?: string;
  readonly sourceShas?: ReadonlyMap<string, string>;
}

export function fixtureReferenceProvider(fixture: ReferenceFixture): ReferenceProvider {
  const languages = fixture.languages ?? ["typescript"];
  const supported: readonly GraphEdgeType[] =
    fixture.callers === undefined ? ["REFERENCES"] : ["REFERENCES", "CALLED_BY"];

  const provider: ReferenceProvider = {
    identity: {
      id: REF_ID,
      kind: "reference-index",
      indexGeneration: fixture.generation ?? REF_GENERATION,
      coverage: fixture.coverage ?? completeCoverage(languages),
    },
    edgeTypeSupport: (language) => (languages.includes(language) ? supported : []),
    sourceShaOf: (target) => fixture.sourceShas?.get(target) ?? fixtureSha(target),
    definitionOf: (symbol): GraphNode | undefined => {
      const declaration = fixture.definitions[symbol];
      if (declaration === undefined) return undefined;
      return symbolNode(declaration.path, symbol, "reference-index", { line: declaration.line });
    },
    referencesTo: (symbol): readonly SymbolReference[] =>
      (fixture.references[symbol] ?? []).map((target) => ({
        node: fileNode(target, "reference-index"),
      })),
  };

  if (fixture.callers !== undefined) {
    const callers = fixture.callers;
    return {
      ...provider,
      callersOf: (symbol): readonly SymbolReference[] =>
        (callers[symbol] ?? []).map((target) => ({ node: fileNode(target, "reference-index") })),
    };
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------

export interface ImportFixture {
  /** file → files it imports. */
  readonly imports: Readonly<Record<string, readonly string[]>>;
  /** file → symbols it exports. */
  readonly exports?: Readonly<Record<string, readonly string[]>>;
  readonly files?: readonly string[];
  readonly languages?: readonly string[];
  readonly coverage?: ProviderCoverage;
  readonly generation?: string;
}

export function fixtureImportProvider(fixture: ImportFixture): ImportGraphProvider {
  const languages = fixture.languages ?? ["typescript"];
  const files = fixture.files ?? Object.keys(fixture.imports);
  const reverse = new Map<string, string[]>();
  for (const file of files) {
    for (const imported of fixture.imports[file] ?? []) {
      const bucket = reverse.get(imported);
      if (bucket === undefined) reverse.set(imported, [file]);
      else bucket.push(file);
    }
  }
  for (const bucket of reverse.values()) bucket.sort();

  return {
    identity: {
      id: IMPORT_ID,
      kind: "import-graph",
      indexGeneration: fixture.generation ?? IMPORT_GENERATION,
      coverage: fixture.coverage ?? completeCoverage(languages),
    },
    edgeTypeSupport: (language) =>
      languages.includes(language) ? ["IMPORTS", "IMPORTED_BY"] : [],
    sourceShaOf: (target) => fixtureSha(target),
    importsOf: (target) => [...(fixture.imports[target] ?? [])].sort(),
    importedBy: (target) => reverse.get(target) ?? [],
    exportsOf: (target) => [...(fixture.exports?.[target] ?? [])].sort(),
  };
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface SymbolFixture {
  readonly declarations: readonly DeclaredSymbolAt[];
  readonly languageOf?: Readonly<Record<string, string>>;
  readonly languages?: readonly string[];
  readonly coverage?: ProviderCoverage;
  readonly generation?: string;
}

export function fixtureSymbolProvider(fixture: SymbolFixture): SymbolProvider {
  const languages = fixture.languages ?? ["typescript"];
  const byPath = new Map<string, DeclaredSymbolAt[]>();
  const byName = new Map<string, DeclaredSymbolAt[]>();
  const subtypes = new Map<string, DeclaredSymbolAt[]>();

  for (const declaration of fixture.declarations) {
    const inPath = byPath.get(declaration.path);
    if (inPath === undefined) byPath.set(declaration.path, [declaration]);
    else inPath.push(declaration);

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

  return {
    identity: {
      id: SYMBOL_ID,
      kind: "symbol",
      indexGeneration: fixture.generation ?? SYMBOL_GENERATION,
      coverage: fixture.coverage ?? completeCoverage(languages),
    },
    edgeTypeSupport: (language) => (languages.includes(language) ? ["EXTENDS", "IMPLEMENTS"] : []),
    files: () => [...byPath.keys()].sort(),
    declarationsIn: (target) => byPath.get(target) ?? [],
    declarationsOf: (name) => byName.get(name) ?? [],
    subtypesOf: (name) => subtypes.get(name) ?? [],
    languageOf: (target) => fixture.languageOf?.[target] ?? languages[0],
    sourceShaOf: (target) => fixtureSha(target),
  };
}

// ---------------------------------------------------------------------------
// Freshness oracle
// ---------------------------------------------------------------------------

/**
 * A view in which every fixture provider and every fixture path is current.
 * A spec that wants to prove staleness perturbs one entry.
 */
export function fixtureView(
  files: readonly string[],
  overrides: {
    readonly generations?: Readonly<Record<string, string>>;
    readonly shas?: Readonly<Record<string, string>>;
  } = {},
): GenerationView {
  const generations = new Map<string, string>([
    [REF_ID, REF_GENERATION],
    [IMPORT_ID, IMPORT_GENERATION],
    [SYMBOL_ID, SYMBOL_GENERATION],
    [PATH_ID, PATH_GENERATION],
  ]);
  for (const [id, generation] of Object.entries(overrides.generations ?? {})) {
    generations.set(id, generation);
  }
  const shas = new Map(files.map((target) => [target, fixtureSha(target)] as const));
  for (const [target, sha] of Object.entries(overrides.shas ?? {})) shas.set(target, sha);
  return makeGenerationView(generations, shas);
}
