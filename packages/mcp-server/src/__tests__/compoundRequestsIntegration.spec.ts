import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskPack,
  resetPackDedupeCache,
} from "../features/task-pack/readCodeTaskPack.js";
import { resetAll as resetSessions } from "../state/session.js";
import { defaultEngineConfiguration, withEngineConfiguration } from "../features/engines/config.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const temporary: string[] = [];
const servers: ServerHandle[] = [];
const ENGLISH = "What does retryDelay() return and what does feeTotal() return?";
const JAPANESE = "retryDelay() の戻り値と、feeTotal() の戻り値を説明してください。";
const CAPPED = Array.from({ length: 9 }, (_, index) => `What does independentWorker${index}() return?`).join("\n");

function configuration(enabled = true) {
  const config = defaultEngineConfiguration();
  config.compoundRequests.enabled = enabled;
  config.typedSymbols.enabled = false;
  config.semanticSearch.enabled = false;
  return config;
}

function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-compound-integration-")));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "compound-integration", type: "module" }));
  fs.writeFileSync(path.join(root, "src/delay.ts"), "export const DELAY_STEP = 150;\nexport function retryDelay(attempt: number): number {\n  return DELAY_STEP * attempt;\n}\n");
  fs.writeFileSync(path.join(root, "src/fees.ts"), "export const SERVICE_FEE = 5;\nexport function feeTotal(subtotal: number): number {\n  return subtotal + SERVICE_FEE;\n}\n");
  return root;
}

beforeEach(() => {
  resetSessions();
  resetPackDedupeCache();
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.kill()));
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
});

function sourceBodies(pack: Awaited<ReturnType<typeof buildTaskPack>>): string {
  return pack.surfaces.map((surface) => surface.code ?? "").join("\n");
}

async function build(query: string, enabled = true, root = fixture()) {
  return withEngineConfiguration(configuration(enabled), () => buildTaskPack({ query, taskProfile: "answer" }, root));
}

describe("compound requests through the task-pack proof pipeline", () => {
  it.each([ENGLISH, JAPANESE])("retains both files and distinct clause proof in the first pack: %s", async (query) => {
    const pack = await build(query);
    const bodies = sourceBodies(pack);
    expect(bodies).toContain("return DELAY_STEP * attempt");
    expect(bodies).toContain("return subtotal + SERVICE_FEE");
    expect(pack.execution_contract?.readiness).toBe("answer-ready");
    const obligations = pack.execution_contract?.readiness_certificate?.obligations ?? [];
    expect(obligations.find((obligation) => obligation.id === "request-item:facet-1:value")?.evidence?.map((entry) => entry.path)).toEqual(["src/delay.ts"]);
    expect(obligations.find((obligation) => obligation.id === "request-item:facet-2:value")?.evidence?.map((entry) => entry.path)).toEqual(["src/fees.ts"]);
  }, 30_000);

  it("retains return-value and flow obligations for two clauses about one subject", async () => {
    const pack = await build("What does retryDelay() return and trace its execution flow.");
    expect(sourceBodies(pack)).toContain("return DELAY_STEP * attempt");
    const ids = pack.execution_contract?.readiness_certificate?.obligations.map((obligation) => obligation.id)
      ?? pack.execution_contract?.evidence_model?.claims.map((claim) => claim.id) ?? [];
    expect(ids).toContain("request-item:facet-1:value");
    expect(ids).toContain("request-item:facet-2:flow");
  }, 30_000);

  it("preserves the first answer pack for one calculation with many supplied input records", async () => {
    const query = "Calculate exact retryDelay() results for these attempts: 1; 2; 3; 4; 5; 6; 7; 8; 9; 10. Explain rounding rules. Include exact evidence.";
    const pack = await build(query);
    expect(sourceBodies(pack)).toContain("return DELAY_STEP * attempt");
    expect(pack.execution_contract?.readiness).toBe("answer-ready");
    expect(pack.missing.some((entry) => entry.includes("compound-request:"))).toBe(false);
  }, 30_000);

  it("preserves a prepared single-task pack despite many evidence-format sentences", async () => {
    const query = `Explain retryDelay and its contract. ${"Include exact evidence. ".repeat(40)}`;
    const root = fixture();
    const pack = await withEngineConfiguration(configuration(), () => buildTaskPack({ query, taskProfile: "answer", paths: [{ path: "src/delay.ts" }] }, root));
    expect(pack.execution_contract?.readiness).toBe("answer-ready");
    expect(pack.missing.some((entry) => entry.includes("compound-request:"))).toBe(false);
  }, 30_000);

  it("keeps an absent second subject disclosed instead of absorbing it into the first facet", async () => {
    const pack = await build("What does retryDelay() return and who calls vanishedWorker()?");
    expect(sourceBodies(pack)).toContain("return DELAY_STEP * attempt");
    expect(pack.request_item_absences?.some((entry) => entry.term.includes("vanishedWorker"))).toBe(true);
    const disclosure = JSON.stringify({ gaps: pack.execution_contract?.capability_gaps, absences: pack.request_item_absences });
    expect(disclosure).toContain("vanishedWorker");
    expect(pack.execution_contract?.discovery_complete).toBe(false);
  }, 30_000);

  it("discloses bounded-away clauses before a readiness certificate can be issued", async () => {
    const pack = await build(CAPPED);
    expect(pack.execution_contract?.discovery_complete).toBe(false);
    expect(pack.execution_contract?.readiness_certificate).toBeUndefined();
    expect(pack.execution_contract?.capability_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request-item-undetermined", obligation_ids: ["request-item:compound-request:query:clause-budget"] }),
    ]));
    expect(pack.request_item_absences?.some((entry) => entry.undetermined !== true && entry.term.includes("clause-budget"))).not.toBe(true);
  }, 30_000);

  it("discloses input truncation as unknown without turning its budget gap into an absence", async () => {
    const pack = await buildTaskPack({ query: `${CAPPED}\n${"context ".repeat(4_200)}Who calls afterTheCap()?`, taskProfile: "answer", paths: [{ path: "src/delay.ts" }] }, fixture());
    expect(pack.execution_contract?.readiness_certificate).toBeUndefined();
    expect(pack.execution_contract?.capability_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request-item-undetermined", obligation_ids: ["request-item:compound-request:query:query-budget"] }),
    ]));
    expect(pack.request_item_absences?.some((entry) => entry.term.includes("query-budget") && entry.undetermined !== true)).not.toBe(true);
  }, 30_000);

  it("keeps concurrent enabled and disabled builds on their captured configurations", async () => {
    const [enabled, disabled] = await Promise.all([build(CAPPED, true), build(CAPPED, false)]);
    expect(enabled.execution_contract?.capability_gaps?.some((gap) => gap.obligation_ids?.includes("request-item:compound-request:query:clause-budget"))).toBe(true);
    expect(disabled.execution_contract?.capability_gaps?.some((gap) => gap.obligation_ids?.some((id) => id.includes("compound-request:")))).not.toBe(true);
    expect(disabled.missing.some((entry) => entry.includes("compound-request:"))).toBe(false);
  }, 30_000);

  it("preserves single-subject citation/conjunction behavior when composition is disabled", async () => {
    const query = "Explain the value of retryDelay() and its callers. Cite file and line sources.";
    const enabled = await build(query, true);
    const disabled = await build(query, false);
    expect(enabled.surfaces.map((surface) => [surface.path, surface.range, surface.code])).toEqual(disabled.surfaces.map((surface) => [surface.path, surface.range, surface.code]));
    expect(enabled.execution_contract?.readiness).toBe(disabled.execution_contract?.readiness);
    expect(enabled.execution_contract?.capability_gaps?.map((gap) => gap.kind)).toEqual(disabled.execution_contract?.capability_gaps?.map((gap) => gap.kind));
  }, 30_000);
});

describe("canonical public compound MCP call shapes", () => {
  it.each([ENGLISH, JAPANESE])("serves two independent source bodies on the first tl_read_file call: %s", async (query) => {
    const root = fixture();
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tl-compound-config-"));
    temporary.push(configRoot);
    const configFile = path.join(configRoot, "engines.json");
    fs.writeFileSync(configFile, JSON.stringify(configuration()));
    const server = startDevServer(root, "default", { extraEnv: { TOKENLIGHTEN_ENGINES_FILE: configFile } });
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", { query, cwd: root, task: { epoch: "new", profile: "answer" } });
    expect(body.kind).toBe("read.task_pack");
    const bodies = body.evidence.map((entry: { body?: string }) => entry.body ?? "").join("\n");
    expect(bodies).toContain("return DELAY_STEP * attempt");
    expect(bodies).toContain("return subtotal + SERVICE_FEE");
    expect(body.decision.kind).toBe("act.answer");
    expect(body.decision.certificate.obligations).toContain("request-item:facet-1:value");
    expect(body.decision.certificate.obligations).toContain("request-item:facet-2:value");
    await server.kill();
  }, 60_000);
});
