/**
 * tlGraphReader.ts — parser for .tokenlighten/index/tl-graph.json.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "symbols": [
 *       { "name": "Foo",
 *         "definition": { "path": "src/foo.ts", "line": 12, "column": 0 },
 *         "references": [{ "path": "src/bar.ts", "line": 5, "column": 2 }] }
 *     ],
 *     "files": [
 *       { "path": "src/foo.ts", "imports": ["src/util.ts"], "exports": ["Foo", "bar"] }
 *     ]
 *   }
 *
 * Pure JSON.parse with light validation. Throws on schema violations.
 */

import type { GraphIndex, GraphLocation } from "./index.js";

// ---------------------------------------------------------------------------
// Raw schema types (post-parse, pre-validate)
// ---------------------------------------------------------------------------

interface RawLocation {
  path: string;
  line: number;
  column: number;
}

interface RawSymbol {
  name: string;
  definition?: RawLocation;
  references?: RawLocation[];
}

interface RawFile {
  path: string;
  imports?: string[];
  exports?: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function expectString(val: unknown, label: string): string {
  if (typeof val !== "string") throw new Error(`tl-graph: expected string for ${label}, got ${typeof val}`);
  return val;
}

function expectNumber(val: unknown, label: string): number {
  if (typeof val !== "number") throw new Error(`tl-graph: expected number for ${label}, got ${typeof val}`);
  return val;
}

function validateLocation(raw: unknown, label: string): RawLocation {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`tl-graph: ${label} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    path: expectString(obj["path"], `${label}.path`),
    line: expectNumber(obj["line"], `${label}.line`),
    column: expectNumber(obj["column"], `${label}.column`),
  };
}

function validateSymbol(raw: unknown, idx: number): RawSymbol {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`tl-graph: symbols[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const name = expectString(obj["name"], `symbols[${idx}].name`);

  let definition: RawLocation | undefined;
  if (obj["definition"] !== undefined) {
    definition = validateLocation(obj["definition"], `symbols[${idx}].definition`);
  }

  let references: RawLocation[] = [];
  if (obj["references"] !== undefined) {
    if (!Array.isArray(obj["references"])) {
      throw new Error(`tl-graph: symbols[${idx}].references must be an array`);
    }
    references = obj["references"].map((r, ri) =>
      validateLocation(r, `symbols[${idx}].references[${ri}]`),
    );
  }

  return { name, definition, references };
}

function validateFile(raw: unknown, idx: number): RawFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`tl-graph: files[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const filePath = expectString(obj["path"], `files[${idx}].path`);

  let imports: string[] = [];
  if (obj["imports"] !== undefined) {
    if (!Array.isArray(obj["imports"])) {
      throw new Error(`tl-graph: files[${idx}].imports must be an array`);
    }
    imports = obj["imports"].map((v, i) => expectString(v, `files[${idx}].imports[${i}]`));
  }

  let exports: string[] = [];
  if (obj["exports"] !== undefined) {
    if (!Array.isArray(obj["exports"])) {
      throw new Error(`tl-graph: files[${idx}].exports must be an array`);
    }
    exports = obj["exports"].map((v, i) => expectString(v, `files[${idx}].exports[${i}]`));
  }

  return { path: filePath, imports, exports };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse a tl-graph.json text into a GraphIndex.
 * Throws clear errors on schema violations.
 */
export function parseTlGraph(jsonText: string): GraphIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`tl-graph: invalid JSON: ${e}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("tl-graph: root must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const version = expectNumber(obj["version"], "version");
  if (version !== 1) {
    throw new Error(`tl-graph: unsupported version ${version} (expected 1)`);
  }

  const rawSymbols: RawSymbol[] = [];
  if (obj["symbols"] !== undefined) {
    if (!Array.isArray(obj["symbols"])) {
      throw new Error("tl-graph: symbols must be an array");
    }
    for (let i = 0; i < obj["symbols"].length; i++) {
      rawSymbols.push(validateSymbol(obj["symbols"][i], i));
    }
  }

  const rawFiles: RawFile[] = [];
  if (obj["files"] !== undefined) {
    if (!Array.isArray(obj["files"])) {
      throw new Error("tl-graph: files must be an array");
    }
    for (let i = 0; i < obj["files"].length; i++) {
      rawFiles.push(validateFile(obj["files"][i], i));
    }
  }

  // Build lookup maps.
  const defMap = new Map<string, GraphLocation>();
  const refMap = new Map<string, GraphLocation[]>();

  for (const sym of rawSymbols) {
    if (sym.definition) {
      defMap.set(sym.name, sym.definition);
    }
    refMap.set(sym.name, sym.references ?? []);
  }

  const importsMap = new Map<string, string[]>();
  const exportsMap = new Map<string, string[]>();

  for (const file of rawFiles) {
    importsMap.set(file.path, file.imports ?? []);
    exportsMap.set(file.path, file.exports ?? []);
  }

  return {
    definition(symbol: string): GraphLocation | undefined {
      return defMap.get(symbol);
    },
    references(symbol: string): GraphLocation[] {
      return refMap.get(symbol) ?? [];
    },
    importsOf(filePath: string): string[] {
      return importsMap.get(filePath) ?? [];
    },
    exportsOf(filePath: string): string[] {
      return exportsMap.get(filePath) ?? [];
    },
  };
}
