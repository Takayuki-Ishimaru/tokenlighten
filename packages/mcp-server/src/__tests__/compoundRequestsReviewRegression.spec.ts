import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { callTool } from "../server.js";
import { resetAll } from "../util/session.js";
import { handleTable } from "../util/handles.js";
import { defaultEngineConfiguration, withEngineConfiguration } from "../features/engines/config.js";
import { planCompoundRequest, extractCompoundFacetRequirements } from "../features/task-pack/compoundRequests.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const roots: string[] = [];
beforeEach(() => { resetAll(); handleTable.reset(); });
afterEach(async () => { for (const root of roots.splice(0)) await rmDirWithRetry(root); });

const MIXED = "What does alpha() return? Who calls beta() (do not change it)? What does gamma() return?";

function fixture(): string {
  const root = fs.realpathSync(shortTmpDir(homedir(), ".tl-compound-review-regression-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, "src/a.ts"), 'export function alpha() { return "ALPHA_BODY"; }\n');
  fs.writeFileSync(path.join(root, "src/b.ts"), 'export function beta() { return "BETA_BODY"; }\n');
  fs.writeFileSync(path.join(root, "src/c.ts"), 'export function gamma() { return "GAMMA_BODY"; }\n');
  fs.writeFileSync(path.join(root, "src/caller.ts"), 'import { beta } from "./b.js";\nexport function betaCaller() { return beta(); }\n');
  return root;
}

describe("compound independent review regressions", () => {
  it.each([
    "Explain alpha() in src/a.ts and beta() in src/b.py. Cite file and line sources.",
    "Explain alpha() in src/a.ts and beta() from src/b.py.",
    "Explain alpha() in src/a.ts and beta() in `src/b.py`.",
  ])("recognizes omitted shared imperatives with explicit file qualifiers: %s", query => {
    const plan = planCompoundRequest(query);
    expect(plan.compound).toBe(true);
    expect(plan.clauses.map(clause => clause.subjects)).toEqual([["alpha"], ["beta"]]);
    expect(plan.clauses.map(clause => clause.paths)).toEqual([["src/a.ts"], ["src/b.py"]]);
    expect(plan.originalQuery).toBe(query);
  });

  it("distinguishes the same callable name at separately requested file paths", () => {
    const query = "Explain retry() in src/a.ts. Explain retry() in src/b.ts.";
    const plan = planCompoundRequest(query);
    expect(plan.compound).toBe(true);
    expect(plan.clauses.map(clause => clause.paths)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(planCompoundRequest("Explain retry() in src/a.ts. Explain its contract in src/a.ts.").compound).toBe(false);
  });

  it.each([
    MIXED,
    "What does alpha() return? What does beta() return (do not modify any files)? What does gamma() return?",
    "What does alpha() return? What does beta() return, do not modify any files. What does gamma() return?",
  ])("retains positive clauses carrying an edit constraint: %s", query => {
    const plan = planCompoundRequest(query);
    expect(plan.compound).toBe(true);
    expect(plan.originalQuery).toBe(query);
    expect(plan.clauses).toHaveLength(3);
    expect(plan.clauses[1]!.text).toContain("beta()");
    expect(plan.clauses[1]!.text).toContain("do not");
    expect(extractCompoundFacetRequirements(query).map(facet => facet.subjectCallables)).toEqual([["alpha"], ["beta"], ["gamma"]]);
    expect(plan.constraints).toEqual([]);
  });

  it("keeps a standalone negative edit instruction outside lookup clauses", () => {
    const plan = planCompoundRequest("Explain alpha(). Do not modify beta(). Explain gamma().");
    expect(plan.compound).toBe(true);
    expect(plan.clauses.map(clause => clause.subjects)).toEqual([["alpha"], ["gamma"]]);
    expect(plan.constraints).toEqual(["Do not modify beta()."]);
  });

  /** Walks MIXED hop by hop, following each `decision.next` verbatim, until it stops (cap 5 hops). */
  async function walkMixed(root: string, extra: Record<string, unknown>) {
    const config = defaultEngineConfiguration();
    config.typedSymbols.enabled = false;
    config.semanticSearch.enabled = false;
    let args: Record<string, unknown> | undefined = { cwd: root, lane: "compound-regression", query: MIXED,
      task: { epoch: "new", profile: "answer" }, ...extra };
    const hops: Array<Record<string, any>> = [];
    let delivered = "";
    for (let hop = 0; hop < 5 && args; hop++) {
      const response = await withEngineConfiguration(config, () => callTool("tl_read_file", args!));
      const first = response.content[0];
      if (first?.type !== "text") throw new Error("Expected textual MCP result.");
      const result = JSON.parse(first.text);
      hops.push(result);
      delivered += "\n" + (result.evidence ?? []).map((row: { body?: string }) => row.body ?? "").join("\n");
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      // The next is followed as written. A lean-call posture (TL_TURN_ECONOMY) leaves `cwd` off a
      // next, and a stdio server rooted at the workspace resolves a cwd-less call there; this
      // in-process walk is not rooted at `root`, so it supplies the root the same way.
      args = next?.tool === "tl_read_file" ? { cwd: root, ...next.arguments } : undefined;
    }
    return { hops, args, delivered };
  }

  it("serves and certifies the positive callers clause despite its parenthetical edit constraint", async () => {
    const root = fixture();
    const { hops, args, delivered } = await walkMixed(root, { budget: { tokens: 5000 } });
    expect(args, JSON.stringify(hops)).toBeUndefined();
    expect(delivered, JSON.stringify(hops)).toContain("export function betaCaller()");
    expect(hops.some(result => result.evidence?.some((row: { path: string }) => row.path === "src/caller.ts"))).toBe(true);
    const answer = hops.find(result => result.decision?.kind === "act.answer");
    expect(answer, JSON.stringify(hops)).toBeDefined();
    expect(answer?.decision.certificate.obligations).toContain("request-item:facet-2:callers");
  }, 30000);

  // v0.16.0 release verification (T01): the small-remainder fold
  // (`applyFoldSmallRemainder`) widened `src/caller.ts 2-2` to its whole file,
  // which made every candidate of this composite candidate-list pack look
  // "served whole" and let GATE-C1 (`discoveryBundleNext`) withhold the one
  // bundle `next`: a bare `await_input/choose-candidate` dead end. A
  // candidate-list pack is a choice, not a remainder, so it is NEVER folded,
  // whatever switched the fold on: the bounded default (ceiling <= 20 KiB with
  // TL_FOLD_SMALL_REMAINDER unset), the TL_TURN_ECONOMY umbrella, or the flag
  // itself. The postures below send NO budget. The first two select the bounded
  // default through the client profile's own ceiling (Copilot CLI 18 KiB, VS
  // Code 14,336 B). The third is what the VS Code extension
  // (mcpProvider.ts) and `tl workspace setup` for VS Code write: the client id
  // plus TL_TURN_ECONOMY=1, whose umbrella turns the fold on. The last is the
  // explicit opt-in.
  it.each([
    ["copilot-cli default ceiling (18432 B)", { TOKENLIGHTEN_CLIENT_ID: "copilot-cli" }],
    ["vscode default ceiling (14336 B)", { TOKENLIGHTEN_CLIENT_ID: "vscode" }],
    ["the VS Code posture the extension and `tl workspace setup` write (vscode + TL_TURN_ECONOMY=1)", { TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1" }],
    ["explicit TL_FOLD_SMALL_REMAINDER=1", { TL_FOLD_SMALL_REMAINDER: "1" }],
  ] as Array<[string, Record<string, string>]>)("%s, no explicit budget: the candidate-list pack is a discover with an executable next, and following it ends act.answer", async (_posture, env) => {
    const root = fixture();
    const KEYS = ["TOKENLIGHTEN_CLIENT_ID", "TL_FOLD_SMALL_REMAINDER", "TL_TURN_ECONOMY", "TOKENLIGHTEN_TASK_PACK_MAX_BYTES"];
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, env);
    try {
      const { hops, args, delivered } = await walkMixed(root, {});
      const first = hops[0]!;
      expect(first.decision?.kind, JSON.stringify(first)).toBe("discover");
      expect(first.decision?.next?.tool, JSON.stringify(first)).toBe("tl_read_file");
      expect(typeof first.decision?.next?.arguments, JSON.stringify(first)).toBe("object");
      expect(args, JSON.stringify(hops)).toBeUndefined();
      expect(delivered, JSON.stringify(hops)).toContain("export function betaCaller()");
      const answer = hops.find(result => result.decision?.kind === "act.answer");
      expect(answer, JSON.stringify(hops)).toBeDefined();
      expect(answer?.decision.certificate.obligations).toContain("request-item:facet-2:callers");
      // The dead end must not be reachable by any hop of the walk.
      expect(hops.some(result => result.decision?.kind === "await_input"), JSON.stringify(hops)).toBe(false);
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }, 30000);
});
