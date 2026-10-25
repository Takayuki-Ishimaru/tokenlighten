/**
 * structureMapAnswer.spec.ts — v0.16 decision window 6t-7, T03 (2026-10-20):
 * the STRUCTURE MAP selection rule, end to end (spawned dev server, `default`
 * config). A short, map-shaped question about a type too large for one
 * surface, naming a flow over its concerns, is answered in ONE act.answer
 * reply: the type's doc comment, its header, every member's signature and
 * every statement that calls a named concern, plus the enum types its header
 * is declared in — never the member bodies, which stay owed (`remaining`).
 * The controls keep the ordinary answer pack: no map wording, no flow facet,
 * or a type that fits one surface.
 *
 * Workspaces are generated (never a bench fixture): a Java class with a
 * transition table over an imported enum, and a TypeScript class of the same
 * shape asked in English. The verbatim T03 call is replay corpus group
 * v016sm; the pure rules are structureMap.spec.ts.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const REPLY_CAP_BYTES = 45_056;
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-smap-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const DESK = "src/main/java/demo/FulfillmentDesk.java";
const DESK_STATE = "src/main/java/demo/model/DeskState.java";

/** A Java class with a transition table over an imported enum, a main flow, a cancel path and `fillers` long arithmetic members. */
function writeDesk(ws: string, fillers: number): void {
  writeFile(ws, DESK_STATE, [
    "package demo.model;",
    "",
    "/** The states one fulfilment moves through. */",
    "public enum DeskState {",
    "    OPEN,",
    "    BILLED,",
    "    SHIPPED,",
    "    VOID;",
    "}",
    "",
  ].join("\n"));
  const filler = (i: number): string[] => [
    "",
    `    /** Measures step ${i}. */`,
    `    public long measure${i}(long seed) {`,
    ...Array.from({ length: 24 }, (_, j) => `        long v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5});`),
    `        return v0 + v23 + ${i};`,
    "    }",
  ];
  writeFile(ws, DESK, [
    "package demo;",
    "",
    "import demo.model.DeskState;",
    "import java.util.EnumMap;",
    "import java.util.EnumSet;",
    "import java.util.Map;",
    "import java.util.Set;",
    "",
    "/**",
    " * Runs one fulfilment from billing to delivery.",
    " */",
    "public class FulfillmentDesk {",
    "",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "    private final DeliveryService deliveryService;",
    "",
    "    private static final Map<DeskState, Set<DeskState>> MOVES = new EnumMap<>(DeskState.class);",
    "",
    "    static {",
    "        MOVES.put(DeskState.OPEN, EnumSet.of(DeskState.BILLED, DeskState.VOID));",
    "        MOVES.put(DeskState.BILLED, EnumSet.of(DeskState.SHIPPED, DeskState.VOID));",
    "        MOVES.put(DeskState.SHIPPED, EnumSet.noneOf(DeskState.class));",
    "        MOVES.put(DeskState.VOID, EnumSet.noneOf(DeskState.class));",
    "    }",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
    "        this.billingClient = billingClient;",
    "        this.stockLedger = stockLedger;",
    "        this.deliveryService = deliveryService;",
    "    }",
    "",
    "    /** Opens a ticket and drives it to delivery. */",
    "    public Ticket open(Order order) {",
    "        Ticket ticket = new Ticket(order);",
    "        stockLedger.reserve(order.sku(), order.quantity());",
    "        try {",
    "            billingClient.charge(order.account(), order.total());",
    "        } catch (BillingException ex) {",
    "            stockLedger.release(order.sku(), order.quantity());",
    "            throw ex;",
    "        }",
    "        deliveryService.dispatch(ticket);",
    "        return ticket;",
    "    }",
    ...Array.from({ length: fillers }, (_, i) => filler(i)).flat(),
    "",
    "    /** Cancels a ticket. */",
    "    public void cancel(Ticket ticket) {",
    "        billingClient.refund(ticket.charge());",
    "        stockLedger.release(ticket.sku(), ticket.quantity());",
    "        deliveryService.recall(ticket);",
    "    }",
    "}",
    "",
  ].join("\n"));
}

const MAP_QUERY = "FulfillmentDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内)。コード変更は不要。";
const PLAIN_QUERY = "FulfillmentDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか説明して。コード変更は不要。";
const NO_FLOW_QUERY = "FulfillmentDesk とは何をするクラスか短く説明して。コード変更は不要。";

interface Reply {
  readonly body: any;
  readonly bytes: number;
}

async function firstReply(ws: string, query: string): Promise<Reply> {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  const { body, textBytes } = await server.callTool("tl_read_file", { query, task: { epoch: "new", profile: "answer" }, cwd: ws });
  return { body, bytes: textBytes };
}

function rowsOf(reply: Reply, relPath: string): any[] {
  return ((reply.body?.evidence ?? []) as any[]).filter((row) => row?.path === relPath && typeof row?.body === "string");
}

function span(range: unknown): [number, number] {
  const match = /^(\d+)-(\d+)$/.exec(String(range));
  return match === null ? [0, -1] : [Number(match[1]), Number(match[2])];
}

/** A row's body with the answer-line gutter (`123|`) removed, when the gutter numbered it. */
function plainBody(row: any): string {
  return String(row.body).split("\n").map((line) => line.replace(/^\d+\|/u, "")).join("\n");
}

function rowWith(rows: readonly any[], text: string): any | undefined {
  return rows.find((row) => plainBody(row).includes(text));
}

function isStateTypeRow(row: any): boolean {
  return row?.why === "answer-structure-map-state-type";
}

describe("structure map — a short, map-shaped question about a large Java class", () => {
  it("answers in one act.answer reply: doc, header with the transition table, every signature, every billing/stock/delivery call in order, the enum — never a member body", async () => {
    const ws = makeWorkspace("java");
    writeDesk(ws, 22);
    const reply = await firstReply(ws, MAP_QUERY);
    const decision = reply.body?.decision ?? {};
    expect(decision.kind, JSON.stringify(reply.body).slice(0, 600)).toBe("act.answer");
    expect(decision.next).toBeUndefined();
    expect(reply.bytes).toBeLessThan(REPLY_CAP_BYTES);
    expect((decision.certificate?.obligations ?? []) as string[]).toContain("request-item:facet-1:flow");

    const rows = rowsOf(reply, DESK);
    expect(plainBody(rows[0])).toContain("Runs one fulfilment from billing to delivery.");
    expect(rowWith(rows, "MOVES.put(DeskState.BILLED, EnumSet.of(DeskState.SHIPPED, DeskState.VOID));")).toBeDefined();
    for (const signature of ["public Ticket open(Order order) {", "public void cancel(Ticket ticket) {", "public long measure0(long seed) {", "public long measure21(long seed) {"]) {
      expect(rowWith(rows, signature), signature).toBeDefined();
    }
    const lineOf = (text: string): number => {
      const row = rowWith(rows, text);
      expect(row, text).toBeDefined();
      const index = plainBody(row).split("\n").findIndex((line) => line.includes(text));
      return span(row.range)[0] + index;
    };
    const reserve = lineOf("stockLedger.reserve(order.sku(), order.quantity());");
    const charge = lineOf("billingClient.charge(order.account(), order.total());");
    const compensate = lineOf("stockLedger.release(order.sku(), order.quantity());");
    const dispatch = lineOf("deliveryService.dispatch(ticket);");
    expect(reserve < charge && charge < compensate && compensate < dispatch).toBe(true);
    expect(rowWith(rows, "deliveryService.recall(ticket);")).toBeDefined();
    expect(rows.some((row) => plainBody(row).includes("long v3 = seed")), "a filler member body was served").toBe(false);

    const classLines = fs.readFileSync(path.join(ws, DESK), "utf8").split("\n").length;
    const served = rows.reduce((total, row) => total + span(row.range)[1] - span(row.range)[0] + 1, 0);
    expect(served / classLines).toBeLessThan(0.3);
    const owed = ((rows[0]?.remaining ?? []) as string[]).map(span);
    expect(owed.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [start, end] = span(row.range);
      expect(owed.some(([from, to]) => from <= end && to >= start), `row ${row.range} overlaps an owed window`).toBe(false);
    }

    const state = rowsOf(reply, DESK_STATE);
    expect(state.some(isStateTypeRow)).toBe(true);
    expect(state.map(plainBody).join("\n")).toContain("BILLED");
  }, 90_000);
});

describe("structure map — controls keep the ordinary answer pack", () => {
  it("without map wording the same question is no structure map: a contiguous slice of the class, no enum row", async () => {
    const ws = makeWorkspace("plain");
    writeDesk(ws, 22);
    const reply = await firstReply(ws, PLAIN_QUERY);
    expect(rowsOf(reply, DESK_STATE).some(isStateTypeRow)).toBe(false);
    expect(rowsOf(reply, DESK).some((row) => plainBody(row).includes("long v3 = seed")), JSON.stringify(reply.body).slice(0, 600)).toBe(true);
  }, 90_000);

  it("with map wording but no flow facet it is no structure map either", async () => {
    const ws = makeWorkspace("noflow");
    writeDesk(ws, 22);
    const reply = await firstReply(ws, NO_FLOW_QUERY);
    expect(rowsOf(reply, DESK_STATE).some(isStateTypeRow)).toBe(false);
    expect(rowsOf(reply, DESK).some((row) => plainBody(row).includes("long v3 = seed")), JSON.stringify(reply.body).slice(0, 600)).toBe(true);
  }, 90_000);

  it("a class that fits one surface is served whole, not mapped", async () => {
    const ws = makeWorkspace("small");
    writeDesk(ws, 2);
    const reply = await firstReply(ws, MAP_QUERY);
    const rows = rowsOf(reply, DESK);
    expect(rowsOf(reply, DESK_STATE).some(isStateTypeRow)).toBe(false);
    expect(rows.some((row) => plainBody(row).includes("long v3 = seed")), JSON.stringify(reply.body).slice(0, 600)).toBe(true);
    expect(rows.every((row) => !Array.isArray(row.remaining) || (row.remaining as string[]).every((range) => span(range)[1] < 12))).toBe(true);
  }, 90_000);

  it("a map that fits the code-bearing tier but not a 14,336 B ceiling (VS Code's) is served without the ceiling and not under it", async () => {
    const ws = makeWorkspace("budget");
    writeDesk(ws, 90);
    const open = await firstReply(ws, MAP_QUERY);
    expect(open.body?.decision?.kind, JSON.stringify(open.body).slice(0, 600)).toBe("act.answer");
    expect(open.bytes).toBeGreaterThan(14_336);
    expect(rowsOf(open, DESK_STATE).some(isStateTypeRow)).toBe(true);

    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body, textBytes } = await server.callTool("tl_read_file", { query: MAP_QUERY, task: { epoch: "new", profile: "answer" }, budget: { bytes: 14_336 }, cwd: ws });
    const budgeted: Reply = { body, bytes: textBytes };
    expect(budgeted.bytes).toBeLessThanOrEqual(14_336);
    expect(rowsOf(budgeted, DESK_STATE).some(isStateTypeRow)).toBe(false);
    const signatureRows = (reply: Reply): number => rowsOf(reply, DESK).filter((row) => /^\s*public long measure\d+\(long seed\) \{\s*$/u.test(plainBody(row))).length;
    // v0.16.0 (structureMap.ts `memberMapWindows`: "Calls alone omit preceding
    // assignments ... cannot certify a flow explanation"): a member that calls a
    // named concern is mapped as the WHOLE member, signature to closing brace.
    // `open` (34-45) therefore touches the class header and the next member's
    // signature, and `mergeSpans` folds header + `open` + `measure0`'s signature
    // into ONE row; the other 89 signatures stay one-line rows. 89, not 90.
    expect(signatureRows(open)).toBe(89);
    expect(signatureRows(budgeted), JSON.stringify(budgeted.body).slice(0, 600)).toBe(0);
    const deskLines = fs.readFileSync(path.join(ws, DESK), "utf8").split("\n");
    const lineOfText = (text: string): number => deskLines.findIndex((line) => line.includes(text)) + 1;
    const openRows = rowsOf(open, DESK);
    const merged = openRows.find((row) => span(row.range)[0] === lineOfText("/**"));
    expect(merged, JSON.stringify(openRows.map((row) => row.range))).toBeDefined();
    expect(merged.range).toBe(`${lineOfText("/**")}-${lineOfText("public long measure0(long seed) {")}`);
    const mergedText = plainBody(merged);
    expect(mergedText).toContain("public Ticket open(Order order) {");
    expect(mergedText).toContain("billingClient.charge(order.account(), order.total());");
    expect(mergedText).toContain("public long measure0(long seed) {");
    // `cancel` calls the concerns too, so it is a whole-member row: signature to closing brace.
    const cancelStart = lineOfText("public void cancel(Ticket ticket) {");
    const cancel = openRows.find((row) => row.range === `${cancelStart}-${cancelStart + 4}`);
    expect(cancel, JSON.stringify(openRows.map((row) => row.range).slice(-3))).toBeDefined();
    expect(plainBody(cancel).trimEnd().split("\n")).toHaveLength(5);
    expect(plainBody(cancel)).toContain("deliveryService.recall(ticket);");
  }, 120_000);
});

describe("structure map — the same rule for a TypeScript class asked in English", () => {
  it("maps DispatchCenter: its doc, every signature, the billing/stock/delivery calls, and the imported enum", async () => {
    const ws = makeWorkspace("ts");
    writeFile(ws, "package.json", `${JSON.stringify({ name: "smap-ts", version: "1.0.0", type: "module" }, null, 2)}\n`);
    writeFile(ws, "src/dispatchState.ts", [
      "/** The states one dispatch moves through. */",
      "export enum DispatchState {",
      "  Open = \"open\",",
      "  Billed = \"billed\",",
      "  Shipped = \"shipped\",",
      "  Void = \"void\",",
      "}",
      "",
    ].join("\n"));
    const filler = (i: number): string[] => [
      "",
      `  /** Weighs step ${i}. */`,
      `  weigh${i}(seed: number): number {`,
      ...Array.from({ length: 24 }, (_, j) => `    const v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5});`),
      `    return v0 + v23 + ${i};`,
      "  }",
    ];
    writeFile(ws, "src/dispatchCenter.ts", [
      "import { DispatchState } from \"./dispatchState.js\";",
      "",
      "/** Drives one dispatch from billing to delivery. */",
      "export class DispatchCenter {",
      "  private readonly moves: Map<DispatchState, DispatchState[]> = new Map();",
      "",
      "  constructor(private readonly billing: Billing, private readonly stock: Stock, private readonly delivery: Delivery) {",
      "    this.moves.set(DispatchState.Open, [DispatchState.Billed, DispatchState.Void]);",
      "    this.moves.set(DispatchState.Billed, [DispatchState.Shipped, DispatchState.Void]);",
      "  }",
      "",
      "  /** Opens a dispatch. */",
      "  open(order: Order): Ticket {",
      "    const ticket = new Ticket(order);",
      "    this.stock.reserve(order.sku);",
      "    this.billing.charge(order.total);",
      "    this.delivery.ship(ticket);",
      "    return ticket;",
      "  }",
      ...Array.from({ length: 22 }, (_, i) => filler(i)).flat(),
      "",
      "  cancel(ticket: Ticket): void {",
      "    this.billing.refund(ticket.id);",
      "    this.stock.release(ticket.sku);",
      "  }",
      "}",
      "",
    ].join("\n"));
    const reply = await firstReply(ws, "Give me a short overview of DispatchCenter: its state transition table and how it sequences the billing / stock / delivery calls. No code changes.");
    expect(reply.body?.decision?.kind, JSON.stringify(reply.body).slice(0, 600)).toBe("act.answer");
    expect(reply.bytes).toBeLessThan(REPLY_CAP_BYTES);
    const rows = rowsOf(reply, "src/dispatchCenter.ts");
    expect(plainBody(rows[0])).toContain("Drives one dispatch from billing to delivery.");
    for (const text of ["open(order: Order): Ticket {", "cancel(ticket: Ticket): void {", "weigh21(seed: number): number {", "this.stock.reserve(order.sku);", "this.billing.charge(order.total);", "this.delivery.ship(ticket);", "this.billing.refund(ticket.id);"]) {
      expect(rowWith(rows, text), text).toBeDefined();
    }
    expect(rows.some((row) => plainBody(row).includes("const v3 = seed"))).toBe(false);
    expect(rowsOf(reply, "src/dispatchState.ts").some(isStateTypeRow)).toBe(true);
  }, 90_000);
});
