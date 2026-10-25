/**
 * mapAnswerFirst.spec.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-23, codex-copilot-proxy
 * answer-first experiment) on SYNTHETIC types, so each boundary of the rule is
 * stated against a type whose lines are known (helpers/owedRowsDesk.ts: `OrderDesk`,
 * a transition table over an imported enum and `n` steps that bill, reserve, save,
 * audit and dispatch). The class the experiment is about is t03AnswerFirst.spec.ts;
 * the pure rules are structureMap.spec.ts (cover) and answerFirstFacts.spec.ts
 * (facts); the verbatim r18 calls are replay corpus group v016wk.
 *
 * WHAT THE FLAG DOES. A structure map that cannot answer on its first page — the
 * members that call the named concerns do not all fit — is, with the flag, the
 * CORE evidence answered at once: the header, every member's signature, the state
 * enums and the WHOLE body of the member that covers the concerns (here `step0`,
 * the earliest of equals); every other body stays owed (`remaining` on the first
 * row) and the reply's `advisory` states what that leaves unread. Where the core
 * does not fit the client's ceiling (90 steps without grouped rows), or the map
 * already answers on its first page (a type of three steps), or the ceiling is not
 * compact, the flag changes nothing.
 *
 * The last describe is the BACKSTOP in-process (evaluation0929.certificateWireInvariant
 * .spec.ts's seam): a late pass that withdraws a window the answer-first certificate
 * cites turns the act.answer into a discover for exactly that window.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";
import { setPostCertificationPassForTest } from "../features/task-pack/readCodeTaskPack.js";
import { expandedReadNextArguments } from "./helpers/readNext.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ConfigName, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import {
  OWED_ROWS_DESK_FILE,
  OWED_ROWS_DESK_QUERY,
  OWED_ROWS_DESK_STATE_FILE,
  owedRowsDesk,
  writeOwedRowsDesk,
  type OwedRowsDesk,
} from "./helpers/owedRowsDesk.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const COPILOT_CEILING = 18_432;
const COPILOT_ENV = { TOKENLIGHTEN_CLIENT_ID: "copilot-cli", TOKENLIGHTEN_CLIENT: "copilot-cli", TOKENLIGHTEN_TOOL_SURFACE: "full", TL_LEGACY_INPUT: "refuse" };
const GROUPING = { TL_EFF_EVIDENCE_PATH_GROUPS: "1" };
const ANSWER_FIRST = { TL_EFF_MAP_ANSWER_FIRST: "1" };
const TASK = { epoch: "new", profile: "answer" };

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];
afterEach(async () => {
  setPostCertificationPassForTest(undefined);
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

function cell(populate: (ws: string) => void): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-mapaf-")));
  tmpDirs.push(ws);
  populate(ws);
  return ws;
}

interface Reply { readonly body: any; readonly bytes: number }

/** The first call and, while the reply is a discover, the call it publishes, until the act.answer or `limit` replies. */
async function run(ws: string, extraEnv: Record<string, string>, query: string, limit = 8): Promise<Reply[]> {
  const server = startDevServer(ws, "default" as ConfigName, { toolSurface: "full", allowWrite: true, extraEnv });
  servers.push(server);
  await server.initialize();
  const replies: Reply[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } = { tool: "tl_read_file", arguments: { cwd: ws, query, task: TASK } };
  for (let step = 0; step < limit; step++) {
    const { body, textBytes } = await server.callTool(call.tool, call.arguments["cwd"] === undefined ? { cwd: ws, ...call.arguments } : call.arguments);
    replies.push({ body, bytes: textBytes });
    if (body?.decision?.kind !== "discover") break;
    const next = body.decision.next;
    call = Array.isArray(next) ? next[0] : next;
  }
  return replies;
}

/** The first call alone, its server kept: for the calls that follow it in the same task (a restated request, a zoom read). */
async function firstCall(ws: string, extraEnv: Record<string, string>, query: string): Promise<{ server: ServerHandle; reply: Reply }> {
  const server = startDevServer(ws, "default" as ConfigName, { toolSurface: "full", allowWrite: true, extraEnv });
  servers.push(server);
  await server.initialize();
  const { body, textBytes } = await server.callTool("tl_read_file", { cwd: ws, query, task: TASK });
  return { server, reply: { body, bytes: textBytes } };
}

/** The lines `ranges` ("a-b" strings) cover. */
function linesOf(ranges: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const range of ranges) {
    const [from, to] = range.split("-").map(Number) as [number, number];
    for (let line = from; line <= to; line++) out.add(line);
  }
  return out;
}

function normalized(value: unknown, ws: string): string {
  return JSON.stringify(value).split(ws).join("<WS>")
    .replace(/tlh_[A-Za-z0-9_-]+/gu, "<TASK>")
    .replace(/\bq-[0-9a-f]{16}\b/gu, "<QREF>")
    .replace(/tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}/gu, "<CURSOR>")
    .replace(/"h[0-9a-z]{10}"/gu, "\"<H>\"")
    .replace(/ready-[0-9a-f]{8,}(?:-[0-9a-f]{8,})?/gu, "ready-<ID>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<HEX>")
    .replace(/"server_build":"[^"]*"/gu, "\"server_build\":\"<B>\"");
}

/** The lines of the desk class a reply carried (the dev server helper reads grouped rows back into whole rows). */
function carriedDeskLines(body: any): Set<number> {
  const held = new Set<number>();
  for (const row of (body?.evidence ?? []) as any[]) {
    const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
    if (row.path !== OWED_ROWS_DESK_FILE || typeof row.body !== "string" || window === null) continue;
    for (let line = Number(window[1]); line <= Number(window[2]); line++) held.add(line);
  }
  return held;
}

/** The concern calls on the lines `from`-`to` of the desk, as the advisory states them: `object.method L<line>`. */
function concernCalls(desk: OwedRowsDesk, from: number, to: number): string[] {
  const calls: string[] = [];
  for (let line = from; line <= to; line++) {
    for (const match of desk.lines[line - 1]!.matchAll(/\b(billingClient|stockLedger|deliveryService)\.(\w+)\(/gu)) calls.push(`${match[1]}.${match[2]} L${line}`);
  }
  return calls;
}

describe("TL_EFF_MAP_ANSWER_FIRST on a type whose map does not answer on its first page (16 steps, 2 loop guards, Copilot CLI)", () => {
  const STEPS = 16, GUARDS = 2;
  const make = (): { ws: string; desk: OwedRowsDesk } => {
    let desk!: OwedRowsDesk;
    const ws = cell(root => { desk = writeOwedRowsDesk(root, STEPS, GUARDS); });
    return { ws, desk };
  };

  it("flag off: the map's first page, then the rows of the other steps — two replies", async () => {
    const { ws } = make();
    const replies = await run(ws, COPILOT_ENV, OWED_ROWS_DESK_QUERY);
    expect(replies.map(reply => reply.body.decision.kind)).toEqual(["discover", "act.answer"]);
    for (const reply of replies) {
      expect(reply.body.advisory).toBeUndefined();
      expect(reply.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    }
  }, 240_000);

  it.each([
    ["only the answer-first flag", ANSWER_FIRST],
    ["with grouped rows", { ...GROUPING, ...ANSWER_FIRST }],
  ])("%s: ONE call reaches act.answer — step0 whole, every signature, the enum, the other bodies owed and their facts in the advisory", async (_name, flags) => {
    const { ws, desk } = make();
    const replies = await run(ws, { ...COPILOT_ENV, ...flags }, OWED_ROWS_DESK_QUERY);
    expect(replies.map(reply => reply.body.decision.kind), JSON.stringify(replies.map(reply => reply.bytes))).toEqual(["act.answer"]);
    const reply = replies[0]!;
    expect(reply.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    expect(reply.body.decision.next).toBeUndefined();
    expect(reply.body.limit?.cause).toBe("capped");

    // The core: step0 from its signature to its last line, the signature of every other step, no other line of theirs.
    const held = carriedDeskLines(reply.body);
    const [first, ...others] = desk.steps;
    for (let line = first!.signature; line <= first!.end; line++) {
      if (desk.lines[line - 1]!.trim() !== "") expect(held.has(line), `step0 line ${line} is served`).toBe(true);
    }
    for (const step of others) {
      expect(held.has(step.signature), `${step.name}: its signature is served`).toBe(true);
      for (const line of [...step.filler, ...step.between]) expect(held.has(line), `${step.name}: line ${line} is not served`).toBe(false);
      for (const line of step.rows.filter(line => line !== step.signature)) expect(held.has(line), `${step.name}: line ${line} is owed`).toBe(false);
    }
    // The state enum is served (the header's table is over it).
    expect((reply.body.evidence as any[]).some(row => row.path === OWED_ROWS_DESK_STATE_FILE && typeof row.body === "string" && row.body.includes("enum DeskState"))).toBe(true);
    // Every other step's body is owed on the first row.
    const remaining = ((reply.body.evidence as any[])[0].remaining as string[]).map(span => span.split("-").map(Number) as [number, number]);
    for (const step of others) expect(remaining.some(([from, to]) => from <= step.signature + 1 && step.end <= to + 1), `${step.name} is owed`).toBe(true);

    const advisory = reply.body.advisory as string;
    expect(typeof advisory).toBe("string");
    // A. served whole and not served.
    expect(advisory.startsWith(`structure map: served whole: step0 ${first!.signature}-${first!.end}; bodies not served of members that call billing/stock/delivery: `)).toBe(true);
    for (const step of others) expect(advisory).toContain(`${step.name} ${step.signature + 1}-${step.end}`);
    // …and what is true of the members the list does not name: the constructor's body is in the header rows, every other member is a signature.
    expect(advisory).toContain(`${others.at(-1)!.name} ${others.at(-1)!.signature + 1}-${others.at(-1)!.end}; every other member but the constructor is signature-only; `);
    // B. the sleep guard of each of the last two steps.
    for (const step of others.slice(-GUARDS)) {
      const [loop, , guard, , sleep] = step.guard as readonly number[] as [number, number, number, number, number];
      expect(desk.lines[sleep - 1]).toContain("Thread.sleep(backoffMs)");
      expect(advisory).toContain(`L${sleep} Thread.sleep(backoffMs) requires L${guard} (attempt < MAX_TRIES); loop L${loop}: attempt <= MAX_TRIES. At loop bound: guard false, no sleep.`);
    }
    // C. the constant the header declares is used by the guard steps only; the table's name is used by served lines only.
    const maxTries = others.slice(-GUARDS).flatMap(step => [step.guard[0]!, step.guard[2]!]);
    expect(advisory).toContain(`same-file references to constants declared in served lines (lexical): MAX_TRIES: read ${maxTries.map(line => `L${line}`).join(" ")}`);
    expect(advisory).not.toContain("no reference outside the declaration");
    // D. the concern calls of the first unserved steps, in source order, as the source has them.
    const calls = /concern calls in unserved bodies, in source order: (.*)$/u.exec(advisory)?.[1] ?? "";
    expect(calls.startsWith(`step1 ${concernCalls(desk, others[0]!.signature + 1, others[0]!.end).join(", ")} | step2 `)).toBe(true);
    // Facts only.
    expect(advisory).not.toMatch(/\b(?:should|must|please|tl_[a-z_]+|use|fetch|run)\b/iu);
    expect(advisory, "\"read\" only classifies lines").not.toMatch(/\bread\b(?! (?:L\d|\+\d))/iu);
  }, 240_000);

  it("the default client (no pack ceiling): the flag changes nothing", async () => {
    const [grouped, flagged] = [make(), make()];
    const [groupedReplies, flaggedReplies] = [await run(grouped.ws, GROUPING, OWED_ROWS_DESK_QUERY), await run(flagged.ws, { ...GROUPING, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY)];
    expect(flaggedReplies.length).toBe(groupedReplies.length);
    flaggedReplies.forEach((reply, index) => {
      expect(normalized(reply.body, flagged.ws), "reply " + (index + 1)).toBe(normalized(groupedReplies[index]!.body, grouped.ws));
      expect(reply.bytes).toBe(groupedReplies[index]!.bytes);
      expect(reply.body.advisory, "no advisory").toBeUndefined();
    });
  }, 400_000);
});

describe("TL_EFF_MAP_ANSWER_FIRST where the core does not fit, or the map already answers", () => {
  it("90 steps: the core needs grouped rows — the flag alone leaves the first reply as it was, with both flags the first reply is the answer", async () => {
    const make = (): string => cell(root => { writeOwedRowsDesk(root, 90, 2); });
    const [offWs, onlyWs, bothWs] = [make(), make(), make()];
    const off = await run(offWs, COPILOT_ENV, OWED_ROWS_DESK_QUERY, 1);
    const only = await run(onlyWs, { ...COPILOT_ENV, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY, 1);
    const both = await run(bothWs, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY, 1);
    expect(off[0]!.body.decision.kind).toBe("discover");
    expect(normalized(only[0]!.body, onlyWs)).toBe(normalized(off[0]!.body, offWs));
    expect(only[0]!.bytes).toBe(off[0]!.bytes);
    expect(only[0]!.body.advisory).toBeUndefined();
    expect(both[0]!.body.decision.kind).toBe("act.answer");
    expect(both[0]!.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    expect(both[0]!.body.advisory).toContain("bodies not served of members that call");
  }, 400_000);

  it("a type of three steps answers on its first page without the flag: the flag leaves its bodies alone", async () => {
    const make = (): string => cell(root => { writeOwedRowsDesk(root, 3); });
    const [offWs, onWs] = [make(), make()];
    const off = await run(offWs, COPILOT_ENV, OWED_ROWS_DESK_QUERY);
    const on = await run(onWs, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY);
    expect(off.map(reply => reply.body.decision.kind)).toEqual(["act.answer"]);
    expect(on.map(reply => reply.body.decision.kind)).toEqual(["act.answer"]);
    expect(on[0]!.body.advisory).toBeUndefined();
    // Every step is served whole in both: answer-first would have owed steps 1 and 2.
    const [offLines, onLines] = [carriedDeskLines(off[0]!.body), carriedDeskLines(on[0]!.body)];
    const desk = owedRowsDesk(3);
    for (const step of desk.steps) {
      for (const line of step.rows) {
        expect(offLines.has(line), `flag off: line ${line}`).toBe(true);
        expect(onLines.has(line), `flag on: line ${line}`).toBe(true);
      }
    }
  }, 240_000);

  it("a type whose first page already answers in one reply (the small FulfillmentDesk): same reply with the flag, no advisory", async () => {
    const make = (): string => cell(root => writeFulfillmentDesk(root, 22));
    const [offWs, onWs] = [make(), make()];
    const query = "FulfillmentDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内)。コード変更は不要。";
    const off = await run(offWs, COPILOT_ENV, query);
    const on = await run(onWs, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, query);
    expect(off.map(reply => reply.body.decision.kind), JSON.stringify(off.map(reply => reply.bytes))).toEqual(on.map(reply => reply.body.decision.kind));
    expect(on.at(-1)!.body.advisory).toBeUndefined();
    const bodiesOf = (replies: Reply[]): string => replies.flatMap(reply => (reply.body.evidence as any[]).map(row => String(row.body ?? ""))).join("\n");
    // The cancel path is read in both (answer-first would have owed it).
    expect(bodiesOf(off)).toContain("deliveryService.recall(ticket)");
    expect(bodiesOf(on)).toContain("deliveryService.recall(ticket)");
  }, 240_000);
});

describe("TL_EFF_MAP_ANSWER_FIRST: the size of the type decides, and a request that is no map request is untouched", () => {
  it("104 steps: the core still fits with grouped rows — the first reply is the answer, the advisory cut at a member boundary to the room that is left", async () => {
    const ws = cell(root => { writeOwedRowsDesk(root, 104, 2); });
    const replies = await run(ws, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY, 1);
    expect(replies[0]!.body.decision.kind, replies[0]!.bytes.toString()).toBe("act.answer");
    expect(replies[0]!.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    const advisory = replies[0]!.body.advisory as string;
    expect(advisory).toContain("bodies not served of members that call");
    // The signatures of 104 members and their owed bodies leave little room: the call index is cut, never the list of what was not served.
    expect(advisory).toMatch(/ \| \+\d+ more members$/u);
    expect(advisory).toContain("step103 ");
  }, 240_000);

  it("128 steps: the core does not fit even with grouped rows — no effect, the reply is the map's first page", async () => {
    const make = (): string => cell(root => { writeOwedRowsDesk(root, 128, 2); });
    const [offWs, onWs] = [make(), make()];
    const off = await run(offWs, { ...COPILOT_ENV, ...GROUPING }, OWED_ROWS_DESK_QUERY, 1);
    const on = await run(onWs, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY, 1);
    expect(off[0]!.body.decision.kind).toBe("discover");
    expect(on[0]!.body.decision.kind).toBe("discover");
    expect(normalized(on[0]!.body, onWs)).toBe(normalized(off[0]!.body, offWs));
    expect(on[0]!.bytes).toBe(off[0]!.bytes);
    expect(on[0]!.body.advisory).toBeUndefined();
  }, 240_000);

  it.each([
    ["no short or map-shaped wording", "OrderDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか説明して。コード変更は不要。"],
    ["no flow facet", "OrderDesk とは何をするクラスか短く説明して (30行以内、構造の地図として見たい)。コード変更は不要。"],
  ])("%s: no structure map, so the flag changes nothing", async (_name, query) => {
    const make = (): string => cell(root => { writeOwedRowsDesk(root, 16, 2); });
    const [offWs, onWs] = [make(), make()];
    const off = await run(offWs, { ...COPILOT_ENV, ...GROUPING }, query, 3);
    const on = await run(onWs, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, query, 3);
    expect(on.length).toBe(off.length);
    on.forEach((reply, index) => {
      expect(normalized(reply.body, onWs), "reply " + (index + 1)).toBe(normalized(off[index]!.body, offWs));
      expect(reply.body.advisory).toBeUndefined();
    });
  }, 240_000);
});

describe("TL_EFF_MAP_ANSWER_FIRST: the same request restated after the answer lists what the page left owed (independent review F7)", () => {
  const make = (): { ws: string; desk: OwedRowsDesk } => {
    let desk!: OwedRowsDesk;
    const ws = cell(root => { desk = writeOwedRowsDesk(root, 16, 2); });
    return { ws, desk };
  };
  const deskRow = (body: any): any => (body.evidence as any[]).find(row => row.path === OWED_ROWS_DESK_FILE);

  it("an act.answer whose row carries the windows still unserved, the page's own and no more — not the map's whole extent", async () => {
    const { ws, desk } = make();
    const { server, reply } = await firstCall(ws, { ...COPILOT_ENV, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY);
    expect(reply.body.decision.kind).toBe("act.answer");
    const owedAtFirst = linesOf(deskRow(reply.body).remaining);
    const { body: restated } = await server.callTool("tl_read_file", { cwd: ws, task: { handle: reply.body.task.id }, query: OWED_ROWS_DESK_QUERY });
    expect(restated.kind).toBe("read.task_pack");
    expect(restated.decision.kind, "the certificate stands").toBe("act.answer");
    const row = deskRow(restated);
    expect(typeof row.body, "a receipt row has no body").toBe("undefined");
    expect(row.remaining.length, JSON.stringify(row.remaining)).toBeGreaterThan(10);
    const owed = linesOf(row.remaining);
    const [first, ...others] = desk.steps;
    // every unserved step body is owed; nothing the first page served is
    for (const step of others) {
      for (let line = step.signature + 1; line <= step.end; line++) {
        if (desk.lines[line - 1]!.trim() !== "") expect(owed.has(line), `${step.name} line ${line} is owed`).toBe(true);
      }
      expect(owed.has(step.signature), `${step.name}: its signature was served`).toBe(false);
    }
    for (let line = first!.signature; line <= first!.end; line++) expect(owed.has(line), `step0 line ${line} was served`).toBe(false);
    // the page's own `remaining`, to the blank lines between its windows
    for (const line of owedAtFirst) expect(owed.has(line), `line ${line} was owed at first`).toBe(true);
    for (const line of owed) if (!owedAtFirst.has(line)) expect(desk.lines[line - 1]!.trim(), `line ${line} is owed now and was not then: only a blank line may be`).toBe("");
  }, 240_000);

  it("a window read since is no longer owed", async () => {
    const { ws, desk } = make();
    const { server, reply } = await firstCall(ws, { ...COPILOT_ENV, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY);
    const step3 = desk.steps[3]!;
    const zoomed = await server.callTool("tl_read_file", { cwd: ws, task: { handle: reply.body.task.id }, targets: [{ handle: deskRow(reply.body).handle, range: `${step3.signature + 1}-${step3.end}` }] });
    expect(zoomed.body.kind).toBe("read.text");
    const { body: restated } = await server.callTool("tl_read_file", { cwd: ws, task: { handle: reply.body.task.id }, query: OWED_ROWS_DESK_QUERY });
    const owed = linesOf(deskRow(restated).remaining);
    for (let line = step3.signature + 1; line <= step3.end; line++) expect(owed.has(line), `step3 line ${line} was read`).toBe(false);
    for (const step of [desk.steps[2]!, desk.steps[4]!]) expect(owed.has(step.signature + 1), `${step.name} is still owed`).toBe(true);
  }, 240_000);

  it("flag off, the receipt of a map that answers at once keeps marking the map's whole extent (unchanged)", async () => {
    const ws = cell(root => writeFulfillmentDesk(root, 22));
    const query = "FulfillmentDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内)。コード変更は不要。";
    const { server, reply } = await firstCall(ws, COPILOT_ENV, query);
    expect(reply.body.decision.kind).toBe("act.answer");
    const { body: restated } = await server.callTool("tl_read_file", { cwd: ws, task: { handle: reply.body.task.id }, query });
    const row = (restated.evidence as any[]).find(entry => String(entry.path).endsWith("FulfillmentDesk.java"));
    expect(row.remaining, "one range: the row's own extent").toEqual([row.range]);
  }, 240_000);
});

describe("TL_EFF_MAP_ANSWER_FIRST under VS Code's own 14,336 B ceiling (TL_TURN_ECONOMY) — within the < 20 KiB scope (independent review F10)", () => {
  const VSCODE = { TOKENLIGHTEN_CLIENT: "vscode", TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1", TOKENLIGHTEN_TOOL_SURFACE: "full", TL_LEGACY_INPUT: "refuse" };
  const VSCODE_CEILING = 14_336;
  const make = (): string => cell(root => { writeOwedRowsDesk(root, 6, 2); });

  it("flag off: the map's first page, then the rest; the flag: ONE act.answer, under the ceiling, with the facts of the bodies it left owed", async () => {
    const [offWs, onWs] = [make(), make()];
    const off = await run(offWs, VSCODE, OWED_ROWS_DESK_QUERY);
    const on = await run(onWs, { ...VSCODE, ...ANSWER_FIRST }, OWED_ROWS_DESK_QUERY);
    expect(off.map(reply => reply.body.decision.kind), JSON.stringify(off.map(reply => reply.bytes))).toEqual(["discover", "act.answer"]);
    for (const reply of off) expect(reply.bytes).toBeLessThanOrEqual(VSCODE_CEILING);
    expect(on.map(reply => reply.body.decision.kind), JSON.stringify(on.map(reply => reply.bytes))).toEqual(["act.answer"]);
    expect(on[0]!.bytes).toBeLessThanOrEqual(VSCODE_CEILING);
    const advisory = on[0]!.body.advisory as string;
    expect(advisory.startsWith("structure map: served whole: step0 ")).toBe(true);
    for (const step of ["step1 ", "step2 ", "step3 ", "step4 ", "step5 "]) expect(advisory, step).toContain(step);
    expect(advisory).toContain("bodies not served of members that call billing/stock/delivery: ");
    expect(off[0]!.body.advisory).toBeUndefined();
  }, 240_000);
});

/** The FulfillmentDesk of structureMapAnswer.spec.ts: a transition table over an imported enum, one main flow, a cancel path and `fillers` members of arithmetic. */
function writeFulfillmentDesk(root: string, fillers: number): void {
  const put = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  put("src/main/java/demo/model/DeskState.java", ["package demo.model;", "", "/** The states one fulfilment moves through. */", "public enum DeskState {", "    OPEN,", "    BILLED,", "    SHIPPED,", "    VOID;", "}", ""].join("\n"));
  const filler = (i: number): string[] => [
    "",
    `    /** Measures step ${i}. */`,
    `    public long measure${i}(long seed) {`,
    ...Array.from({ length: 24 }, (_, j) => `        long v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5});`),
    `        return v0 + v23 + ${i};`,
    "    }",
  ];
  put("src/main/java/demo/FulfillmentDesk.java", [
    "package demo;", "", "import demo.model.DeskState;", "import java.util.EnumMap;", "import java.util.EnumSet;", "import java.util.Map;", "import java.util.Set;", "",
    "/**", " * Runs one fulfilment from billing to delivery.", " */",
    "public class FulfillmentDesk {", "",
    "    private final BillingClient billingClient;", "    private final StockLedger stockLedger;", "    private final DeliveryService deliveryService;", "",
    "    private static final Map<DeskState, Set<DeskState>> MOVES = new EnumMap<>(DeskState.class);", "",
    "    static {",
    "        MOVES.put(DeskState.OPEN, EnumSet.of(DeskState.BILLED, DeskState.VOID));",
    "        MOVES.put(DeskState.BILLED, EnumSet.of(DeskState.SHIPPED, DeskState.VOID));",
    "        MOVES.put(DeskState.SHIPPED, EnumSet.noneOf(DeskState.class));",
    "        MOVES.put(DeskState.VOID, EnumSet.noneOf(DeskState.class));",
    "    }", "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
    "        this.billingClient = billingClient;", "        this.stockLedger = stockLedger;", "        this.deliveryService = deliveryService;", "    }", "",
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
    "", "    /** Cancels a ticket. */",
    "    public void cancel(Ticket ticket) {",
    "        billingClient.refund(ticket.charge());",
    "        stockLedger.release(ticket.sku(), ticket.quantity());",
    "        deliveryService.recall(ticket);",
    "    }",
    "}", "",
  ].join("\n"));
}

/** A TypeScript class of the same shape as `OrderDesk`: a state enum in another file, constants, and `steps` members that reserve, bill and ship (the last two also loop). */
function writeTsDesk(root: string, steps: number): string[] {
  const put = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  put("package.json", `${JSON.stringify({ name: "mapaf-ts", version: "1.0.0", type: "module" }, null, 2)}\n`);
  put("src/deskState.ts", ["/** The states one order moves through. */", "export enum DeskState {", "  Open = \"open\",", "  Billed = \"billed\",", "  Shipped = \"shipped\",", "  Void = \"void\",", "}", ""].join("\n"));
  const lines: string[] = [
    "import { DeskState } from \"./deskState.js\";", "",
    "/** Runs orders from billing to delivery. */",
    "export class OrderDesk {",
    "  private static readonly MAX_TRIES = 3;",
    "  private static readonly NOTE_VOID = \"void\";",
    "  private readonly moves: Map<DeskState, DeskState[]> = new Map();", "",
    "  constructor(private readonly billing: Billing, private readonly stock: Stock, private readonly delivery: Delivery) {",
    "    this.moves.set(DeskState.Open, [DeskState.Billed, DeskState.Void]);",
    "    this.moves.set(DeskState.Billed, [DeskState.Shipped, DeskState.Void]);",
    "  }",
  ];
  for (let step = 0; step < steps; step++) {
    lines.push("", `  /** Step ${step}: bills, reserves and ships order ${step}. */`, `  step${step}(order: Order): Ticket {`, `    const base = order.total * ${step + 2};`);
    for (let j = 0; j < 22; j++) lines.push(`    const filler${step}_${j} = base * ${j + 3} + ${step * 7 + j} - (base >> ${j % 5});`);
    if (step >= steps - 2) lines.push("    for (let attempt = 1; attempt <= OrderDesk.MAX_TRIES; attempt++) {", "      if (attempt < OrderDesk.MAX_TRIES) { this.wait(base * attempt); }", "    }");
    lines.push("    this.stock.reserve(order.sku);", "    try {", "      this.billing.charge(order.account, base);", "    } catch (error) {", "      this.stock.release(order.sku);", "      throw error;", "    }", "    const ticket = new Ticket(order, OrderDesk.NOTE_VOID);", "    this.delivery.ship(ticket);", "    return ticket;", "  }");
    // The member after step0 branches: the cases of one switch and the arms of one if/else are alternatives, not a sequence.
    if (step === 0) {
      lines.push(
        "", "  /** Routes an order by what happened to it. */", "  route(order: Order, event: string): void {",
        "    switch (event) {",
        "      case \"refund\":", "        this.billing.refund(order.account);", "        break;",
        "      case \"recall\":", "        this.delivery.recall(order.id);", "        break;",
        "      default:", "        this.stock.release(order.sku);",
        "    }",
        "    if (order.void) {", "      this.stock.restore(order.sku);", "    } else {", "      this.billing.settle(order.account);", "    }",
        "    order.note = OrderDesk.NOTE_VOID;",
        "  }",
      );
    }
  }
  lines.push("}", "");
  put("src/orderDesk.ts", lines.join("\n"));
  return lines;
}

describe("TL_EFF_MAP_ANSWER_FIRST for a TypeScript class asked in English (16 steps, Copilot CLI)", () => {
  const QUERY = "Give me a short overview of OrderDesk: its state transition table and how it sequences the billing / stock / delivery calls. No code changes.";
  const FILE = "src/orderDesk.ts";
  const make = (): { ws: string; lines: string[] } => {
    let lines!: string[];
    const ws = cell(root => { lines = writeTsDesk(root, 16); });
    return { ws, lines };
  };

  it("flag off: the map's first page, then the rest — two replies", async () => {
    const replies = await run(make().ws, COPILOT_ENV, QUERY);
    expect(replies.map(reply => reply.body.decision.kind)).toEqual(["discover", "act.answer"]);
  }, 240_000);

  it("flag on: ONE act.answer — step0 whole, every signature, the enum; the facts of the other bodies in the advisory, each checked against the source", async () => {
    const { ws, lines } = make();
    const replies = await run(ws, { ...COPILOT_ENV, ...ANSWER_FIRST }, QUERY);
    expect(replies.map(reply => reply.body.decision.kind), JSON.stringify(replies.map(reply => reply.bytes))).toEqual(["act.answer"]);
    const reply = replies[0]!;
    expect(reply.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    const rows = (reply.body.evidence as any[]).filter(row => row.path === FILE && typeof row.body === "string");
    const held = new Set<number>();
    for (const row of rows) {
      const window = /^(\d+)-(\d+)$/u.exec(String(row.range))!;
      for (let line = Number(window[1]); line <= Number(window[2]); line++) held.add(line);
    }
    const lineOf = (text: string, nth = 1): number => {
      let seen = 0;
      for (let index = 0; index < lines.length; index++) if (lines[index]!.includes(text) && ++seen === nth) return index + 1;
      throw new Error(text);
    };
    const step0 = { signature: lineOf("step0(order: Order): Ticket {") };
    // step0's last line is the closing brace of its body: the first "  }" after its signature.
    const closing = lines.findIndex((text, index) => index + 1 > step0.signature && text === "  }") + 1;
    for (let line = step0.signature; line <= closing; line++) expect(held.has(line), `step0 line ${line}`).toBe(true);
    for (let step = 1; step < 16; step++) {
      expect(held.has(lineOf(`step${step}(order: Order): Ticket {`)), `step${step}: its signature is served`).toBe(true);
      expect(held.has(lineOf(`const filler${step}_3 =`)), `step${step}: its arithmetic is not`).toBe(false);
    }
    expect((reply.body.evidence as any[]).some(row => row.path === "src/deskState.ts" && String(row.body).includes("enum DeskState"))).toBe(true);

    const advisory = reply.body.advisory as string;
    expect(advisory.startsWith(`structure map: served whole: step0 ${step0.signature}-${closing}; bodies not served of members that call billing/stock/delivery: route `)).toBe(true);
    // The constructor's two body lines are in the header rows; every other member is a signature.
    expect(advisory).toContain("; every other member but the constructor is signature-only; ");
    expect(advisory, "no loop-guard review for TypeScript").not.toContain("loop guards");
    // Constants: every indexed line mentions the constant and sits in the group its own text puts it in; MAX_TRIES is read by the last two steps only,
    // NOTE_VOID is stored once (route's assignment) and read by every unserved step.
    const constants = (/\(lexical\): (.*?)(?:; no reference outside the declaration|; concern calls|$)/u.exec(advisory)?.[1] ?? "").split("; ");
    expect(constants.map(entry => entry.split(":")[0])).toEqual(["MAX_TRIES", "NOTE_VOID"]);
    for (const entry of constants) {
      const [name, groups] = entry.split(": ") as [string, string];
      for (const group of groups.split(", ")) {
        const [word, ...rest] = group.split(" ");
        for (const token of rest.filter(text => /^L\d+$/u.test(text))) {
          const line = lines[Number(token.slice(1)) - 1]!;
          expect(line, `${name} ${token}`).toMatch(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "u"));
          expect(/(?<![=!<>])=\s*OrderDesk\.\w+\s*;/u.test(line) ? "set" : "read", `${name} ${token}: ${line.trim()}`).toBe(word);
        }
      }
    }
    expect(constants[0]).toBe(`MAX_TRIES: read ${[lineOf("attempt <= OrderDesk.MAX_TRIES"), lineOf("attempt < OrderDesk.MAX_TRIES"), lineOf("attempt <= OrderDesk.MAX_TRIES", 2), lineOf("attempt < OrderDesk.MAX_TRIES", 2)].map(line => `L${line}`).join(" ")}`);
    expect(constants[1]!.startsWith(`NOTE_VOID: set L${lineOf("order.note = OrderDesk.NOTE_VOID;")}, read L${lineOf("new Ticket(order, OrderDesk.NOTE_VOID)", 2)} `)).toBe(true);
    // Calls: each names a line of its own member that makes the call, in source order.
    const calls = (/source order: (.*)$/u.exec(advisory)?.[1] ?? "").split(" | ").filter(entry => !/^\+\d+ more members$/u.test(entry));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    let previous = 0;
    for (const entry of calls) {
      const space = entry.indexOf(" ");
      for (const call of [...entry.slice(space + 1).matchAll(/(\w+\.\w+) L(\d+)/gu)]) {
        expect(lines[Number(call[2]) - 1], call[0]).toContain(`${call[1]}(`);
        expect(Number(call[2]), "source order").toBeGreaterThan(previous);
        previous = Number(call[2]);
      }
    }
    // route branches: refund / recall / the default of one switch, then the two arms of one if/else, which follow the switch in sequence.
    expect(calls[0]).toBe([
      `route billing.refund L${lineOf("this.billing.refund(order.account);")} [case refund]`,
      ` / delivery.recall L${lineOf("this.delivery.recall(order.id);")} [case recall]`,
      ` / stock.release L${lineOf("this.stock.release(order.sku);", 2)} [default]`,
      `, stock.restore L${lineOf("this.stock.restore(order.sku);")} [if order.void]`,
      ` / billing.settle L${lineOf("this.billing.settle(order.account);")} [else]`,
    ].join(""));
    // …while step1 is one sequence: a reservation, a charge, its compensation, a dispatch.
    expect(calls[1]).toBe(`step1 stock.reserve L${lineOf("this.stock.reserve(order.sku);", 2)}, billing.charge L${lineOf("this.billing.charge(order.account, base);", 2)}, stock.release L${lineOf("this.stock.release(order.sku);", 3)}, delivery.ship L${lineOf("this.delivery.ship(ticket);", 2)}`);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The backstop, in-process: the act.answer of an answer-first map is a claim over its cited windows.
// ---------------------------------------------------------------------------

async function inProcess(ws: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await callTool("tl_read_file", { cwd: ws, ...args });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  return JSON.parse(text) as Record<string, any>;
}

describe("TL_EFF_MAP_ANSWER_FIRST under the certificate backstop (a late pass that withdraws a cited window)", () => {
  const saved: Record<string, string | undefined> = {};
  const FLAGS = { TL_EFF_MAP_ANSWER_FIRST: "1", TOKENLIGHTEN_TASK_PACK_MAX_BYTES: String(COPILOT_CEILING) } as const;
  beforeEach(() => {
    resetAll();
    handleTable.reset();
    for (const [key, value] of Object.entries(FLAGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(FLAGS)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const deskCell = (): { ws: string; desk: OwedRowsDesk } => {
    let desk!: OwedRowsDesk;
    const ws = cell(root => { desk = writeOwedRowsDesk(root, 16, 2); });
    return { ws, desk };
  };

  it("control: the 16-step type is ONE act.answer under an 18,432 B pack ceiling, with the advisory, in the ceiling", async () => {
    const { ws } = deskCell();
    const hop0 = await inProcess(ws, { query: OWED_ROWS_DESK_QUERY, task: TASK });
    expect(hop0["decision"]?.kind).toBe("act.answer");
    expect(Buffer.byteLength(JSON.stringify(hop0), "utf8")).toBeLessThanOrEqual(COPILOT_CEILING);
    expect(hop0["advisory"]).toContain("bodies not served of members that call");
  });

  it("withdrawing the class's own window after certification downgrades to discover — no certificate, and no advisory about a page that did not ship — with a next that re-reads it, then converges", async () => {
    const { ws, desk } = deskCell();
    let withdrawn = 0;
    setPostCertificationPassForTest(surfaces => {
      for (let index = surfaces.length - 1; index >= 0; index--) {
        if (surfaces[index]!.path === OWED_ROWS_DESK_FILE) {
          surfaces.splice(index, 1);
          withdrawn += 1;
        }
      }
      setPostCertificationPassForTest(undefined);
    });
    const hop0 = await inProcess(ws, { query: OWED_ROWS_DESK_QUERY, task: TASK });
    expect(withdrawn, "the seam must have removed the class's surface").toBeGreaterThan(0);
    const decision = hop0["decision"] ?? {};
    expect(decision.kind, `a certificate may not outlive its evidence; got ${JSON.stringify(decision)}`).not.toBe("act.answer");
    expect(decision.certificate).toBeUndefined();
    expect(hop0["advisory"], "the facts describe an answer-first page; this reply is not one").toBeUndefined();
    const next = Array.isArray(decision.next) ? decision.next[0] : decision.next;
    expect(next?.tool).toBe("tl_read_file");
    const targets = (expandedReadNextArguments(next?.arguments, ws)?.["targets"] ?? []) as Array<{ path?: string; range?: string }>;
    expect(targets.some(target => target.path === OWED_ROWS_DESK_FILE), `next must re-read the withdrawn class; got ${JSON.stringify(next)}`).toBe(true);
    // Following it converges, and what it certifies is on the wire: step0's concern calls.
    let call = next as { tool: string; arguments: Record<string, unknown> } | undefined;
    const responses = [hop0];
    for (let hop = 1; hop < 8 && call !== undefined; hop++) {
      const response = await inProcess(ws, call.arguments);
      responses.push(response);
      const following = response["decision"]?.next;
      call = Array.isArray(following) ? following[0] : following;
    }
    expect(responses.at(-1)!["decision"]?.kind, JSON.stringify(responses.map(response => response["decision"]?.kind))).toBe("act.answer");
    const bodies = responses.flatMap(response => (response["evidence"] ?? []) as any[]).map(row => String(row.body ?? "")).join("\n");
    expect(bodies).toContain(desk.lines[desk.steps[0]!.rows[3]! - 1]!.trim());
  });
});
