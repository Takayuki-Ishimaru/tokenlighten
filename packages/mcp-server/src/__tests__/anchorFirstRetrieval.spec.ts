/**
 * anchorFirstRetrieval.spec.ts — the anchors a request NAMES are looked up in
 * the workspace first, and `act.answer` waits for their definitions
 * (2026-10-29 first-hop field report; features/task-pack/anchorFirst.ts,
 * requestAnchors.ts).
 *
 * Field report: "express の res.redirect がどう動くか説明して" answered from a
 * Readme (the primary became `lib/express.js`, `var res = require(...)`);
 * `res.redirect` itself (`lib/response.js`, `res.redirect = function redirect(url) {…}`)
 * was never served. A pricing question certified `act.answer` with a call site of
 * `MODEL_PRICES` and not its definition. A task text carrying
 * `[default: (unlimited)]` (a literal `grep` finds at once) got `await_input` and
 * ten kilobytes of unrelated evidence.
 *
 * Fixtures are fresh (helpers/anchorFirstFixtures.ts); none is keyed to the real
 * repositories the report measured.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  anchorDefinitionsFor,
  requestAnchorsOf,
  resetAnchorResolutions,
  resolveAnchorDefinitions,
  resolveAnchorDefinitionsSync,
  resolveAnchorLiterals,
  type AnchorIO,
} from "../features/task-pack/anchorFirst.js";
import { locateTaskContext } from "../features/locator/locateTaskContext.js";
import { explicitCodeIdentifiers } from "../features/task-pack/readCodeTaskPack.js";
import { makeSmallTaskWorkspace, startSmallTaskServer, type CallResult, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CLICK_FILES,
  COMPUTE_TOTAL_FILES,
  EXPRESS_FILES,
  MODEL_PRICES_FILES,
} from "./helpers/anchorFirstFixtures.js";

interface Row {
  readonly path: string;
  readonly range: string;
  readonly body?: string;
  readonly remaining?: string[];
  readonly why?: string;
  readonly symbol?: string;
}

const rowsOf = (call: CallResult): Row[] => ((call.body["evidence"] as Row[] | undefined) ?? []);
const decisionOf = (call: CallResult): { kind: string; next?: { tool: string; arguments: Record<string, unknown> }; gaps?: Array<{ code: string; refs?: string[] }> } =>
  call.body["decision"] as never;

/** The reply, followed through its `discover.next` calls until it acts (at most three hops). */
async function followToAct(server: SmallTaskServer, first: CallResult, maxHops = 3): Promise<{ hops: CallResult[] }> {
  const hops = [first];
  while (hops.length <= maxHops) {
    const last = hops[hops.length - 1]!;
    const decision = decisionOf(last);
    if (decision.kind.startsWith("act.") || decision.next === undefined) break;
    hops.push(await server.call(decision.next.tool, { cwd: server.workspace, ...decision.next.arguments }, 120000));
  }
  return { hops };
}

const servers: SmallTaskServer[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) {
    await server.kill();
    await rmDirWithRetry(server.workspace);
  }
});

/** The ten semantic-frontier v2 flags the shipped configuration runs with (fxR3cNamedFrontier.spec.ts). */
const SF_V2_ENV: Readonly<Record<string, string>> = Object.fromEntries([
  "TL_SF_STATEFUL", "TL_SF_DEMOTE", "TL_SF_STRUCTURAL_CONCERNS", "TL_SF_RELATION_PACKETS", "TL_SF_VERIFY_FIRST",
  "TL_SF_CONTINUATION_BUNDLE", "TL_CWD_NEAR_MISS", "TL_RECEIPT_COVERAGE", "TL_BATCH_HINTS", "TL_SEARCH_DEDUP", "TL_GRAPH_EVIDENCE",
].map((flag) => [flag, "1"]));

async function startFixture(prefix: string, files: Readonly<Record<string, string>>, env?: Readonly<Record<string, string>>): Promise<SmallTaskServer> {
  const server = await startSmallTaskServer(makeSmallTaskWorkspace(prefix, files), env === undefined ? {} : { env });
  servers.push(server);
  return server;
}

const read = (server: SmallTaskServer, args: Record<string, unknown>): Promise<CallResult> =>
  server.call("tl_read_file", { cwd: server.workspace, task: { epoch: "new" }, ...args }, 120000);

describe("express-shaped: a dotted member the request names is served at its definition", () => {
  let server: SmallTaskServer;
  beforeAll(async () => {
    server = await startFixture("tl-anchor-express-", EXPRESS_FILES);
  }, 120000);

  it.each([
    ["Japanese", "express の res.redirect がどう動くか説明して"],
    ["English", "How does res.redirect work?"],
  ])("%s: the first row is lib/response.js with the whole res.redirect definition, nothing else carries a body", async (_label, query) => {
    const reply = await read(server, { query });
    const rows = rowsOf(reply);
    expect(rows[0]?.path).toBe("lib/response.js");
    const body = rows[0]?.body ?? "";
    expect(body).toContain("res.redirect = function redirect(url) {");
    expect(body).toContain("this.end(body);");
    expect(body.trimEnd().endsWith("};")).toBe(true);
    // The rest of the file is disclosed as `remaining` (the usual convention), never a hole inside the definition (lines 39-72).
    for (const hole of rows[0]?.remaining ?? []) {
      const [from, to] = hole.split("-").map(Number);
      expect(to! < 39 || from! > 72, `remaining ${hole} cuts into the res.redirect definition`).toBe(true);
    }
    for (const row of rows.slice(1)) {
      if (/history\.md$/i.test(row.path) || /readme\.md$/i.test(row.path)) expect(row.body).toBeUndefined();
    }
    expect(rows.some((row) => /history\.md$/i.test(row.path) && row.body !== undefined)).toBe(false);
    expect(reply.bytes).toBeLessThanOrEqual(6 * 1024);
    // …and the answer is allowed: the certificate names the anchor it proved.
    const decision = decisionOf(reply);
    expect(decision.kind).toBe("act.answer");
    const certificate = (decision as unknown as { certificate?: { obligations?: string[] } }).certificate;
    expect(certificate?.obligations ?? []).toContain("identifier:res.redirect");
  }, 120000);

  it("two anchors in two files: both definitions carry bodies, every other row is a location (path, range, remaining = its whole range)", async () => {
    const reply = await read(server, { query: "Compare res.redirect with req.accepts: what do they return?" });
    const rows = rowsOf(reply);
    const definitions = rows.filter((row) => row.why === "request-anchor-definition");
    expect(definitions.map((row) => row.path).sort()).toEqual(["lib/request.js", "lib/response.js"]);
    expect(definitions.every((row) => (row.body ?? "").length > 0)).toBe(true);
    expect(definitions.find((row) => row.path === "lib/request.js")?.body).toContain("req.accepts = function");
    const history = rows.find((row) => /history\.md$/i.test(row.path));
    if (history !== undefined) {
      expect(history.body).toBeUndefined();
      expect(history.remaining).toEqual([history.range]);
    }
  }, 120000);

  it("a sibling member of the same object is not the subject: res.location is served only when asked", async () => {
    const reply = await read(server, { query: "How does res.location encode the url?" });
    const rows = rowsOf(reply);
    expect(rows[0]?.path).toBe("lib/response.js");
    expect(rows[0]?.body ?? "").toContain("res.location = function location(url) {");
    expect(rows[0]?.body ?? "").not.toContain("res.redirect = function redirect(url) {");
  }, 120000);

  it("a chain the workspace defines nowhere (a stdlib call) mints no obligation and blocks nothing", async () => {
    const reply = await read(server, { query: "Does res.redirect use path.join anywhere?" });
    const decision = decisionOf(reply);
    const certificate = (decision as unknown as { certificate?: { obligations?: string[] } }).certificate;
    expect(decision.kind).not.toBe("await_input");
    expect(certificate?.obligations ?? []).not.toContain("identifier:path.join");
    expect(rowsOf(reply)[0]?.path).toBe("lib/response.js");
  }, 120000);
});

describe("a file the request names stays addressable beside an anchor, under a tight byte cap", () => {
  const CONTRACT = ["# Contract", "", ...Array.from({ length: 220 }, (_, i) => `- rule ${i}: the mixer must keep shelf ${i} within bounds.`), ""].join("\n");
  const FILES: Record<string, string> = {
    "docs/CONTRACT.md": CONTRACT,
    "src/mixer.ts": [
      "export function mixerDispatch(x: number): number {",
      "  return mixerApply(x) + 1;",
      "}",
      "export function mixerApply(v: number): number { return v * 2; }",
      ...Array.from({ length: 30 }, (_, k) => `export const mixer_${k} = ${k};`),
      "",
    ].join("\n"),
  };

  it("…also when the anchor is declared in two non-implementation files (two definition rows lead the pack)", async () => {
    const helper = (name: string): string => ["export function " + name + "Dispatch(x: number): number {", "  return mixerApply(x) + 1;", "}", "export function mixerApply(v: number): number { return v * 2; }", ""].join(String.fromCharCode(10));
    const server = await startFixture("tl-anchor-named-cap2-", {
      "docs/CONTRACT.md": FILES["docs/CONTRACT.md"]!,
      "tests/a.test.ts": helper("a"),
      "tests/b.test.ts": helper("b"),
    }, SF_V2_ENV);
    const reply = await read(server, {
      query: "Explain how mixerApply is wired in tests and whether that matches CONTRACT.md; CONTRACT.md is authoritative.",
      budget: { bytes: 8000 },
    });
    const addresses = [...rowsOf(reply).map((row) => row.path), ...((reply.body["frontier_index"] as Array<{ path?: string }> | undefined) ?? []).map((entry) => entry.path)];
    expect(addresses, JSON.stringify(decisionOf(reply)).slice(0, 400)).toContain("docs/CONTRACT.md");
  }, 120000);

  it("…and when five same-named contracts compete and the anchor is declared in twelve non-implementation files", async () => {
    const nl = String.fromCharCode(10);
    const files: Record<string, string> = {};
    for (const family of ["aeroctl", "bravo", "charlie", "delta", "echo"]) files["fixtures/" + family + "/CONTRACT.md"] = FILES["docs/CONTRACT.md"]!;
    for (let i = 0; i < 12; i += 1) {
      files["fixtures/aeroctl/firmware/src/fixture_mod" + i + ".ts"] = ["export function mod" + i + "Dispatch(x: number): number {", "  return mixerApply(x) + 1;", "}", "export function mixerApply(v: number): number { return v * 2; }", ...Array.from({ length: 30 }, (_, k) => "export const mod" + i + "_" + k + " = " + k + ";"), ""].join(nl);
    }
    const server = await startFixture("tl-anchor-named-cap3-", files, SF_V2_ENV);
    const reply = await read(server, {
      query: "Explain how mixerApply and its imports are wired in fixtures/aeroctl/firmware/src and whether that matches CONTRACT.md; CONTRACT.md is authoritative.",
      budget: { bytes: 8000 },
    });
    const addresses = [...rowsOf(reply).map((row) => row.path), ...((reply.body["frontier_index"] as Array<{ path?: string }> | undefined) ?? []).map((entry) => entry.path)];
    expect(addresses, JSON.stringify(decisionOf(reply)).slice(0, 400)).toContain("fixtures/aeroctl/CONTRACT.md");
    expect(decisionOf(reply).kind).toBe("discover");
    expect(decisionOf(reply).next?.tool).toBeTruthy();
  }, 120000);

  it("CONTRACT.md is evidence or a frontier_index address of the first reply, and the anchor keeps its body", async () => {
    const server = await startFixture("tl-anchor-named-cap-", FILES, SF_V2_ENV);
    const reply = await read(server, {
      query: "Explain how mixerApply is wired in src/mixer.ts and whether that matches CONTRACT.md; CONTRACT.md is authoritative.",
      budget: { bytes: 8000 },
    });
    const rows = rowsOf(reply);
    const addresses = [...rows.map((row) => row.path), ...((reply.body["frontier_index"] as Array<{ path?: string }> | undefined) ?? []).map((entry) => entry.path)];
    expect(addresses, JSON.stringify(decisionOf(reply)).slice(0, 400)).toContain("docs/CONTRACT.md");
    const anchor = rows.find((row) => row.path === "src/mixer.ts");
    expect(anchor?.body).toContain("mixerApply");
    expect(reply.bytes).toBeLessThanOrEqual(12 * 1024);
  }, 120000);
});

describe("act.answer waits for the definition of a name the workspace defines", () => {
  it("computeTotal: a served call site proves nothing — discover reads the definition, then act.answer", async () => {
    const server = await startFixture("tl-anchor-total-", COMPUTE_TOTAL_FILES);
    const first = await read(server, {
      query: "Explain how computeTotal is used when checking out",
      task: { epoch: "new", profile: "answer" },
      targets: [{ path: "src/checkout.ts" }],
    });
    // Only the call site was served.
    expect(rowsOf(first).map((row) => row.path)).toEqual(["src/checkout.ts"]);
    expect(rowsOf(first)[0]?.body).toContain("computeTotal(items)");
    const decision = decisionOf(first);
    expect(decision.kind).toBe("discover");
    expect(decision.gaps?.flatMap((gap) => gap.refs ?? [])).toContain("identifier:computeTotal");
    expect(decision.next?.tool).toBe("tl_read_file");

    const { hops } = await followToAct(server, first);
    const last = hops[hops.length - 1]!;
    expect(decisionOf(last).kind).toBe("act.answer");
    const served = hops.flatMap(rowsOf).find((row) => row.path === "src/order.ts");
    expect(served?.body).toContain("export function computeTotal(items: LineItem[]): number {");
    expect(served?.body).toContain("return Math.round(total * 100) / 100;");
    // The follow-up reads the definition, not the whole workspace.
    expect(hops.length).toBe(2);
    expect(rowsOf(last).map((row) => row.path)).toEqual(["src/order.ts"]);
  }, 180000);

  it("computeTotal: asked cold, the first reply already carries the definition", async () => {
    const server = await startFixture("tl-anchor-total-cold-", COMPUTE_TOTAL_FILES);
    const reply = await read(server, { query: "What does computeTotal do with the bulk discount?" });
    const row = rowsOf(reply).find((entry) => entry.path === "src/order.ts");
    expect(row?.body).toContain("export function computeTotal(");
    expect(decisionOf(reply).kind).toBe("act.answer");
  }, 120000);

  it("MODEL_PRICES: a constant defined in one file and read in another is served at its definition", async () => {
    const server = await startFixture("tl-anchor-prices-", MODEL_PRICES_FILES);
    const reply = await read(server, { query: "How is the cost of a request computed from MODEL_PRICES?" });
    const definition = rowsOf(reply).find((row) => row.path === "src/pricing.ts");
    expect(definition?.body).toContain("export const MODEL_PRICES: Record<string, ModelPrice> = {");
    expect(definition?.body).toContain("\"beta-mini\"");
    expect(decisionOf(reply).kind).toBe("act.answer");
  }, 120000);

  it("MODEL_PRICES: asked about its call site, the answer is still never certified without the definition row", async () => {
    const server = await startFixture("tl-anchor-prices-cs-", MODEL_PRICES_FILES);
    const first = await read(server, {
      query: "What does estimateCost do with MODEL_PRICES?",
      task: { epoch: "new", profile: "answer" },
      targets: [{ path: "src/cost.ts" }],
    });
    const { hops } = await followToAct(server, first);
    const servedDefinition = (calls: CallResult[]): boolean =>
      calls.flatMap(rowsOf).some((row) => row.path === "src/pricing.ts" && row.body?.includes("export const MODEL_PRICES"));
    // Whichever hop first acts, the definition has been served by then.
    const acted = hops.findIndex((hop) => decisionOf(hop).kind === "act.answer");
    expect(acted).toBeGreaterThanOrEqual(0);
    expect(servedDefinition(hops.slice(0, acted + 1))).toBe(true);
  }, 180000);
});

describe("a bracketed literal the request names is found where it is written", () => {
  it("[default: (unlimited)] reaches the first reply with a body, and the pack does not ask for input", async () => {
    const server = await startFixture("tl-anchor-click-", CLICK_FILES);
    const reply = await read(server, { query: "Fix the help so count options show [default: (unlimited)]" });
    const hit = rowsOf(reply).find((row) => row.path === "tests/test_options.py");
    expect(hit?.body).toContain("[default: (unlimited)]");
    expect(decisionOf(reply).kind).not.toBe("await_input");
    // The changelog that merely repeats "default" and "help" carries no body.
    expect(rowsOf(reply).some((row) => /changes\.md$/i.test(row.path) && row.body !== undefined)).toBe(false);
  }, 120000);

  it("a quoted literal in an answer question is served at the function that holds it", async () => {
    const server = await startFixture("tl-anchor-quoted-", EXPRESS_FILES);
    const reply = await read(server, { query: "Where does the \"Redirecting to\" message come from?" });
    const hit = rowsOf(reply).find((row) => row.path === "lib/response.js");
    expect(hit?.body).toContain("Redirecting to");
    expect(decisionOf(reply).kind).not.toBe("await_input");
  }, 120000);
});

// ---------------------------------------------------------------------------
// In-process: the resolver itself
// ---------------------------------------------------------------------------

describe("anchorFirst resolver", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots.splice(0)) await rmDirWithRetry(root);
  });

  function workspaceOf(files: Readonly<Record<string, string>>): AnchorIO {
    const root = makeSmallTaskWorkspace("tl-anchor-unit-", files);
    roots.push(root);
    return {
      workspace: root,
      read: (relPath) => {
        try {
          return fs.readFileSync(path.join(root, relPath), "utf8");
        } catch {
          return undefined;
        }
      },
      isDeclarationShaped: (text, identifier) => new RegExp(`\\b(?:function|class|const|let|var|def|type|interface|enum)\\s+${identifier}\\b`).test(text),
    };
  }

  it("finds the assignment that declares a dotted member, with its brace-bounded extent", () => {
    const io = workspaceOf(EXPRESS_FILES);
    const resolution = resolveAnchorDefinitionsSync(io, ["res.redirect", "res.nothere"]);
    expect(resolution.definedIds).toEqual(["res.redirect"]);
    const [definition] = resolution.definitions;
    expect(definition).toMatchObject({ id: "res.redirect", path: "lib/response.js", startLine: 39 });
    expect(definition!.endLine).toBe(72);
  });

  it("parses with the host's symbols when it supplies them: the parsed extent and name win", async () => {
    const io: AnchorIO = {
      ...workspaceOf(EXPRESS_FILES),
      parsedSymbols: async () => [{ name: "res.redirect", kind: "function", startLine: 39, endLine: 70 }],
    };
    const resolution = await resolveAnchorDefinitions(io, ["res.redirect"]);
    expect(resolution.definitions).toHaveLength(1);
    expect(resolution.definitions[0]).toMatchObject({ symbol: "res.redirect", startLine: 39, endLine: 70 });
  });

  it("does not take a call site or a mention for a definition", () => {
    const io = workspaceOf(EXPRESS_FILES);
    expect(resolveAnchorDefinitionsSync(io, ["computeTotal"]).definedIds).toEqual([]);
    const shop = workspaceOf(COMPUTE_TOTAL_FILES);
    const resolution = resolveAnchorDefinitionsSync(shop, ["computeTotal"]);
    expect(resolution.definitions.map((definition) => definition.path)).toEqual(["src/order.ts"]);
  });

  it("leaves out a name several implementation files declare: which one the request means is the same-name logic's call", () => {
    const body = (second: string): string => ["export function settle(id: string" + second + "): string {", "  return id;", "}", ""].join("\n");
    const files: Record<string, string> = {
      "src/legacy/billing.ts": body(""),
      "src/billing.ts": body(", now: number"),
      "tests/billing.test.ts": body(""),
    };
    expect(resolveAnchorDefinitionsSync(workspaceOf(files), ["settle"]).definedIds).toEqual([]);
    // …while a test's or example's same-named helper is no rival for the one implementation.
    delete files["src/legacy/billing.ts"];
    const resolution = resolveAnchorDefinitionsSync(workspaceOf(files), ["settle"]);
    expect(resolution.definitions.map((definition) => definition.path)).toEqual(["src/billing.ts"]);
  });

  const EKF_FILES: Record<string, string> = {
    "include/ekf.hpp": [
      "class EKF {",
      " public:",
      "  void updateGps(const Vec3& pos);",
      "  bool first_gps_fix_ = true;",
      "};",
      "",
    ].join("\n"),
    "src/ekf.cpp": [
      "#include \"ekf.hpp\"",
      "",
      "void EKF::updateGps(const Vec3& pos) {",
      "  first_gps_fix_ = false;",
      "}",
      "",
    ].join("\n"),
  };

  it("a member of a type the request names is that type's business: no anchor definition of its own", async () => {
    const io: AnchorIO = {
      ...workspaceOf(EKF_FILES),
      parsedSymbols: async (_text, _lang, relPath) => relPath.endsWith(".hpp")
        ? [{ name: "updateGps", kind: "method", startLine: 3, endLine: 3, enclosingSymbol: { name: "EKF" } }]
        : [{ name: "EKF::updateGps", kind: "method", startLine: 3, endLine: 5 }],
    };
    const named = await resolveAnchorDefinitions({ ...io, query: "Explain what the big EKF class does around updateGps" }, ["updateGps"]);
    expect(named.definitions).toEqual([]);
    expect(named.definedIds).toEqual([]);
    // Without the type in the request the method is its own subject — at its definition, not its prototype.
    const bare = await resolveAnchorDefinitions({ ...io, query: "How does updateGps gate the first fix?" }, ["updateGps"]);
    expect(bare.definitions.map((definition) => definition.path)).toEqual(["src/ekf.cpp"]);
  });

  it("without a parser only an unmistakable declaration counts: a chain's assignment or a top-level statement, never a member", () => {
    const io = workspaceOf(EKF_FILES);
    expect(resolveAnchorDefinitionsSync(io, ["updateGps", "first_gps_fix_"]).definedIds).toEqual([]);
  });

  it("TL_ANCHOR_FIRST=0 makes every anchor invisible", async () => {
    const previous = process.env["TL_ANCHOR_FIRST"];
    process.env["TL_ANCHOR_FIRST"] = "0";
    try {
      expect(explicitCodeIdentifiers("express の res.redirect がどう動くか説明して")).toEqual([]);
      expect(requestAnchorsOf("How does res.redirect work?").chains).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["TL_ANCHOR_FIRST"]; else process.env["TL_ANCHOR_FIRST"] = previous;
    }
    expect(requestAnchorsOf("How does res.redirect work?").chains.map((chain) => chain.raw)).toEqual(["res.redirect"]);
  });

  it("anchorDefinitionsFor resolves on demand and remembers the answer", () => {
    resetAnchorResolutions();
    const io = workspaceOf(MODEL_PRICES_FILES);
    const query = "How is the cost computed from MODEL_PRICES?";
    expect(anchorDefinitionsFor(io, query, "MODEL_PRICES").map((definition) => `${definition.path}:${definition.startLine}-${definition.endLine}`))
      .toEqual(["src/pricing.ts:6-10"]);
    expect(anchorDefinitionsFor(io, query, "MODEL_PRICES")).toHaveLength(1);
    expect(anchorDefinitionsFor(io, query, "NOT_IN_THE_QUERY")).toEqual([]);
  });

  it("finds a literal's exact occurrences, implementation files first, at most two per literal", async () => {
    const io = workspaceOf({
      ...CLICK_FILES,
      "src/click/extra.py": "MESSAGE = \"[default: (unlimited)]\"\n",
      "tests/test_more.py": "def test_more():\n    assert \"[default: (unlimited)]\"\n",
    });
    const hits = await resolveAnchorLiterals(io, ["[default: (unlimited)]"]);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ path: "src/click/extra.py", implementation: true, line: 1 });
    expect(hits[1]!.implementation).toBe(false);
    expect(hits[1]!.path.startsWith("tests/")).toBe(true);
  });
});

describe("locateTaskContext: the anchors a request names lead the candidates", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots.splice(0)) await rmDirWithRetry(root);
  });
  const locate = async (files: Readonly<Record<string, string>>, query: string) => {
    const root = makeSmallTaskWorkspace("tl-anchor-locate-", files);
    roots.push(root);
    return locateTaskContext(root, { action: "locate", query, limit: 8 } as never) as Promise<{
      hit: boolean;
      primary?: Array<{ path: string; line: number; why: string; symbol?: string }>;
      candidateDetails?: Array<{ path: string; why: string }>;
    }>;
  };

  it("a dotted member is looked up whole: res.redirect is the primary, not the file named for `res`", async () => {
    const located = await locate(EXPRESS_FILES, "express の res.redirect がどう動くか説明して");
    expect(located.hit).toBe(true);
    expect(located.primary?.[0]).toMatchObject({ path: "lib/response.js", line: 39, why: "dotted-member", symbol: "res.redirect" });
  }, 120000);

  it("a member the workspace does not define is no anchor: the locator falls back to the words", async () => {
    const located = await locate(EXPRESS_FILES, "How does res.nothere work?");
    expect(located.primary?.some((candidate) => candidate.why === "dotted-member") ?? false).toBe(false);
  }, 120000);

  it("a bracketed literal found in one file makes that file the primary, even where a filename match already holds its lines", async () => {
    const located = await locate(CLICK_FILES, "Fix the help so count options show [default: (unlimited)]");
    expect(located.hit).toBe(true);
    expect(located.primary?.[0]).toMatchObject({ path: "tests/test_options.py", why: "exact-text:distinctive" });
  }, 120000);
});

describe("explicitCodeIdentifiers: a dotted member is one identifier", () => {
  it("admits the chain at its place in the request, beside the identifiers the casing rules find", () => {
    expect(explicitCodeIdentifiers("express の res.redirect がどう動くか説明して")).toEqual(["res.redirect"]);
    expect(explicitCodeIdentifiers("How does res.redirect call encodeUrl?")).toEqual(["res.redirect", "encodeUrl"]);
    expect(explicitCodeIdentifiers("Does encodeUrl run before res.redirect?")).toEqual(["encodeUrl", "res.redirect"]);
  });

  it("does not take a file name, a domain or a version for a chain", () => {
    expect(explicitCodeIdentifiers("Look at lib/response.js, README.md and https://expressjs.com for v5.2.1")).toEqual([]);
  });
});

// The tmp dir helper above creates directories under the OS temp dir; nothing else to clean here.
void os;
