import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { REVIEW_0153_QUERY as QUERY, review0153Pricing as pricing } from "./helpers/independentReview0153Fixture.js";

const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of dirs.splice(0)) await rmDirWithRetry(dir);
});

async function fixture(files: Record<string, string>) {
  const ws = fs.realpathSync(shortTmpDir(os.homedir(), ".tl-review0153-"));
  dirs.push(ws);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), content);
  }
  const server = startDevServer(ws, "default", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  return { server, ws };
}


async function answer(server: ServerHandle, query = QUERY, budget?: { bytes: number }) {
  let reply = (await server.callTool("tl_read_file", { query, task: { epoch: "new" }, ...(budget ? { budget } : {}) })).body;
  const pages = [reply];
  for (let hop = 0; hop < 12 && (reply.decision?.next ?? reply.limit?.next); hop++) {
    const next = reply.decision?.next ?? reply.limit.next;
    reply = (await server.callTool(next.tool, next.arguments)).body;
    pages.push(reply);
  }
  const body = pages.flatMap(r => r.evidence ?? []).map(e => e.body ?? "").join("\n");
  return { reply, body, pages };
}

describe("independent v0.15.3 review — exact public calls", () => {
  it("keeps a small natural-language explanation below 1000 bytes with its evidence and certificate", async () => {
    const source = "export function add(a: number, b: number) { return a + b; }\n";
    const { server } = await fixture({ "src/tiny.ts": source });
    const result = await server.callTool("tl_read_file", { query: "src/tiny.ts の add 関数を説明してください。", task: { epoch: "new" } });
    expect(result.body.decision?.kind).toBe("act.answer");
    expect(result.body.evidence[0].body).toBe(source);
    expect(result.body.decision.certificate.obligations).toEqual(["surface-content"]);
    expect(result.body.profile_binding).toMatchObject({ selected: "answer", source: "inferred" });
    expect(result.textBytes).toBeLessThan(1000);
  });

  it.each([1000, 2000])("returns numeric opt-in pagination advice without changing next (%s bytes)", async bytes => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) =>
      [`searchset/item${String(i).padStart(3, "0")}.ts`, `export const RETRY_LIMIT_${i} = 3; // shared retry policy\n`]));
    const { server } = await fixture(files);
    const input = { action: "find", queries: ["RETRY_LIMIT_"], scope: { path: "searchset", kind: "text" }, budget: { bytes } };
    const first = await server.callTool("tl_search_files", input);
    const advice = first.body.matches.pagination_advice;
    expect(advice.remaining_lines).toBe(120 - first.body.matches.files.length);
    expect(Number.isInteger(advice.estimated_remaining_bytes)).toBe(true);
    expect(advice.recommended_budget.bytes).toBeGreaterThan(bytes);
    expect(first.body.limit.next.arguments.budget).toEqual(input.budget);
    expect(first.textBytes).toBeLessThanOrEqual(bytes);
    const paths = first.body.matches.files.map((file: any) => file.path);
    let page = first;
    for (let hop = 0; hop < 10 && page.body.limit?.next; hop++) {
      const next = page.body.limit.next;
      page = await server.callTool(next.tool, { ...next.arguments, budget: advice.recommended_budget });
      expect(page.textBytes).toBeLessThanOrEqual(advice.recommended_budget.bytes);
      paths.push(...page.body.matches.files.map((file: any) => file.path));
    }
    expect(page.body.limit).toBeUndefined();
    expect(page.body.matches.pagination_advice).toBeUndefined();
    expect(paths.length).toBe(120);
    expect(new Set(paths).size).toBe(120);
    for (const budget of [{ bytes, items: 2 }, { bytes, tokens: 500 }]) {
      const limited = await server.callTool("tl_search_files", { ...input, budget, lane: `limited-${JSON.stringify(budget)}` });
      expect(limited.body.matches.pagination_advice).toBeUndefined();
    }
  });
  it.each([0.1, 0.2])("serves single-letter constant bindings and the distinguishing value (%s)", async rate => {
    const { server } = await fixture(pricing(rate, true));
    const { reply, body, pages } = await answer(server);
    expect(body, JSON.stringify(pages)).toContain(`export const RATE = ${rate};`);
    expect(body).toContain("RATE as R");
    expect(body).toContain("FREE as MINIMUM");
    expect(body).toContain("FEE as DELIVERY");
    expect(body).toContain("Math.floor(x * R)");
    expect(reply.decision?.kind, JSON.stringify(pages)).toBe("act.answer");
    expect(reply.decision?.certificate?.gaps).toBeUndefined();
  });

  it("keeps UTF-8 search pages within budget and delivers each result exactly once", async () => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) =>
      [`searchset/項目${String(i).padStart(3, "0")}.ts`, `export const RETRY_LIMIT_${i} = 3; // 共通の再試行設定\n`]));
    const { server } = await fixture(files);
    let page = await server.callTool("tl_search_files", { action: "find", queries: ["RETRY_LIMIT_"],
      scope: { path: "searchset", kind: "text" }, budget: { bytes: 2000 } });
    const paths: string[] = [];
    for (let hop = 0; hop < 100; hop++) {
      expect(page.textBytes).toBeLessThanOrEqual(2000);
      paths.push(...page.body.matches.files.map((file: any) => file.path));
      if (!page.body.limit?.next) break;
      const next = page.body.limit.next;
      expect(next.arguments.budget.bytes).toBe(2000);
      page = await server.callTool(next.tool, next.arguments);
    }
    expect(page.body.limit).toBeUndefined();
    expect(paths.length).toBe(120);
    expect(new Set(paths).size).toBe(120);
  });

  it.each([[true, false], [false, true], [true, true]])("resolves function aliases=%s and barrels=%s with their bindings", async (alias, barrel) => {
    const { server } = await fixture(pricing(0.2, true, alias, barrel));
    const { reply, body, pages } = await answer(server);
    expect(body, JSON.stringify(pages)).toContain("export const RATE = 0.2;");
    expect(body).toContain("Math.floor(x * R)");
    expect(body).toContain("x >= MINIMUM ? 0 : DELIVERY");
    if (barrel) expect(body).toContain('from "./helpers.ts"');
    if (alias) expect(body).toContain("discount as cut");
    expect(reply.decision?.kind, JSON.stringify(pages)).toBe("act.answer");
    expect(reply.decision?.certificate?.gaps).toBeUndefined();
  });

  it("discloses a missing single-letter value instead of silently certifying it", async () => {
    const files = pricing(0.1, true);
    files["src/policy.ts"] = "export const FREE = 5000;\nexport const FEE = 500;\n";
    const { server } = await fixture(files);
    const { reply } = await answer(server);
    expect(JSON.stringify(reply.decision)).toMatch(/(?:unresolved|undetermined).*R/);
    expect(reply.decision?.certificate?.gaps).toBeDefined();
  });

  it("discloses both value and flow when a barrel cannot resolve an imported function", async () => {
    const files = pricing(0.1, false, true, true);
    files["src/index.ts"] = 'export {unknown as cut, shipping as delivery} from "./helpers.ts";\n';
    const { server } = await fixture(files);
    const { reply } = await answer(server);
    const gaps = JSON.stringify(reply.decision?.certificate?.gaps);
    expect(gaps).toContain("value");
    expect(gaps).toContain("flow");
    expect(gaps).toContain("cut");
  });

  it("requires wrapped alias statements as source evidence", async () => {
    const files = pricing(0.1, true);
    files["src/helpers.ts"] = files["src/helpers.ts"].replace("{ RATE as R, FREE as MINIMUM, FEE as DELIVERY }", "{\n RATE as R,\n FREE as MINIMUM,\n FEE as DELIVERY\n}");
    const { server } = await fixture(files);
    const { body, reply } = await answer(server);
    expect(body).toContain("RATE as R,");
    expect(body).toContain('} from "./policy.ts";');
    expect(body).toContain("export const RATE = 0.1;");
    expect(reply.decision?.certificate?.gaps).toBeUndefined();
  });

  it("keeps identically named aliases in different modules as different dependencies", async () => {
    const files = pricing(0.1, true);
    files["src/helpers.ts"] = 'import { RATE as R } from "./policy.ts";\nimport { shipping } from "./delivery.ts";\nexport { shipping };\nexport function discount(x: number, member: boolean): number { return member ? Math.floor(x * R) : 0; }\n';
    // Use a direct import for the second helper so only the value binding's
    // scope is at issue here, independently of a local export-list shape.
    files["src/bill.ts"] = files["src/bill.ts"].replace("discount, shipping", "discount")
      .replace("export function", 'import { shipping } from "./delivery.ts";\nexport function');
    const { server } = await fixture({ ...files,
      "src/delivery.ts": 'import { FEE as R } from "./fee.ts";\nexport function shipping(x: number): number { return x >= 5000 ? 0 : R; }\n',
      "src/fee.ts": "export const FEE = 700;\n",
    });
    const { body, reply, pages } = await answer(server);
    expect(body, JSON.stringify(pages)).toContain("export const RATE = 0.1;");
    expect(body).toContain("export const FEE = 700;");
    expect(body).toContain("FEE as R");
    expect(reply.decision?.certificate?.gaps).toBeUndefined();
  });

  it("does not resolve a callee parameter to a shadowed module alias", async () => {
    const files = pricing(0.2, true);
    files["src/helpers.ts"] = files["src/helpers.ts"].replace("discount(x: number", "discount(R: number")
      .replace("Math.floor(x * R)", "Math.floor(R * 0.1)");
    const { server } = await fixture(files);
    const { body, reply } = await answer(server);
    expect(body).toContain("Math.floor(R * 0.1)");
    expect(body).not.toContain("export const RATE = 0.2;");
    expect(reply.decision?.certificate?.gaps).toBeUndefined();
  });

  it("bounds cyclic re-exports and discloses unresolved value and flow", async () => {
    const files = pricing(0.1, false, true, true);
    files["src/index.ts"] = 'export {cut, delivery} from "./loop.ts";\n';
    const { server } = await fixture({ ...files, "src/loop.ts": 'export {cut, delivery} from "./index.ts";\n' });
    const { reply } = await answer(server);
    const gaps = JSON.stringify(reply.decision?.certificate?.gaps);
    expect(gaps).toContain("value");
    expect(gaps).toContain("flow");
  });

  it("deduplicates elided symbol reads while keeping comments readable and force serve effective", async () => {
    const source = "/** Shipping policy.\n * Threshold after discount.\n */\nexport function shipping(x: number): number {\n  return x >= 5000 ? 0 : 500;\n}\n";
    const { server, ws } = await fixture({ "src/pricing.ts": source });
    const args = { targets: [{ path: "src/pricing.ts", symbol: "shipping" }], content: "full", select: { comments: "elide" } };
    expect((await server.callTool("tl_read_file", args)).body.kind).toBe("read.text");
    for (let i = 0; i < 2; i++) expect((await server.callTool("tl_read_file", args)).body.kind).toBe("read.receipt");
    const kept = (await server.callTool("tl_read_file", { ...args, select: { comments: "keep" } })).body;
    expect(kept.kind).toBe("read.text");
    expect(JSON.stringify(kept)).toContain("Shipping policy");
    expect((await server.callTool("tl_read_file", { ...args, task: { force_serve: true } })).body.kind).toBe("read.text");
    fs.writeFileSync(path.join(ws, "src/pricing.ts"), source.replace("5000", "6000"));
    const changed = (await server.callTool("tl_read_file", args)).body;
    expect(changed.kind).toBe("read.text");
    expect(JSON.stringify(changed)).toContain("6000");
  });
});
