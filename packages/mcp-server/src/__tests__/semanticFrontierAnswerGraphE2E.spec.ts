/**
 * Real modern-protocol regression for answer-profile relationship requests.
 * It deliberately uses a temporary TypeScript project: the relation is proved
 * by actual import syntax, never a filename or identifier-stem heuristic.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { semanticFrontierPathId } from "../features/task-pack/semanticFrontier.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const tmpDirs: string[] = [];
const clients: Client[] = [];

function makeTemp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "invoice_flags.ts"), [
    "export const INVOICE_V2_FLAG = 'invoice-v2';",
    "export function invoiceVersion(flag: boolean): 'v1' | 'v2' { return flag ? 'v2' : 'v1'; }",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "invoice_template.ts"),
    "export const INVOICE_TEMPLATE = 'invoice: {{number}}';\n");
  fs.writeFileSync(path.join(root, "src", "invoice_schema.gen.ts"),
    "export interface InvoiceSchema { number: string }\n");
  fs.writeFileSync(path.join(root, "src", "render_invoice.ts"), [
    "import { INVOICE_V2_FLAG, invoiceVersion } from './invoice_flags.js';",
    "import { INVOICE_TEMPLATE } from './invoice_template.js';",
    "import type { InvoiceSchema } from './invoice_schema.gen.js';",
    "export function renderInvoice(input: InvoiceSchema, enabled: boolean): string {",
    "  return `${INVOICE_TEMPLATE} ${input.number} ${INVOICE_V2_FLAG} ${invoiceVersion(enabled)}`;",
    "}",
  ].join("\n"));
  // Same vocabulary in prose must never create a relation edge.
  fs.mkdirSync(path.join(root, "examples"), { recursive: true });
  fs.writeFileSync(path.join(root, "examples", "invoice_notes.ts"),
    "export const note = 'INVOICE_TEMPLATE INVOICE_V2_FLAG InvoiceSchema renderInvoice';\n");
}

async function connect(root: string, home: string, guard: "0" | "1"): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, BIN_TS, root],
    cwd: root,
    env: {
      ...process.env,
      TOKENLIGHTEN_PROTOCOL_ERA: "modern",
      TL_TRACE: "1",
      TL_SEMANTIC_FRONTIER_GUARD: guard,
      HOME: home,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "tl-semantic-frontier-answer-graph-e2e", version: "0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function packet(result: unknown): Record<string, any> {
  const text = (result as { content?: Array<{ text?: unknown }> }).content?.[0]?.text;
  expect(typeof text, JSON.stringify(result)).toBe("string");
  return JSON.parse(text as string) as Record<string, any>;
}

function traceRecords(home: string): Array<Record<string, unknown>> {
  const traceDir = path.join(home, ".tokenlighten", "trace");
  if (!fs.existsSync(traceDir)) return [];
  return fs.readdirSync(traceDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => fs.readFileSync(path.join(traceDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function semanticSummary(body: Record<string, any>): Record<string, unknown> {
  const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : [];
  const decision = body["decision"] as Record<string, any> | undefined;
  const next = decision?.["next"] as Record<string, any> | undefined;
  const nextArguments = next?.["arguments"] as Record<string, unknown> | undefined;
  const { qref: _qref, cwd: _cwd, lane: _lane, task: _task, ...stableNextArguments } = nextArguments ?? {};
  return {
    evidence: evidence.map((entry: Record<string, unknown>) => ({
      path: entry["path"], body: entry["body"], prior: entry["prior"], remaining: entry["remaining"],
    })).sort((left: any, right: any) => String(left.path).localeCompare(String(right.path))),
    decision: decision === undefined ? undefined : {
      ...decision,
      ...(next === undefined ? {} : { next: { tool: next["tool"], arguments: stableNextArguments } }),
    },
  };
}

async function firstPack(client: Client, root: string, query: string, lane: string): Promise<Record<string, any>> {
  const result = await client.callTool({
    name: "read_file",
    arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: root, lane },
  });
  const body = packet(result);
  expect(body["kind"], JSON.stringify(body)).toBe("read.task_pack");
  return body;
}

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("semantic frontier answer import graph through real modern stdio", () => {
  it("keeps explicit TS providers on the first pack and traces only observed imports", async () => {
    const source = "src/render_invoice.ts";
    const cases = [
      { query: "Trace INVOICE_V2_FLAG invoiceVersion renderInvoice relation", target: "src/invoice_flags.ts", token: "INVOICE_V2_FLAG" },
      { query: "Trace INVOICE_TEMPLATE invoice_template.ts renderInvoice relation", target: "src/invoice_template.ts", token: "INVOICE_TEMPLATE" },
      { query: "Trace InvoiceSchema invoice_schema.gen.ts renderInvoice consumed relation", target: "src/invoice_schema.gen.ts", token: "InvoiceSchema" },
      { query: "Trace renderInvoice render_invoice.ts imports to INVOICE_V2_FLAG INVOICE_TEMPLATE InvoiceSchema", target: "src/invoice_flags.ts", token: "INVOICE_V2_FLAG" },
    ];
    const events: Array<Record<string, unknown>> = [];
    for (const [index, testCase] of cases.entries()) {
      // A first pack is a new process/session, not a dedupe receipt from an
      // earlier anchor query in this test.
      const root = makeTemp(`tl-semantic-answer-graph-${index}-`);
      const home = makeTemp(`tl-semantic-answer-graph-home-${index}-`);
      writeProject(root);
      const client = await connect(root, home, "0");
      const body = await firstPack(client, root, testCase.query, `answer-import-${index}`);
      const evidence = (body["evidence"] as Array<Record<string, unknown>>)
        .filter((entry) => typeof entry["body"] === "string");
      const bodies = new Map<string, string[]>();
      for (const entry of evidence) {
        const current = bodies.get(entry["path"] as string) ?? [];
        current.push(entry["body"] as string);
        bodies.set(entry["path"] as string, current);
      }
      expect(bodies.get(source)?.some((body) => body.includes("renderInvoice")), JSON.stringify(body)).toBe(true);
      expect(bodies.get(testCase.target)?.some((body) => body.includes(testCase.token)), JSON.stringify(body)).toBe(true);
      // A terminal answer is valid only after these asserted first-pack bodies
      // exist; this is the false-ready guard for explicit providers.
      if (body["decision"]?.["kind"] === "act.answer") {
        expect(bodies.has(testCase.target)).toBe(true);
      }
      const event = traceRecords(home).find((record) => record["event"] === "semantic_frontier_attestation");
      expect(event, JSON.stringify(traceRecords(home))).toBeDefined();
      events.push(event!);
    }

    expect(events).toHaveLength(cases.length);
    const relationsEvent = events.at(-1)!;
    const relations = relationsEvent["relations"] as Array<Record<string, unknown>>;
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proof: "graph-edge",
        relation_kind: "imports",
        from_path_id: semanticFrontierPathId(source),
        to_path_id: semanticFrontierPathId("src/invoice_flags.ts"),
      }),
      expect.objectContaining({
        proof: "graph-edge",
        relation_kind: "imports",
        from_path_id: semanticFrontierPathId(source),
        to_path_id: semanticFrontierPathId("src/invoice_template.ts"),
      }),
      expect.objectContaining({
        proof: "graph-edge",
        relation_kind: "imports",
        from_path_id: semanticFrontierPathId(source),
        to_path_id: semanticFrontierPathId("src/invoice_schema.gen.ts"),
      }),
    ]));
    expect(JSON.stringify(relations)).not.toContain("invoice_notes");
  }, 90_000);

  it("does not suppress an explicit import-bound answer under the guard", async () => {
    const root = makeTemp("tl-semantic-answer-parity-");
    writeProject(root);
    const query = "Trace renderInvoice render_invoice.ts imports to INVOICE_V2_FLAG INVOICE_TEMPLATE InvoiceSchema";
    const controlHome = makeTemp("tl-semantic-answer-parity-control-");
    const treatmentHome = makeTemp("tl-semantic-answer-parity-treatment-");
    const control = await connect(root, controlHome, "0");
    const treatment = await connect(root, treatmentHome, "1");
    const controlPacket = await firstPack(control, root, query, "answer-parity-control");
    const treatmentPacket = await firstPack(treatment, root, query, "answer-parity-treatment");
    expect(semanticSummary(treatmentPacket)).toEqual(semanticSummary(controlPacket));

    const treatmentEvents = traceRecords(treatmentHome)
      .filter((record) => record["event"] === "semantic_frontier_attestation");
    expect(treatmentEvents, JSON.stringify(traceRecords(treatmentHome))).toHaveLength(1);
    const treatmentEvent = treatmentEvents[0];
    expect(treatmentEvent).toMatchObject({ committed: false, suppression_reasons: [] });
    expect(treatmentEvent?.["relations"], JSON.stringify(treatmentEvent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_path_id: semanticFrontierPathId("src/render_invoice.ts"),
        to_path_id: semanticFrontierPathId("src/invoice_schema.gen.ts"),
        relation_kind: "imports",
      }),
    ]));
  }, 90_000);
});
