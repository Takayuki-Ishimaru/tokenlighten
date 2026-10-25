/**
 * structureMapEntryPhrasing.spec.ts — the structure map's ENTRY wording, end to
 * end (spawned dev server, `default` config; 2026-10-24).
 *
 * The map is served to a request that asks for a short answer AND names a flow.
 * The generality audit (fable-analysis-r16/generality-audit.md §3.3.3) found the
 * entry shaped by one benchmark request: of 16 natural paraphrases, 1 EN and no JA
 * paraphrase passed both detectors. structureMapEntry.heldout{1,2}.spec.ts score
 * the two detectors on hundreds of requests; THIS spec pins the call shape end
 * to end on a generated TypeScript class: paraphrases the old wording missed are
 * now answered in ONE act.answer reply carrying the map (the doc comment, the
 * header, every signature, the calls of the named concerns, the enum the header
 * is declared in — never a filler member body), and requests whose "short" /
 * "quick" / "order" are words of another sense, or that ask for MORE detail, keep
 * the ordinary answer pack. The wording itself is in structureMap.ts
 * (`asksForStructureMap`) and requestFacets.ts (`isCallOrderClause`).
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

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const CLASS_PATH = "src/dispatchCenter.ts";
const STATE_PATH = "src/dispatchState.ts";

/** A TypeScript class too large for one surface: a transition table over an imported enum, an `open` flow that calls billing / stock / delivery in order, a cancel path and 22 long filler members. */
function makeWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-smap-entry-"));
  tmpDirs.push(ws);
  writeFile(ws, "package.json", `${JSON.stringify({ name: "smap-entry", version: "1.0.0", type: "module" }, null, 2)}\n`);
  writeFile(ws, STATE_PATH, [
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
  writeFile(ws, CLASS_PATH, [
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
  return ws;
}

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

function plainBody(row: any): string {
  return String(row.body).split("\n").map((line) => line.replace(/^\d+\|/u, "")).join("\n");
}

function isStateTypeRow(row: any): boolean {
  return row?.why === "answer-structure-map-state-type";
}

const CONCERNS = "billing / stock / delivery";

/** Paraphrases the pre-2026-10-24 wording missed: the order of the calls and the brevity are each written in a way no detector knew. */
const MAPPED = [
  `Give me a quick overview of DispatchCenter and the order it calls ${CONCERNS} in.`,
  `TL;DR of DispatchCenter: in which order does it call ${CONCERNS}?`,
  `Short explanation of DispatchCenter please, and in which order it calls ${CONCERNS}. No code changes.`,
  `Describe DispatchCenter at a glance; which of ${CONCERNS} runs first?`,
  `DispatchCenter の概要と、${CONCERNS} を呼ぶ順番を教えて。コード変更は不要。`,
  `DispatchCenter をざっと説明して。${CONCERNS} はどの順で呼ばれる？ コード変更は不要。`,
  `DispatchCenter について簡単に。${CONCERNS} の呼び出し順序も。コード変更は不要。`,
  `Briefly: what is DispatchCenter for, and in which order does it invoke ${CONCERNS}? No code changes.`,
  `Quick overview of DispatchCenter, and the precise order it calls ${CONCERNS}. No code changes.`,
] as const;

describe("structure map entry — paraphrases of a map-shaped order-of-calls question", () => {
  it.each(MAPPED)("answers in one act.answer reply with the map: %s", async (query) => {
    const ws = makeWorkspace();
    const reply = await firstReply(ws, query);
    const decision = reply.body?.decision ?? {};
    expect(decision.kind, JSON.stringify(reply.body).slice(0, 600)).toBe("act.answer");
    expect(reply.bytes).toBeLessThan(REPLY_CAP_BYTES);
    const rows = rowsOf(reply, CLASS_PATH);
    expect(plainBody(rows[0]), "the type's own doc comment opens the map").toContain("Drives one dispatch from billing to delivery.");
    for (const text of ["open(order: Order): Ticket {", "weigh21(seed: number): number {", "this.stock.reserve(order.sku);", "this.billing.charge(order.total);", "this.delivery.ship(ticket);"]) {
      expect(rows.some((row) => plainBody(row).includes(text)), text).toBe(true);
    }
    expect(rows.some((row) => plainBody(row).includes("const v3 = seed")), "a filler member body was served").toBe(false);
    expect(rowsOf(reply, STATE_PATH).some(isStateTypeRow), "the enum the header is declared in rides beside the map").toBe(true);
  }, 90_000);
});

/** Same flow question, no map: each is a brevity word of ANOTHER sense or asks for MORE detail, so the type keeps the ordinary answer pack (a contiguous slice that reads filler members, no enum row). */
const NOT_MAPPED = [
  // a flow, but the answer is asked in detail
  `Explain in detail how DispatchCenter calls ${CONCERNS}, and in which order.`,
  `I need a thorough explanation of DispatchCenter: what order does it call ${CONCERNS} in?`,
  // a brevity word in another sense next to the same flow
  `Why does the short-circuit evaluation in DispatchCenter.open skip a call? In which order does it call ${CONCERNS}?`,
  `Is there a quick fix for how DispatchCenter calls ${CONCERNS}? In which order does it call them now?`,
  `DispatchCenter が ${CONCERNS} を呼ぶ順番を、簡単には直せないので詳しく説明して。コード変更は不要。`,
  // a NEGATED brevity word asks for the opposite of a map
  `Don't summarize - go through DispatchCenter line by line and tell me the order in which it calls ${CONCERNS}.`,
  `要約せずに、DispatchCenter が ${CONCERNS} を呼ぶ順番を一つずつ追って。コード変更は不要。`,
] as const;

describe("structure map entry — controls keep the ordinary answer pack", () => {
  it.each(NOT_MAPPED)("is no structure map: %s", async (query) => {
    const ws = makeWorkspace();
    const reply = await firstReply(ws, query);
    expect(rowsOf(reply, STATE_PATH).some(isStateTypeRow), JSON.stringify(reply.body).slice(0, 600)).toBe(false);
  }, 90_000);
});
