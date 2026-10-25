/**
 * answerFirstAdoption.spec.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-24, generality audit
 * follow-up): WHEN an answer-first page is the reply, end to end. The audit found that
 * where answer-first did not fire the flag still replaced the map's required windows by
 * the core's, and the chain went on from a first reply that did not answer with a third
 * of the type's lines and no advisory (22 of 56 map-shaped requests). The rule now is an
 * invariant: with the flag set, every reply of every chain is either
 *
 *   (a) the answer-first act.answer as the FIRST reply — the core served, the advisory
 *       with at least its first tier, under the ceiling; or
 *   (b) byte for byte the reply the same request gets with the flag unset.
 *
 * Which of the two is decided before the pack is built, by a dry run of the facet hook
 * against the core (readCodeTaskPack.ts `answerFirstPageHolds`, `answerFirstPageProves`).
 * The pure rules are structureMapAnswerFirstRules.spec.ts; the type the experiment is
 * about is t03AnswerFirst.spec.ts; the boundaries of its size are mapAnswerFirst.spec.ts.
 *
 * "Byte for byte" is what the other specs of this family mean by it: the replies of both
 * chains with what each server mints (workspace path, task ids, replay refs, cursors,
 * handles, certificate ids, build stamps) set aside, and the same size.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";
import { answerFirstPageHolds, setPostCertificationPassForTest, withoutNamedFileArtifacts } from "../features/task-pack/readCodeTaskPack.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import type { FacetPlanEntry } from "../features/task-pack/facetGate.js";
import { expandedReadNextArguments } from "./helpers/readNext.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ConfigName, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import {
  OWED_ROWS_DESK_FILE,
  OWED_ROWS_DESK_QUERY,
  OWED_ROWS_DESK_STATE_FILE,
  owedRowsDesk,
  writeOwedRowsDesk,
} from "./helpers/owedRowsDesk.js";
import { AF_DESK_QUERY, AF_SIBLING_FILE, AF_TOP_LEVEL_FUNCTION, writeAfDesk } from "./helpers/answerFirstDesks.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const COPILOT_CEILING = 18_432;
const COPILOT_ENV = { TOKENLIGHTEN_CLIENT_ID: "copilot-cli", TOKENLIGHTEN_CLIENT: "copilot-cli", TOKENLIGHTEN_TOOL_SURFACE: "full", TL_LEGACY_INPUT: "refuse" };
const GROUPING = { TL_EFF_EVIDENCE_PATH_GROUPS: "1" };
const ANSWER_FIRST = { TL_EFF_MAP_ANSWER_FIRST: "1" };
const TASK = { epoch: "new", profile: "answer" };
/** The flag sets the invariant is checked against: the flag-unset chain with and without grouped rows. */
const FLAG_SETS = [
  ["ungrouped rows", COPILOT_ENV],
  ["grouped rows", { ...COPILOT_ENV, ...GROUPING }],
] as const;

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
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-afadopt-")));
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

function normalized(value: unknown, ws: string): string {
  return JSON.stringify(value).split(ws).join("<WS>")
    .replace(/tlh_[A-Za-z0-9_-]+/gu, "<TASK>")
    .replace(/\bq-[0-9a-f]{16}\b/gu, "<QREF>")
    .replace(/tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}/gu, "<CURSOR>")
    .replace(/"h[0-9a-z]{10}"/gu, "\"<H>\"")
    .replace(/\bh[0-9a-z]{10}\b(?= — | only if)/gu, "<H>")
    .replace(/ready-[0-9a-f]{8,}(?:-[0-9a-f]{8,})?/gu, "ready-<ID>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<HEX>")
    .replace(/"server_build":"[^"]*"/gu, "\"server_build\":\"<B>\"");
}

/** The lines of `file` the replies carried in a body. */
function carriedLines(replies: readonly Reply[], file: string): Set<number> {
  const held = new Set<number>();
  for (const { body } of replies) {
    for (const row of (body?.evidence ?? []) as any[]) {
      const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
      if (row.path !== file || typeof row.body !== "string" || window === null) continue;
      for (let line = Number(window[1]); line <= Number(window[2]); line++) held.add(line);
    }
  }
  return held;
}

/** Rows as `path:range:body` — what a chain served, whatever the order of the rows or the replies it came in. */
function servedRows(replies: readonly Reply[]): string[] {
  return replies.flatMap(({ body }) => ((body?.evidence ?? []) as any[]).map(row => `${row.path}:${row.range}:${typeof row.body === "string" ? row.body : ""}`)).sort();
}

/** The invariant for one request: the chain with the flag is the answer-first reply, or the flag-unset chain, byte for byte. */
async function expectInvariant(label: string, offWs: string, onWs: string, offEnv: Record<string, string>, query: string, ceiling = COPILOT_CEILING): Promise<"answer-first" | "unchanged"> {
  const off = await run(offWs, offEnv, query);
  const on = await run(onWs, { ...offEnv, ...ANSWER_FIRST }, query);
  const advisory = on[0]!.body.advisory;
  if (on.length === 1 && on[0]!.body.decision?.kind === "act.answer" && typeof advisory === "string") {
    expect(advisory.startsWith("structure map: served whole: "), `${label}: the advisory states at least its first tier`).toBe(true);
    expect(advisory, `${label}: the first tier names what was not served`).toContain("bodies not served of members that call ");
    expect(on[0]!.bytes, `${label}: under the ceiling`).toBeLessThanOrEqual(ceiling);
    return "answer-first";
  }
  expect(on.length, `${label}: neither the answer-first reply nor the same number of replies as the flag-unset chain (${on.map(reply => `${reply.body.decision?.kind}/${reply.bytes}`).join(" ")} against ${off.map(reply => `${reply.body.decision?.kind}/${reply.bytes}`).join(" ")})`).toBe(off.length);
  on.forEach((reply, index) => {
    expect(normalized(reply.body, onWs), `${label}: reply ${index + 1}`).toBe(normalized(off[index]!.body, offWs));
    expect(reply.bytes, `${label}: reply ${index + 1} bytes`).toBe(off[index]!.bytes);
    expect(reply.body.advisory, `${label}: no advisory on a reply the flag did not write`).toBeUndefined();
  });
  return "unchanged";
}

describe("answerFirstPageHolds — whether the first page holds what the planned facets require (pure)", () => {
  const FILE = "src/orderDesk.ts";
  const map = {
    type: { path: FILE, name: "OrderDesk" },
    rows: [{ start: 4, end: 52 }, { start: 89, end: 89 }, { start: 126, end: 140 }],
    stateWindows: [{ path: "src/deskState.ts", start: 1, end: 7, name: "DeskState" }],
  };
  const flowOverType = (windows: FacetPlanEntry["windows"] = [], extra: Partial<FacetPlanEntry> = {}): FacetPlanEntry => ({
    facet: "flow", clause: "how it sequences the calls", resolution: "resolved",
    focal: { path: FILE, name: "OrderDesk", start: 4, end: 700, callable: false }, windows, ...extra,
  });
  const window = (path: string, start: number, end: number): FacetPlanEntry["windows"][number] => ({ kind: "callee", path, start, end, name: "x" });

  it("holds: the flow over the mapped type, its windows inside the rows and the enum declaration, nothing else to serve", () => {
    const verdict = answerFirstPageHolds(map, [flowOverType([window(FILE, 5, 9), window(FILE, 89, 89), window("src/deskState.ts", 1, 7)])], [{ path: FILE, start: 126, end: 130 }]);
    expect(verdict).toEqual({ holds: true, outside: [] });
  });

  it.each([
    ["a window in another member the core does not hold", [flowOverType([window(FILE, 5, 9), window(FILE, 300, 310)])], [], `${FILE}:300-310`],
    ["a window one line past a row", [flowOverType([window(FILE, 126, 141)])], [], `${FILE}:126-141`],
    ["a window in another file", [flowOverType([window("src/factory.ts", 1, 6)])], [], "src/factory.ts:1-6"],
    ["a call site of the type in a top-level function of the same file", [flowOverType([], { callSites: [{ path: FILE, line: 640 }] })], [], `${FILE}:640-640`],
    ["a call site in a sibling file", [flowOverType([], { callSites: [{ path: "src/factory.ts", line: 5 }] })], [], "src/factory.ts:5-5"],
    ["an unclassified mention elsewhere", [flowOverType([], { unclassifiedMentions: [{ path: "README.md", line: 3 }] })], [], "README.md:3-3"],
    ["a window the hook would serve (a widened or added candidate) outside the page", [flowOverType()], [{ path: "src/util.ts", start: 3, end: 5 }], "src/util.ts:3-5"],
  ] as const)("does not hold: %s", (_name, entries, served, outside) => {
    const verdict = answerFirstPageHolds(map, entries as unknown as FacetPlanEntry[], served as unknown as Array<{ path: string; start: number; end: number }>);
    expect(verdict.holds).toBe(false);
    expect(verdict.outside).toEqual([outside]);
  });

  it("the focal of a second subject is required too (trimmed of the blank and comment-only lines at its ends), unless the facet asks for its callers", () => {
    const lines = Array.from({ length: 140 }, (_, index) => (index + 1 === 124 || index + 1 === 125) ? "  /** doc */" : "  code();");
    const second = (facet: FacetPlanEntry["facet"], start: number, end: number): FacetPlanEntry => ({
      facet, clause: "step3()", resolution: "resolved", focal: { path: FILE, name: "step3", start, end }, windows: [],
    });
    const source = (path: string): string[] | undefined => path === FILE ? lines : undefined;
    // 124-125 are doc lines above a body that starts at 126 and is on a row: held once trimmed
    expect(answerFirstPageHolds(map, [flowOverType(), second("condition", 124, 140)], [], source).holds).toBe(true);
    expect(answerFirstPageHolds(map, [flowOverType(), second("condition", 124, 140)]).holds, "untrimmed it reaches a line no row holds").toBe(false);
    expect(answerFirstPageHolds(map, [flowOverType(), second("condition", 200, 240)], [], source)).toEqual({ holds: false, outside: [`${FILE}:200-240`] });
    expect(answerFirstPageHolds(map, [flowOverType(), second("callers", 200, 240)], [], source).holds, "a callers facet needs the call sites, not the focal").toBe(true);
  });

  it("an entry that did not resolve a focal requires nothing; a plan with no flow over the mapped type is no plan for this page", () => {
    const unresolved: FacetPlanEntry = { facet: "flow", clause: "x", resolution: "no-focal", windows: [] };
    expect(answerFirstPageHolds(map, [flowOverType(), unresolved]).holds).toBe(true);
    expect(answerFirstPageHolds(map, [unresolved])).toEqual({ holds: false, outside: ["(no flow facet planned over the mapped type)"] });
    expect(answerFirstPageHolds(map, [])).toEqual({ holds: false, outside: ["(no flow facet planned over the mapped type)"] });
    // a flow over another type of the file is not a flow over the mapped one
    const other = flowOverType([], { focal: { path: FILE, name: "Other", start: 800, end: 900, callable: false } });
    expect(answerFirstPageHolds(map, [other]).holds).toBe(false);
  });
});

describe("withoutNamedFileArtifacts — the type's own file name in a request is a file name (pure)", () => {
  const JA_TAIL = "payment / inventory / shipping をどの順番で呼んでいるかを中心に、何をしているクラスか短く説明してほしい (40行以内、構造の地図として見たい)。コード変更は不要。";
  const EN_PLAIN = "Explain what the big OrderOrchestrator class does, around how it calls payment / inventory / shipping and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";
  const FORMS = [
    ["JA, the file first", `OrderOrchestrator.java の OrderOrchestrator クラスについて、${JA_TAIL}`, `OrderOrchestrator クラスについて、${JA_TAIL}`],
    ["JA, the file in parentheses", "OrderOrchestrator (OrderOrchestrator.java) っていうクラスについて、" + JA_TAIL, "OrderOrchestrator っていうクラスについて、" + JA_TAIL],
    ["EN, `(in OrderOrchestrator.java)`", EN_PLAIN.replace("OrderOrchestrator class", "OrderOrchestrator class (in OrderOrchestrator.java)"), EN_PLAIN],
  ] as const;
  const PATH = "backend/src/main/java/com/shopflow/service/OrderOrchestrator.java";
  const shape = (query: string, typePath = PATH) => withoutNamedFileArtifacts(extractFacetRequirements(query), query, typePath)
    .map(requirement => ({ facet: requirement.facet, ids: requirement.subjectIdentifiers, terms: requirement.subjectTerms, qualified: requirement.qualifiedMembers ?? [] }));

  it.each(FORMS)("%s: the requirements are those of the same request without the file name — no `OrderOrchestrator.java` pair, no `java` term", (_name, named, plain) => {
    const raw = extractFacetRequirements(named);
    expect(raw.some(requirement => (requirement.qualifiedMembers ?? []).some(pair => pair.owner === "OrderOrchestrator" && pair.member === "java")), "the extractor reads the file name as owner.member").toBe(true);
    expect(raw.some(requirement => requirement.subjectTerms.includes("java"))).toBe(true);
    expect(shape(named)).toEqual(shape(plain));
    expect(shape(named).every(requirement => requirement.qualified.length === 0 && !requirement.terms.includes("java"))).toBe(true);
  });

  it("a request that uses the extension as a word of its own keeps the term; another file's name, a lowercase stem and a request that names no file are untouched", () => {
    const own = `OrderOrchestrator.java の OrderOrchestrator クラスについて、java の例外は ${JA_TAIL}`;
    expect(shape(own).some(requirement => requirement.terms.includes("java"))).toBe(true);
    expect(shape(own).every(requirement => requirement.qualified.length === 0)).toBe(true);
    const other = `OrderStatus.java の OrderOrchestrator クラスについて、${JA_TAIL}`;
    expect(shape(other).some(requirement => requirement.qualified.some(pair => pair.owner === "OrderStatus" && pair.member === "java"))).toBe(true);
    const untouched = extractFacetRequirements(FORMS[0][2]);
    expect(withoutNamedFileArtifacts(untouched, FORMS[0][2], PATH)).toEqual(untouched);
    expect(withoutNamedFileArtifacts(extractFacetRequirements(FORMS[0][1]), FORMS[0][1], "src/orders.py"), "a file the request does not name").toEqual(extractFacetRequirements(FORMS[0][1]));
  });
});

describe("a flow facet that requires a window OUTSIDE the type: the flag changes nothing, every reply is the flag-unset reply", () => {
  const desks = [
    ["a top-level function of the same file builds the desk and bills through it", (root: string) => { writeAfDesk(root, 16, { topLevel: AF_TOP_LEVEL_FUNCTION }); }, AF_DESK_QUERY],
    ["a sibling file builds the desk and warms the billing client up", (root: string) => { writeAfDesk(root, 16, { files: AF_SIBLING_FILE }); }, AF_DESK_QUERY],
    ["a second facet names a function of another file (its focal and its value are windows the core does not hold)", (root: string) => {
      writeAfDesk(root, 16, { files: { "src/util.ts": ["export const BACKOFF_BASE_MS = 250;", "", "export function backoffMs(attempt: number): number {", "  return BACKOFF_BASE_MS * 2 ** attempt;", "}", ""].join("\n") } });
    }, `${AF_DESK_QUERY.replace(" No code changes.", "")} And what does backoffMs() return? No code changes.`],
    ["a Java sibling file builds the desk", (root: string) => {
      writeOwedRowsDesk(root, 16, 2);
      fs.writeFileSync(path.join(root, "src/main/java/demo/DeskFactory.java"), ["package demo;", "", "public class DeskFactory {",
        "    public OrderDesk open(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService, TicketRepository repo) {",
        "        OrderDesk desk = new OrderDesk(billingClient, stockLedger, deliveryService, repo);", "        billingClient.warmUp();", "        return desk;", "    }", "}", ""].join("\n"));
    }, OWED_ROWS_DESK_QUERY],
  ] as const;

  it.each(desks)("%s", async (name, populate, query) => {
    for (const [flagName, env] of FLAG_SETS) {
      const [offWs, onWs] = [cell(populate), cell(populate)];
      expect(await expectInvariant(`${name}, ${flagName}`, offWs, onWs, env, query)).toBe("unchanged");
    }
  }, 600_000);

  it("the same desks WITHOUT that window are answered first: one act.answer, the advisory states what the core left owed (the control)", async () => {
    for (const [flagName, env] of FLAG_SETS) {
      const [offWs, onWs] = [cell(root => { writeAfDesk(root, 16); }), cell(root => { writeAfDesk(root, 16); })];
      expect(await expectInvariant(`plain desk, ${flagName}`, offWs, onWs, env, AF_DESK_QUERY)).toBe("answer-first");
    }
  }, 600_000);
});

describe("the pack ceiling decides between the two replies, and between them nothing: a ceiling sweep of the 16-step desk", () => {
  // 8,200-8,400 B: the core and the first tier of the advisory do not fit — the chain is the flag-unset chain, whatever it is
  // (a discover loop that never converges under a ceiling this small is the flag-unset reply too). 8,600 B and up: the first reply answers.
  it.each([8_200, 8_400, 8_600, 9_000, 10_000, 12_000, COPILOT_CEILING])("TOKENLIGHTEN_TASK_PACK_MAX_BYTES=%i", async (ceiling) => {
    const env = { ...COPILOT_ENV, ...GROUPING, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: String(ceiling) };
    const [offWs, onWs] = [cell(root => { writeOwedRowsDesk(root, 16, 2); }), cell(root => { writeOwedRowsDesk(root, 16, 2); })];
    const verdict = await expectInvariant(`ceiling ${ceiling}`, offWs, onWs, env, OWED_ROWS_DESK_QUERY);
    expect(verdict).toBe(ceiling <= 8_400 ? "unchanged" : "answer-first");
  }, 400_000);
});

describe("a request that spells the type's own file name is planned as the same request without it", () => {
  // The constructor calls a helper of the class (seedMoves): the flow facet of a request that names `OrderDesk.java` is, by default, the
  // callable named like the class — the constructor — and its callees, not the map (readCodeTaskPack.ts `withoutNamedFileArtifacts`).
  const seededDesk = (root: string): void => {
    const desk = owedRowsDesk(16, 2);
    const lines = [...desk.lines];
    const at = lines.findIndex(line => line.includes("this.ticketRepository = ticketRepository;"));
    lines.splice(at + 1, 0, "        seedMoves();");
    const close = lines.findIndex((line, index) => index > at && line === "    }");
    lines.splice(close + 1, 0, "", "    private void seedMoves() {", "        MOVES.put(DeskState.OPEN, EnumSet.of(DeskState.BILLED));", "    }");
    const put = (rel: string, content: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
    put(OWED_ROWS_DESK_FILE, lines.join("\n"));
    put(OWED_ROWS_DESK_STATE_FILE, "package demo.model;\n\n/** States. */\npublic enum DeskState {\n    OPEN,\n    BILLED,\n    SHIPPED,\n    VOID;\n}\n");
  };
  const BASE = "billing / stock / delivery をどの順番で呼んでいるかを中心に、何をしているクラスか短く説明してほしい (30行以内、構造の地図として見たい)。コード変更は不要。";
  const FORMS = [
    ["JA, the file first: `OrderDesk.java の OrderDesk クラスについて、…`", `OrderDesk.java の OrderDesk クラスについて、${BASE}`, `OrderDesk クラスについて、${BASE}`],
    ["JA, the file in parentheses after the class: `OrderDesk (OrderDesk.java) っていうクラスについて、…`", `OrderDesk (OrderDesk.java) っていうクラスについて、${BASE}`, `OrderDesk っていうクラスについて、${BASE}`],
    ["EN: `… OrderDesk class (in OrderDesk.java) …`", "Explain what the big OrderDesk class (in OrderDesk.java) does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 30 lines). No code changes.", "Explain what the big OrderDesk class does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 30 lines). No code changes."],
  ] as const;

  it.each(FORMS)("%s: answered first, with the evidence of the request without the file name", async (_name, named, plain) => {
    const env = { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST };
    const [withName, without] = [await run(cell(seededDesk), env, named), await run(cell(seededDesk), env, plain)];
    expect(withName.map(reply => reply.body.decision.kind), JSON.stringify(withName.map(reply => reply.bytes))).toEqual(["act.answer"]);
    expect(without.map(reply => reply.body.decision.kind)).toEqual(["act.answer"]);
    expect(servedRows(withName)).toEqual(servedRows(without));
    // the advisory's tiers about the bodies, the guards and the constants are the same; only the room for the call index can differ with the request's length
    const tiers = (reply: Reply): string => String(reply.body.advisory).split("; concern calls in unserved bodies")[0]!;
    expect(tiers(withName[0]!)).toBe(tiers(without[0]!));
    expect(withName[0]!.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
  }, 400_000);

  it("flag unset, the default path is what it was: the file-named request's flow is planned on the constructor, and its chain ends on fewer rows than the plain request's (described here, not endorsed; the flag leaves it alone)", async () => {
    const env = { ...COPILOT_ENV, ...GROUPING };
    const [offNamed, offPlain] = [await run(cell(seededDesk), env, FORMS[0][1]), await run(cell(seededDesk), env, FORMS[0][2])];
    const rowsAtTheEnd = (replies: Reply[]): number => ((replies.at(-1)!.body.evidence ?? []) as unknown[]).length;
    expect(offNamed.at(-1)!.body.decision.kind).toBe("act.answer");
    expect(offPlain.at(-1)!.body.decision.kind).toBe("act.answer");
    expect(rowsAtTheEnd(offNamed), "the file-named chain's last reply").toBeLessThan(rowsAtTheEnd(offPlain));
    for (const reply of [...offNamed, ...offPlain]) expect(reply.body.advisory).toBeUndefined();
    // …and with the answer-first flag on, a request that is NOT adopted for answer-first (a tight ceiling) is that same default reply, byte for byte
    const tight = { ...env, TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "8400" };
    const [offTight, onTight] = [cell(seededDesk), cell(seededDesk)];
    expect(await expectInvariant("file-named, tight ceiling", offTight, onTight, tight, FORMS[0][1])).toBe("unchanged");
  }, 400_000);
});

describe("a member the request names is in the cover when it calls a concern; when the cover cannot hold the named members, the request is served as without the flag", () => {
  const QUERY_WITH = (names: string): string => `OrderDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、${names} の挙動も含めて何をしているクラスか短く説明して (30行以内、構造の地図として見たい)。コード変更は不要。`;

  it("step3() named: served whole beside step0, the other steps owed", async () => {
    let desk!: ReturnType<typeof owedRowsDesk>;
    const ws = cell(root => { desk = writeOwedRowsDesk(root, 16, 2); });
    const replies = await run(ws, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, QUERY_WITH("step3()"));
    expect(replies.map(reply => reply.body.decision.kind), JSON.stringify(replies.map(reply => reply.bytes))).toEqual(["act.answer"]);
    const held = carriedLines(replies, OWED_ROWS_DESK_FILE);
    const [step0, step3, step4] = [desk.steps[0]!, desk.steps[3]!, desk.steps[4]!];
    for (const step of [step0, step3]) for (let line = step.signature; line <= step.end; line++) if (desk.lines[line - 1]!.trim() !== "") expect(held.has(line), `${step.name} line ${line} is served whole`).toBe(true);
    for (const line of step4.rows.filter(line => line !== step4.signature)) expect(held.has(line), `step4 line ${line} is owed`).toBe(false);
    const advisory = replies[0]!.body.advisory as string;
    expect(advisory.startsWith(`structure map: served whole: step0 ${step0.signature}-${step0.end}, step3 ${step3.signature}-${step3.end}; bodies not served of members that call `)).toBe(true);
    expect(advisory).not.toContain(`step3 ${step3.signature + 1}-`);
  }, 400_000);

  it("step1(), step2() and step3() named: the entry point and three more are four members, no cover — every reply is the flag-unset reply", async () => {
    const query = QUERY_WITH("step1() と step2() と step3()");
    for (const [flagName, env] of FLAG_SETS) {
      const [offWs, onWs] = [cell(root => { writeOwedRowsDesk(root, 16, 2); }), cell(root => { writeOwedRowsDesk(root, 16, 2); })];
      const off = await run(offWs, env, query);
      const on = await run(onWs, { ...env, ...ANSWER_FIRST }, query);
      expect(on.length, `${flagName}: reply count`).toBe(off.length);
      on.forEach((reply, index) => {
        expect(normalized(reply.body, onWs), `${flagName}: reply ${index + 1}`).toBe(normalized(off[index]!.body, offWs));
        expect(reply.bytes, `${flagName}: reply ${index + 1} bytes`).toBe(off[index]!.bytes);
        expect(reply.body.advisory, `${flagName}: rejected candidate must not attach an advisory`).toBeUndefined();
      });
      expect(off.at(-1)!.body.decision.kind, `${flagName}: ordinary chain reaches its answer`).toBe("act.answer");
      expect(on.at(-1)!.body.decision.kind, `${flagName}: rejected candidate follows the ordinary chain to its answer`).toBe("act.answer");
      expect(servedRows(on), `${flagName}: complete served-evidence ledger`).toEqual(servedRows(off));
    }
  }, 400_000);
});

describe("a class whose concern calls hang from no field it receives: the named rule, and the words of the request's own form are no concern", () => {
  // `billing`, `stock` and `delivery` are module-level objects here (helpers/answerFirstDesks.ts `ambient`): no collaborator field, so
  // the collaborators rule finds no member and the named rule decides. `render` calls nothing of the three, and `rows.map(…)` has the
  // name of a word the request uses for the shape of its answer ("as a map of its structure").
  const RENDER = [
    "  /** Renders the desk's rows as text. */", "  render(rows: Row[]): string {", "    const lines = rows.map(row => row.label);", "    const widths = lines.map(line => line.length);",
    "    const total = widths.reduce((sum, width) => sum + width, 0);", "    return lines.join('\\n') + total;", "  }",
  ];
  const QUERY = "Explain what the big OrderDesk class does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";

  it("step0 is served whole, `render` is neither served nor listed, the concerns named are billing/stock/delivery, and the call index states the calls on the module-level objects", async () => {
    let desk!: ReturnType<typeof writeAfDesk>;
    const ws = cell(root => { desk = writeAfDesk(root, 16, { ambient: true, extraMembers: RENDER }); });
    const replies = await run(ws, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST }, QUERY);
    expect(replies.map(reply => reply.body.decision.kind), JSON.stringify(replies.map(reply => reply.bytes))).toEqual(["act.answer"]);
    const advisory = replies[0]!.body.advisory as string;
    const step0 = desk.steps[0]!;
    expect(advisory.startsWith(`structure map: served whole: step0 ${step0.signature}-${step0.end}; bodies not served of members that call billing/stock/delivery: `), advisory).toBe(true);
    expect(advisory, "the word `map` of the request's shape is no concern").not.toMatch(/billing\/stock\/delivery\/map/u);
    expect(advisory).not.toContain("render");
    const held = carriedLines(replies, "src/orderDesk.ts");
    const renderAt = desk.lines.findIndex(line => line.includes("render(rows: Row[]): string {")) + 1;
    expect(renderAt).toBeGreaterThan(0);
    expect(held.has(renderAt + 1), "render's body is not on the page").toBe(false);
    for (let line = step0.signature; line <= step0.end; line++) if (desk.lines[line - 1]!.trim() !== "") expect(held.has(line), `step0 line ${line}`).toBe(true);
    const calls = /concern calls in unserved bodies, in source order: (.*)$/u.exec(advisory)?.[1] ?? "";
    expect(calls).toMatch(/^route billing\.refund L\d+ \[case refund\] \/ delivery\.recall L\d+ \[case recall\] \/ stock\.release L\d+ \[default\], stock\.restore L\d+ \[if order\.void\] \/ billing\.settle L\d+ \[else\] \| step1 stock\.reserve L\d+, billing\.charge L\d+, stock\.release L\d+, delivery\.ship L\d+/u);
    expect(advisory, "facts only").not.toMatch(/\b(?:should|must|please|tl_[a-z_]+|use|fetch|run)\b/iu);
  }, 240_000);
});

describe("the sizes: T03-length requests, the state store off and the reply compaction rolled back", () => {
  // Every first reply of an adopted page is under its ceiling with at least the first tier of the advisory, whatever the request's length
  // (the request is restated in the certificate's gaps) and whichever rollbacks are set: the room is measured, not allowed for.
  const LENGTHS = [0, 700, 3_000];
  const ROLLBACKS = [
    ["state store off", { TOKENLIGHTEN_STATE_STORE: "off" }],
    ["reply compaction off", { TL_EFF_REPLY_COMPACT: "0" }],
    ["both off", { TOKENLIGHTEN_STATE_STORE: "off", TL_EFF_REPLY_COMPACT: "0" }],
  ] as const;
  const padded = (extra: number): string => {
    let query = OWED_ROWS_DESK_QUERY;
    while (Buffer.byteLength(query, "utf8") - Buffer.byteLength(OWED_ROWS_DESK_QUERY, "utf8") < extra) query += "\n補足: 以下は文脈の説明であり、コードの変更は求めていない。背景として、この件は新入りメンバーの引き継ぎ資料の作成に使う。";
    return query;
  };

  it.each(LENGTHS.flatMap(extra => ROLLBACKS.map(([name, env]) => [extra, name, env] as const)))("the 104-step desk, %i B longer, %s: one act.answer under 18,432 B, the first tier of the advisory present", async (extra, _name, env) => {
    const ws = cell(root => { writeOwedRowsDesk(root, 104, 2); });
    const [reply] = await run(ws, { ...COPILOT_ENV, ...GROUPING, ...ANSWER_FIRST, ...env }, padded(extra), 1);
    expect(reply!.body.decision.kind, `${reply!.bytes}`).toBe("act.answer");
    expect(reply!.bytes).toBeLessThanOrEqual(COPILOT_CEILING);
    expect(reply!.body.advisory as string).toContain("bodies not served of members that call");
    expect(reply!.body.advisory as string).toContain("step103 ");
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The backstop, in-process: an adopted page that does not ship as the answer.
// ---------------------------------------------------------------------------

async function inProcess(ws: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await callTool("tl_read_file", { cwd: ws, ...args });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  return JSON.parse(text) as Record<string, any>;
}

describe("an adopted answer-first page that a late pass withdraws: the rest of the chain runs under the ordinary map's requirements, not the core's", () => {
  const saved: Record<string, string | undefined> = {};
  let afterClientRestore: (() => void) | undefined;
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
    afterClientRestore?.();
    afterClientRestore = undefined;
    for (const key of Object.keys(FLAGS)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("the discover that follows the withdrawal carries no advisory, and following it serves the ordinary map's rows of every step — the core alone would have stopped at step0", async () => {
    let desk!: ReturnType<typeof owedRowsDesk>;
    const ws = cell(root => { desk = writeOwedRowsDesk(root, 16, 2); });
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
    expect(withdrawn, "the seam removed the class's surface").toBeGreaterThan(0);
    expect(hop0["decision"]?.kind).not.toBe("act.answer");
    expect(hop0["advisory"], "the facts describe an answer-first page; this reply is not one").toBeUndefined();
    const responses = [hop0];
    let next = Array.isArray(hop0["decision"]?.next) ? hop0["decision"].next[0] : hop0["decision"]?.next;
    for (let hop = 1; hop < 14 && next !== undefined; hop++) {
      expect(next.tool).toBe("tl_read_file");
      const response = await inProcess(ws, expandedReadNextArguments(next.arguments, ws) ?? next.arguments);
      responses.push(response);
      const following = response["decision"]?.next;
      next = Array.isArray(following) ? following[0] : following;
    }
    expect(responses.at(-1)!["decision"]?.kind, JSON.stringify(responses.map(response => response["decision"]?.kind))).toBe("act.answer");
    const held = new Set<number>();
    for (const response of responses) {
      for (const row of (response["evidence"] ?? []) as any[]) {
        const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
        if (row.path !== OWED_ROWS_DESK_FILE || typeof row.body !== "string" || window === null) continue;
        for (let line = Number(window[1]); line <= Number(window[2]); line++) held.add(line);
      }
    }
    // the ordinary map requires the rows of EVERY member that calls a concern; step0's whole body is not all it asks
    for (const step of desk.steps) for (const line of step.rows) expect(held.has(line), `${step.name} line ${line} is served by the end of the chain`).toBe(true);
  }, 240_000);

  it("no room under the ceiling for even the first tier of the advisory: the reply is not the answer-first reply (no certificate over the core, no advisory), and the chain is the ordinary map's", async () => {
    let desk!: ReturnType<typeof owedRowsDesk>;
    const ws = cell(root => {
      desk = writeOwedRowsDesk(root, 16, 2);
      // a file of exact source the pass below adds to the finished pack: it takes the room the advisory would have had
      fs.writeFileSync(path.join(root, "src/main/java/demo/Padding.java"), Array.from({ length: 700 }, (_, index) => `// padding line ${index} of a file that fills the pack up to its ceiling`).join("\n") + "\n");
    });
    // The client whose bodies the size preview can prove exact (copilot-cli): the room is the finished pack's measured size, the padding
    // included. Any other client has the plan's estimate, which the pass below does not change.
    const clientBefore = process.env["TOKENLIGHTEN_CLIENT_ID"];
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "copilot-cli";
    afterClientRestore = () => {
      if (clientBefore === undefined) delete process.env["TOKENLIGHTEN_CLIENT_ID"];
      else process.env["TOKENLIGHTEN_CLIENT_ID"] = clientBefore;
    };
    let padded = 0;
    setPostCertificationPassForTest(surfaces => {
      const padding = "src/main/java/demo/Padding.java";
      const code = fs.readFileSync(path.join(ws, padding), "utf8").split("\n").slice(0, 400).join("\n");
      const handle = handleTable.upsert({ kind: "range", path: padding, range: "1-400", workspaceRoot: ws, sha: "pad" });
      surfaces.push({ role: "domain", handle: handle.id, path: padding, range: "1-400", required: false, why: "test padding", code } as never);
      padded += 1;
      setPostCertificationPassForTest(undefined);
    });
    const hop0 = await inProcess(ws, { query: OWED_ROWS_DESK_QUERY, task: TASK });
    expect(padded, "the seam ran").toBe(1);
    expect(hop0["decision"]?.kind, JSON.stringify(hop0["decision"])).not.toBe("act.answer");
    expect(hop0["advisory"]).toBeUndefined();
    const responses = [hop0];
    let next = Array.isArray(hop0["decision"]?.next) ? hop0["decision"].next[0] : hop0["decision"]?.next;
    for (let hop = 1; hop < 14 && next !== undefined; hop++) {
      const response = await inProcess(ws, expandedReadNextArguments(next.arguments, ws) ?? next.arguments);
      responses.push(response);
      const following = response["decision"]?.next;
      next = Array.isArray(following) ? following[0] : following;
    }
    expect(responses.at(-1)!["decision"]?.kind, JSON.stringify(responses.map(response => response["decision"]?.kind))).toBe("act.answer");
    const held = new Set<number>();
    for (const response of responses) {
      for (const row of (response["evidence"] ?? []) as any[]) {
        const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
        if (row.path !== OWED_ROWS_DESK_FILE || typeof row.body !== "string" || window === null) continue;
        for (let line = Number(window[1]); line <= Number(window[2]); line++) held.add(line);
      }
    }
    for (const step of desk.steps) for (const line of step.rows) expect(held.has(line), `${step.name} line ${line} is served by the end of the chain`).toBe(true);
  }, 240_000);
});
