// ---------------------------------------------------------------------------
// office/csvLookup.ts, the pure half, then the pack on a named csv through the real
// `callTool`: a read-only lookup its rows answer ends in act.answer, and anything else
// keeps searching.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { csvLookupAbsent, csvLookupAcrossColumns, csvLookupAnswersRequest, csvLookupAsksCount, csvLookupColumnValues, csvLookupRows, csvLookupTerms, csvLookupWholeCells } from "../office/csvLookup.js";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetArtifactSectionPrefetch, resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";

type Json = Record<string, unknown>;

function model(rows: Array<Array<string | null>>, columns = ["id", "service", "status"]) {
  return { rows, columns, firstDataRow: 2, dataSpans: rows.map((_, i): [number, number] => [i + 2, i + 2]) };
}

describe("csvLookupTerms", () => {
  const table = model([
    ["10", "svc-1", "ok"],
    ["11", "svc-2", "gateway-timeout"],
    ["12", "東京", "timeout"],
  ]);

  it("finds a table's own value the request spells, in the table's spelling", () => {
    expect(csvLookupTerms(table, "status が GATEWAY-TIMEOUT の行")).toEqual(["gateway-timeout"]);
  });

  it("a value is not found inside a longer latin token, but is found between Japanese words", () => {
    expect(csvLookupTerms(table, "status が gateway-timeouts の行")).toEqual([]);
    expect(csvLookupTerms(table, "okay and token")).toEqual([]);
    expect(csvLookupTerms(table, "地域が東京の行")).toEqual(["東京"]);
  });

  it("a column's own name is never a value", () => {
    const named = model([["status", "x"]], ["status", "other"]);
    expect(csvLookupTerms(named, "status の値")).toEqual([]);
  });

  it("a bare number counts only right after its column", () => {
    expect(csvLookupTerms(table, "id 11 の service")).toEqual(["11"]);
    expect(csvLookupTerms(table, "id=11 の service")).toEqual(["11"]);
    expect(csvLookupTerms(table, "id が 11 の service")).toEqual(["11"]);
    expect(csvLookupTerms(table, "11 行目の service")).toEqual([]);
    expect(csvLookupTerms(table, "id 110 の service")).toEqual([]);
    expect(csvLookupTerms(table, "valid 11 の service")).toEqual([]);
  });

  it("null and empty cells, one-character values and very long values are not terms", () => {
    const sparse = model([["a", null, ""], ["x".repeat(65), "", "ok"]]);
    expect(csvLookupTerms(sparse, `a ${"x".repeat(65)} ok`)).toEqual(["ok"]);
  });

  it("more distinct values than a lookup could use yields none", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
    expect(csvLookupTerms(model(words.map((word) => [word, "x", "y"])), words.join(" "))).toEqual([]);
  });
});

describe("csvLookupRows", () => {
  const table = model([
    ["1", "svc-1", "ok"],
    ["2", "svc-2", "GATEWAY-timeout"],
    ["3", null, "upstream gateway-timeout seen"],
    ["4", "svc-4", "ok"],
  ]);

  it("returns every row containing a term in any cell, ignoring case, with its logical row number", () => {
    const lookup = csvLookupRows(table, ["gateway-timeout"], 30, 6000);
    expect(lookup.total).toBe(2);
    expect(lookup.scanned).toBe(4);
    expect(lookup.row_numbers).toEqual([3, 4]);
    expect(lookup.rows.map((row) => row[0])).toEqual(["2", "3"]);
  });

  it("takes the union of several terms, never their intersection", () => {
    const lookup = csvLookupRows(table, ["svc-1", "svc-4"], 30, 6000);
    expect(lookup.row_numbers).toEqual([2, 5]);
  });

  it("past maxRows or roomBytes it stops listing and keeps counting", () => {
    const byRows = csvLookupRows(table, ["ok", "timeout"], 2, 6000);
    expect(byRows.total).toBe(4);
    expect(byRows.rows).toHaveLength(2);
    const byBytes = csvLookupRows(table, ["ok", "timeout"], 30, 1);
    expect(byBytes.total).toBe(4);
    expect(byBytes.rows).toHaveLength(0);
  });
});

describe("csvLookupAbsent", () => {
  const table = model([
    ["1", "svc-1", "ok"],
    ["2", "svc-2", "gateway-timeout"],
  ]);

  it("names what the request marks as a value when no cell contains it", () => {
    expect(csvLookupAbsent(table, "status が db-overload の行")).toEqual(["db-overload"]);
    expect(csvLookupAbsent(table, "status が E1234 の行")).toEqual(["e1234"]);
    expect(csvLookupAbsent(table, "status が「東京」の行")).toEqual(["東京"]);
  });

  it("marks nothing in plain words, bare numbers or the read-only clause", () => {
    expect(csvLookupAbsent(table, "status が failed の行")).toEqual([]);
    expect(csvLookupAbsent(table, "id 99 の行")).toEqual([]);
    expect(csvLookupAbsent(table, "read-only で status の行")).toEqual([]);
  });

  it("a marked value inside a cell, or one of several, is no absence", () => {
    expect(csvLookupAbsent(table, "status が gateway-time の行")).toEqual([]);
    expect(csvLookupAbsent(table, "db-overload と gateway-time の行")).toEqual([]);
  });

  it("a column's name is not a value", () => {
    const named = model([["x"]], ["trace-id"]);
    expect(csvLookupAbsent(named, "trace-id の値")).toEqual([]);
  });
});

describe("csvLookupColumnValues", () => {
  const table = model([
    ["1", "svc-1", "ok"],
    ["2", "svc-1", "busy"],
    ["3", null, " ok "],
  ]);

  it("lists the distinct values of a column the request names", () => {
    expect(csvLookupColumnValues(table, "status が x-y の行")).toEqual({ status: ["ok", "busy"] });
    expect(csvLookupColumnValues(table, "x-y の行")).toBeUndefined();
    expect(csvLookupColumnValues(table, "statuses が x-y の行")).toBeUndefined();
  });

  it("leaves out a column with too many or too long values", () => {
    const many = model(Array.from({ length: 13 }, (_, i) => [String(i), "s", "v"]));
    expect(csvLookupColumnValues(many, "id と status")).toEqual({ status: ["v"] });
    const long = model([["1", "s", "x".repeat(33)]]);
    expect(csvLookupColumnValues(long, "status")).toBeUndefined();
  });
});

describe("csvLookupWholeCells", () => {
  it("counts rows holding a term as a whole cell and names their one column", () => {
    const table = model([["1", "svc-1", "busy"], ["2", "svc-1", "not busy"], ["3", "svc-2", "BUSY"]]);
    expect(csvLookupWholeCells(table, ["busy"])).toEqual({ total: 2, column: "status" });
  });

  it("names no column when the cells are in several, and counts a row once", () => {
    const table = model([["busy", "busy", "x"], ["1", "2", "busy"]]);
    expect(csvLookupWholeCells(table, ["busy"])).toEqual({ total: 2 });
  });
});

describe("csvLookupAcrossColumns", () => {
  const table = model([
    ["1", "svc-1", "ok"],
    ["2", "svc-1", "gateway-timeout"],
    ["3", "svc-2", "gateway-timeout"],
    ["4", "svc-2", "busy"],
    ["5", "svc-1", "busy"],
  ]);

  it("values of different columns narrow each other, and values of one column are alternatives", () => {
    expect(csvLookupAcrossColumns(table, ["svc-1", "gateway-timeout"], "svc-1 の gateway-timeout", 30, 6000)).toMatchObject({ all_of: { service: ["svc-1"], status: ["gateway-timeout"] }, total: 1, row_numbers: [3] });
    expect(csvLookupAcrossColumns(table, ["svc-1", "gateway-timeout", "busy"], "svc-1 の gateway-timeout と busy", 30, 6000)).toMatchObject({ all_of: { service: ["svc-1"], status: ["gateway-timeout", "busy"] }, total: 2, row_numbers: [3, 6] });
  });

  it("does not apply to one column, a value of two columns, a partial cell or \"either\"", () => {
    expect(csvLookupAcrossColumns(table, ["busy", "ok"], "busy と ok", 30, 6000)).toBeUndefined();
    expect(csvLookupAcrossColumns(model([["a", "a"], ["b", "c"]], ["x", "y"]), ["a", "c"], "a と c", 30, 6000)).toBeUndefined();
    expect(csvLookupAcrossColumns(table, ["svc-1", "gateway"], "svc-1 の gateway", 30, 6000)).toBeUndefined();
    expect(csvLookupAcrossColumns(table, ["svc-1", "busy"], "svc-1 または busy", 30, 6000)).toBeUndefined();
    expect(csvLookupAcrossColumns(table, ["svc-1", "busy"], "svc-1 or busy", 30, 6000)).toBeUndefined();
    expect(csvLookupAcrossColumns(table, ["svc-1", "busy"], "svc-1 か busy", 30, 6000)).toBeUndefined();
  });

  it("no row holding them all is a result, not a failure", () => {
    expect(csvLookupAcrossColumns(table, ["svc-2", "ok"], "svc-2 の ok", 30, 6000)).toMatchObject({ all_of: { service: ["svc-2"], status: ["ok"] }, total: 0, row_numbers: [] });
  });
});

describe("csvLookupAsksCount", () => {
  it.each(["gateway-timeout は何件?", "件数を教えて", "how many rows", "何行ある?", "count of rows", "いくつある?"])("asks: %s", (request) => {
    expect(csvLookupAsksCount(request)).toBe(true);
  });

  it.each(["gateway-timeout の行を教えて", "何行目にある?", "account の行", "show the rows"])("does not ask: %s", (request) => {
    expect(csvLookupAsksCount(request)).toBe(false);
  });

  it("a column of that name is not the question", () => {
    expect(csvLookupAsksCount("count が 5 の行を教えて", ["id", "count"])).toBe(false);
    expect(csvLookupAsksCount("count が 5 の行は何件?", ["id", "count"])).toBe(true);
  });
});

describe("csvLookupAnswersRequest", () => {
  it.each([
    "status が gateway-timeout の行を教えて",
    "status が gateway-timeout の行を教えて。ファイルは変更しないで。",
    "status が gateway-timeout の行をすべて挙げて (id と service)。ファイルは編集しないでください",
    "rows where status is gateway-timeout. Do not change the file.",
    "gateway-timeout は何件?",
  ])("a list of rows answers: %s", (request) => {
    expect(csvLookupAnswersRequest(request)).toBe(true);
  });

  it.each([
    "status が gateway-timeout ではない行",
    "gateway-timeout 以外の行",
    "status is not gateway-timeout",
    "rows other than gateway-timeout",
    "gateway-timeout の行の中で id が最大のもの",
    "gateway-timeout の平均レイテンシ",
    "average latency of gateway-timeout rows",
    "gateway-timeout が増えた理由",
    "why is it gateway-timeout",
    "latency が 100 以上の gateway-timeout",
  ])("a list of rows does not answer: %s", (request) => {
    expect(csvLookupAnswersRequest(request)).toBe(false);
  });
});

describe("a pack on a named csv", () => {
  const created: string[] = [];
  let workspace = "";
  let savedEnv: Record<string, string | undefined>;
  const ENV_KEYS = ["TL_ARTIFACT_QUERY_WINDOW", "TL_CSV_SAMPLE", "TL_CSV_LOOKUP", "TL_LEGACY_INPUT", "TOKENLIGHTEN_CLIENT_ID"] as const;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-csv-lookup-")));
    created.push(workspace);
    fs.mkdirSync(path.join(workspace, "ops"));
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

  function events(rows: number, marked: readonly number[]): void {
    const lines = ["id,service,status,detail"];
    for (let i = 0; i < rows; i += 1) {
      lines.push(`${i},svc-${i % 7},${marked.includes(i) ? "gateway-timeout" : "ok"},plain detail text for row number ${i}`);
    }
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
  }

  async function pack(query: string): Promise<{ reply: Json; entry: { section: { rows?: unknown[][]; lookup?: { terms: string[]; total: number; columns?: string[]; scanned?: number; row_numbers: number[]; rows: unknown[][] } }; next?: unknown; note?: string; remaining_sections?: string[] } | undefined; decision: { kind: string; next?: unknown } }> {
    const raw = await callTool("tl_read_file", { cwd: workspace, query, task: { epoch: "new" } });
    const reply = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text) as Json;
    const sections = (reply["plan"] as { artifact_sections?: unknown[] } | undefined)?.artifact_sections;
    return { reply, entry: sections?.[0] as never, decision: reply["decision"] as never };
  }

  const ONE = "ops/events.csv で status が gateway-timeout の行の id を教えて。ファイルは変更しないで。";

  it("answers one match deep in a table in the first reply, and points at no further read", async () => {
    events(5000, [4980]);
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("act.answer");
    expect(decision.next).toBeUndefined();
    expect(entry!.section.lookup).toMatchObject({ all_of: { status: ["gateway-timeout"] }, total: 1 });
    expect(entry!.section.lookup!.rows[0]).toEqual(["4980"]);
    expect(entry!.next).toBeUndefined();
    expect(entry!.note).toContain("all 5000 data rows");
  });

  it("holds the columns the request asks for, and whole rows when it asks for none beyond those searched", async () => {
    events(5000, [4980]);
    const asked = await pack("ops/events.csv で status が gateway-timeout の行の id と service を教えて。");
    expect(asked.entry!.section.lookup).toMatchObject({ columns: ["id", "service"], rows: [["4980", "svc-3"]] });
    const rows = await pack("ops/events.csv で status が gateway-timeout の行を教えて。");
    expect(rows.entry!.section.lookup).not.toHaveProperty("columns");
    expect(rows.entry!.section.lookup!.rows[0]).toEqual(["4980", "svc-3", "gateway-timeout", "plain detail text for row number 4980"]);
    const none = await pack("ops/events.csv の gateway-timeout の行を教えて。");
    expect(none.entry!.section.lookup!.rows[0]).toHaveLength(4);
    // Every column named, none of them searched: nothing to cut.
    const every = await pack("ops/events.csv の gateway-timeout の行の id service detail を教えて。");
    expect(every.entry!.section.lookup).toMatchObject({ columns: ["id", "service", "detail"] });
    expect(every.entry!.section.lookup!.rows[0]).toEqual(["4980", "svc-3", "plain detail text for row number 4980"]);
  });

  it("a named column holding a term's own value is one searched, wherever else the term sits", async () => {
    events(5000, [4980]);
    const { entry } = await pack("ops/events.csv で service が svc-3 で status が gateway-timeout の行の id を教えて。");
    expect(entry!.section.lookup).toMatchObject({ columns: ["id"] });
    expect(entry!.section.lookup!.rows).toContainEqual(["4980"]);
  });

  it("an answer carries the rows and none of what only a further read would use", async () => {
    events(5000, [4980]);
    const { reply, entry, decision } = await pack(ONE);
    expect(Object.keys(entry!).sort()).toEqual(["note", "section"]);
    expect(Object.keys(entry!.section).sort()).toEqual(["columns", "lookup", "total_rows"]);
    expect(entry!.section.lookup).not.toHaveProperty("scanned");
    expect(entry!.section.lookup).not.toHaveProperty("row_numbers");
    expect(reply).not.toHaveProperty("task");
    expect(reply).not.toHaveProperty("profile");
    expect((reply["plan"] as Json)["inlined"]).toBeUndefined();
    expect(reply["qref"]).toBeUndefined();
    expect(decision).toEqual({ kind: "act.answer" });
    // The evidence row's handle still reaches every other row and column.
    const handle = (reply["evidence"] as Array<{ handle: string }>)[0]!.handle;
    const raw = await callTool("tl_read_file", { cwd: workspace, targets: [{ handle, range: "100-101" }] });
    expect((raw as { content: Array<{ text: string }> }).content[0]!.text).toContain("plain detail text for row number 98");
  });

  it("a reply that does not end the request keeps all of it", async () => {
    events(5000, [4980]);
    const { reply, entry } = await pack("ops/events.csv で status が gateway-timeout ではない行を教えて");
    expect(entry!.section.lookup).toMatchObject({ total: 1, scanned: 5000, row_numbers: [4982] });
    expect(entry!.section.rows).toHaveLength(1);
    expect(entry!.remaining_sections).toBeDefined();
    expect(reply["qref"]).toBeDefined();
  });

  it("how many: the count answers even when the rows are too many to list", async () => {
    events(5000, Array.from({ length: 100 }, (_, i) => i * 37));
    const { decision, entry } = await pack("ops/events.csv で status が gateway-timeout の行は何件? ファイルは変更しないで。");
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.lookup).toMatchObject({ total: 100, counted: true });
    expect(entry!.section.lookup!.rows).toHaveLength(0);
    expect(entry!.section.rows).toBeUndefined();
    expect(entry!.section.lookup).toMatchObject({ all_of: { status: ["gateway-timeout"] } });
    expect(entry!.note).toContain("counts all 100 rows where status is gateway-timeout (no other row contains it)");
    expect(entry!.next).toBeUndefined();
    // "何件" is a value question to the code path; a table's count closes it with no gap.
    expect(decision).not.toHaveProperty("certificate.gaps");
  });

  it("how many of a value no cell contains is zero, and more than one alternative is not one count", async () => {
    events(5000, Array.from({ length: 100 }, (_, i) => i * 37));
    const absent = await pack("ops/events.csv で status が db-overload の行は何件? ファイルは変更しないで。");
    expect(absent.decision.kind).toBe("act.answer");
    expect(absent.entry!.section.lookup).toMatchObject({ absent: ["db-overload"], total: 0 });
    const lines = ["id,status"];
    for (let i = 0; i < 2000; i += 1) lines.push(`${i},${i % 2 === 0 ? "busy" : "gone"}`);
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
    const either = await pack("ops/events.csv で status が busy や gone の行は何件? ファイルは変更しないで。");
    expect(either.decision.kind).not.toBe("act.answer");
    expect(either.entry!.section.lookup).not.toHaveProperty("counted");
  });

  it("how many: a count of cells that only contain the value says so", async () => {
    const lines = ["id,status"];
    for (let i = 0; i < 2000; i += 1) lines.push(`${i},${i % 2 === 0 ? "timeout" : "gateway-timeout"}`);
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
    const { entry } = await pack("ops/events.csv で status が timeout の行は何件? ファイルは変更しないで。");
    expect(entry!.section.lookup).toMatchObject({ total: 2000, whole_cell_total: 1000, counted: true });
    expect(entry!.note).toContain("1000 as a whole cell");
  });

  it("values of different columns narrow a union too long to list", async () => {
    const marked = [3, 10, 17, 24, 700, 701];
    events(5000, marked);
    const { decision, entry } = await pack("ops/events.csv で service が svc-3 で status が gateway-timeout の行の id を教えて。ファイルは変更しないで。");
    expect(decision.kind).toBe("act.answer");
    const expected = marked.filter((i) => i % 7 === 3);
    expect(entry!.section.lookup).toMatchObject({ all_of: { service: ["svc-3"], status: ["gateway-timeout"] }, total: expected.length });
    expect(entry!.section.lookup!.rows.map((row) => row[0])).toEqual(expected.map(String));
    expect(entry!.note).toContain("rows where service is svc-3 and status is gateway-timeout");
  });

  it("\"a or b\" across columns stays a union, and too long a union keeps searching", async () => {
    events(5000, [3, 700]);
    const { decision, entry } = await pack("ops/events.csv で service が svc-3 または status が gateway-timeout の行を教えて。");
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).not.toHaveProperty("all_of");
  });

  it("a union that fits is not narrowed", async () => {
    const lines = ["id,service,status"];
    for (let i = 0; i < 2000; i += 1) lines.push(`${i},${i < 3 ? "svc-rare" : "svc-x"},${i === 1000 ? "gateway-timeout" : "ok"}`);
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
    const { entry } = await pack("ops/events.csv の svc-rare と gateway-timeout の行を教えて。");
    expect(entry!.section.lookup!.total).toBe(4);
    expect(entry!.section.lookup).not.toHaveProperty("all_of");
  });

  it("\"all the rows\" is answered too: the lookup read every row of the table", async () => {
    const marked = [41, 233, 512, 640, 871, 1010, 1266, 1499];
    events(1500, marked);
    const { decision, entry } = await pack("ops/events.csv で status が gateway-timeout の行をすべて挙げて (id と service)。ファイルは変更しないで。");
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.lookup!.rows.map((row) => row[0])).toEqual(marked.map(String));
  });

  it("a table the pack carries whole says which rows without repeating them", async () => {
    events(12, [7]);
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.rows).toHaveLength(12);
    expect(entry!.section.lookup).toMatchObject({ total: 1, row_numbers: [9], rows: [] });
  });

  it("too many matches to list: counts them, shows a few, and still searches", async () => {
    events(5000, Array.from({ length: 100 }, (_, i) => i * 37));
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).toMatchObject({ total: 100, scanned: 5000 });
    expect(entry!.section.lookup!.rows).toHaveLength(3);
    expect(entry!.section.rows).toHaveLength(10);
    expect(entry!.next).toBeDefined();
  });

  it("a marked value no cell contains is answered: every row was read", async () => {
    events(5000, [4980]);
    const { decision, entry } = await pack("ops/events.csv で status が missing-value の行を教えて。ファイルは変更しないで。");
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.lookup).toMatchObject({ terms: [], absent: ["missing-value"], total: 0, rows: [] });
    expect(entry!.section.rows).toHaveLength(1);
    expect(entry!.note).toContain("no cell contains missing-value; all 5000 data rows");
    expect(entry!.next).toBeUndefined();
    // The column the request names has few values, so other spellings are visibly absent too.
    expect((entry!.section.lookup as unknown as Json)["column_values"]).toEqual({ status: ["ok", "gateway-timeout"] });
    expect(entry!.note).toContain("column_values");
  });

  it("a value in two columns' rows that never meet is answered too", async () => {
    const lines = ["id,service,status"];
    for (let i = 0; i < 5000; i += 1) lines.push(`${i},${i % 2 === 0 ? "svc-a" : "svc-b"},${i % 2 === 0 ? "busy" : "ok"}`);
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
    const { decision, entry } = await pack("ops/events.csv で service が svc-a で status が ok の行を教えて。ファイルは変更しないで。");
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.lookup).toMatchObject({ total: 0, any_total: 5000 });
    expect(entry!.note).toContain("all 0 rows where service is svc-a and status is ok (5000 hold any of them)");
  });

  it("a near miss inside a cell is no absence, and still searches", async () => {
    events(5000, [4980]);
    const { decision, entry } = await pack("ops/events.csv で status が gateway-time の行を教えて。ファイルは変更しないで。");
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).toBeUndefined();
    expect(entry!.next).toBeDefined();
  });

  it("a plain word the table does not hold is not marked as a value, and still searches", async () => {
    events(5000, [4980]);
    const { decision, entry } = await pack("ops/events.csv で status が failed の行を教えて。ファイルは変更しないで。");
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).toBeUndefined();
  });

  it("a negated request keeps its rows but does not end there", async () => {
    events(5000, [4980]);
    const { decision, entry } = await pack("ops/events.csv で status が gateway-timeout ではない行を教えて");
    expect(decision.kind).not.toBe("act.answer");
    expect(entry!.section.lookup?.total).toBe(1);
  });

  it("a change request does not end in an answer", async () => {
    events(5000, [4980]);
    const { decision } = await pack("ops/events.csv の gateway-timeout を ok に直して。");
    expect(decision.kind).not.toBe("act.answer");
  });

  it("a named csv above the walk's 1 MB default is still read whole", async () => {
    events(30_000, [29_980]);
    expect(fs.statSync(path.join(workspace, "ops/events.csv")).size).toBeGreaterThan(1_000_000);
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("act.answer");
    expect(entry!.section.lookup).toMatchObject({ total: 1 });
    expect(entry!.note).toContain("all 30000 data rows");
  }, 60_000);

  it("a gitignored csv the request names is answered, as a named file always was", async () => {
    events(5000, [4980]);
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(path.join(workspace, ".gitignore"), "ops/\n");
    const { decision } = await pack(ONE);
    expect(decision.kind).toBe("act.answer");
  });

  it("a row wider than its header has a cell nothing searched, so there is no lookup to trust", async () => {
    events(5000, [4980]);
    const file = path.join(workspace, "ops/events.csv");
    fs.appendFileSync(file, "5000,svc-1,ok,plain detail,gateway-timeout\n");
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).toBeUndefined();
  });

  it("a table past the served columns has none either", async () => {
    const columns = Array.from({ length: 51 }, (_, i) => `c${i}`);
    const lines = [columns.join(",")];
    for (let i = 0; i < 2000; i += 1) lines.push(columns.map((_, c) => (c === 0 && i === 7 ? "gateway-timeout" : `v${i}_${c}`)).join(","));
    fs.writeFileSync(path.join(workspace, "ops/events.csv"), `${lines.join("\n")}\n`);
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).not.toBe("act.answer");
    expect(entry?.section.lookup).toBeUndefined();
  });

  it("a request that also names a source file is answered from that file, not closed by the table alone", async () => {
    events(5000, [4980]);
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src/report.ts"), "export function writeEvents(): void {}\n");
    const { decision, reply } = await pack("src/report.ts の writeEvents が ops/events.csv に gateway-timeout を書く処理を教えて");
    const evidence = reply["evidence"] as Array<{ path: string; body?: string }>;
    // Any answer here has to rest on the code's own body, the proof a code surface always needs.
    if (decision.kind === "act.answer") {
      expect(evidence.find((item) => item.path === "src/report.ts")?.body).toContain("writeEvents");
    }
    expect(evidence.some((item) => item.path === "src/report.ts")).toBe(true);
  });

  it("TL_CSV_LOOKUP=0 restores the sample and the search", async () => {
    process.env["TL_CSV_LOOKUP"] = "0";
    events(5000, [4980]);
    const { decision, entry } = await pack(ONE);
    expect(decision.kind).toBe("discover");
    expect(entry!.section.lookup).toBeUndefined();
    expect(entry!.section.rows).toHaveLength(10);
    expect(entry!.next).toBeDefined();
  });
});
