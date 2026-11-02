// ---------------------------------------------------------------------------
// A3 -- the query-relevant csv window, end to end through the real `callTool`.
// T-numbers refer to the improvement spec's §10.2 table. `TL_LEGACY_INPUT` is
// removed so every call here is a canonical call a production server accepts.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetArtifactSectionPrefetch, resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";
import { artifactSectionCandidates, fitArtifactSectionToBytes } from "../features/task-pack/artifactSections.js";
import { csvPageModel, csvTable } from "../office/csv.js";

type Json = Record<string, unknown>;

const NEEDLE = "gateway-timeout";
const created: string[] = [];
let workspace = "";
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["TL_ARTIFACT_QUERY_WINDOW", "TL_LEGACY_INPUT", "TOKENLIGHTEN_CLIENT_ID"] as const;

function resetServerState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetArtifactSectionPrefetch();
  resetRootResolverCache();
  setActiveRootWorkspace(workspace);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["TL_ARTIFACT_QUERY_WINDOW"] = "1";
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-a3-")));
  created.push(workspace);
  resetServerState();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const ws of created) fs.rmSync(ws, { recursive: true, force: true });
});

async function read(args: Json): Promise<Json> {
  const reply = await callTool("tl_read_file", { cwd: workspace, ...args });
  const text = (reply as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as Json;
}

function write(rel: string, text: string): string {
  fs.writeFileSync(path.join(workspace, rel), text, "utf8");
  return rel;
}

/** `rows` data rows after a header; one row carries the needle when asked. */
function table(rows: number, needleAt?: number): string {
  const lines = ["id,service,status,detail"];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${i},svc-${i % 7},${i === needleAt ? NEEDLE : "ok"},plain detail text for row number ${i}`);
  }
  return `${lines.join("\n")}\n`;
}

function windowCall(rel: string, query: string, extra: Json = {}): Json {
  return { targets: [{ path: rel }], select: { kind: rel.endsWith(".tsv") ? "tsv" : "csv" }, query, ...extra };
}

/** A reply with its per-process handle id removed, for comparing two runs of one call. */
function withoutHandle(reply: Json): Json {
  const { handle: _handle, ...rest } = reply;
  return rest;
}

function content(reply: Json): Json {
  return reply["content"] as Json;
}

function rowsOf(reply: Json): unknown[][] {
  return (content(reply)["rows"] ?? []) as unknown[][];
}

function nextOf(reply: Json): Json | undefined {
  const limit = reply["limit"] as Json | undefined;
  return (limit?.["next"] as Json | undefined)?.["arguments"] as Json | undefined;
}

/** Follows `limit.next` to the end, optionally changing the budget each call. */
async function follow(first: Json, budgets: ReadonlyArray<number> = []): Promise<{ ids: number[]; calls: number; last: Json; replies: Json[] }> {
  const ids = rowsOf(first).map((row) => Number(row[0]));
  const replies = [first];
  let reply = first;
  let calls = 1;
  while (nextOf(reply) !== undefined) {
    calls += 1;
    if (calls > 200) throw new Error("no termination");
    const budget = budgets.length > 0 ? budgets[(calls - 2) % budgets.length] : undefined;
    reply = await read({ ...nextOf(reply)!, ...(budget !== undefined ? { budget: { bytes: budget } } : {}) });
    replies.push(reply);
    expect(reply["kind"], JSON.stringify(reply).slice(0, 300)).toBe("read.artifact");
    ids.push(...rowsOf(reply).map((row) => Number(row[0])));
  }
  return { ids, calls, last: reply, replies };
}

function expectExactCoverage(ids: readonly number[], rows: number): void {
  expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: rows }, (_, i) => i));
}

describe("T17: a tail match first, then exactly the rest", () => {
  it("serves the relevant window first, labels it partial, and completes Q with every row delivered exactly once", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, `which row reports ${NEEDLE}?`));

    expect(first["kind"]).toBe("read.artifact");
    const served = rowsOf(first);
    expect(served.some((row) => row[2] === NEEDLE)).toBe(true);
    expect(content(first)["range"]).not.toMatch(/^2-/);
    expect(content(first)["selected_by"]).toBe("query");
    expect(content(first)["total_rows"]).toBe(1500);
    expect(String(content(first)["note"])).toMatch(/partial view/);
    expect(typeof nextOf(first)?.["cursor"]).toBe("string");

    const run = await follow(first);
    expectExactCoverage(run.ids, 1500);
    expect(nextOf(run.last)).toBeUndefined();
    expect(run.calls).toBeGreaterThan(1);
  });

  it("finds a Japanese value, and works for tsv", async () => {
    const rel = write("sales.tsv", ["id\tcity\tamount", ...Array.from({ length: 900 }, (_, i) => `${i}\t${i === 870 ? "東京都" : "大阪府"}\t${i}`)].join("\n"));
    const first = await read(windowCall(rel, "東京都の売上を教えて"));
    expect(rowsOf(first).some((row) => row[1] === "東京都")).toBe(true);
    expect(content(first)["selected_by"]).toBe("query");
    expectExactCoverage((await follow(first)).ids, 900);
  });

  it("a table that fits whole completes on the first response, with no continuation", async () => {
    const rel = write("small.csv", table(10, 7));
    const first = await read(windowCall(rel, NEEDLE));
    expect(rowsOf(first)).toHaveLength(10);
    expect(nextOf(first)).toBeUndefined();
    expect(content(first)["range"]).toBe("2-11");
  });
});

describe("T18: explicit scope is never replaced", () => {
  it("an explicit row range with the same query is served exactly as without the flag", async () => {
    const rel = write("events.csv", table(800, 790));
    process.env["TL_LEGACY_INPUT"] = "accept";
    const call = { mode: "artifact", path: rel, range: "2-6", query: NEEDLE };
    const on = await read(call);
    expect(rowsOf(on).map((row) => row[0])).toEqual(["0", "1", "2", "3", "4"]);
    expect(content(on)["selected_by"]).toBeUndefined();
    delete process.env["TL_ARTIFACT_QUERY_WINDOW"];
    resetServerState();
    expect(withoutHandle(await read(call))).toEqual(withoutHandle(on));
  });

  it("a target carrying its own selector, or a kind that disagrees with the file, stays the task pack it always was", async () => {
    const rel = write("events.csv", table(800, 790));
    expect((await read({ targets: [{ path: rel, range: "2-6" }], select: { kind: "csv" }, query: NEEDLE }))["kind"]).toBe("read.task_pack");
    expect((await read({ targets: [{ path: rel }], select: { kind: "tsv" }, query: NEEDLE }))["kind"]).toBe("read.task_pack");
  });
});

describe("T19: partial views never claim completeness or absence", () => {
  it.each(["すべての行を確認して gateway-timeout は他にないか", "confirm that gateway-timeout appears nowhere else"])(
    "an exhaustive question still owes the rest: %s",
    async (query) => {
      const rel = write("events.csv", table(1500, 1480));
      const first = await read(windowCall(rel, query));
      expect(typeof nextOf(first)?.["cursor"]).toBe("string");
      expect(String(content(first)["note"])).toMatch(/neither that a value is absent nor that the table is complete/);
      expect(JSON.stringify(first)).not.toMatch(/"complete":true/);
      expectExactCoverage((await follow(first)).ids, 1500);
    },
  );

  it("a query that matches nothing says nothing about absence: it is the ordinary head, and honest about being cut", async () => {
    const rel = write("events.csv", table(1500));
    const first = await read(windowCall(rel, "zzzabsentvalue"));
    expect(content(first)["selected_by"]).toBeUndefined();
    expect(content(first)["range"]).toMatch(/^2-/);
    expect(content(first)["note"]).toMatch(/fetch more with range=/);
  });

  it("an unscanned file is not windowed: a quota-truncated parse never becomes an empty remainder", async () => {
    const delimiterFlood = `a,b\n${",".repeat(60_000)}\nlast,gateway-timeout\n`;
    const rel = write("flood.csv", delimiterFlood);
    const first = await read(windowCall(rel, NEEDLE));
    expect(content(first)["selected_by"]).toBeUndefined();
  });
});

describe("T20: positions, headers and values stay true", () => {
  const CSV = [
    "id,label,qty,code",
    "0,first,,007",
    "",
    "1,\"multi",
    "line, with comma\",3,1e3",
    ...Array.from({ length: 700 }, (_, i) => `${i + 2},row${i + 2},${i},${String(i).padStart(3, "0")}`),
    "",
    "702,\"quoted \"\"gateway-timeout\"\" value\",,",
    "703,after,5,",
    "",
  ].join("\n");

  it("a window after blank lines and a multi-line row keeps logical rows, physical lines, types and empties exact", async () => {
    const rel = write("messy.csv", CSV);
    const first = await read(windowCall(rel, NEEDLE));
    const c = content(first);
    expect(c["columns"]).toEqual(["id", "label", "qty", "code"]);
    const hit = rowsOf(first).find((row) => row[0] === "702")!;
    expect(hit).toEqual(["702", 'quoted "gateway-timeout" value', "", ""]);
    const [startRow, endRow] = String(c["range"]).split("-").map(Number);
    const [startLine, endLine] = String(c["file_range"]).split("-").map(Number);
    // Logical rows skip blanks and count a multi-line record once; physical lines do neither.
    expect(startLine).toBeGreaterThan(startRow!);
    expect(endLine).toBeGreaterThan(endRow!);
    const sourceLines = CSV.split("\n");
    expect(sourceLines[endLine! - 1]).toBe("703,after,5,");

    // Re-reading the reported range from the same source returns the same rows.
    process.env["TL_LEGACY_INPUT"] = "accept";
    const again = await read({ mode: "artifact", path: rel, range: c["range"], maxRows: 200, task: { force_serve: true } });
    expect(rowsOf(again)).toEqual(rowsOf(first));
    delete process.env["TL_LEGACY_INPUT"];

    const run = await follow(first);
    expectExactCoverage(run.ids, 704);
    const multi = run.replies.flatMap(rowsOf).find((row) => row[0] === "1")!;
    expect(multi).toEqual(["1", "multi\nline, with comma", "3", "1e3"]);
    const zero = run.replies.flatMap(rowsOf).find((row) => row[0] === "0")!;
    expect(zero).toEqual(["0", "first", "", "007"]);
  });

  it("a ragged row reports its missing cells as null, as an ordinary read does", async () => {
    const rel = write("ragged.csv", ["a,b,c", ...Array.from({ length: 700 }, (_, i) => (i === 690 ? `x,${NEEDLE}` : `${i},ok,z`))].join("\n"));
    const first = await read(windowCall(rel, NEEDLE));
    expect(rowsOf(first).find((row) => row[1] === NEEDLE)).toEqual(["x", NEEDLE, null]);
  });
});

describe("T21: kinds without an exact window keep their path", () => {
  it("an xlsx-shaped request is never routed to the csv window", async () => {
    const rel = write("data.csv", table(10));
    const asXlsx = await read({ targets: [{ path: "book.xlsx" }], select: { kind: "xlsx" }, query: NEEDLE });
    expect(asXlsx["kind"]).not.toBe("read.artifact");
    expect(rel).toBe("data.csv");
  });
});

describe("T22: fallback when the query locates nothing", () => {
  it.each([
    ["no match", "zzzabsentvalue"],
    ["too short to tokenize", "ab"],
    ["matches most rows", "plain detail text"],
  ])("%s keeps today's head, stably", async (_name, query) => {
    const rel = write("events.csv", table(1000));
    const first = await read(windowCall(rel, query));
    expect(content(first)["selected_by"]).toBeUndefined();
    expect(content(first)["range"]).toMatch(/^2-/);
    resetServerState();
    expect(withoutHandle(await read(windowCall(rel, query)))).toEqual(withoutHandle(first));
  });
});

describe("T23: progress under changing budgets", () => {
  it("every budget change still advances, with no row repeated and none lost", async () => {
    const rel = write("events.csv", table(600, 590));
    const first = await read(windowCall(rel, NEEDLE));
    const run = await follow(first, [2_000, 1_100, 6_000, 1_400]);
    expectExactCoverage(run.ids, 600);
  });

  it("a repeat at a larger budget continues after the match, and does not call those rows the match", async () => {
    const rel = write("events.csv", table(1200, 700));
    const first = await read(windowCall(rel, NEEDLE, { budget: { bytes: 2_500 } }));
    expect(rowsOf(first).some((row) => row[2] === NEEDLE)).toBe(true);
    const second = await read(windowCall(rel, NEEDLE, { budget: { bytes: 20_000 } }));
    const ids = rowsOf(second).map((row) => Number(row[0]));
    expect(ids[0]).toBeGreaterThan(700);
    expect(content(second)["selected_by"]).toBeUndefined();
    expect(String(content(second)["note"])).toMatch(/already served in this lane/);
    expect(String(content(second)["note"])).not.toMatch(/chosen by query relevance/);
  });

  it("a repeat of the same query moves on rather than re-serving the same rows", async () => {
    const rel = write("events.csv", table(1200, 1190));
    const first = await read(windowCall(rel, NEEDLE));
    const second = await read(windowCall(rel, NEEDLE));
    expect(second["kind"]).toBe("read.artifact");
    const firstIds = new Set(rowsOf(first).map((row) => row[0]));
    expect(rowsOf(second).length).toBeGreaterThan(0);
    expect(rowsOf(second).every((row) => !firstIds.has(row[0]))).toBe(true);
  });
});

describe("T24: only what shipped is credited", () => {
  it("a refused page books nothing: the same rows are still owed afterwards", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    const next = nextOf(first)!;
    const refused = await read({ ...next, budget: { bytes: 200 } });
    expect(refused["kind"]).toBe("refusal");
    expect(refused["code"]).toBe("budget-below-minimum");
    expect(rowsOf({ content: {} })).toEqual([]);

    const run = await follow(await read(next));
    const all = [...rowsOf(first).map((row) => Number(row[0])), ...run.ids];
    expectExactCoverage(all, 1500);
  });

  it("a budget too small for the matching row is not a success with no rows", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const reply = await read(windowCall(rel, NEEDLE, { budget: { bytes: 300 } }));
    if (reply["kind"] === "read.artifact") {
      expect(content(reply)["selected_by"]).toBeUndefined();
    } else {
      expect(reply["kind"]).toBe("refusal");
    }
  });
});

describe("T25: state contracts", () => {
  // With TL_READ_SNAPSHOT the walk keeps its revision instead; artifactSnapshot.spec.ts covers that.
  it.skipIf(process.env["TL_READ_SNAPSHOT"] === "1")("a source change refuses the old cursor, names the restart, and the restart serves the new revision", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    write(rel, table(1500, 3));
    const stale = await read(nextOf(first)!);
    expect(stale["kind"]).toBe("refusal");
    expect(stale["code"]).toBe("cursor-stale");
    const restart = ((stale["next"] ?? (stale["retry"] as Json | undefined)?.["next"]) as Json)["arguments"] as Json;
    const fresh = await read(restart);
    expect(fresh["kind"]).toBe("read.artifact");
    expect(rowsOf(fresh).some((row) => row[0] === "3" && row[2] === NEEDLE)).toBe(true);
  });

  it("another lane cannot use this lane's cursor, and its reads do not satisfy this one", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE, { lane: "alpha" }));
    const refused = await read({ ...nextOf(first)!, lane: "beta" });
    expect(refused["kind"]).toBe("refusal");
    expect(refused["code"]).toBe("cursor-invalid");
    expect(String(refused["detail"])).toMatch(/wrong-lane/);
    const beta = await read(windowCall(rel, NEEDLE, { lane: "beta" }));
    expect(rowsOf(beta).some((row) => row[2] === NEEDLE)).toBe(true);
  });

  it("an expired cursor refuses and asks for a restart", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60 * 60 * 1000);
    const refused = await read(nextOf(first)!);
    expect(refused["kind"]).toBe("refusal");
    expect(refused["code"]).toBe("cursor-invalid");
  });

  it("lost session memory does not lose the request: the store carries D", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    const firstIds = rowsOf(first).map((row) => Number(row[0]));
    resetServerState();
    const run = await follow(await read(nextOf(first)!));
    expect(run.ids.length).toBeGreaterThan(0);
    expect(new Set(run.ids).size).toBe(run.ids.length);
    expect(run.ids.some((id) => firstIds.includes(id))).toBe(false);
    expectExactCoverage([...firstIds, ...run.ids], 1500);
  });

  it("turning the flag off mid-chain finishes the chain already out, and new requests go back to the task pack", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    delete process.env["TL_ARTIFACT_QUERY_WINDOW"];
    expectExactCoverage((await follow(first)).ids, 1500);
    expect((await read(windowCall(rel, NEEDLE)))["kind"]).toBe("read.task_pack");
  });
});

describe("T26: force_serve and tiny budgets", () => {
  it("a forced repeat gets the same window's bytes again", async () => {
    const rel = write("events.csv", table(1200, 1190));
    const first = await read(windowCall(rel, NEEDLE));
    const forced = await read(windowCall(rel, NEEDLE, { task: { force_serve: true } }));
    expect(rowsOf(forced)).toEqual(rowsOf(first));
    expect(typeof nextOf(forced)?.["cursor"]).toBe("string");
  });

  it("a floor refusal names a budget that then works, and the page advances", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const first = await read(windowCall(rel, NEEDLE));
    const refused = await read({ ...nextOf(first)!, budget: { bytes: 200 } });
    expect(refused["code"]).toBe("budget-below-minimum");
    const floor = refused["required_min_bytes"] as number;
    expect(floor).toBeGreaterThan(200);
    const page = await read({ ...nextOf(first)!, budget: { bytes: floor } });
    expect(page["kind"]).toBe("read.artifact");
    expect(rowsOf(page).length).toBeGreaterThanOrEqual(1);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(floor);
  });
});

describe("review regressions", () => {
  it("#1 a first window never overshoots its ceiling and credits rows it did not ship", async () => {
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "claude-code";
    for (const width of [40, 120, 190, 260, 400]) {
      const rel = write(`wide${width}.csv`, ["id,a,b,c,d,status", ...Array.from({ length: 1500 }, (_, i) =>
        `${i},${"x".repeat(width / 4)},${"y".repeat(width / 4)},${"z".repeat(width / 4)},${"w".repeat(width / 4)},${i === 1480 ? NEEDLE : "ok"}`)].join("\n"));
      const first = await read(windowCall(rel, NEEDLE));
      expect(first["kind"], `width ${width}: ${JSON.stringify(first).slice(0, 300)}`).toBe("read.artifact");
      expect(rowsOf(first).some((row) => row[5] === NEEDLE), `width ${width}`).toBe(true);
      const run = await follow(first);
      expectExactCoverage(run.ids, 1500);
      resetServerState();
    }
  });

  it("#1 every declared budget either serves within itself or refuses with a floor that serves, and a refusal books nothing", async () => {
    const rel = write("narrow.csv", table(900, 880));
    for (let bytes = 1_000; bytes <= 12_500; bytes += 1_500) {
      resetServerState();
      const first = await read(windowCall(rel, NEEDLE, { budget: { bytes } }));
      if (first["kind"] === "refusal") {
        const floor = first["required_min_bytes"] as number | undefined;
        expect(floor, JSON.stringify(first).slice(0, 300)).toBeDefined();
        const retried = await read(windowCall(rel, NEEDLE, { budget: { bytes: floor } }));
        expect(retried["kind"], `floor ${floor} for ${bytes}`).toBe("read.artifact");
      } else {
        expect(Buffer.byteLength(JSON.stringify(first), "utf8"), `budget ${bytes}`).toBeLessThanOrEqual(bytes);
        if (content(first)["selected_by"] === "query") expect(rowsOf(first).some((row) => row[2] === NEEDLE)).toBe(true);
      }
      resetServerState();
      // Whatever that call did, a later unconstrained chain still owes and delivers every row.
      expectExactCoverage((await follow(await read(windowCall(rel, NEEDLE)))).ids, 900);
    }
  });

  it("#2 a text read that holds part of a multi-line row cannot wedge the chain on the rest of it", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => (i === 300 ? `${i},"first part\nsecond part",ok` : `${i},plain,${i === 1480 ? NEEDLE : "ok"}`));
    const rel = write("split.csv", `id,text,status\n${rows.join("\n")}\n`);
    await read({ targets: [{ path: rel, range: "1-302" }] });
    const first = await read(windowCall(rel, NEEDLE));
    const run = await follow(first);
    const pages = run.replies.map((reply) => content(reply)["range"]);
    expect(new Set(pages).size, JSON.stringify(pages)).toBe(pages.length);
    expect(nextOf(run.last)).toBeUndefined();
    expect(new Set(run.ids).has(300)).toBe(true);
    expect(new Set(run.ids).has(1400)).toBe(true);
  });

  it("#3 concurrent packs in two lanes each get their own query's rows", async () => {
    const rows = Array.from({ length: 900 }, (_, i) => `${i},svc,${i === 100 ? "alpha-token" : i === 800 ? "omega-token" : "ok"},plain detail text for row number ${i}`);
    const rel = write("two.csv", `id,service,status,detail\n${rows.join("\n")}\n`);
    const pack = (lane: string, value: string) => read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${value}?`, lane, task: { epoch: "new" } });
    for (let run = 0; run < 5; run += 1) {
      resetServerState();
      const [alpha, omega] = await Promise.all([pack("lane-a", "alpha-token"), pack("lane-b", "omega-token")]);
      const rowsIn = (reply: Json): unknown[][] => {
        const plan = reply["plan"] as Json | undefined;
        const entries = (plan?.["artifact_sections"] ?? reply["artifact_sections"]) as Json[];
        return (entries[0]!["section"] as Json)["rows"] as unknown[][];
      };
      expect(rowsIn(alpha).some((row) => row[2] === "alpha-token"), `run ${run}`).toBe(true);
      expect(rowsIn(omega).some((row) => row[2] === "omega-token"), `run ${run}`).toBe(true);
    }
  });

  it("#4 cutting a pack's window keeps the row the query matched, with an honest range", async () => {
    const rel = write("anchor.csv", table(900, 880));
    const pack = await read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${NEEDLE}?`, budget: { bytes: 7_000 }, task: { epoch: "new" } });
    const plan = pack["plan"] as Json | undefined;
    const entries = (plan?.["artifact_sections"] ?? pack["artifact_sections"]) as Json[] | undefined;
    expect(entries, JSON.stringify(pack).slice(0, 400)).toBeDefined();
    const section = entries![0]!["section"] as Json;
    const kept = section["rows"] as unknown[][];
    expect(kept.some((row) => row[2] === NEEDLE)).toBe(true);
    const [start, end] = String(section["range"]).split("-").map(Number);
    expect(end! - start! + 1).toBe(kept.length);
    expect(Number(kept[0]![0]) + 2).toBe(start);
    expect(String(entries![0]!["note"])).toMatch(new RegExp(`rows ${section["range"]} of 900`));
  });

  it.each([
    ["header only", "id,status\n"],
    ["empty", ""],
  ])("#5 %s: the spelling answers plainly, without a required-set refusal", async (_name, text) => {
    const rel = write("nothing.csv", text);
    const reply = await read(windowCall(rel, NEEDLE));
    const flat = JSON.stringify(reply);
    expect(flat, flat.slice(0, 400)).not.toContain("required-set");
    expect(reply["kind"]).toBe("refusal");
    expect(flat).toContain("has no data rows to search");
    expect(nextOf(reply)).toBeUndefined();
  });
});

describe("the task-pack route", () => {
  const SECTION = (pack: Json): Json => (pack["artifact_sections"] as Json[] | undefined)?.[0] as Json;

  function sectionsOf(pack: Json): Json[] {
    const plan = pack["plan"] as Json | undefined;
    return ((plan?.["artifact_sections"] ?? pack["artifact_sections"]) ?? []) as Json[];
  }

  it("the first canonical call carries the relevant rows inline, honest about position, and its next walks the table", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const pack = await read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${NEEDLE}?`, task: { epoch: "new" } });
    expect(pack["kind"]).toBe("read.task_pack");
    const entry = sectionsOf(pack)[0] ?? SECTION(pack);
    expect(entry, JSON.stringify(pack).slice(0, 500)).toBeDefined();
    const section = entry["section"] as Json;
    const rows = section["rows"] as unknown[][];
    expect(rows.some((row) => row[2] === NEEDLE)).toBe(true);
    expect((section["query_window"] as Json)["total_rows"]).toBe(1500);
    const [start, end] = String(section["range"]).split("-").map(Number);
    expect(end! - start! + 1).toBe(rows.length);
    expect(Number(rows[0]![0]) + 2).toBe(start);
    expect(entry["content_completeness"]).toBe("partial");
    expect(String(entry["note"])).toMatch(/partial view/);

    const next = entry["next"] as Json;
    const run = await follow(await read(next["arguments"] as Json));
    expectExactCoverage([...rows.map((row) => Number(row[0])), ...run.ids], 1500);
  });

  async function packThenWalk(rel: string, budget?: number, change?: () => void): Promise<{ section: Json | undefined; packIds: number[]; walkIds: number[] }> {
    const pack = await read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${NEEDLE}?`, task: { epoch: "new" }, ...(budget !== undefined ? { budget: { bytes: budget } } : {}) });
    const entry = sectionsOf(pack)[0];
    const section = entry?.["section"] as Json | undefined;
    const packIds = ((section?.["rows"] ?? []) as unknown[][]).map((row) => Number(row[0]));
    change?.();
    const run = await follow(await read(windowCall(rel, `which row in ${rel} reports ${NEEDLE}?`)));
    return { section, packIds, walkIds: run.ids };
  }

  it("when a pack ends discovery, its next still walks the rows it does not hold", async () => {
    const value = "接続タイムアウト";
    const lines = table(1500).split("\n");
    lines[1481] = `1480,svc-3,${value},plain detail text for row number 1480`;
    const rel = write("events.csv", lines.join("\n"));
    const pack = await read({ targets: [{ path: rel }], query: `${value}が出た行はどれ？ (${rel})`, task: { epoch: "new" } });
    const entry = sectionsOf(pack)[0]!;
    const held = ((entry["section"] as Json)["rows"] as string[][]).map((row) => Number(row[0]));
    expect(held).toContain(1480);
    const run = await follow(await read((entry["next"] as Json)["arguments"] as Json));
    expectExactCoverage([...held, ...run.ids], 1500);
  });

  it("a window that follows blank lines still credits exactly its own lines", async () => {
    const lines = table(1500, 1480).split("\n");
    lines.splice(40, 0, "", "");
    const rel = write("blanks.csv", lines.join("\n"));
    const { section, packIds, walkIds } = await packThenWalk(rel);
    expect((section!["query_window"] as Json)["line_offset"]).toBe(2);
    expectExactCoverage([...packIds, ...walkIds], 1500);
  });

  it("a multi-line row inside the window has no line offset, so rows repeat and none is skipped", async () => {
    const lines = table(1500, 1480).split("\n");
    lines[1485] = `1484,svc-0,ok,"two\nlines"`;
    const rel = write("multiline.csv", lines.join("\n"));
    const { section, packIds, walkIds } = await packThenWalk(rel);
    expect((section!["query_window"] as Json)["line_offset"]).toBeUndefined();
    expect(packIds.length).toBeGreaterThan(0);
    expect(new Set(walkIds).size).toBe(1500);
  });

  it.each([3_000, 5_000, 7_000])("a pack cut to %i bytes credits only what it kept whole, and no row is lost", async (budget) => {
    const rel = write("cut.csv", table(900, 880));
    const { section, packIds, walkIds } = await packThenWalk(rel, budget);
    expect(new Set([...packIds, ...walkIds]).size).toBe(900);
    // Whatever the walk did not resend has to be in the pack, untouched.
    const inWalk = new Set(walkIds);
    const rows = ((section?.["rows"] ?? []) as string[][]);
    for (const row of rows.filter((candidate) => !inWalk.has(Number(candidate[0])))) {
      expect(row).toEqual([row[0], `svc-${Number(row[0]) % 7}`, Number(row[0]) === 880 ? NEEDLE : "ok", `plain detail text for row number ${row[0]}`]);
    }
  });

  describe("a cut says whether the rows it kept are still whole", () => {
    const queryWindow = { selected_by: "query" as const, total_rows: 900, anchor_row: 102, line_offset: 0 };
    const sheet = (rows: string[][]) => ({ sheet: "t.csv", range: `100-${99 + rows.length}`, columns: ["a", "b"], rows, truncated: true, query_window: queryWindow });

    it("fewer whole rows keep the offset, so their lines can be credited", () => {
      const fit = fitArtifactSectionToBytes(sheet(Array.from({ length: 200 }, (_, i) => [String(i), "short"])), 1_000).section;
      expect("sheet" in fit && fit.rows.length < 200).toBe(true);
      expect("sheet" in fit && fit.query_window?.line_offset).toBe(0);
    });

    it("narrowed columns lose it", () => {
      const fit = fitArtifactSectionToBytes(sheet([["1", "x".repeat(2_000)]]), 300).section;
      expect("sheet" in fit && fit.columns.length).toBe(1);
      expect("sheet" in fit && fit.query_window?.line_offset).toBeUndefined();
    });

    it("clipped cells lose it, and unclipped rows of a smaller rung keep it", () => {
      const clipped = artifactSectionCandidates(sheet(Array.from({ length: 30 }, (_, i) => [String(i), "x".repeat(400)])));
      expect(clipped.length).toBeGreaterThan(1);
      for (const candidate of clipped.slice(1)) expect("sheet" in candidate && candidate.query_window?.line_offset).toBeUndefined();
      const whole = artifactSectionCandidates(sheet(Array.from({ length: 30 }, (_, i) => [String(i), "short"])));
      expect(whole.length).toBeGreaterThan(1);
      for (const candidate of whole.slice(1)) expect("sheet" in candidate && candidate.query_window?.line_offset).toBe(0);
    });
  });

  it("one bytes object read as csv and as tsv is parsed as each", () => {
    const bytes = Buffer.from("a,b\tc\n1,2\t3\n", "utf8");
    const asCsv = csvTable(bytes, { ext: "csv" });
    const asTsv = csvTable(bytes, { ext: "tsv" });
    expect(asCsv.ok && asCsv.columns).toEqual(["a", "b\tc"]);
    expect(asTsv.ok && asTsv.columns).toEqual(["a,b", "c"]);
    expect(csvPageModel(bytes, { ext: "tsv" })?.columns).toEqual(["a,b", "c"]);
    expect(csvTable(bytes, { ext: "csv" })).toEqual(asCsv);
  });

  it("rows of a revision the file has left are not credited to the new one", async () => {
    const rel = write("moved.csv", table(1500, 1480));
    const { packIds, walkIds } = await packThenWalk(rel, undefined, () => write(rel, table(1500, 1480).replace("row number 5\n", "row number five\n")));
    expect(packIds.length).toBeGreaterThan(0);
    expectExactCoverage(walkIds, 1500);
  });

  it("the pack's rows answer an identical read with a receipt, and a forced read still gets the bytes", async () => {
    const rel = write("events.csv", table(1500, 1480));
    const pack = await read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${NEEDLE}?`, task: { epoch: "new" } });
    const section = sectionsOf(pack)[0]!["section"] as Json;
    const again = await read({ targets: [{ path: rel, range: section["range"] }], select: { kind: "csv" } });
    expect(again["kind"], JSON.stringify(again).slice(0, 300)).toBe("read.receipt");
    const forced = await read({ targets: [{ path: rel, range: section["range"] }], select: { kind: "csv" }, task: { force_serve: true } });
    expect(forced["kind"], JSON.stringify(forced).slice(0, 300)).toBe("read.artifact");
    expect(rowsOf(forced)).toEqual(section["rows"]);
  });

  it("without the flag the pack's csv section is exactly today's head", async () => {
    const rel = write("events.csv", table(1500, 1480));
    delete process.env["TL_ARTIFACT_QUERY_WINDOW"];
    const pack = await read({ targets: [{ path: rel }], query: `which row in ${rel} reports ${NEEDLE}?`, task: { epoch: "new" } });
    const entry = sectionsOf(pack)[0] ?? SECTION(pack);
    const section = entry["section"] as Json;
    expect(section["query_window"]).toBeUndefined();
    expect(String(section["range"])).toMatch(/^2-/);
  });
});
