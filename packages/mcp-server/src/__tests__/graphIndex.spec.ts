/**
 * graphIndex.spec.ts — tests for the optional graph index consumer.
 *
 * Covers:
 *   - loadGraphIndex returns undefined when no index files exist and traces missing.
 *   - parseTlGraph round-trips a 2-symbol, 2-file fixture.
 *   - parseScip on a tiny hand-encoded binpb returns expected symbols.
 *   - graphIndexMode() == "off" -> loadGraphIndex returns undefined without reading anything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadGraphIndex, resetMissingLoggedForTest, GRAPH_INDEX_MAX_BYTES } from "../graph/index.js";
import { parseTlGraph } from "../graph/tlGraphReader.js";
import { parseScip } from "../graph/scipReader.js";
import { setTraceEnabledForTest } from "../util/trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-graph-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeBytes(workspace: string, rel: string, buf: Buffer): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = { TL_GRAPH_INDEX: process.env["TL_GRAPH_INDEX"] };
  delete process.env["TL_GRAPH_INDEX"];
  setTraceEnabledForTest(false);
  resetMissingLoggedForTest();
});

afterEach(() => {
  if (savedEnv["TL_GRAPH_INDEX"] === undefined) {
    delete process.env["TL_GRAPH_INDEX"];
  } else {
    process.env["TL_GRAPH_INDEX"] = savedEnv["TL_GRAPH_INDEX"];
  }
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// loadGraphIndex: missing index
// ---------------------------------------------------------------------------

describe("loadGraphIndex — missing index", () => {
  it("returns undefined when .tokenlighten/index/ does not exist", () => {
    const ws = mkWorkspace();
    const result = loadGraphIndex(ws);
    expect(result).toBeUndefined();
  });

  it("returns undefined when index directory is empty", () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, ".tokenlighten", "index"), { recursive: true });
    const result = loadGraphIndex(ws);
    expect(result).toBeUndefined();
  });

  it("logs graph-index-missing trace only once per workspace in auto mode", () => {
    // Enable trace capture via the real trace module — we cannot easily intercept,
    // but we verify the one-time guard works by calling loadGraphIndex twice and
    // checking the guard set (tested via resetMissingLoggedForTest behavior).
    const ws = mkWorkspace();
    // First call should mark workspace as logged.
    const r1 = loadGraphIndex(ws);
    expect(r1).toBeUndefined();
    // Second call must not crash or re-log (guard set prevents it).
    const r2 = loadGraphIndex(ws);
    expect(r2).toBeUndefined();
    // No assertion on trace output directly — the trace is written to a file and
    // is tested in trace.spec.ts. We just verify no exception is thrown.
  });
});

// ---------------------------------------------------------------------------
// loadGraphIndex: TL_GRAPH_INDEX=off
// ---------------------------------------------------------------------------

describe("loadGraphIndex — TL_GRAPH_INDEX=off", () => {
  it("returns undefined immediately without reading the filesystem", () => {
    process.env["TL_GRAPH_INDEX"] = "off";
    const ws = mkWorkspace();
    // Even if tl-graph.json exists, off mode short-circuits before reading.
    writeFile(ws, ".tokenlighten/index/tl-graph.json", JSON.stringify({
      version: 1,
      symbols: [],
      files: [],
    }));
    const result = loadGraphIndex(ws);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseTlGraph: round-trip fixture
// ---------------------------------------------------------------------------

describe("parseTlGraph — 2-symbol, 2-file fixture", () => {
  const fixture = {
    version: 1,
    symbols: [
      {
        name: "Foo",
        definition: { path: "src/foo.ts", line: 12, column: 0 },
        references: [
          { path: "src/bar.ts", line: 5, column: 2 },
          { path: "src/baz.ts", line: 9, column: 4 },
        ],
      },
      {
        name: "bar",
        definition: { path: "src/bar.ts", line: 1, column: 7 },
        references: [],
      },
    ],
    files: [
      { path: "src/foo.ts", imports: ["src/util.ts"], exports: ["Foo"] },
      { path: "src/bar.ts", imports: ["src/foo.ts"], exports: ["bar"] },
    ],
  };

  it("definition() returns the correct location for Foo", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    const def = index.definition("Foo");
    expect(def).toBeDefined();
    expect(def!.path).toBe("src/foo.ts");
    expect(def!.line).toBe(12);
    expect(def!.column).toBe(0);
  });

  it("definition() returns undefined for an unknown symbol", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.definition("NonExistent")).toBeUndefined();
  });

  it("references() returns all reference locations for Foo", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    const refs = index.references("Foo");
    expect(refs).toHaveLength(2);
    expect(refs[0]!.path).toBe("src/bar.ts");
    expect(refs[0]!.line).toBe(5);
    expect(refs[1]!.path).toBe("src/baz.ts");
    expect(refs[1]!.line).toBe(9);
  });

  it("references() returns empty array for symbol with no references", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.references("bar")).toEqual([]);
  });

  it("references() returns empty array for unknown symbol", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.references("Unknown")).toEqual([]);
  });

  it("importsOf() returns import list for src/foo.ts", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.importsOf("src/foo.ts")).toEqual(["src/util.ts"]);
  });

  it("importsOf() returns empty array for unknown file", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.importsOf("src/unknown.ts")).toEqual([]);
  });

  it("exportsOf() returns export list for src/bar.ts", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.exportsOf("src/bar.ts")).toEqual(["bar"]);
  });

  it("exportsOf() returns empty array for unknown file", () => {
    const index = parseTlGraph(JSON.stringify(fixture));
    expect(index.exportsOf("src/unknown.ts")).toEqual([]);
  });
});

describe("parseTlGraph — validation", () => {
  it("throws on invalid JSON", () => {
    expect(() => parseTlGraph("not json")).toThrow(/invalid JSON/i);
  });

  it("throws when version is not 1", () => {
    expect(() => parseTlGraph(JSON.stringify({ version: 2, symbols: [], files: [] }))).toThrow(/unsupported version/i);
  });

  it("throws when symbols is not an array", () => {
    expect(() => parseTlGraph(JSON.stringify({ version: 1, symbols: "bad", files: [] }))).toThrow(/symbols must be an array/i);
  });

  it("accepts empty symbols and files", () => {
    const index = parseTlGraph(JSON.stringify({ version: 1, symbols: [], files: [] }));
    expect(index.definition("x")).toBeUndefined();
    expect(index.references("x")).toEqual([]);
    expect(index.importsOf("f")).toEqual([]);
    expect(index.exportsOf("f")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadGraphIndex: tl-graph.json is loaded
// ---------------------------------------------------------------------------

describe("loadGraphIndex — tl-graph.json present", () => {
  it("returns a working GraphIndex from a valid tl-graph.json", () => {
    const ws = mkWorkspace();
    const fixture = {
      version: 1,
      symbols: [
        {
          name: "MyFunc",
          definition: { path: "src/my.ts", line: 3, column: 0 },
          references: [{ path: "src/other.ts", line: 7, column: 2 }],
        },
      ],
      files: [
        { path: "src/my.ts", imports: [], exports: ["MyFunc"] },
      ],
    };
    writeFile(ws, ".tokenlighten/index/tl-graph.json", JSON.stringify(fixture));

    const index = loadGraphIndex(ws);
    expect(index).toBeDefined();
    expect(index!.definition("MyFunc")!.path).toBe("src/my.ts");
    expect(index!.references("MyFunc")).toHaveLength(1);
    expect(index!.exportsOf("src/my.ts")).toEqual(["MyFunc"]);
  });

  it("returns undefined (graceful) when tl-graph.json is malformed", () => {
    const ws = mkWorkspace();
    writeFile(ws, ".tokenlighten/index/tl-graph.json", "{ version: 1 INVALID }");

    const result = loadGraphIndex(ws);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseScip — hand-encoded minimal protobuf buffer
// ---------------------------------------------------------------------------

/**
 * Hand-encode a minimal SCIP Index protobuf buffer containing:
 *   - one Document with relative_path="src/alpha.ts"
 *     - Occurrence: range=[10,3], symbol="AlphaFunc", symbol_roles=1 (definition)
 *   - one Document with relative_path="src/beta.ts"
 *     - Occurrence: range=[2,8], symbol="AlphaFunc", symbol_roles=0 (reference)
 *
 * Protobuf encoding helpers (all little-endian varints):
 *   tag = (field_number << 3) | wire_type
 *   wire_type 2 = length-delimited
 *   wire_type 0 = varint
 */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0; // treat as unsigned
  while (v > 127) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encode a varint using regular (non-bitwise) arithmetic — unlike
 * encodeVarint above, this is safe for values >= 2^32. `encodeVarint`'s
 * `value >>> 0` forces a 32-bit-unsigned round-trip, which would silently
 * wrap any value at/above 2^32 before encoding even begins, so it cannot be
 * used to construct the large-varint regression fixture below. Kept as a
 * SEPARATE helper (rather than changing encodeVarint) so the existing small
 * fixtures above are untouched.
 */
function encodeVarintBig(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  while (v > 127) {
    bytes.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeLenDelim(fieldNumber: number, data: Buffer): Buffer {
  const tag = encodeTag(fieldNumber, 2); // wire type 2
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

function encodeString(fieldNumber: number, s: string): Buffer {
  return encodeLenDelim(fieldNumber, Buffer.from(s, "utf8"));
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodePackedInts(fieldNumber: number, values: number[]): Buffer {
  const packed = Buffer.concat(values.map(encodeVarint));
  return encodeLenDelim(fieldNumber, packed);
}

function encodeOccurrence(range: number[], symbol: string, symbolRoles: number): Buffer {
  const rangePart = encodePackedInts(1, range);       // field 1: range
  const symbolPart = encodeString(2, symbol);          // field 2: symbol
  const rolesPart = encodeVarintField(3, symbolRoles); // field 3: symbol_roles
  return Buffer.concat([rangePart, symbolPart, rolesPart]);
}

function encodeDocument(relativePath: string, occurrences: Buffer[]): Buffer {
  const pathPart = encodeString(1, relativePath);      // field 1: relative_path
  const occParts = occurrences.map((occ) => encodeLenDelim(4, occ)); // field 4: occurrences
  return Buffer.concat([pathPart, ...occParts]);
}

function encodeIndex(documents: Buffer[]): Buffer {
  const docParts = documents.map((doc) => encodeLenDelim(2, doc)); // field 2: documents
  return Buffer.concat(docParts);
}

function buildTestScipBuffer(): Buffer {
  const alphaDoc = encodeDocument("src/alpha.ts", [
    encodeOccurrence([10, 3, 10, 12], "AlphaFunc", 1), // definition
  ]);
  const betaDoc = encodeDocument("src/beta.ts", [
    encodeOccurrence([2, 8, 2, 17], "AlphaFunc", 0),   // reference
  ]);
  return encodeIndex([alphaDoc, betaDoc]);
}

describe("parseScip — hand-encoded buffer", () => {
  it("definition() returns the definition location from src/alpha.ts", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    const def = index.definition("AlphaFunc");
    expect(def).toBeDefined();
    expect(def!.path).toBe("src/alpha.ts");
    expect(def!.line).toBe(10);
    expect(def!.column).toBe(3);
  });

  it("references() returns the reference in src/beta.ts", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    const refs = index.references("AlphaFunc");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe("src/beta.ts");
    expect(refs[0]!.line).toBe(2);
    expect(refs[0]!.column).toBe(8);
  });

  it("importsOf('src/beta.ts') includes src/alpha.ts (because AlphaFunc defined there)", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    const imports = index.importsOf("src/beta.ts");
    expect(imports).toContain("src/alpha.ts");
  });

  it("exportsOf('src/alpha.ts') includes AlphaFunc", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    const exports = index.exportsOf("src/alpha.ts");
    expect(exports).toContain("AlphaFunc");
  });

  it("definition() returns undefined for unknown symbol", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    expect(index.definition("Unknown")).toBeUndefined();
  });

  it("references() returns empty for unknown symbol", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    expect(index.references("Unknown")).toEqual([]);
  });

  it("parses an empty buffer as empty index", () => {
    const index = parseScip(Buffer.alloc(0));
    expect(index.definition("x")).toBeUndefined();
    expect(index.references("x")).toEqual([]);
    expect(index.importsOf("f")).toEqual([]);
    expect(index.exportsOf("f")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: ProtoReader.readVarint used JS bitwise `|=`/`<<` to accumulate
// the varint, which ToInt32-coerces to 32 bits — a byte whose 7-bit payload
// needs bits 4-6 (value >= 16) at shift 28 has those bits silently shifted
// past bit 31 and dropped, and (for a 5-byte varint whose LAST byte is the
// one at shift 28) the function returns straight from the corrupted main
// loop without ever reaching its own "> 28 bits" float-based fallback,
// because the loop's `if ((byte & 0x80) === 0) break;` fires first. The
// module's own comment claims this path exists specifically "to avoid
// signed 32-bit truncation" — it did not, for exactly the case it names.
// ---------------------------------------------------------------------------

describe("parseScip — large varint (regression: 32-bit bitwise truncation)", () => {
  it("decodes a range startLine >= 2^28 exactly, not truncated by JS's 32-bit bitwise ops", () => {
    // 17 * 2^28 = 4,563,402,752 — encodes as the 5-byte varint
    // [0x80,0x80,0x80,0x80,0x11]: the terminal byte's payload (17 =
    // 0b0010001) has bit 4 set, which is exactly the bit that JS's `<<28`
    // silently drops. The buggy decoder returned 1*2^28 = 268435456 instead
    // (only the payload's low nibble, bits 0-3, survived the shift).
    const bigLine = 17 * Math.pow(2, 28);
    expect(bigLine).toBe(4563402752);

    const rangeBytes = Buffer.concat([
      encodeVarintBig(bigLine),
      encodeVarintBig(3),
      encodeVarintBig(bigLine),
      encodeVarintBig(12),
    ]);
    const occ = Buffer.concat([
      encodeLenDelim(1, rangeBytes),          // field 1: range (packed varints)
      encodeString(2, "HugeLineFn"),          // field 2: symbol
      encodeVarintField(3, 1),                // field 3: symbol_roles (definition)
    ]);
    const doc = encodeDocument("src/huge.ts", [occ]);
    const buf = encodeIndex([doc]);

    const index = parseScip(buf);
    const def = index.definition("HugeLineFn");
    expect(def).toBeDefined();
    expect(def!.path).toBe("src/huge.ts");
    expect(def!.line).toBe(bigLine);
    expect(def!.column).toBe(3);
  });

  it("still decodes small (1-4 byte) varints correctly — no regression for the common case", () => {
    const buf = buildTestScipBuffer();
    const index = parseScip(buf);
    const def = index.definition("AlphaFunc");
    expect(def).toBeDefined();
    expect(def!.line).toBe(10);
    expect(def!.column).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// loadGraphIndex: scip.binpb is loaded
// ---------------------------------------------------------------------------

describe("loadGraphIndex — scip.binpb present", () => {
  it("returns a working GraphIndex from a valid scip.binpb", () => {
    const ws = mkWorkspace();
    writeBytes(ws, ".tokenlighten/index/scip.binpb", buildTestScipBuffer());

    const index = loadGraphIndex(ws);
    expect(index).toBeDefined();
    expect(index!.definition("AlphaFunc")!.path).toBe("src/alpha.ts");
  });

  it("tl-graph.json takes priority over scip.binpb when both exist", () => {
    const ws = mkWorkspace();
    // tl-graph.json has "GraphPreferred" symbol; scip.binpb has "AlphaFunc".
    const tlGraph = {
      version: 1,
      symbols: [
        {
          name: "GraphPreferred",
          definition: { path: "src/graph.ts", line: 1, column: 0 },
          references: [],
        },
      ],
      files: [],
    };
    writeFile(ws, ".tokenlighten/index/tl-graph.json", JSON.stringify(tlGraph));
    writeBytes(ws, ".tokenlighten/index/scip.binpb", buildTestScipBuffer());

    const index = loadGraphIndex(ws);
    expect(index).toBeDefined();
    // Should use tl-graph.json (GraphPreferred defined, AlphaFunc not).
    expect(index!.definition("GraphPreferred")).toBeDefined();
    expect(index!.definition("AlphaFunc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadGraphIndex: scip.binpb stat gate (mirrors the tl-graph.json branch's
// GRAPH_INDEX_MAX_BYTES idiom in graph/index.ts). Node's built-in `fs` ESM
// binding is non-configurable in this runtime (vi.spyOn(fs, "readFileSync")
// throws "Cannot redefine property"), so the read-count proofs below use
// vi.doMock("node:fs", ...) + vi.resetModules() + a dynamic re-import of the
// module under test instead — same pattern as
// locateTaskContext.spec.ts's "efficiency: contract file read once" suite.
// ---------------------------------------------------------------------------

/**
 * Re-imports graph/index.js against a "node:fs" whose readFileSync is
 * wrapped to count calls whose path ends with `matchSuffix`. Returns that
 * count after `run` has exercised the freshly-imported `loadGraphIndex`.
 */
async function withMockedFsReadCount(
  matchSuffix: string,
  run: (mockedLoadGraphIndex: typeof loadGraphIndex) => void | Promise<void>,
): Promise<number> {
  vi.resetModules();
  let count = 0;
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      readFileSync: (...args: Parameters<typeof import("node:fs").readFileSync>) => {
        const p = args[0];
        if (typeof p === "string" && p.endsWith(matchSuffix)) count++;
        return (actual.readFileSync as (...a: typeof args) => ReturnType<typeof actual.readFileSync>)(...args);
      },
    };
  });
  try {
    const { loadGraphIndex: mockedLoadGraphIndex } = await import("../graph/index.js");
    const { setTraceEnabledForTest: setMockedTraceEnabled } = await import("../util/trace.js");
    setMockedTraceEnabled(false);
    await run(mockedLoadGraphIndex);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
  return count;
}

function writeOversizeFile(workspace: string, rel: string, size: number): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, size);
}

describe("loadGraphIndex — scip.binpb size cap (GRAPH_INDEX_MAX_BYTES)", () => {
  it("refuses an over-cap scip.binpb (same degrade as the tl-graph.json oversize path: undefined, no throw)", () => {
    const ws = mkWorkspace();
    writeOversizeFile(ws, ".tokenlighten/index/scip.binpb", GRAPH_INDEX_MAX_BYTES + 1);

    expect(loadGraphIndex(ws)).toBeUndefined();
  });

  it("never calls fs.readFileSync on an over-cap scip.binpb, on the first call or a memoized second call", async () => {
    const ws = mkWorkspace();
    writeOversizeFile(ws, ".tokenlighten/index/scip.binpb", GRAPH_INDEX_MAX_BYTES + 1);

    let first: unknown;
    let second: unknown;
    const readCount = await withMockedFsReadCount("scip.binpb", (mockedLoadGraphIndex) => {
      first = mockedLoadGraphIndex(ws);
      second = mockedLoadGraphIndex(ws);
    });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(readCount).toBe(0);
  });

  it("refuses a directory named scip.binpb (regular-file check, same stat gate)", () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, ".tokenlighten/index/scip.binpb"), { recursive: true });

    expect(loadGraphIndex(ws)).toBeUndefined();
  });
});

describe("loadGraphIndex — scip.binpb memoization parity with tl-graph.json", () => {
  it("does not re-read a valid scip.binpb on a second call (same memo+rememberGraph idiom as tl-graph.json; control: a small file still reaches the decoder)", async () => {
    const ws = mkWorkspace();
    writeBytes(ws, ".tokenlighten/index/scip.binpb", buildTestScipBuffer());

    let first: unknown;
    let second: unknown;
    const readCount = await withMockedFsReadCount("scip.binpb", (mockedLoadGraphIndex) => {
      first = mockedLoadGraphIndex(ws);
      second = mockedLoadGraphIndex(ws);
    });

    expect(first).toBeDefined();
    expect(second).toBe(first); // exact same memoized GraphIndex instance, not just deep-equal
    expect(readCount).toBe(1);
  });
});
