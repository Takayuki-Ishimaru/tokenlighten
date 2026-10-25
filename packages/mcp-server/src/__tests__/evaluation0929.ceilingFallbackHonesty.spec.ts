/**
 * evaluation0929.ceilingFallbackHonesty.spec.ts — R2-T1 (eval-0929 review
 * P0-3 + P1-1, orchestrator ruling 2026-09-30).
 *
 * THE DEFECTS (review-0929 REPORT.md):
 *  - P0-3: under a byte ceiling near the pack size (the VS Code 14,336 B
 *    client ceiling, `TOKENLIGHTEN_TASK_PACK_MAX_BYTES`, or `budget.bytes`),
 *    "Explain all conditions of retry300, including the actual values in
 *    RETRY_CODES." over a 300-branch function answered `act.answer` with the
 *    constant's line and the import line only: the byte-budget shed tier of
 *    `dedupeTrimAndPersist` removed the whole body AFTER certification, and the
 *    re-derivation re-certified over surrogates. No `next`, no gap.
 *  - P1-1: the same shape over a 160-branch function threw a JSON-RPC -32603
 *    "unreachable task-pack construction invariant: proof-preserving
 *    byte-budget fallback exceeds cap".
 *  - The ruling's class (budget 8192): a condition question certified
 *    `act.answer` with ZERO lines of the focal's body ever delivered — the
 *    facet gate waived a long focal for every facet and `behavior-body`
 *    accepted the signature line.
 *
 * WHAT IS PINNED:
 *  1. the pure helpers the restoring read is built from
 *     (`breachedCitations`, `unservedCitedWindows`);
 *  2. the facet gate's long-focal rule: condition / flow on a long CALLABLE
 *     focal require the whole body (open on the unserved rest, undetermined
 *     once the rest was asked for and never delivered); value keeps its
 *     reviewed waiver; a focal of at most MAX_FACET_FOCAL_LINES and a long
 *     TYPE focal are unchanged;
 *  3. the in-process matrix (fresh fixture names/values): 120/160/300-branch
 *     functions x budget 8192 / 14336 x condition / value / explain questions
 *     x EN / JA x answer / no profile — never an exception; no `act.answer`
 *     before the evidence its requirement needs has reached the client
 *     (condition / explain: every branch; value: the constant's values); the
 *     chain ends on its own and delivers what the question asked for;
 *  4. the reviewer's own shapes on spawned dev servers: the VS Code client
 *     ceiling (client id alone, and with turn economy) and the env-only
 *     ceiling;
 *  5. recall controls: a pack that fits the ceiling is still ONE-hop
 *     `act.answer`; a short focal and a long focal's VALUE question are
 *     unchanged at the default config.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { expandedReadNextArguments } from "./helpers/readNext.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";
import {
  breachedCitations,
  certificateWireBreaches,
  unservedCitedWindows,
  type CertificateCitation,
  type ServedSpans,
} from "../features/task-pack/certificateWireInvariant.js";
import {
  evaluateFacetRequirement,
  MAX_FACET_FOCAL_LINES,
  type FacetEvaluationContext,
  type FacetLineSpan,
  type FacetPlanEntry,
} from "../features/task-pack/facetGate.js";
import type { FacetRequirement } from "../features/task-pack/requestFacets.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
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

// ---------------------------------------------------------------------------
// Fresh fixtures: names and values used nowhere else in the repo.
// ---------------------------------------------------------------------------

const VALUES = ["427", "461", "583"] as const;
const CODES_PATH = "src/policy/statuses.ts";
const CODES_FILE = "export const RESEND_STATUSES = new Set([427, 461, 583]);\nexport const MAX_TRIES = 3;\n";

/** A `branches`-branch callable; every body line carries its own `branch N` marker so delivery is checked from served bytes alone. */
function longCallable(name: string, branches: number): string {
  const lines = [
    `import { RESEND_STATUSES, MAX_TRIES } from './statuses.js';`,
    `export function ${name}(status: number, tries: number): boolean {`,
    "  if (tries >= MAX_TRIES) return false;",
  ];
  for (let i = 0; i < branches; i++) lines.push(`  if (status === ${3000 + i}) return tries < ${i % 4}; // branch ${i} ${"q".repeat(30)}`);
  lines.push("  return RESEND_STATUSES.has(status);", "}", "");
  return lines.join("\n");
}

function makeWorkspace(tag: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-cfh-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries({ "package.json": "{\"name\":\"cfh\",\"private\":true,\"type\":\"module\"}\n", ...files })) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

type Question = "condition" | "value" | "explain" | "conditionJa";

function questionFor(kind: Question, fn: string): string {
  switch (kind) {
    case "condition": return `Explain all conditions of ${fn}, including the actual values in RESEND_STATUSES.`;
    case "value": return `What values does ${fn} check in RESEND_STATUSES, and what does it return?`;
    case "explain": return `Explain ${fn}.`;
    case "conditionJa": return `${fn} の条件と RESEND_STATUSES の実際の値を説明してください。`;
  }
}

// ---------------------------------------------------------------------------
// Served-bytes accounting (never the server's own metadata).
// ---------------------------------------------------------------------------

function bodiesOf(response: Record<string, any> | undefined, filePath?: string): string {
  const out: string[] = [];
  for (const entry of Array.isArray(response?.["evidence"]) ? response["evidence"] : []) {
    if (typeof entry?.body === "string" && (filePath === undefined || entry.path === filePath)) out.push(entry.body);
  }
  for (const entry of Array.isArray(response?.["entries"]) ? response["entries"] : []) {
    if (filePath !== undefined && entry?.path !== filePath) continue;
    if (typeof entry?.content === "string") out.push(entry.content);
    if (typeof entry?.body === "string") out.push(entry.body);
  }
  return out.join("\n");
}

function branchesIn(text: string): Set<number> {
  return new Set([...text.matchAll(/branch (\d+) /g)].map((match) => Number(match[1])));
}

function nextOf(response: Record<string, any>): { tool: string; arguments: Record<string, unknown> } | undefined {
  for (const candidate of [response["decision"]?.next, response["next"], response["limit"]?.next]) {
    if (candidate !== undefined && typeof candidate?.tool === "string") return candidate;
  }
  return undefined;
}

async function inProcess(ws: string, tool: string, args: Record<string, unknown>): Promise<{ body: Record<string, any>; bytes: number }> {
  const response = await callTool(tool, { ...args, cwd: ws });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  return { body: JSON.parse(text) as Record<string, any>, bytes: Buffer.byteLength(text, "utf8") };
}

interface Walk {
  readonly hops: ReadonlyArray<{ body: Record<string, any>; bytes: number }>;
  readonly capped: boolean;
}

async function walk(ws: string, first: Record<string, unknown>, hopCap = 16): Promise<Walk> {
  const hops: Array<{ body: Record<string, any>; bytes: number }> = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_read_file", arguments: first };
  while (call !== undefined) {
    if (hops.length >= hopCap) return { hops, capped: true };
    const hop = await inProcess(ws, call.tool, call.arguments);
    hops.push(hop);
    call = nextOf(hop.body);
  }
  return { hops, capped: false };
}

/**
 * eval §8 on a whole chain: no hop is `act.answer` before the evidence the
 * question needs reached the client in THIS chain; the chain ends on its own;
 * and by its end the question's evidence was delivered.
 */
function expectHonestChain(label: string, walked: Walk, focalPath: string, branches: number, question: Question): void {
  const describeHops = (): string => JSON.stringify(walked.hops.map((hop) => ({
    kind: hop.body["kind"],
    decision: hop.body["decision"]?.kind,
    bytes: hop.bytes,
    evidence: (Array.isArray(hop.body["evidence"]) ? hop.body["evidence"] : []).map((entry: any) =>
      `${entry.path}:${entry.range}${typeof entry.body === "string" ? "" : "(nobody)"}${entry.remaining ? ` rem=${JSON.stringify(entry.remaining)}` : ""}`),
    next: nextOf(hop.body)?.arguments,
  })));
  expect(walked.capped, `[${label}] the chain must end on its own: ${describeHops()}`).toBe(false);
  const delivered = new Set<number>();
  let all = "";
  for (const [index, hop] of walked.hops.entries()) {
    expect(hop.body["kind"], `[${label}] hop ${index} must not be a JSON-RPC failure`).not.toBe("nonjson");
    for (const branch of branchesIn(bodiesOf(hop.body, focalPath))) delivered.add(branch);
    all += `\n${bodiesOf(hop.body)}`;
    if (hop.body["decision"]?.kind !== "act.answer") continue;
    if (question === "value") {
      for (const value of VALUES) {
        expect(all.includes(value), `[${label}] hop ${index} certifies the value before ${value} reached the client: ${describeHops()}`).toBe(true);
      }
    } else {
      expect(
        delivered.size,
        `[${label}] hop ${index} is act.answer with ${delivered.size}/${branches} branches of the focal delivered: ${describeHops()}`,
      ).toBe(branches);
    }
  }
  if (question === "value") {
    for (const value of VALUES) expect(all, `[${label}] value ${value} must reach the client`).toContain(value);
  } else {
    expect(delivered.size, `[${label}] following next must deliver the whole body: ${describeHops()}`).toBe(branches);
  }
}

// ---------------------------------------------------------------------------
// 1. The restoring read's pure helpers.
// ---------------------------------------------------------------------------

describe("certificateWireInvariant: the read that restores a breached citation", () => {
  const spans = (entries: Record<string, Array<[number, number]>>): ServedSpans => new Map(Object.entries(entries));
  const behaviorBody: CertificateCitation = {
    obligationId: "behavior-body",
    mode: "any",
    windows: [{ handle: "h-body", path: "src/a.ts", spans: [[2, 305]] }],
  };
  const constant: CertificateCitation = {
    obligationId: "request-item:facet-2:value",
    mode: "every",
    windows: [{ handle: "h-const", path: "src/c.ts", spans: [[1, 1]] }],
  };

  it("names every line of a breached window the client does not hold — the withdrawn lines AND the never-carried rest the removed row had disclosed", () => {
    const certified = spans({ "src/a.ts": [[1, 144]], "src/c.ts": [[1, 1]] });
    const final = spans({ "src/a.ts": [[1, 127]], "src/c.ts": [[1, 1]] });
    const breaches = certificateWireBreaches([behaviorBody, constant], certified, final);
    expect(breaches.map((breach) => [breach.obligationId, breach.lost])).toEqual([["behavior-body", [[128, 144]]]]);
    const cited = breachedCitations([behaviorBody, constant], breaches);
    expect(cited.map((citation) => citation.obligationId)).toEqual(["behavior-body"]);
    expect(unservedCitedWindows(cited, final)).toEqual({ windows: [{ path: "src/a.ts", start: 128, end: 305 }], obligationIds: ["behavior-body"] });
  });

  it("an earlier call's residency counts as delivered, and a fully held window names nothing", () => {
    const delivered = spans({ "src/a.ts": [[1, 200], [201, 305]] });
    expect(unservedCitedWindows([behaviorBody], delivered)).toEqual({ windows: [], obligationIds: [] });
    const holes = unservedCitedWindows([behaviorBody], spans({ "src/a.ts": [[2, 50], [100, 305]] }));
    expect(holes.windows).toEqual([{ path: "src/a.ts", start: 51, end: 99 }]);
  });

  it("windows of different paths stay separate, merged per path in first-citation order", () => {
    const two: CertificateCitation = {
      obligationId: "request-item:facet-1:condition",
      mode: "every",
      windows: [
        { handle: "h-x", path: "src/x.ts", spans: [[10, 20]] },
        { handle: "h-a2", path: "src/a.ts", spans: [[300, 310]] },
      ],
    };
    const result = unservedCitedWindows([behaviorBody, two], spans({ "src/a.ts": [[2, 250]] }));
    expect(result.windows).toEqual([
      { path: "src/a.ts", start: 251, end: 310 },
      { path: "src/x.ts", start: 10, end: 20 },
    ]);
    expect(result.obligationIds).toEqual(["behavior-body", "request-item:facet-1:condition"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The facet gate's long-focal rule (orchestrator ruling rules 1, 2, 4).
// ---------------------------------------------------------------------------

describe("facet gate: a long callable focal is required whole for condition / flow, never for value", () => {
  const FOCAL_LINES = 200;
  const focalText = [
    "export function canResend(status: number, tries: number): boolean {",
    ...Array.from({ length: FOCAL_LINES - 2 }, (_, i) => `  if (status === ${3000 + i}) return tries < 2;`),
    "}",
  ];
  const fileLines = ["import { RESEND_STATUSES } from './statuses.js';", ...focalText];
  const focal = { path: "src/policy/resend.ts", name: "canResend", start: 2, end: FOCAL_LINES + 1 };
  const constantWindow = { kind: "constant" as const, path: CODES_PATH, start: 1, end: 1, name: "RESEND_STATUSES" };
  const entryFor = (facet: FacetPlanEntry["facet"], overrides: Partial<FacetPlanEntry> = {}): FacetPlanEntry => ({
    facet,
    clause: `the ${facet} of canResend`,
    resolution: "resolved",
    focal,
    windows: [constantWindow],
    ...(facet === "flow" ? { callSites: [], totalCallSites: 0, callSitesComplete: true, focalMakesCalls: false } : {}),
    ...overrides,
  });
  const requirementFor = (facet: FacetRequirement["facet"]): FacetRequirement => ({
    facet,
    clause: `the ${facet} of canResend`,
    subjectIdentifiers: ["canResend"],
    subjectTerms: ["canresend"],
  } as unknown as FacetRequirement);
  const ctxWith = (served: Record<string, FacetLineSpan[]>, undelivered: Record<string, FacetLineSpan[]> = {}): FacetEvaluationContext => ({
    servedSpans: (relPath) => served[relPath] ?? [],
    fileLines: (relPath) => (relPath === focal.path ? fileLines : relPath === CODES_PATH ? CODES_FILE.split("\n").slice(0, 2) : undefined),
    undeliveredSpans: (relPath) => undelivered[relPath] ?? [],
  });

  it("the focal under test is longer than the waiver bound", () => {
    expect(FOCAL_LINES).toBeGreaterThan(MAX_FACET_FOCAL_LINES);
  });

  it("condition: constants plus part of the body is OPEN on exactly the unserved rest of the focal", () => {
    const facts = evaluateFacetRequirement(requirementFor("condition"), entryFor("condition"), ctxWith({
      [focal.path]: [{ start: 1, end: 120 }],
      [CODES_PATH]: [{ start: 1, end: 1 }],
    }));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: focal.path, start: 121, end: FOCAL_LINES + 1 }]);
  });

  it("condition: constants plus the signature line alone are never covered", () => {
    const facts = evaluateFacetRequirement(requirementFor("condition"), entryFor("condition"), ctxWith({
      [focal.path]: [{ start: 1, end: 2 }],
      [CODES_PATH]: [{ start: 1, end: 1 }],
    }));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: focal.path, start: 3, end: FOCAL_LINES + 1 }]);
  });

  it("condition: the whole focal served is covered, and it is cited", () => {
    const facts = evaluateFacetRequirement(requirementFor("condition"), entryFor("condition"), ctxWith({
      [focal.path]: [{ start: 1, end: FOCAL_LINES + 1 }],
      [CODES_PATH]: [{ start: 1, end: 1 }],
    }));
    expect(facts.kind).toBe("covered");
    expect(facts.servedWindows.map((window) => `${window.kind}:${window.path}:${window.start}-${window.end}`))
      .toContain(`focal:${focal.path}:2-${FOCAL_LINES + 1}`);
  });

  it("condition: the rest was asked for and never delivered -> undetermined, naming the range (never a silent pass)", () => {
    const facts = evaluateFacetRequirement(requirementFor("condition"), entryFor("condition"), ctxWith(
      { [focal.path]: [{ start: 1, end: 120 }], [CODES_PATH]: [{ start: 1, end: 1 }] },
      { [focal.path]: [{ start: 121, end: FOCAL_LINES + 1 }] },
    ));
    expect(facts.kind).toBe("undetermined");
    expect(facts.disclosure?.word).toBe("request-item-undetermined");
    expect(facts.disclosure?.reason).toContain(`${focal.path}:121-${FOCAL_LINES + 1}`);
  });

  it("flow on a long CALLABLE focal follows the same rule", () => {
    const facts = evaluateFacetRequirement(requirementFor("flow"), entryFor("flow"), ctxWith({ [focal.path]: [{ start: 1, end: 2 }] }));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: focal.path, start: 3, end: FOCAL_LINES + 1 }]);
  });

  it("RECALL (rule 1): value keeps its waiver — the constants alone cover a long focal's value", () => {
    const facts = evaluateFacetRequirement(requirementFor("value"), entryFor("value"), ctxWith({
      [focal.path]: [{ start: 1, end: 2 }],
      [CODES_PATH]: [{ start: 1, end: 1 }],
    }));
    expect(facts.kind).toBe("covered");
  });

  it("RECALL (rule 4): a focal of at most MAX_FACET_FOCAL_LINES lines is required exactly as before", () => {
    const short = { ...focal, end: 40 };
    const facts = evaluateFacetRequirement(requirementFor("condition"), entryFor("condition", { focal: short }), ctxWith({
      [focal.path]: [{ start: 1, end: 20 }],
      [CODES_PATH]: [{ start: 1, end: 1 }],
    }));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: focal.path, start: 21, end: 40 }]);
  });

  it("RECALL: a long TYPE focal's flow keeps the waiver (its members are the requirement)", () => {
    const typeFocal = { ...focal, callable: false };
    const facts = evaluateFacetRequirement(requirementFor("flow"), entryFor("flow", { focal: typeFocal }), ctxWith({ [focal.path]: [{ start: 1, end: 2 }] }));
    expect(facts.kind).not.toBe("open");
  });
});

// ---------------------------------------------------------------------------
// 3. The in-process matrix.
// ---------------------------------------------------------------------------

describe("ceiling matrix: no exception, no act.answer ahead of its evidence, next reaches the body", () => {
  beforeEach(() => {
    resetAll();
    handleTable.reset();
  });

  const SIZES = [120, 160, 300] as const;
  const BUDGETS = [8192, 14336] as const;
  const QUESTIONS: readonly Question[] = ["condition", "value", "explain", "conditionJa"];

  for (const size of SIZES) {
    for (const budget of BUDGETS) {
      it(`${size}-branch function at budget ${budget}: every question, answer and undeclared profile`, async () => {
        for (const question of QUESTIONS) {
          for (const profile of ["answer", undefined] as const) {
            // A no-profile run of every question would double the cost; the
            // condition question carries the undeclared-profile axis.
            if (profile === undefined && question !== "condition" && question !== "conditionJa") continue;
            const fn = "canResend";
            const focalPath = "src/policy/resend.ts";
            const ws = makeWorkspace(`m${size}-${budget}-${question}-${profile ?? "none"}`, {
              [CODES_PATH]: CODES_FILE,
              [focalPath]: longCallable(fn, size),
            });
            const walked = await walk(ws, {
              query: questionFor(question, fn),
              task: { epoch: "new", ...(profile === undefined ? {} : { profile }) },
              budget: { bytes: budget },
            });
            expectHonestChain(`${size}/${budget}/${question}/${profile ?? "none"}`, walked, focalPath, size, question);
            // The first response is a task pack under the caller's own ceiling.
            expect(walked.hops[0]!.body["kind"]).toBe("read.task_pack");
            expect(walked.hops[0]!.bytes, `[${size}/${budget}/${question}] hop 0 within the ceiling`).toBeLessThanOrEqual(budget + 700);
          }
        }
      }, 300_000);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The reviewer's own shapes on spawned dev servers.
// ---------------------------------------------------------------------------

async function askSpawned(
  ws: string,
  query: string,
  config: "default" | "vscode",
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<ChainResult> {
  const saved = new Map(Object.keys(extraEnv).map((key) => [key, process.env[key]] as const));
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  let server: ServerHandle;
  try {
    server = startDevServer(ws, config);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  servers.push(server);
  await server.initialize();
  return followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 16, maxQrefRepacks: 0 },
  );
}

function chainAsWalk(chain: ChainResult): Walk {
  return { hops: chain.hops.map((hop) => ({ body: hop.response as Record<string, any>, bytes: hop.textBytes })), capped: chain.capped };
}

/**
 * The VS Code client ceiling as the review measured it: the client id alone
 * (14,336 B). The shared "vscode" config of qualityFirstScenarios.ts sets
 * TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0 — the sentinel that DISABLES the client
 * ceiling — so it is not used for the ceiling shapes here.
 */
const VSCODE_CEILING_ENV = { TOKENLIGHTEN_CLIENT_ID: "vscode" } as const;
/** The same ceiling plus the turn-economy switch `tl setup` turns on for VS Code. */
const VSCODE_SETUP_ENV = { TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1" } as const;

describe("reviewer shapes: the VS Code client ceiling and the env-only ceiling", () => {
  it("P0-3: a 300-branch focal under the VS Code client ceiling is never act.answer ahead of its body, and next delivers the rest", async () => {
    const focalPath = "src/policy/resend300.ts";
    // An all-lowercase digit-suffixed name, as in the review's own repro.
    const files = { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("resend300", 300) };
    for (const [label, env] of [["client-id", VSCODE_CEILING_ENV], ["setup", VSCODE_SETUP_ENV]] as const) {
      const chain = await askSpawned(makeWorkspace(`p03-${label}`, files), questionFor("condition", "resend300"), "default", env);
      expectHonestChain(`p03-${label}`, chainAsWalk(chain), focalPath, 300, "condition");
      expect(chain.hops[0]!.response?.decision?.kind, `[${label}] the capped first pack does not certify`).not.toBe("act.answer");
      expect(chain.hops[0]!.textBytes, `[${label}] hop 0 within the client ceiling`).toBeLessThanOrEqual(14336);
    }
  }, 240_000);

  it("P1-1: a 160-branch focal under the VS Code client ceiling (EN, JA, with turn economy) and under TOKENLIGHTEN_TASK_PACK_MAX_BYTES never throws", async () => {
    const focalPath = "src/policy/resend.ts";
    const files = { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("canResend", 160) };
    const runs: Array<[string, ChainResult, Question]> = [
      ["vscode-en", await askSpawned(makeWorkspace("p11-en", files), questionFor("condition", "canResend"), "default", VSCODE_CEILING_ENV), "condition"],
      ["vscode-ja", await askSpawned(makeWorkspace("p11-ja", files), questionFor("conditionJa", "canResend"), "default", VSCODE_CEILING_ENV), "conditionJa"],
      ["vscode-setup", await askSpawned(makeWorkspace("p11-setup", files), questionFor("condition", "canResend"), "default", VSCODE_SETUP_ENV), "condition"],
      ["env-14336", await askSpawned(makeWorkspace("p11-env", files), questionFor("condition", "canResend"), "default", { TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "14336" }), "condition"],
    ];
    for (const [label, chain, question] of runs) {
      expect(chain.hops.length, `[${label}] at least one response`).toBeGreaterThan(0);
      for (const hop of chain.hops) {
        expect(hop.response?.kind, `[${label}] a JSON-RPC failure surfaces as a non-JSON body: ${JSON.stringify(hop.response).slice(0, 300)}`).not.toBe(undefined);
      }
      expectHonestChain(label, chainAsWalk(chain), focalPath, 160, question);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 5. Recall controls.
// ---------------------------------------------------------------------------

describe("recall controls: what fits, what is short, and a long focal's value question are unchanged", () => {
  beforeEach(() => {
    resetAll();
    handleTable.reset();
  });

  it("a 120-branch focal that fits the 14336 ceiling is still ONE-hop act.answer with the whole body", async () => {
    const focalPath = "src/policy/resend.ts";
    const ws = makeWorkspace("fits", { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("canResend", 120) });
    const walked = await walk(ws, { query: questionFor("condition", "canResend"), task: { epoch: "new", profile: "answer" }, budget: { bytes: 14336 } });
    expect(walked.hops.map((hop) => hop.body["decision"]?.kind)).toEqual(["act.answer"]);
    expect(branchesIn(bodiesOf(walked.hops[0]!.body, focalPath)).size).toBe(120);
    for (const value of VALUES) expect(bodiesOf(walked.hops[0]!.body)).toContain(value);
  }, 120_000);

  it("a short focal's condition question is ONE-hop act.answer at the default config", async () => {
    const focalPath = "src/policy/resend.ts";
    const ws = makeWorkspace("short", { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("canResend", 12) });
    const walked = await walk(ws, { query: questionFor("condition", "canResend"), task: { epoch: "new", profile: "answer" } });
    expect(walked.hops.map((hop) => hop.body["decision"]?.kind)).toEqual(["act.answer"]);
    expect(branchesIn(bodiesOf(walked.hops[0]!.body, focalPath)).size).toBe(12);
  }, 120_000);

  it("a behavior question naming a callable declared NOWHERE keeps the verified-absence path (never a ranged read of a body that does not exist)", async () => {
    // handsOnReport0142 SHOULD-FIX 37(b)'s shape without its NUL: the named
    // subject is absent everywhere and the only callables in reach have empty
    // bodies. The behavior-body rule reaches only a NAMED callable whose
    // declaration exists; here the chain must certify the absence, not re-read
    // an empty function's one line forever.
    const ws = makeWorkspace("absent-how", {
      "src/panel.ts": "// refresh cycle for stored quotes in the panel\nexport function refreshStoredQuotes(): void {}\n",
      "src/store.ts": "// stored quotes live here; the refresh cycle reads them\nexport const storedQuotes = new Map<string, string>();\n",
      "src/cycle.ts": `${"// padding\n".repeat(10)}export const storedQuotesRefreshCycle = () => {};\n${"// trailer\n".repeat(10)}`,
    });
    const walked = await walk(ws, { query: "Explain how QuoteLedger uses the stored quotes refresh cycle in src/cycle.ts.", task: { epoch: "new" } }, 6);
    expect(walked.capped, JSON.stringify(walked.hops.map((hop) => nextOf(hop.body)?.arguments))).toBe(false);
    const final = walked.hops[walked.hops.length - 1]!.body;
    expect(final["decision"]?.kind).toBe("act.answer");
    const gaps: string[] = final["decision"]?.certificate?.gaps ?? [];
    expect(gaps.some((gap) => gap.startsWith("explicit-gap:request-item-absent:QuoteLedger")), JSON.stringify(gaps)).toBe(true);
  }, 120_000);

  it("a long focal's VALUE question keeps its one-hop act.answer at the default config (the reviewed waiver)", async () => {
    const focalPath = "src/policy/resend.ts";
    const ws = makeWorkspace("value", { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("canResend", 300) });
    const walked = await walk(ws, { query: questionFor("value", "canResend"), task: { epoch: "new", profile: "answer" } });
    expect(walked.hops.map((hop) => hop.body["decision"]?.kind)).toEqual(["act.answer"]);
    for (const value of VALUES) expect(bodiesOf(walked.hops[0]!.body)).toContain(value);
  }, 120_000);

  it("RULED COST: a long focal's CONDITION question at the default config no longer certifies a partial body; ONE extra hop reads the rest and ends act.answer with every branch", async () => {
    const focalPath = "src/policy/resend.ts";
    const files = { [CODES_PATH]: CODES_FILE, [focalPath]: longCallable("canResend", 300) };
    const first = { query: questionFor("condition", "canResend"), task: { epoch: "new", profile: "answer" } };
    // Default (TL_EFF_AUTOFOLLOW, ON since 2026-10-19): the discover pack's
    // one `next` re-issues the request, so the server takes that extra hop
    // itself and the client gets ONE act.answer with every branch. One hop
    // also shows the `next` read all of the rest: had it named only a part,
    // the merged reply would still be a discover.
    const merged = await walk(makeWorkspace("cost", files), first);
    expectHonestChain("default-300-condition", merged, focalPath, 300, "condition");
    expect(merged.hops.map((hop) => hop.body["decision"]?.kind)).toEqual(["act.answer"]);
    expect(merged.hops[0]!.body["auto_followed"]).toBeDefined();
    // The rollback shows that hop on the wire. The rest of the focal is larger
    // than one follow-up surface carries whole; the facet `next` names it as
    // surface-sized pieces, so one hop reads all of it (measured before the
    // split: a third hop for the tail).
    resetAll();
    handleTable.reset();
    const saved = process.env["TL_EFF_AUTOFOLLOW"];
    process.env["TL_EFF_AUTOFOLLOW"] = "0";
    try {
      const walked = await walk(makeWorkspace("cost-off", files), first);
      expectHonestChain("rollback-300-condition", walked, focalPath, 300, "condition");
      expect(walked.hops.map((hop) => hop.body["decision"]?.kind)).toEqual(["discover", "act.answer"]);
      const next = nextOf(walked.hops[0]!.body);
      // v0.16.0 (release note: "Clients follow a short reference instead of
      // repeating the full arguments"): a long read `next` is a `{cwd, cursor}`
      // reference. Expand it -- without consuming its once-only plan, which the
      // walk already ran -- to see how it splits the rest of the focal.
      const targets = (expandedReadNextArguments(next?.arguments)?.["targets"] ?? []) as Array<{ path?: string; range?: string }>;
      expect(targets.filter((target) => target.path === focalPath).length, JSON.stringify(next)).toBeGreaterThan(1);
    } finally {
      if (saved === undefined) delete process.env["TL_EFF_AUTOFOLLOW"];
      else process.env["TL_EFF_AUTOFOLLOW"] = saved;
    }
  }, 120_000);
});
