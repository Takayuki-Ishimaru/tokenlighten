import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { maskCitationFormatFields } from "../util/citationFormat.js";
import { extractRequestItems } from "../features/task-pack/requestItems.js";
import { explicitIdentifiersIn } from "../features/task-pack/requestFacets.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const QUERY = "What exact delay sequence does retrySchedule() return, and which constants and functions determine it? Use keys delays and sources. Include sources as an array of {path,startLine,endLine}; cite each function and constant needed for the result. Return only a JSON object. Do not modify files or run terminal commands.";
const servers: ServerHandle[] = [];
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map(server => server.kill()));
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
describe("citation response fields are not code subjects", () => {
  it("masks arbitrary citation fields while preserving offsets, the question, and real occurrences", () => {
    const masked = maskCitationFormatFields(QUERY);
    expect(masked.length).toBe(QUERY.length);
    expect(masked).toContain("retrySchedule()");
    expect(masked).not.toContain("startLine");
    expect(masked).not.toContain("endLine");
    const other = "What does sourceRow() return? Return citations in a list of {sourceRow,sourceColumn}.";
    const m = maskCitationFormatFields(other);
    expect(m).toContain("sourceRow()");
    expect(m).not.toContain("sourceColumn");
    expect(maskCitationFormatFields("Explain startLine and endLine.")).toBe("Explain startLine and endLine.");
    expect(maskCitationFormatFields("Add fields {startLine,endLine} to src/parser.ts.")).toBe("Add fields {startLine,endLine} to src/parser.ts.");
  });
  it("keeps response field names out of request items and explicit facet subjects", () => {
    expect(extractRequestItems(QUERY).flatMap(item => item.terms)).not.toEqual(expect.arrayContaining(["startLine"]));
    expect(extractRequestItems(QUERY).flatMap(item => item.terms)).not.toEqual(expect.arrayContaining(["endLine"]));
    expect(explicitIdentifiersIn(QUERY)).toContain("retrySchedule");
    expect(explicitIdentifiersIn(QUERY)).not.toContain("startLine");
    expect(explicitIdentifiersIn(QUERY)).not.toContain("endLine");
  });
  it("closes the exact observed Copilot CLI call with every value dependency", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-citation-shape-"))); roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/constants.ts"), "export const RETRY = { attempts: 4, initialDelayMs: 125, factor: 2, maxDelayMs: 800 } as const;\n");
    fs.writeFileSync(path.join(root, "src/backoff.ts"), 'import { RETRY } from "./constants.ts";\nexport function backoff(attempt: number): number {\n  return Math.min(RETRY.initialDelayMs * RETRY.factor ** attempt, RETRY.maxDelayMs);\n}\n');
    fs.writeFileSync(path.join(root, "src/retry.ts"), 'import { RETRY } from "./constants.ts";\nimport { backoff } from "./backoff.ts";\nexport function retrySchedule(): number[] {\n  return Array.from({ length: RETRY.attempts }, (_, attempt) => backoff(attempt));\n}\n');
    const server = startDevServer(root, "default"); servers.push(server); await server.initialize();
    const { body } = await server.callTool("tl_read_file", { cwd: root, query: QUERY, task: { epoch: "new" } });
    expect(body.kind).toBe("read.task_pack");
    expect(body.decision.kind, JSON.stringify(body.decision)).toBe("act.answer");
    expect(body.decision.next).toBeUndefined();
    const evidence = body.evidence as Array<{ path: string; body?: string }>;
    expect(new Set(evidence.map(item => item.path))).toEqual(new Set(["src/retry.ts", "src/backoff.ts", "src/constants.ts"]));
    expect(evidence.map(item => item.body ?? "").join("\n")).toContain("RETRY.initialDelayMs * RETRY.factor ** attempt");
  }, 60_000);
});
