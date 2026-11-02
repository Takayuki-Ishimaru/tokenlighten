// ---------------------------------------------------------------------------
// A plain csv/tsv section of a task pack, with no query window: `range` names
// exactly the rows the section carries, and `next` reaches the rows it left out.
// Through the real `callTool`, on the default path (TL_ARTIFACT_QUERY_WINDOW off).
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetArtifactSectionPrefetch, resetPackDedupeCache, resetRoleInventoryCache, trimToCap, type TaskPackResult } from "../tools/readCodeTaskPack.js";
import { artifactSectionCandidates, plainCsvRemainder } from "../features/task-pack/artifactSections.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";

type Json = Record<string, unknown>;
type Section = { sheet: string; range: string; columns: string[]; rows: unknown[][]; truncated: boolean };
type Entry = { path: string; section: Section; content_completeness?: string; handle?: string; next?: { tool: string; arguments: Json }; note?: string };

const created: string[] = [];
let workspace = "";
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["TL_ARTIFACT_QUERY_WINDOW", "TL_CSV_SAMPLE", "TL_LEGACY_INPUT", "TOKENLIGHTEN_CLIENT_ID"] as const;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-csv-section-")));
  created.push(workspace);
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetArtifactSectionPrefetch();
  resetRootResolverCache();
  setActiveRootWorkspace(workspace);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  for (const ws of created) fs.rmSync(ws, { recursive: true, force: true });
});

async function read(args: Json): Promise<Json> {
  const reply = await callTool("tl_read_file", { cwd: workspace, ...args });
  const text = (reply as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as Json;
}

/** `rows` data rows after a header, each wide enough that 8 KiB holds well under 200. */
function table(rows: number, delimiter = ","): string {
  const lines = [["id", "service", "status", "detail"].join(delimiter)];
  for (let i = 0; i < rows; i += 1) {
    lines.push([i, `svc-${i % 7}`, "ok", `plain detail text for row number ${i}`].join(delimiter));
  }
  return `${lines.join("\n")}\n`;
}

function write(rel: string, text: string): string {
  fs.writeFileSync(path.join(workspace, rel), text, "utf8");
  return rel;
}

/** The pack's csv entry, wherever the pack's shape put it. */
function entryOf(reply: Json, rel: string): Entry {
  const seen: Entry[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      const record = value as Json;
      if (record["path"] === rel && record["section"] !== undefined) seen.push(record as unknown as Entry);
      Object.values(record).forEach(visit);
    }
  };
  visit(reply);
  expect(seen.length, JSON.stringify(reply).slice(0, 600)).toBeGreaterThan(0);
  return seen[0]!;
}

const packFor = (rel: string): Promise<Json> => read({
  query: `What services are listed in ${rel}? No code changes.`,
  task: { epoch: "new" },
});

/** The logical row numbers of a section whose first column is the 0-based id. */
function logicalRows(rows: readonly unknown[][], firstDataRow = 2): number[] {
  return rows.map((row) => Number(row[0]) + firstDataRow);
}

function expectRangeNamesRows(range: string, rows: readonly unknown[][], firstDataRow = 2): void {
  const logical = logicalRows(rows, firstDataRow);
  expect(range).toBe(`${logical[0]}-${logical[logical.length - 1]}`);
}

/** The logical span a wire-form `next` asks for. */
function rangeOf(next: { arguments: Json } | undefined): unknown {
  return (next?.arguments["targets"] as Json[] | undefined)?.[0]?.["range"];
}

/** Follows `next`, then the replies' own range= notes, to the end of the table. */
async function walkFrom(next: { arguments: Json }): Promise<{ rows: unknown[][]; firstReply: Json }> {
  const target = (next.arguments["targets"] as Json[])[0]!;
  let reply = await read(next.arguments);
  const firstReply = reply;
  const rows: unknown[][] = [];
  for (let calls = 0; calls < 50; calls += 1) {
    expect(reply["kind"], JSON.stringify(reply).slice(0, 400)).toBe("read.artifact");
    const content = reply["content"] as Json;
    rows.push(...(content["rows"] as unknown[][]));
    const more = /fetch more with range=(\d+-\d+)/.exec(String(content["note"] ?? ""));
    if (more === null) return { rows, firstReply };
    reply = await read({ ...next.arguments, targets: [{ ...target, range: more[1] }] });
  }
  throw new Error("no termination");
}

describe("a plain csv section cut by the per-artifact budget", () => {
  it("names only the rows it carries in `range`", async () => {
    const rel = write("events.csv", table(150));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.content_completeness).toBe("partial");
    expect(entry.section.rows.length).toBeGreaterThan(0);
    expect(entry.section.rows.length).toBeLessThan(150);
    expectRangeNamesRows(entry.section.range, entry.section.rows);
  });

  it("`next` serves the rows left out, not the head again", async () => {
    const rel = write("events.csv", table(150));
    const entry = entryOf(await packFor(rel), rel);
    const served = logicalRows(entry.section.rows);
    const { rows } = await walkFrom(entry.next!);
    const fetched = logicalRows(rows);
    expect(fetched[0]).toBe(served[served.length - 1]! + 1);
    expect([...served, ...fetched]).toEqual(Array.from({ length: 150 }, (_, i) => i + 2));
  });

  it("reaches the rows past the extractor's 200-row window as well", async () => {
    const rel = write("events.csv", table(1000));
    const entry = entryOf(await packFor(rel), rel);
    expectRangeNamesRows(entry.section.range, entry.section.rows);
    const served = logicalRows(entry.section.rows);
    const { rows } = await walkFrom(entry.next!);
    expect([...served, ...logicalRows(rows)]).toEqual(Array.from({ length: 1000 }, (_, i) => i + 2));
  });

  it("holds for tsv and for a headerless table, whose data starts at row 1", async () => {
    const tsv = write("events.tsv", table(150, "\t"));
    const tsvEntry = entryOf(await packFor(tsv), tsv);
    expectRangeNamesRows(tsvEntry.section.range, tsvEntry.section.rows);
    const tsvServed = logicalRows(tsvEntry.section.rows);
    expect(logicalRows((await walkFrom(tsvEntry.next!)).rows)[0]).toBe(tsvServed[tsvServed.length - 1]! + 1);

    const bare = write("bare.csv", Array.from({ length: 150 }, (_, i) => `${i},${i * 2},plain detail text for row number ${i}, and some more of it`).join("\n"));
    const bareEntry = entryOf(await packFor(bare), bare);
    expectRangeNamesRows(bareEntry.section.range, bareEntry.section.rows, 1);
    const bareServed = logicalRows(bareEntry.section.rows, 1);
    expect(logicalRows((await walkFrom(bareEntry.next!)).rows, 1)).toEqual(
      Array.from({ length: 150 - bareServed.length }, (_, i) => bareServed.length + i + 1),
    );
  });
});

describe("a plain csv section whose single row overflows the budget", () => {
  it("narrows the columns, then `next` repeats that row so its cut cells stay reachable", async () => {
    const big = "x".repeat(9000);
    const rel = write("wide.csv", ["id,service,blob", ...Array.from({ length: 5 }, (_, i) => `${i},svc,${big}`)].join("\n"));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.columns).toEqual(["id", "service"]);
    expect(entry.section.range).toBe("2-2");
    expect(rangeOf(entry.next)).toBe("2-6");
    expect(entry.note).toContain("columns or cells cut");
    const { rows, firstReply } = await walkFrom(entry.next!);
    expect((firstReply["content"] as Json)["columns"]).toEqual(["id", "service", "blob"]);
    expect(logicalRows(rows)).toEqual([2, 3, 4, 5, 6]);
    expect(rows[0]![2]).toBe(big);
  });
});

describe("a plain csv section shrunk again by the pack's trim", () => {
  /** A pack `excess` bytes over the code-bearing cap, so one shrink of `entry` closes it. */
  const overCap = (entry: Entry, excess: number): TaskPackResult => {
    const pack = (filler: number): TaskPackResult => ({
      mode: "task_pack",
      coverage: "complete",
      surfaces: [{ role: "api", handle: "h1", path: "src/a.ts", range: "1-50", code: "x".repeat(filler) }],
      missing: [],
      artifact_sections: [structuredClone(entry) as never],
      inlined: [`artifact-section:${entry.path}#${entry.section.sheet}`],
    });
    return pack(28672 + excess - Buffer.byteLength(JSON.stringify(pack(0)), "utf8"));
  };

  /** The entry trimToCap left, with its `next` in the form the wire carries. */
  const shrink = (entry: Entry, excess: number): Entry => {
    const trimmed = trimToCap(overCap(entry, excess), undefined, new Set(["some/other.csv"]));
    const shrunk = trimmed.artifact_sections?.[0] as unknown as Entry | undefined;
    expect(shrunk, JSON.stringify(trimmed.artifact_sections_trimmed)).toBeDefined();
    return { ...shrunk!, next: canonicalToolCall("tl_read_file", shrunk!.next!.arguments as Json) as Entry["next"] };
  };

  it("moves `next` back to the first row the trim dropped, so no row is skipped", async () => {
    // A head long enough for one trim to shrink rather than shed it.
    process.env["TL_CSV_SAMPLE"] = "0";
    const rel = write("events.csv", table(1000));
    const entry = entryOf(await packFor(rel), rel);
    const servedBefore = entry.section.rows.length;
    expect(rangeOf(entry.next)).toBe(`${servedBefore + 2}-1001`);

    const shrunk = shrink(entry, 1000);
    expect(shrunk.section.rows.length).toBeLessThan(servedBefore);
    expectRangeNamesRows(shrunk.section.range, shrunk.section.rows);
    expect(rangeOf(shrunk.next)).toBe(`${shrunk.section.rows.length + 2}-1001`);
    expect(shrunk.note).toMatch(/^inlined \d+ of 1000 data rows/);

    const { rows } = await walkFrom(shrunk.next!);
    expect([...logicalRows(shrunk.section.rows), ...logicalRows(rows)]).toEqual(Array.from({ length: 1000 }, (_, i) => i + 2));
  });

  it("gives an entry that had no `next` one that reaches the rows it just lost", async () => {
    const rel = write("events.csv", table(100));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.next).toBeUndefined();

    const shrunk = shrink(entry, 1000);
    expectRangeNamesRows(shrunk.section.range, shrunk.section.rows);
    expect(rangeOf(shrunk.next)).toBe(`${shrunk.section.rows.length + 2}-101`);
    const { rows } = await walkFrom(shrunk.next!);
    expect([...logicalRows(shrunk.section.rows), ...logicalRows(rows)]).toEqual(Array.from({ length: 100 }, (_, i) => i + 2));
  });
});

describe("the bounded ladder and the remainder of a plain csv section", () => {
  const section = (rows: number, cell = "ok"): Section => ({
    sheet: "t.csv",
    range: `2-${rows + 1}`,
    columns: ["id", "v"],
    rows: Array.from({ length: rows }, (_, i) => [String(i), cell]),
    truncated: false,
  });

  it("every ladder variant names its own rows and the table's total", () => {
    const [, ...cuts] = artifactSectionCandidates(section(30));
    expect(cuts.length).toBeGreaterThan(0);
    for (const cut of cuts as Array<Section & { total_rows?: number }>) {
      expectRangeNamesRows(cut.range, cut.rows);
      expect(cut.total_rows).toBe(30);
    }
  });

  it("a clipped cell sends `next` back over the kept rows, and a later clean cut keeps that", () => {
    const whole = section(30, "z".repeat(500));
    const clipped = artifactSectionCandidates(whole)[1] as Section;
    expect(clipped.rows).toHaveLength(12);
    expect(plainCsvRemainder(whole, clipped)).toBe("2-31");
    const smaller = { ...clipped, range: "2-5", rows: clipped.rows.slice(0, 4) };
    expect(plainCsvRemainder(clipped, smaller)).toBe("6-31");
    expect(plainCsvRemainder(clipped, smaller, "2-31")).toBe("2-31");
  });

  it("leaves an xlsx-shaped section and a query window to their own continuations", () => {
    const sheet = { ...section(30), range: "A1:B31" };
    expect(plainCsvRemainder(sheet, { ...sheet, rows: sheet.rows.slice(0, 4) })).toBeUndefined();
    const window = { ...section(30), query_window: { selected_by: "query" as const, total_rows: 900, anchor_row: 12 } };
    expect(plainCsvRemainder(window, { ...window, rows: window.rows.slice(0, 4) })).toBeUndefined();
  });
});

describe("a sample of a csv the pack cannot carry whole", () => {
  it("shows ten rows and reaches every other row, however the table was cut", async () => {
    for (const [rel, rows] of [["byBytes.csv", 150], ["byExtractor.csv", 1000]] as const) {
      write(rel, table(rows));
      const entry = entryOf(await packFor(rel), rel);
      expect(entry.section.rows).toHaveLength(10);
      expectRangeNamesRows(entry.section.range, entry.section.rows);
      expect(entry.section.truncated).toBe(true);
      expect(entry.content_completeness).toBe("partial");
      expect(entry.note).toMatch(new RegExp(`^inlined 10 of ${rows} data rows, a sample .*tl_search_files.*next reads the rest`));
      const walked = await walkFrom(entry.next!);
      expect([...logicalRows(entry.section.rows), ...logicalRows(walked.rows)]).toEqual(Array.from({ length: rows }, (_, i) => i + 2));
    }
  });

  it("samples a narrow table that fits the budget only because the extractor stopped at 200 rows", async () => {
    const rel = write("narrow.csv", ["a,b", ...Array.from({ length: 300 }, (_, i) => `${i},x`)].join("\n"));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.range).toBe("2-11");
    expect(rangeOf(entry.next)).toBe("12-301");
  });

  it("holds its rows to the byte cap when ten of them do not fit, and skips none", async () => {
    const wide = "w".repeat(1500);
    const rel = write("wide.csv", ["id,blob", ...Array.from({ length: 30 }, (_, i) => `${i},${wide}`)].join("\n"));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.rows.length).toBeLessThan(10);
    expect(entry.note).toContain("per-artifact inline cap");
    const { rows } = await walkFrom(entry.next!);
    expect([...logicalRows(entry.section.rows), ...logicalRows(rows)]).toEqual(Array.from({ length: 30 }, (_, i) => i + 2));
  });

  it("keeps a table of a few more than ten rows whole when it fits", async () => {
    const rel = write("eleven.csv", table(11));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.rows).toHaveLength(11);
    expect(entry.next).toBeUndefined();
  });

  it("TL_CSV_SAMPLE=0 restores the head that fills the inline cap", async () => {
    process.env["TL_CSV_SAMPLE"] = "0";
    const rel = write("events.csv", table(1000));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.rows.length).toBeGreaterThan(100);
    expect(entry.note).toContain("per-artifact inline cap");
  });
});

describe("a plain csv section the budget did not cut", () => {
  it("keeps a whole table byte-for-byte, with no partial marker and no next", async () => {
    const rel = write("small.csv", table(10));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.range).toBe("2-11");
    expect(entry.section.rows).toHaveLength(10);
    expect(entry.content_completeness).toBeUndefined();
    expect(entry.next).toBeUndefined();
  });

  it("a section that fits but stopped at the extractor's 200 rows continues at row 202", async () => {
    process.env["TL_CSV_SAMPLE"] = "0";
    const rel = write("narrow.csv", ["a,b", ...Array.from({ length: 300 }, (_, i) => `${i},x`)].join("\n"));
    const entry = entryOf(await packFor(rel), rel);
    expect(entry.section.range).toBe("2-201");
    expect(entry.section.truncated).toBe(true);
    expect(rangeOf(entry.next)).toBe("202-301");
    const { rows } = await walkFrom(entry.next!);
    expect(logicalRows(rows)).toEqual(Array.from({ length: 100 }, (_, i) => i + 202));
  });
});
