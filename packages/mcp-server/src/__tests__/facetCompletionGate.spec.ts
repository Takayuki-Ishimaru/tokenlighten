/**
 * facetCompletionGate.spec.ts — FIX-G (eval-0927 P0, 2026-09-27): the facet
 * completion gate end to end, against the DEV server (spawned, both configs).
 *
 * The acceptance scenarios (evaluation0927.acceptance.spec.ts V01–V05) prove
 * the gate lets a fully-served faceted answer through. This file proves the
 * other direction — HONESTY: when the evidence a facet needs is NOT on the
 * wire, the pack never certifies `act.answer` with a silent gap. Each case
 * ends either with a truthful `certificate.gaps` disclosure, or with an
 * executable ranged `next` whose chain terminates in `act.answer` once the
 * evidence has actually been served:
 *   - a constant the focal reads has no declaration in the workspace
 *     → `request-item-undetermined:value:<focal> (... <NAME> ...)`;
 *   - the value is supplied at runtime (no constant, no literal)
 *     → `request-item-empty:value:<focal> (...)`;
 *   - the function has no callers → `request-item-empty:callers:<focal> (0 call sites ...)`;
 *   - the closure exceeds the in-pack budget / one batch → `discover` with
 *     exact ranged targets, then `act.answer` only after every constant body
 *     was served (never before);
 *   - more call sites than the pack served → ranged reads of the rest.
 * Plus the recall controls: a facet-free question mints no facet obligation,
 * and G3 — an uncovered identifier nothing declares (an env-var key) is
 * recovered by a ranged literal read, never a symbol-scoped find.
 *
 * Fixtures are neutral and built here; no rule under test keys on their names.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { buildTaskExecutionContract } from "../features/task-pack/readCodeTaskPack.js";
import type { TaskPackResult } from "../features/task-pack/model.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

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

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function tableConst(name: string, rows: number): string {
  const body = Array.from({ length: rows }, (_, i) => `  row${i}: "entry-${i}-of-${name.toLowerCase()}",`).join("\n");
  return `export const ${name} = {\n${body}\n};\n`;
}

const HEAVY_NAMES = Array.from({ length: 10 }, (_, i) => `LEVEL_TABLE_${i}`);

function buildWorkspace(root: string): void {
  write(root, "package.json", `${JSON.stringify({ name: "facet-gate-fixture", version: "1.0.0", type: "module" }, null, 2)}\n`);
  write(root, "src/limits.ts", `import { MAX_UPLOAD_BYTES } from "upload-sdk";\n\nexport function uploadLimit(): number {\n  return MAX_UPLOAD_BYTES * 2;\n}\n`);
  write(root, "src/timeouts.ts", `export function requestTimeout(env: Record<string, string | undefined> = process.env): number {\n  return Number(env.REQUEST_TIMEOUT_MS);\n}\n`);
  write(root, "src/orphan.ts", `export function neverCalled(input: string): string {\n  return input.trim();\n}\n`);
  let heavy = "";
  for (const name of HEAVY_NAMES) heavy += `${tableConst(name, 40)}\n`;
  write(root, "src/levels.ts", `${heavy}export function resolveLevel(key: string): unknown {\n  return ${HEAVY_NAMES.map((n) => `(${n} as Record<string, unknown>)[key]`).join(" ?? ")};\n}\n`);
  write(root, "src/format.ts", `export function formatAmount(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n`);
  for (let i = 0; i < 6; i++) {
    write(root, `src/views/view${i}.ts`, `import { formatAmount } from "../format";\n\nexport function renderView${i}(total: number): string {\n  const label = "view-${i}";\n  return label + ": " + formatAmount(total);\n}\n`);
  }
  for (let i = 0; i < 8; i++) write(root, `src/misc/m${i}.ts`, `export function misc${i}(x: number): number {\n  return x + ${i};\n}\n`);
}

async function runChain(config: ConfigName, query: string): Promise<ChainResult> {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fixg-${config}-`));
  tmpDirs.push(ws);
  buildWorkspace(ws);
  const server = startDevServer(ws, config);
  servers.push(server);
  await server.initialize();
  try {
    return await followNextToEnd(
      server,
      { tool: "read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
      { cwd: ws, hopCap: 10, maxQrefRepacks: 1 },
    );
  } finally {
    await server.kill();
  }
}

const decisionOf = (response: any): any => response?.decision ?? {};
const bodiesUpTo = (chain: ChainResult, hopIndex: number): string =>
  chain.hops.slice(0, hopIndex + 1).flatMap((hop) => (hop.response?.evidence ?? []).map((e: any) => String(e?.body ?? ""))).join("\n");

function finalAnswer(chain: ChainResult): any {
  const answers = chain.hops.map((hop) => decisionOf(hop.response)).filter((d) => d.kind === "act.answer");
  return answers[answers.length - 1];
}

/** No hop's `next` is a bare `search_files` tree / symbol-scoped find — the dead ends this gate replaces. */
function expectNoBareSearchNext(chain: ChainResult): void {
  for (const hop of chain.hops) {
    const next = decisionOf(hop.response).next;
    if (next?.tool !== "search_files") continue;
    expect(next.arguments?.action).not.toBe("tree");
    expect(next.arguments?.scope?.kind).not.toBe("symbol");
  }
}

describe.each(CONFIG_NAMES)("facet completion gate — honesty controls [%s]", (config) => {
  it("a constant the focal reads with no declaration in the workspace is disclosed undetermined, never silently certified", async () => {
    const chain = await runChain(config, "Explain the default upload limit value computed by uploadLimit.");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(answer.certificate.obligations).toContain("request-item:facet-1:value");
    const gaps: string[] = answer.certificate.gaps ?? [];
    expect(gaps.some((g) => g.startsWith("explicit-gap:request-item-undetermined:value:uploadLimit") && g.includes("MAX_UPLOAD_BYTES"))).toBe(true);
    expectNoBareSearchNext(chain);
  }, 120_000);

  it("a value supplied only at runtime is covered by the served focal with a verified-empty disclosure", async () => {
    const chain = await runChain(config, "What is the default value returned by requestTimeout?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(answer.certificate.obligations).toContain("request-item:facet-1:value");
    expect((answer.certificate.gaps ?? []).some((g: string) => g.startsWith("explicit-gap:request-item-empty:value:requestTimeout"))).toBe(true);
    expect(bodiesUpTo(chain, chain.hops.length - 1)).toContain("env.REQUEST_TIMEOUT_MS");
  }, 120_000);

  it("a function nobody calls: callers are covered by a verified-empty fact, disclosed with its scan scope", async () => {
    const chain = await runChain(config, "Who calls neverCalled?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(answer.certificate.obligations).toContain("request-item:facet-1:callers");
    expect(answer.certificate.gaps).toContain(
      "explicit-gap:request-item-empty:callers:neverCalled (0 call sites in the scanned workspace; test files excluded)",
    );
  }, 120_000);

  it("a closure beyond one pack's budget: discover with exact ranged targets, act.answer only after every constant body is served", async () => {
    const chain = await runChain(config, "Which values does resolveLevel read by default?");
    const first = decisionOf(chain.hops[0]!.response);
    expect(first.kind).toBe("discover");
    expect((first.gaps ?? []).some((g: any) => (g.refs ?? []).includes("request-item:facet-1:value"))).toBe(true);
    expect(first.next?.tool).toBe("read_file");
    for (const target of first.next.arguments.targets) {
      expect(target.path).toBe("src/levels.ts");
      expect(target.range).toMatch(/^\d+-\d+$/u);
    }
    let certifiedAt = -1;
    chain.hops.forEach((hop, index) => {
      if (decisionOf(hop.response).kind !== "act.answer") return;
      const served = bodiesUpTo(chain, index);
      // Never certified before EVERY constant's declaration is on the wire.
      for (const name of HEAVY_NAMES) expect(served).toContain(`export const ${name} = {`);
      if (certifiedAt < 0) certifiedAt = index;
    });
    expect(certifiedAt).toBeGreaterThan(0);
    expect(chain.capped).toBe(false);
    expectNoBareSearchNext(chain);
  }, 180_000);

  it("more call sites than the pack served: the rest are read by ranged targets before act.answer", async () => {
    const chain = await runChain(config, "Where is formatAmount called?");
    let certifiedAt = -1;
    chain.hops.forEach((hop, index) => {
      if (decisionOf(hop.response).kind !== "act.answer") return;
      const served = bodiesUpTo(chain, index);
      for (let i = 0; i < 6; i++) expect(served).toContain(`renderView${i}`);
      if (certifiedAt < 0) certifiedAt = index;
    });
    expect(certifiedAt).toBeGreaterThanOrEqual(0);
    expect(finalAnswer(chain).certificate.obligations).toContain("request-item:facet-1:callers");
    expect(chain.capped).toBe(false);
    expectNoBareSearchNext(chain);
  }, 180_000);

  it("a faceted question asked WITH explicit targets is planned too: the missing constants are read before act.answer", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fixg-${config}-seeded-`));
    tmpDirs.push(ws);
    buildWorkspace(ws);
    const focalLine = fs.readFileSync(path.join(ws, "src/levels.ts"), "utf8").split("\n").findIndex((l) => l.startsWith("export function resolveLevel")) + 1;
    const server = startDevServer(ws, config);
    servers.push(server);
    await server.initialize();
    let chain: ChainResult;
    try {
      chain = await followNextToEnd(
        server,
        {
          tool: "read_file",
          arguments: {
            query: "Which values does resolveLevel read by default?",
            targets: [{ path: "src/levels.ts", range: `${focalLine}-${focalLine + 2}` }],
            cwd: ws,
            task: { epoch: "new", profile: "answer" },
          },
        },
        { cwd: ws, hopCap: 10, maxQrefRepacks: 1 },
      );
    } finally {
      await server.kill();
    }
    expect(decisionOf(chain.hops[0]!.response).kind).toBe("discover");
    chain.hops.forEach((hop, index) => {
      if (decisionOf(hop.response).kind !== "act.answer") return;
      const served = bodiesUpTo(chain, index);
      for (const name of HEAVY_NAMES) expect(served).toContain(`export const ${name} = {`);
    });
    const answer = finalAnswer(chain);
    expect(answer.certificate.obligations).toContain("request-item:facet-1:value");
    expect((answer.certificate.gaps ?? []).some((g: string) => g.includes("not computed"))).toBe(false);
  }, 180_000);

  it("recall control: a facet-free question mints no facet obligation", async () => {
    const chain = await runChain(config, "Explain how formatAmount formats cents.");
    for (const hop of chain.hops) {
      const obligations: string[] = decisionOf(hop.response).certificate?.obligations ?? [];
      expect(obligations.some((id) => id.startsWith("request-item:facet-"))).toBe(false);
    }
    expect(finalAnswer(chain)).toBeDefined();
  }, 120_000);
});

describe("a facet chain under a caller budget: partial deliveries continue under the SAME task, never a query-less read that certifies", () => {
  it("every hop stays within the budget, every continuation keeps the task (query or qref), and act.answer comes only after every constant is served", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-fixg-budget-"));
    tmpDirs.push(ws);
    buildWorkspace(ws);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    let chain: ChainResult;
    try {
      chain = await followNextToEnd(
        server,
        {
          tool: "read_file",
          arguments: { query: "Which values does resolveLevel read by default?", cwd: ws, task: { epoch: "new", profile: "answer" }, budget: { bytes: 7000 } },
        },
        { cwd: ws, hopCap: 14, maxQrefRepacks: 0 },
      );
    } finally {
      await server.kill();
    }
    expect(chain.capped).toBe(false);
    chain.hops.forEach((hop, index) => {
      const decision = decisionOf(hop.response);
      if (decision.next?.tool === "read_file" && Array.isArray(decision.next.arguments?.targets)) {
        // A continuation of this query-bearing task never drops the task.
        const args = decision.next.arguments;
        expect(typeof args.query === "string" || typeof args.qref === "string", JSON.stringify(args)).toBe(true);
        expect(args.budget).toEqual({ bytes: 7000 });
      }
      if (["act.answer", "act.edit"].includes(decision.kind)) {
        const served = bodiesUpTo(chain, index);
        for (const name of HEAVY_NAMES) expect(served).toContain(`export const ${name} = {`);
      }
    });
    expect(finalAnswer(chain)).toBeDefined();
  }, 240_000);
});

describe("G3 — an uncovered identifier nothing declares is recovered by a ranged literal read", () => {
  function workspaceWithEnvKey(): string {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-fixg-g3-"));
    tmpDirs.push(ws);
    write(ws, "package.json", "{}\n");
    write(ws, "src/other.ts", `export function other(): number {\n  return 1;\n}\n`);
    const filler = Array.from({ length: 30 }, (_, i) => `export function helper${i}(): number {\n  return ${i};\n}\n`).join("\n");
    write(ws, "src/settings.ts", `${filler}\nexport function readTimeout(env: Record<string, string | undefined>): number {\n  return Number(env.SERVICE_TIMEOUT_KEY ?? "30");\n}\n\nexport function declaredButUnserved(): number {\n  return 2;\n}\n`);
    return ws;
  }

  function answerResult(): TaskPackResult {
    return {
      mode: "task_pack",
      coverage: "partial",
      coverage_reason: "concerns-uncovered",
      missing: [],
      // An open route: the pack itself says discovery may continue, so the
      // contract's candidate chain (where the uncovered identifier's recovery
      // call lives) is consulted.
      route: { action: "locate_missing_surfaces", max_additional_tl_calls: 1 },
      surfaces: [{ role: "domain", handle: "h-other", path: "src/other.ts", range: "1-3", required: true, code: "export function other(): number {\n  return 1;\n}\n" }],
    } as unknown as TaskPackResult;
  }

  it("an env-var key: the next reads the window around its occurrence (query-bearing), not a symbol lookup", () => {
    const ws = workspaceWithEnvKey();
    const query = "Explain how SERVICE_TIMEOUT_KEY is interpreted.";
    const contract = buildTaskExecutionContract(answerResult(), "answer", query, undefined, ws);
    const identifier = contract.readiness_certificate?.obligations.find((o) => o.id === "identifier:SERVICE_TIMEOUT_KEY")
      ?? (contract.falsification?.unresolved ?? []).includes("identifier:SERVICE_TIMEOUT_KEY");
    expect(identifier).toBeTruthy();
    const next = contract.next_call;
    expect(next?.tool).toBe("read_file");
    const targets = (next?.arguments as { targets?: Array<{ path: string; range?: string }>; query?: string }).targets ?? [];
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("src/settings.ts");
    const [start, end] = targets[0]!.range!.split("-").map(Number);
    const occurrence = fs.readFileSync(path.join(ws, "src/settings.ts"), "utf8").split("\n").findIndex((l) => l.includes("SERVICE_TIMEOUT_KEY")) + 1;
    expect(start!).toBeLessThanOrEqual(occurrence);
    expect(end!).toBeGreaterThanOrEqual(occurrence);
    expect((next?.arguments as { query?: string }).query).toBe(query);
  });

  it("recall: a DECLARED identifier keeps the symbol lookup", () => {
    const ws = workspaceWithEnvKey();
    const contract = buildTaskExecutionContract(answerResult(), "answer", "Explain how declaredButUnserved works.", undefined, ws);
    const next = contract.next_call;
    expect(next?.tool).toBe("search_files");
    expect((next?.arguments as { action?: string }).action).toBe("symbols");
  });
});
