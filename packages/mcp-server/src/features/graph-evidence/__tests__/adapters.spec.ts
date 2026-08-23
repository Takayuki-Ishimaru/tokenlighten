// ---------------------------------------------------------------------------
// adapters.spec.ts — V11-01: the concrete binding, against a REAL workspace.
//
// Everything else in this suite drives the engine with injected fixtures. This
// file drives the one adapter against a real temp-dir workspace, a real
// `tl-graph.json` read through `graph/index.ts`, and the real tree-sitter
// collector — so the honesty claims (`direct` needs parser proof; a heritage
// clause read from signature TEXT is not a parse; a missing graph fails closed)
// are proven against the surfaces the wave-B consumers will actually see.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadGraphIndex, resetMissingLoggedForTest } from "../../../graph/index.js";
import {
  classifyPathRole,
  contentSha,
  createParserSymbolProvider,
  createPathHeuristicsProvider,
  createTlGraphProviders,
  generatedSourceStem,
  testSubjectStem,
} from "../adapters.js";
import { analyzeImpact } from "../impact.js";
import { nodeId, validateEdge, type GraphEdge } from "../model.js";
import { providerIdentities, type ProviderSet, type SymbolProvider } from "../providers.js";
import { makeGenerationView, type GenerationView } from "../stale.js";
import type { ExpansionBounds } from "../bounds.js";

// ---------------------------------------------------------------------------
// Fixture workspace
// ---------------------------------------------------------------------------

const ROOT_HASH = "root-hash-1";

const SOURCES: Readonly<Record<string, string>> = {
  "src/registry.ts": [
    "export class Registry {",
    "  register(name: string): void {",
    "    void name;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/plugin.ts": [
    'import { Registry } from "./registry.js";',
    "",
    "export class Plugin extends Registry {",
    "  activate(): void {}",
    "}",
    "",
  ].join("\n"),
  "src/consumer.ts": [
    'import { Registry } from "./registry.js";',
    "",
    "export function consume(registry: Registry): void {",
    "  void registry;",
    "}",
    "",
  ].join("\n"),
  "src/__tests__/registry.spec.ts": [
    'import { Registry } from "../registry.js";',
    "",
    "export const fixture = new Registry();",
    "",
  ].join("\n"),
};

const EXTRA_FILES: Readonly<Record<string, string>> = {
  "tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
  "src/schema.proto": "message Thing { string id = 1; }\n",
  "src/schema.pb.ts": "export interface Thing { id: string }\n",
  "notes.md": "# Notes\n",
};

const ALL_FILES = [...Object.keys(SOURCES), ...Object.keys(EXTRA_FILES)].sort();
const TS_LANGUAGE = "typescript";

const TL_GRAPH = {
  version: 1,
  rootHash: ROOT_HASH,
  symbols: [
    {
      name: "Registry",
      definition: { path: "src/registry.ts", line: 1, column: 0 },
      references: [
        { path: "src/plugin.ts", line: 1, column: 0 },
        { path: "src/consumer.ts", line: 1, column: 0 },
        { path: "src/__tests__/registry.spec.ts", line: 1, column: 0 },
      ],
    },
  ],
  files: [
    { path: "src/registry.ts", imports: [], exports: ["Registry"] },
    { path: "src/plugin.ts", imports: ["src/registry.ts"], exports: ["Plugin"] },
    { path: "src/consumer.ts", imports: ["src/registry.ts"], exports: ["consume"] },
    { path: "src/__tests__/registry.spec.ts", imports: ["src/registry.ts"], exports: [] },
  ],
};

const tmpDirs: string[] = [];
let workspace = "";

function write(relative: string, content: string): void {
  const absolute = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

function shaMap(): ReadonlyMap<string, string> {
  const all = { ...SOURCES, ...EXTRA_FILES };
  return new Map(Object.entries(all).map(([file, text]) => [file, contentSha(text)] as const));
}

beforeEach(() => {
  resetMissingLoggedForTest();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tl-graph-evidence-"));
  tmpDirs.push(workspace);
  for (const [file, text] of Object.entries({ ...SOURCES, ...EXTRA_FILES })) write(file, text);
  write(path.join(".tokenlighten", "index", "tl-graph.json"), JSON.stringify(TL_GRAPH));
});

afterEach(() => {
  resetMissingLoggedForTest();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leaked temp dir must not fail a green suite.
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Generation stamping
// ---------------------------------------------------------------------------

describe("generation stamping via GraphIndex.rootHash()", () => {
  // V11-05: the second, duplicate head-byte read (readTlGraphGeneration) is
  // gone — the generation now comes straight off the SAME loadGraphIndex()
  // result graph/index.ts's own consumers already use, via its additive
  // `rootHash()` accessor (graphIndex.spec.ts covers that accessor itself in
  // isolation; this suite proves createTlGraphProviders' consumption of it).

  it("loadGraphIndex(workspace).rootHash() reads the graph's own rootHash", () => {
    const index = loadGraphIndex(workspace);
    expect(index?.rootHash()).toBe(ROOT_HASH);
  });

  it("createTlGraphProviders stamps the same tl-graph:<rootHash> generation as before", () => {
    const providers = createTlGraphProviders({
      workspace,
      files: ALL_FILES,
      sourceShas: shaMap(),
      languages: [TS_LANGUAGE],
    });
    expect(providers.generation).toBe(`tl-graph:${ROOT_HASH}`);
    expect(providers.references?.identity.indexGeneration).toBe(`tl-graph:${ROOT_HASH}`);
  });

  it("FAILS CLOSED when the workspace has no graph at all", () => {
    const providers = createTlGraphProviders({
      workspace: path.join(workspace, "nope"),
      files: ALL_FILES,
      sourceShas: shaMap(),
      languages: [TS_LANGUAGE],
    });
    expect(providers.generation).toBe("");
    expect(providers.references).toBeUndefined();
    expect(providers.imports).toBeUndefined();
  });

  it("FAILS CLOSED on a graph with no rootHash — an unstamped provider makes every edge it produces fail the staleness check", () => {
    write(path.join(".tokenlighten", "index", "tl-graph.json"), '{"version":1,"symbols":[]}');
    const index = loadGraphIndex(workspace);
    expect(index?.rootHash()).toBeUndefined();
    const providers = createTlGraphProviders({
      workspace,
      files: ALL_FILES,
      sourceShas: shaMap(),
      languages: [TS_LANGUAGE],
    });
    expect(providers.generation).toBe("");
    expect(providers.references?.identity.indexGeneration).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. tl-graph providers
// ---------------------------------------------------------------------------

describe("createTlGraphProviders", () => {
  function build(): ReturnType<typeof createTlGraphProviders> {
    return createTlGraphProviders({
      workspace,
      files: ALL_FILES,
      sourceShas: shaMap(),
      languages: [TS_LANGUAGE],
    });
  }

  it("binds both providers to the real loaded index", () => {
    const providers = build();
    expect(providers.generation).toBe(`tl-graph:${ROOT_HASH}`);
    expect(providers.imports?.identity.kind).toBe("import-graph");
    expect(providers.references?.identity.kind).toBe("reference-index");
  });

  it("returns NO providers when the workspace has no graph", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tl-graph-evidence-empty-"));
    tmpDirs.push(empty);
    const providers = createTlGraphProviders({
      workspace: empty,
      files: [],
      sourceShas: new Map(),
      languages: [TS_LANGUAGE],
    });
    expect(providers).toEqual({ generation: "" });
  });

  it("serves imports and derives importedBy by inverting over the caller's inventory", () => {
    const providers = build();
    expect(providers.imports?.importsOf("src/plugin.ts")).toEqual(["src/registry.ts"]);
    expect(providers.imports?.importedBy("src/registry.ts")).toEqual([
      "src/__tests__/registry.spec.ts",
      "src/consumer.ts",
      "src/plugin.ts",
    ]);
    expect(providers.imports?.exportsOf("src/registry.ts")).toEqual(["Registry"]);
  });

  it("serves the declaration as a symbol node and the mentions as FILE nodes", () => {
    const providers = build();
    expect(providers.references?.definitionOf("Registry")).toEqual({
      kind: "symbol",
      path: "src/registry.ts",
      symbol: "Registry",
      proof: "reference-index",
      line: 1,
    });
    // tl-graph records the referencing FILE (line 1 / column 0 for every
    // reference), so claiming an enclosing declaration would be an invention.
    const mentions = providers.references?.referencesTo("Registry") ?? [];
    expect(mentions.map((mention) => mention.node.kind)).toEqual(["file", "file", "file"]);
    expect(mentions.map((mention) => mention.node.path)).toEqual([
      "src/__tests__/registry.spec.ts",
      "src/consumer.ts",
      "src/plugin.ts",
    ]);
  });

  it("does NOT claim call edges it cannot prove", () => {
    const providers = build();
    expect(providers.references?.callersOf).toBeUndefined();
    expect(providers.references?.calleesOf).toBeUndefined();
    expect(providers.references?.edgeTypeSupport(TS_LANGUAGE)).toEqual(["REFERENCES"]);
    expect(providers.imports?.edgeTypeSupport("rust")).toEqual([]);
  });

  it("claims UNKNOWN coverage by default — the graph is not cross-checked", () => {
    const coverage = build().references?.identity.coverage;
    expect(coverage?.status).toBe("unknown");
    expect(coverage?.reason).toContain("not cross-checked");
  });

  it("accepts a proven coverage claim from a caller that has one", () => {
    const providers = createTlGraphProviders({
      workspace,
      files: ALL_FILES,
      sourceShas: shaMap(),
      languages: [TS_LANGUAGE],
      coverage: { status: "complete", languages: [TS_LANGUAGE] },
    });
    expect(providers.references?.identity.coverage.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// 3. Parser symbol provider
// ---------------------------------------------------------------------------

describe("createParserSymbolProvider", () => {
  async function build(): Promise<SymbolProvider> {
    return createParserSymbolProvider({
      sources: Object.entries(SOURCES).map(([file, text]) => ({
        path: file,
        language: TS_LANGUAGE,
        text,
      })),
    });
  }

  it("collects PARSER-proven declarations from real sources", async () => {
    const symbols = await build();
    expect(symbols.identity.coverage.status).toBe("complete");
    expect(symbols.identity.coverage.languages).toEqual([TS_LANGUAGE]);
    expect(symbols.identity.indexGeneration).toMatch(/^parser:[0-9a-f]{64}$/);

    const registry = symbols.declarationsOf("Registry");
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      path: "src/registry.ts",
      name: "Registry",
      kind: "class",
      proof: "parser",
    });
  });

  it("records heritage, and labels it as read from TEXT rather than parsed", async () => {
    const symbols = await build();
    const plugin = symbols.declarationsOf("Plugin")[0];
    expect(plugin?.extendsNames).toEqual(["Registry"]);
    expect(plugin?.proof).toBe("parser");
    // The declaration is parsed; the base clause is regexed out of the
    // parser-delimited signature. That difference is carried, not smoothed.
    expect(plugin?.heritageProof).toBe("regex-fallback");
    expect(symbols.subtypesOf("Registry").map((s) => s.name)).toEqual(["Plugin"]);
  });

  it("stamps the corpus digest and every file's digest", async () => {
    const symbols = await build();
    expect(symbols.sourceShaOf("src/registry.ts")).toBe(contentSha(SOURCES["src/registry.ts"] ?? ""));
    expect(symbols.files()).toEqual(Object.keys(SOURCES).sort());
    expect(symbols.languageOf("src/plugin.ts")).toBe(TS_LANGUAGE);
  });

  it("a moved file moves the corpus generation", async () => {
    const first = await build();
    const second = await createParserSymbolProvider({
      sources: Object.entries(SOURCES).map(([file, text]) => ({
        path: file,
        language: TS_LANGUAGE,
        text: file === "src/registry.ts" ? `${text}// changed\n` : text,
      })),
    });
    expect(second.identity.indexGeneration).not.toBe(first.identity.indexGeneration);
  });

  it("LABELS the regex fallback when the parser cannot help", async () => {
    const symbols = await createParserSymbolProvider({
      sources: [
        {
          path: "src/legacy.zz",
          language: "unsupported-language",
          text: "export class Legacy extends Base {}\n",
        },
      ],
    });
    expect(symbols.identity.coverage.status).toBe("partial");
    expect(symbols.identity.coverage.reason).toContain("regex declaration scan");
    const legacy = symbols.declarationsOf("Legacy")[0];
    expect(legacy?.proof).toBe("regex-fallback");
    expect(legacy?.extendsNames).toEqual(["Base"]);
    expect(symbols.edgeTypeSupport("unsupported-language")).toEqual([]);
  });

  it("an empty corpus is unknown, not complete", async () => {
    const symbols = await createParserSymbolProvider({ sources: [] });
    expect(symbols.identity.coverage.status).toBe("unknown");
    expect(symbols.identity.indexGeneration).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4. Path heuristics
// ---------------------------------------------------------------------------

describe("path heuristics", () => {
  it("classifies roles from path and naming shape", () => {
    expect(classifyPathRole("src/registry.ts")).toBe("source");
    expect(classifyPathRole("src/__tests__/registry.spec.ts")).toBe("test");
    expect(classifyPathRole("svc/test_handler.py")).toBe("test");
    expect(classifyPathRole("cmd/main_test.go")).toBe("test");
    expect(classifyPathRole("tsconfig.json")).toBe("config");
    expect(classifyPathRole("vite.config.ts")).toBe("config");
    expect(classifyPathRole("Makefile")).toBe("build");
    expect(classifyPathRole("notes.md")).toBe("doc");
    expect(classifyPathRole("src/schema.pb.ts")).toBe("generated");
    expect(classifyPathRole("src/generated/thing.ts")).toBe("generated");
  });

  it("recovers a test's subject stem and a generated file's source stem", () => {
    expect(testSubjectStem("registry.spec.ts")).toBe("registry");
    expect(testSubjectStem("test_handler.py")).toBe("handler");
    expect(testSubjectStem("main_test.go")).toBe("main");
    expect(testSubjectStem("RegistryTest.java")).toBe("Registry");
    expect(generatedSourceStem("schema.pb.ts")).toBe("schema");
    expect(generatedSourceStem("schema_pb2.py")).toBe("schema");
    expect(generatedSourceStem("model.g.ts")).toBe("model");
  });

  it("proposes relations from BOTH endpoints, so either seed derives the edge", () => {
    const paths = createPathHeuristicsProvider({ files: ALL_FILES, sourceShas: shaMap() });
    expect(paths.relatedTo("src/registry.ts", "TESTED_BY")).toEqual([
      {
        path: "src/__tests__/registry.spec.ts",
        direction: "outgoing",
        rule: "test-stem-mirror",
        exactStemMatch: true,
      },
    ]);
    expect(paths.relatedTo("src/__tests__/registry.spec.ts", "TESTED_BY")).toEqual([
      {
        path: "src/registry.ts",
        direction: "incoming",
        rule: "test-stem-mirror",
        exactStemMatch: true,
      },
    ]);
  });

  it("is always PARTIAL — a naming rule cannot know what it missed", () => {
    const paths = createPathHeuristicsProvider({ files: ALL_FILES, sourceShas: shaMap() });
    expect(paths.identity.coverage.status).toBe("partial");
    expect(paths.identity.kind).toBe("path-heuristics");
  });
});

// ---------------------------------------------------------------------------
// 5. The whole stack, end to end
// ---------------------------------------------------------------------------

describe("the adapter stack, end to end", () => {
  const BOUNDS: ExpansionBounds = {
    maxNodes: 60,
    maxDepth: 3,
    maxFanout: 25,
    maxBytes: 200_000,
    maxDurationMs: 15_000,
  };

  async function buildStack(): Promise<{ providers: ProviderSet; view: GenerationView }> {
    const shas = shaMap();
    const graph = createTlGraphProviders({
      workspace,
      files: ALL_FILES,
      sourceShas: shas,
      languages: [TS_LANGUAGE],
    });
    const symbols = await createParserSymbolProvider({
      sources: Object.entries(SOURCES).map(([file, text]) => ({
        path: file,
        language: TS_LANGUAGE,
        text,
      })),
    });
    const providers: ProviderSet = {
      ...(graph.imports ? { imports: graph.imports } : {}),
      ...(graph.references ? { references: graph.references } : {}),
      symbols,
      paths: createPathHeuristicsProvider({
        files: ALL_FILES,
        sourceShas: shas,
        languages: [TS_LANGUAGE],
      }),
    };
    const view = makeGenerationView(
      providerIdentities(providers).map((id) => [id.id, id.indexGeneration] as const),
      [...shas.entries()],
    );
    return { providers, view };
  }

  async function run(): Promise<ReturnType<typeof analyzeImpact>> {
    const { providers, view } = await buildStack();
    return analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: BOUNDS,
      generations: view,
    });
  }

  function keyOf(edge: GraphEdge): string {
    return `${edge.type}|${nodeId(edge.from)}|${nodeId(edge.to)}`;
  }

  it("produces DIRECT reference edges from the real index", async () => {
    const result = await run();
    const references = result.edges.filter((edge) => edge.type === "REFERENCES");
    expect(references).toHaveLength(3);
    for (const edge of references) {
      expect(edge.evidenceClass, keyOf(edge)).toBe("direct");
      expect(validateEdge(edge)).toEqual([]);
    }
  });

  it("keeps a text-read heritage clause at STRUCTURAL, not direct", async () => {
    const result = await run();
    const extendsEdge = result.edges.find((edge) => edge.type === "EXTENDS");
    expect(keyOf(extendsEdge as GraphEdge)).toBe(
      "EXTENDS|symbol:src/plugin.ts#Plugin|symbol:src/registry.ts#Registry",
    );
    expect(extendsEdge?.evidenceClass).toBe("structural");
    expect(extendsEdge?.corroboration).toContain("exact-symbol-match");
  });

  it("promotes TESTED_BY to structural because the real test really imports it", async () => {
    const result = await run();
    const tested = result.edges.find((edge) => edge.type === "TESTED_BY");
    expect(keyOf(tested as GraphEdge)).toBe(
      "TESTED_BY|file:src/registry.ts|file:src/__tests__/registry.spec.ts",
    );
    expect(tested?.evidenceClass).toBe("structural");
    expect(tested?.corroboratedBy?.[0]).toContain("tl-graph");
  });

  it("leaves CONFIGURES and GENERATED_FROM heuristic, and never direct", async () => {
    const result = await run();
    for (const type of ["CONFIGURES", "GENERATED_FROM"] as const) {
      const derived = result.edges.filter((edge) => edge.type === type);
      expect(derived.length, type).toBeGreaterThan(0);
      for (const edge of derived) expect(edge.evidenceClass, keyOf(edge)).toBe("heuristic");
    }
  });

  it("refuses closure while the graph's own coverage is unknown", async () => {
    const result = await run();
    expect(result.coverage).toBe("unknown");
    expect(result.closure.canClose).toBe(false);
    expect(result.closure.reasons).toContain("coverage:unknown");
  });

  it("discards every tl-graph edge once the graph generation moves", async () => {
    const { providers, view } = await buildStack();
    const graphIds = providerIdentities(providers)
      .filter((identity) => identity.id.startsWith("tl-graph"))
      .map((identity) => identity.id);
    expect(graphIds.length).toBe(2);

    const moved = makeGenerationView(
      [...view.generations.entries()].map(
        ([id, generation]) => [id, graphIds.includes(id) ? "tl-graph:root-hash-2" : generation] as const,
      ),
      [...view.sourceShas.entries()],
    );
    const result = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: BOUNDS,
      generations: moved,
    });

    expect(result.stale.excluded).toBeGreaterThan(0);
    expect(result.edges.filter((edge) => graphIds.includes(edge.provider))).toEqual([]);
    expect(result.edges.filter((edge) => edge.evidenceClass === "direct")).toEqual([]);
  });
});
